const mongoose = require('mongoose');
const zlib = require('zlib');
const ReportArtifact = require('../models/ReportArtifact');

const CACHE_TTL_MS = 2 * 60 * 1000;
const projectCache = new Map();

const THRESHOLDS = {
    stress: { warning: 2.5, critical: 3.5, unit: 'MPa' },
    deflection: { warning: 1.8, critical: 2.5, unit: 'mm' },
    load: { warning: 6000, critical: 8500, unit: 'kN' },
    anomalyZScore: 3,
};

const SUPPORTED_DATA_TYPES = new Set([
    'strain',
    'temperature',
    'stress',
    'deflection',
    'load',
    'moment',
]);

const SUPPORTED_GRAPH_TYPES = new Set(['line', 'scatter']);

const ELEMENT_OPTIONS = {
    strain: [{ value: 'channel', label: 'Selected Channel' }],
    temperature: [{ value: 'channel', label: 'Selected Channel' }],
    stress: [
        { value: 'all', label: 'All Elements' },
        { value: 'beam', label: 'Beam' },
        { value: 'pier3a', label: 'Pier 3A' },
        { value: 'pier3b', label: 'Pier 3B' },
    ],
    deflection: [{ value: 'beam', label: 'Beam' }],
    load: [
        { value: 'all', label: 'All Elements' },
        { value: 'beam', label: 'Beam' },
        { value: 'pier3a', label: 'Pier 3A' },
        { value: 'pier3b', label: 'Pier 3B' },
    ],
    moment: [
        { value: 'all', label: 'All Elements' },
        { value: 'beam', label: 'Beam' },
        { value: 'pier3a', label: 'Pier 3A' },
        { value: 'pier3b', label: 'Pier 3B' },
    ],
};

const cleanNumber = (value, digits = 6) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return Number(value.toFixed(digits));
};

const parseTimestamp = (value) => {
    if (!value) return null;
    if (value instanceof Date) return value.toISOString();

    if (typeof value === 'string') {
        const normalized = value.includes('T') ? value : value.replace(' ', 'T');
        const date = new Date(normalized);
        if (!Number.isNaN(date.getTime())) return date.toISOString();
        return value;
    }

    return null;
};

const downsampleRows = (rows, maxPoints) => {
    if (!Array.isArray(rows)) return [];
    if (rows.length <= maxPoints) return rows;

    const step = Math.ceil(rows.length / maxPoints);
    const sampled = rows.filter((_, idx) => idx % step === 0);

    if (sampled[sampled.length - 1] !== rows[rows.length - 1]) {
        sampled.push(rows[rows.length - 1]);
    }

    return sampled;
};

const quantile = (sortedVals, q) => {
    if (!sortedVals.length) return null;
    const pos = (sortedVals.length - 1) * q;
    const base = Math.floor(pos);
    const rest = pos - base;

    if (sortedVals[base + 1] !== undefined) {
        return sortedVals[base] + rest * (sortedVals[base + 1] - sortedVals[base]);
    }

    return sortedVals[base];
};

const buildProjectFilters = (projectId) => {
    const asString = String(projectId);
    const filter = [
        { project_id: asString },
        { projectId: asString },
    ];

    if (mongoose.Types.ObjectId.isValid(asString)) {
        const objectId = new mongoose.Types.ObjectId(asString);
        filter.push({ project_id: objectId });
        filter.push({ projectId: objectId });
    }

    return filter;
};

const getLatestReportDocument = async (projectId) => {
    const reportsCol = mongoose.connection.db.collection('reports');
    const report = await reportsCol
        .find({ $or: buildProjectFilters(projectId) })
        .sort({ generated_at: -1, created_at: -1, createdAt: -1 })
        .limit(1)
        .next();

    return report || null;
};

const getLatestSheetsArtifact = async (projectId, reportId) => {
    const asString = String(projectId);
    const projectOr = [
        { 'metadata.project_id': asString },
        { 'metadata.projectId': asString },
    ];

    if (mongoose.Types.ObjectId.isValid(asString)) {
        const objectId = new mongoose.Types.ObjectId(asString);
        projectOr.push({ 'metadata.project_id': objectId });
        projectOr.push({ 'metadata.projectId': objectId });
    }

    const baseFilter = {
        $and: [
            { 'metadata.artifact_type': 'excel_sheets_data' },
            { $or: projectOr },
        ],
    };

    if (reportId) {
        const reportIdString = String(reportId);
        const reportOr = [
            { 'metadata.report_id': reportIdString },
            { 'metadata.reportId': reportIdString },
        ];

        if (mongoose.Types.ObjectId.isValid(reportIdString)) {
            const reportObjectId = new mongoose.Types.ObjectId(reportIdString);
            reportOr.push({ 'metadata.report_id': reportObjectId });
            reportOr.push({ 'metadata.reportId': reportObjectId });
        }

        const scopedArtifact = await ReportArtifact.findOne({
            $and: [...baseFilter.$and, { $or: reportOr }],
        })
            .sort({ uploadDate: -1 })
            .lean();

        if (scopedArtifact) {
            return scopedArtifact;
        }
    }

    const artifact = await ReportArtifact.findOne(baseFilter)
        .sort({ uploadDate: -1 })
        .lean();

    return artifact || null;
};

const getReportDocument = async (projectId, reportId) => {
    const reportsCol = mongoose.connection.db.collection('reports');

    if (reportId && mongoose.Types.ObjectId.isValid(String(reportId))) {
        const reportDoc = await reportsCol.findOne({
            _id: new mongoose.Types.ObjectId(String(reportId)),
            $or: buildProjectFilters(projectId),
        });

        if (reportDoc) return reportDoc;
    }

    return getLatestReportDocument(projectId);
};

const sanitizeJsonLike = (content) => {
    return content
        .replace(/\bNaN\b/g, 'null')
        .replace(/\bInfinity\b/g, 'null')
        .replace(/\b-Infinity\b/g, 'null');
};

const downloadArtifactPayload = async (artifact) => {
    if (!artifact?._id) return null;

    const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
        bucketName: 'report_files',
    });

    const chunks = [];
    await new Promise((resolve, reject) => {
        bucket
            .openDownloadStream(new mongoose.Types.ObjectId(String(artifact._id)))
            .on('data', (chunk) => chunks.push(chunk))
            .on('error', reject)
            .on('end', resolve);
    });

    const buffer = Buffer.concat(chunks);

    let textContent = null;
    const looksCompressed =
        artifact?.metadata?.content_encoding === 'gzip' ||
        (artifact.contentType || '').includes('gzip') ||
        (artifact.filename || '').endsWith('.json');

    if (looksCompressed) {
        try {
            textContent = zlib.gunzipSync(buffer).toString('utf8');
        } catch {
            textContent = buffer.toString('utf8');
        }
    } else {
        textContent = buffer.toString('utf8');
    }

    const safeText = sanitizeJsonLike(textContent);
    return JSON.parse(safeText);
};

const getProjectDataBundle = async (projectId, reportId = '') => {
    const cacheKey = `${String(projectId)}::${String(reportId || 'latest')}`;
    const cached = projectCache.get(cacheKey);
    const now = Date.now();

    if (cached && now - cached.cachedAt < CACHE_TTL_MS) {
        return cached.value;
    }

    const [artifact, reportDoc] = await Promise.all([
        getLatestSheetsArtifact(projectId, reportId),
        getReportDocument(projectId, reportId),
    ]);

    if (!artifact && !reportDoc) {
        return null;
    }

    let payload = null;
    if (artifact) {
        payload = await downloadArtifactPayload(artifact);
    }

    const value = {
        artifact,
        reportDoc,
        payload,
        rows: Array.isArray(payload?.['Analysis Results']) ? payload['Analysis Results'] : [],
        summaryStats: reportDoc?.summary?.stats || payload?.summary?.stats || {},
    };

    projectCache.set(cacheKey, {
        value,
        cachedAt: now,
    });

    return value;
};

const getRowsTemperatureRange = (rows) => {
    let min = null;
    let max = null;

    for (const row of rows) {
        for (const [key, value] of Object.entries(row || {})) {
            if (!key.includes('Temp')) continue;
            const num = cleanNumber(value);
            if (num === null) continue;
            if (min === null || num < min) min = num;
            if (max === null || num > max) max = num;
        }
    }

    return { min, max };
};

const getMaxAbs = (maxStats, minStats, key) => {
    const maxVal = cleanNumber(maxStats?.[key]);
    const minVal = cleanNumber(minStats?.[key]);

    const candidates = [
        maxVal !== null ? Math.abs(maxVal) : null,
        minVal !== null ? Math.abs(minVal) : null,
    ].filter((v) => v !== null);

    if (!candidates.length) return null;
    return cleanNumber(Math.max(...candidates), 4);
};

const evaluateStatus = ({ maxStressBeam, maxDeflection, maxLoad }) => {
    const stress = maxStressBeam ?? 0;
    const deflection = maxDeflection ?? 0;
    const load = maxLoad ?? 0;

    if (
        stress >= THRESHOLDS.stress.critical ||
        deflection >= THRESHOLDS.deflection.critical ||
        load >= THRESHOLDS.load.critical
    ) {
        return 'CRITICAL';
    }

    if (
        stress >= THRESHOLDS.stress.warning ||
        deflection >= THRESHOLDS.deflection.warning ||
        load >= THRESHOLDS.load.warning
    ) {
        return 'WARNING';
    }

    return 'SAFE';
};

const getChannelCodes = (rows) => {
    if (!rows?.length) return [];

    const keys = Object.keys(rows[0]);
    const channels = keys
        .map((k) => {
            const match = /^CH(\d{2}) \(me\)$/.exec(k);
            return match ? `CH${match[1]}` : null;
        })
        .filter(Boolean);

    return Array.from(new Set(channels)).sort((a, b) => a.localeCompare(b));
};

const parseDateSafe = (value) => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
};

const filterRowsByRange = (rows, startDate, endDate) => {
    if (!startDate && !endDate) return rows;

    return rows.filter((row) => {
        const timestamp = parseDateSafe(row?.['Date/Time']);
        if (!timestamp) return false;
        if (startDate && timestamp < startDate) return false;
        if (endDate && timestamp > endDate) return false;
        return true;
    });
};

const normalizeDataType = (value) => {
    const type = String(value || 'strain').trim().toLowerCase();
    return SUPPORTED_DATA_TYPES.has(type) ? type : 'strain';
};

const normalizeGraphType = (value) => {
    const graphType = String(value || 'line').trim().toLowerCase();
    return SUPPORTED_GRAPH_TYPES.has(graphType) ? graphType : 'line';
};

const getElementOptionsForType = (selectedType) => {
    return ELEMENT_OPTIONS[selectedType] || [{ value: 'all', label: 'All Elements' }];
};

const normalizeElement = (value, selectedType) => {
    const options = getElementOptionsForType(selectedType);
    const allowed = new Set(options.map((option) => option.value));
    const requested = String(value || options[0]?.value || 'all').trim().toLowerCase();

    if (allowed.has(requested)) {
        return requested;
    }

    return options[0]?.value || 'all';
};

const normalizeReportSummary = (reportDoc) => {
    if (!reportDoc) return null;

    return {
        _id: reportDoc._id,
        title: reportDoc.title || reportDoc.report_type || reportDoc.fileName || 'Untitled Report',
        reportType: reportDoc.report_type || reportDoc.title || 'shm_report',
        status: reportDoc.status || reportDoc.processing_status || 'READY',
        generatedAt:
            parseTimestamp(reportDoc.generated_at || reportDoc.created_at || reportDoc.createdAt) ||
            parseTimestamp(reportDoc.uploadDate) ||
            null,
    };
};

const buildLineSeriesData = (rows, seriesDefs) => {
    return rows
        .map((row) => {
            const point = {
                timestamp: parseTimestamp(row['Date/Time']),
            };

            for (const series of seriesDefs) {
                point[series.key] = cleanNumber(row[series.source], 6);
            }

            return point;
        })
        .filter((point) => seriesDefs.some((series) => point[series.key] !== null));
};

const toSeriesMeta = (seriesDefs) => {
    return seriesDefs.map(({ key, name, color }) => ({ key, name, color }));
};

const buildFilteredSeries = ({ rows, selectedChannel, selectedType, graphType, requestedElement }) => {
    const availableElements = getElementOptionsForType(selectedType);
    const selectedElement = normalizeElement(requestedElement, selectedType);

    switch (selectedType) {
        case 'strain': {
            const seriesDefs = [
                {
                    key: 'strain',
                    name: 'Strain',
                    color: '#2563eb',
                    source: `${selectedChannel} (me)`,
                },
            ];

            const data = buildLineSeriesData(rows, seriesDefs);

            return {
                fields: ['strain'],
                unit: 'microstrain',
                chartType: 'line',
                data,
                selectedElement,
                availableElements,
                series: toSeriesMeta(seriesDefs),
            };
        }

        case 'temperature': {
            const seriesDefs = [
                {
                    key: 'temperature',
                    name: 'Temperature',
                    color: '#f97316',
                    source: `${selectedChannel} Temp`,
                },
            ];

            const data = buildLineSeriesData(rows, seriesDefs);

            return {
                fields: ['temperature'],
                unit: 'C',
                chartType: 'line',
                data,
                selectedElement,
                availableElements,
                series: toSeriesMeta(seriesDefs),
            };
        }

        case 'stress': {
            const allSeries = [
                { key: 'stressBeam', name: 'Stress Beam', color: '#2563eb', source: 'Stress Beam (MPa)' },
                { key: 'stressPier3A', name: 'Stress PIER3A', color: '#16a34a', source: 'Stress PIER3A (MPa)' },
                { key: 'stressPier3B', name: 'Stress PIER3B', color: '#9333ea', source: 'Stress PIER3B (MPa)' },
            ];

            let activeSeries = allSeries;
            if (selectedElement === 'beam') {
                activeSeries = allSeries.filter((item) => item.key === 'stressBeam');
            } else if (selectedElement === 'pier3a') {
                activeSeries = allSeries.filter((item) => item.key === 'stressPier3A');
            } else if (selectedElement === 'pier3b') {
                activeSeries = allSeries.filter((item) => item.key === 'stressPier3B');
            }

            const data = buildLineSeriesData(rows, activeSeries);

            return {
                fields: activeSeries.map((item) => item.key),
                unit: 'MPa',
                chartType: 'line',
                data,
                selectedElement,
                availableElements,
                series: toSeriesMeta(activeSeries),
            };
        }

        case 'deflection': {
            const seriesDefs = [
                {
                    key: 'deflection',
                    name: 'Deflection Beam',
                    color: '#0ea5e9',
                    source: 'Deflection Beam (mm)',
                },
            ];

            const data = buildLineSeriesData(rows, seriesDefs);

            return {
                fields: ['deflection'],
                unit: 'mm',
                chartType: 'line',
                data,
                selectedElement,
                availableElements,
                series: toSeriesMeta(seriesDefs),
            };
        }

        case 'load': {
            const allSeries = [
                { key: 'totalLoad', name: 'Total Load', color: '#ea580c', source: 'Total Load (kN)' },
                { key: 'axialLoadPier3A', name: 'Axial PIER3A', color: '#8b5cf6', source: 'Axial Load PIER3A (kN)' },
                { key: 'axialLoadPier3B', name: 'Axial PIER3B', color: '#14b8a6', source: 'Axial Load PIER3B (kN)' },
            ];

            if (graphType === 'scatter') {
                let xSource = 'Total Load (kN)';
                let xName = 'Total Load';

                if (selectedElement === 'pier3a') {
                    xSource = 'Axial Load PIER3A (kN)';
                    xName = 'Axial PIER3A';
                } else if (selectedElement === 'pier3b') {
                    xSource = 'Axial Load PIER3B (kN)';
                    xName = 'Axial PIER3B';
                }

                const data = rows
                    .map((row) => ({
                        timestamp: parseTimestamp(row['Date/Time']),
                        x: cleanNumber(row[xSource]),
                        y: cleanNumber(row['Deflection Beam (mm)']),
                    }))
                    .filter((point) => point.x !== null && point.y !== null);

                return {
                    fields: ['x', 'y'],
                    unit: 'kN/mm',
                    chartType: 'scatter',
                    data,
                    selectedElement,
                    availableElements,
                    series: [
                        { key: 'x', name: xName, color: '#ea580c' },
                        { key: 'y', name: 'Deflection Beam', color: '#0ea5e9' },
                    ],
                };
            }

            let activeSeries = allSeries;
            if (selectedElement === 'beam') {
                activeSeries = allSeries.filter((item) => item.key === 'totalLoad');
            } else if (selectedElement === 'pier3a') {
                activeSeries = allSeries.filter((item) => item.key === 'axialLoadPier3A');
            } else if (selectedElement === 'pier3b') {
                activeSeries = allSeries.filter((item) => item.key === 'axialLoadPier3B');
            }

            const data = buildLineSeriesData(rows, activeSeries);

            return {
                fields: activeSeries.map((item) => item.key),
                unit: 'kN',
                chartType: 'line',
                data,
                selectedElement,
                availableElements,
                series: toSeriesMeta(activeSeries),
            };
        }

        case 'moment': {
            const allSeries = [
                { key: 'momentPier3AMxx', name: 'PIER3A Mxx', color: '#1d4ed8', source: 'PIER3A Mxx (kN-m)' },
                { key: 'momentPier3AMyy', name: 'PIER3A Myy', color: '#0f766e', source: 'PIER3A Myy (kN-m)' },
                { key: 'momentPier3BMxx', name: 'PIER3B Mxx', color: '#9333ea', source: 'PIER3B Mxx (kN-m)' },
                { key: 'momentPier3BMyy', name: 'PIER3B Myy', color: '#b45309', source: 'PIER3B Myy (kN-m)' },
                { key: 'bendingMomentBeam', name: 'Beam Moment', color: '#be123c', source: 'Bending Moment Beam (kN-m)' },
            ];

            let activeSeries = allSeries;
            if (selectedElement === 'beam') {
                activeSeries = allSeries.filter((item) => item.key === 'bendingMomentBeam');
            } else if (selectedElement === 'pier3a') {
                activeSeries = allSeries.filter(
                    (item) => item.key === 'momentPier3AMxx' || item.key === 'momentPier3AMyy'
                );
            } else if (selectedElement === 'pier3b') {
                activeSeries = allSeries.filter(
                    (item) => item.key === 'momentPier3BMxx' || item.key === 'momentPier3BMyy'
                );
            }

            const data = buildLineSeriesData(rows, activeSeries);

            return {
                fields: activeSeries.map((item) => item.key),
                unit: 'kN-m',
                chartType: 'line',
                data,
                selectedElement,
                availableElements,
                series: toSeriesMeta(activeSeries),
            };
        }

        default:
            return {
                fields: ['strain'],
                unit: 'microstrain',
                chartType: 'line',
                data: [],
                selectedElement,
                availableElements,
                series: [],
            };
    }
};

const STATUS_RANK = {
    SAFE: 0,
    WARNING: 1,
    CRITICAL: 2,
};

const getSeriesThreshold = (selectedType, seriesKey) => {
    if (selectedType === 'stress') return THRESHOLDS.stress;
    if (selectedType === 'deflection') return THRESHOLDS.deflection;

    if (selectedType === 'load') {
        if (seriesKey === 'x' || seriesKey === 'totalLoad' || String(seriesKey).toLowerCase().includes('load')) {
            return THRESHOLDS.load;
        }
    }

    return null;
};

const getAnalysisSeriesKeys = (result) => {
    if (!result) return [];

    if (result.chartType === 'scatter') {
        if (Array.isArray(result.series) && result.series.some((s) => s.key === 'y')) {
            return ['y'];
        }
        return Array.isArray(result.fields) ? result.fields.filter((k) => k !== 'x') : [];
    }

    return Array.isArray(result.fields) ? result.fields : [];
};

const computeTrend = (values) => {
    if (!Array.isArray(values) || values.length < 3) {
        return { direction: 'stable', slope: null };
    }

    const n = values.length;
    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumXX = 0;

    for (let i = 0; i < n; i += 1) {
        const x = i;
        const y = values[i];
        sumX += x;
        sumY += y;
        sumXY += x * y;
        sumXX += x * x;
    }

    const denominator = n * sumXX - sumX * sumX;
    if (!denominator) {
        return { direction: 'stable', slope: 0 };
    }

    const slope = (n * sumXY - sumX * sumY) / denominator;
    const minVal = Math.min(...values);
    const maxVal = Math.max(...values);
    const range = Math.abs(maxVal - minVal);
    const epsilon = Math.max(range * 0.005, 1e-6);

    if (Math.abs(slope) < epsilon) {
        return { direction: 'stable', slope: cleanNumber(slope, 8) };
    }

    return {
        direction: slope > 0 ? 'increasing' : 'decreasing',
        slope: cleanNumber(slope, 8),
    };
};

const evaluateThresholdBreaches = (values, threshold) => {
    if (!threshold) {
        return {
            warning: 0,
            critical: 0,
        };
    }

    let warning = 0;
    let critical = 0;

    for (const value of values) {
        const absValue = Math.abs(value);
        if (absValue >= threshold.critical) {
            critical += 1;
        } else if (absValue >= threshold.warning) {
            warning += 1;
        }
    }

    return { warning, critical };
};

const computeSeriesSeverity = ({ anomalyPercent, warningCount, criticalCount }) => {
    if (criticalCount > 0) return 'CRITICAL';
    if (warningCount > 0 || anomalyPercent >= 12) return 'WARNING';
    return 'SAFE';
};

const getSeriesName = (result, key) => {
    const seriesItem = Array.isArray(result?.series) ? result.series.find((item) => item.key === key) : null;
    return seriesItem?.name || key;
};

const buildRealtimeAnalysis = ({ result, selectedType, selectedChannel, selectedElement }) => {
    const seriesKeys = getAnalysisSeriesKeys(result);

    if (!Array.isArray(result?.data) || !result.data.length || !seriesKeys.length) {
        return {
            status: 'SAFE',
            score: 100,
            sampleCount: 0,
            anomalyCount: 0,
            anomalyPercent: 0,
            insights: ['No sufficient data points available for analysis.'],
            recommendation: 'Collect more data points for this selection to generate reliable insights.',
            summaryText: 'No actionable summary available for the selected filters.',
            seriesInsights: [],
            updatedAt: new Date().toISOString(),
        };
    }

    const seriesInsights = [];
    let globalStatus = 'SAFE';
    let totalAnomalyCount = 0;
    let totalWarningBreaches = 0;
    let totalCriticalBreaches = 0;

    for (const key of seriesKeys) {
        const values = result.data
            .map((point) => point?.[key])
            .filter((value) => typeof value === 'number' && Number.isFinite(value));

        if (!values.length) continue;

        const meanStd = getMeanAndStd(values);
        const min = cleanNumber(Math.min(...values), 6);
        const max = cleanNumber(Math.max(...values), 6);
        const trend = computeTrend(values);

        const zAnomalyCount = values.reduce((acc, value) => {
            if (!meanStd.std || meanStd.std === 0 || meanStd.mean === null) return acc;
            const z = Math.abs((value - meanStd.mean) / meanStd.std);
            return z >= THRESHOLDS.anomalyZScore ? acc + 1 : acc;
        }, 0);

        const threshold = getSeriesThreshold(selectedType, key);
        const breaches = evaluateThresholdBreaches(values, threshold);

        const anomalyCount = Math.max(zAnomalyCount, breaches.warning + breaches.critical);
        const anomalyPercent = values.length
            ? cleanNumber((anomalyCount / values.length) * 100, 2) || 0
            : 0;

        const status = computeSeriesSeverity({
            anomalyPercent,
            warningCount: breaches.warning,
            criticalCount: breaches.critical,
        });

        if (STATUS_RANK[status] > STATUS_RANK[globalStatus]) {
            globalStatus = status;
        }

        totalAnomalyCount += anomalyCount;
        totalWarningBreaches += breaches.warning;
        totalCriticalBreaches += breaches.critical;

        seriesInsights.push({
            key,
            name: getSeriesName(result, key),
            mean: meanStd.mean,
            std: meanStd.std,
            min,
            max,
            trend,
            anomalyCount,
            anomalyPercent,
            warningBreaches: breaches.warning,
            criticalBreaches: breaches.critical,
            status,
        });
    }

    if (!seriesInsights.length) {
        return {
            status: 'SAFE',
            score: 100,
            sampleCount: result.data.length,
            anomalyCount: 0,
            anomalyPercent: 0,
            insights: ['No numeric values available for analytical summary.'],
            recommendation: 'Change filter selection to a metric that has numeric readings.',
            summaryText: 'Current selection has insufficient numeric data for analysis.',
            seriesInsights: [],
            updatedAt: new Date().toISOString(),
        };
    }

    const sampleCount = result.data.length;
    const normalizedAnomalyPercent = cleanNumber(
        (totalAnomalyCount / (sampleCount * seriesInsights.length)) * 100,
        2
    ) || 0;

    const primarySeries = [...seriesInsights].sort((a, b) => Math.abs((b.max || 0)) - Math.abs((a.max || 0)))[0];
    const trendWord = primarySeries?.trend?.direction || 'stable';

    const insights = [
        `Selection summary for ${selectedType.toUpperCase()} on ${selectedChannel} (${selectedElement}).`,
        `${primarySeries.name} trend is ${trendWord} with mean ${primarySeries.mean ?? 'N/A'} ${result.unit || ''}.`,
        `Peak ${primarySeries.name} observed: ${primarySeries.max ?? 'N/A'} ${result.unit || ''}.`,
    ];

    if (totalCriticalBreaches > 0) {
        insights.push(`Critical threshold breaches detected: ${totalCriticalBreaches}.`);
    } else if (totalWarningBreaches > 0) {
        insights.push(`Warning threshold breaches detected: ${totalWarningBreaches}.`);
    } else {
        insights.push(`No threshold breach detected for current selection.`);
    }

    const scorePenalty =
        totalCriticalBreaches * 14 +
        totalWarningBreaches * 5 +
        normalizedAnomalyPercent * 1.5;
    const score = Math.max(0, Math.min(100, Math.round(100 - scorePenalty)));

    const recommendation =
        globalStatus === 'CRITICAL'
            ? 'Immediate engineering review is recommended for this selection.'
            : globalStatus === 'WARNING'
                ? 'Schedule preventive inspection and monitor the trend closely.'
                : 'Current behavior is stable. Continue routine monitoring.';

    return {
        status: globalStatus,
        score,
        sampleCount,
        anomalyCount: totalAnomalyCount,
        anomalyPercent: normalizedAnomalyPercent,
        warningBreaches: totalWarningBreaches,
        criticalBreaches: totalCriticalBreaches,
        primarySeries: {
            key: primarySeries.key,
            name: primarySeries.name,
            mean: primarySeries.mean,
            max: primarySeries.max,
            min: primarySeries.min,
            trend: primarySeries.trend,
        },
        insights,
        recommendation,
        summaryText: `${selectedType.toUpperCase()} analysis is ${globalStatus} with score ${score}/100.`,
        seriesInsights,
        updatedAt: new Date().toISOString(),
    };
};

const getMeanAndStd = (numbers) => {
    const valid = numbers.filter((n) => typeof n === 'number' && Number.isFinite(n));
    if (!valid.length) return { mean: null, std: null };

    const mean = valid.reduce((acc, n) => acc + n, 0) / valid.length;
    const variance = valid.reduce((acc, n) => acc + (n - mean) ** 2, 0) / valid.length;
    const std = Math.sqrt(variance);

    return {
        mean: cleanNumber(mean, 6),
        std: cleanNumber(std, 6),
    };
};

// GET /api/project/:id/summary
exports.getProjectSummary = async (req, res) => {
    try {
        const bundle = await getProjectDataBundle(req.params.id);

        if (!bundle) {
            return res.status(404).json({ success: false, message: 'No SHM data found for this project' });
        }

        const { rows, reportDoc, summaryStats } = bundle;
        const maxStats = summaryStats?.Max || {};
        const minStats = summaryStats?.Min || {};

        const firstTimestamp = rows.length ? parseTimestamp(rows[0]['Date/Time']) : null;
        const lastTimestamp = rows.length ? parseTimestamp(rows[rows.length - 1]['Date/Time']) : null;

        const maxStressBeam = getMaxAbs(maxStats, minStats, 'Stress Beam (MPa)');
        const maxDeflection = getMaxAbs(maxStats, minStats, 'Deflection Beam (mm)');
        const maxLoad = getMaxAbs(maxStats, minStats, 'Total Load (kN)');
        const temperatureRange = getRowsTemperatureRange(rows);

        const status = evaluateStatus({ maxStressBeam, maxDeflection, maxLoad });

        return res.status(200).json({
            success: true,
            summary: {
                projectId: req.params.id,
                projectName: req.project?.projectName || reportDoc?.project_name || 'Project',
                userName: reportDoc?.user_name || req.user?.name || 'User',
                reportType: reportDoc?.report_type || 'shm_report',
                totalDataPoints: rows.length || reportDoc?.summary?.rows || 0,
                timeRange: {
                    start: firstTimestamp,
                    end: lastTimestamp,
                },
                generatedAt: parseTimestamp(reportDoc?.generated_at || reportDoc?.created_at || reportDoc?.createdAt),
                kpis: {
                    maxStressBeam,
                    maxDeflection,
                    maxLoad,
                    temperatureRange,
                    status,
                },
            },
            thresholds: THRESHOLDS,
        });
    } catch (error) {
        console.error('Summary API error:', error);
        return res.status(500).json({ success: false, message: 'Server error fetching summary' });
    }
};

// GET /api/project/:id/timeseries
exports.getProjectTimeseries = async (req, res) => {
    try {
        const bundle = await getProjectDataBundle(req.params.id);
        if (!bundle) {
            return res.status(404).json({ success: false, message: 'No SHM data found for this project' });
        }

        const maxPoints = Math.min(Math.max(Number(req.query.maxPoints) || 800, 50), 5000);
        const sampledRows = downsampleRows(bundle.rows, maxPoints);

        const series = sampledRows.map((row) => {
            const stressBeam = cleanNumber(row['Stress Beam (MPa)']);
            const deflectionBeam = cleanNumber(row['Deflection Beam (mm)']);
            const totalLoad = cleanNumber(row['Total Load (kN)']);

            const stressAnomaly =
                stressBeam !== null && Math.abs(stressBeam) >= THRESHOLDS.stress.critical;
            const deflectionAnomaly =
                deflectionBeam !== null && Math.abs(deflectionBeam) >= THRESHOLDS.deflection.critical;
            const loadAnomaly =
                totalLoad !== null && Math.abs(totalLoad) >= THRESHOLDS.load.critical;

            return {
                timestamp: parseTimestamp(row['Date/Time']),
                stressBeam,
                stressPier3A: cleanNumber(row['Stress PIER3A (MPa)']),
                stressPier3B: cleanNumber(row['Stress PIER3B (MPa)']),
                deflectionBeam,
                totalLoad,
                axialLoadPier3A: cleanNumber(row['Axial Load PIER3A (kN)']),
                axialLoadPier3B: cleanNumber(row['Axial Load PIER3B (kN)']),
                momentPier3AMxx: cleanNumber(row['PIER3A Mxx (kN-m)']),
                momentPier3AMyy: cleanNumber(row['PIER3A Myy (kN-m)']),
                momentPier3BMxx: cleanNumber(row['PIER3B Mxx (kN-m)']),
                momentPier3BMyy: cleanNumber(row['PIER3B Myy (kN-m)']),
                bendingMomentBeam: cleanNumber(row['Bending Moment Beam (kN-m)']),
                anomaly: {
                    stress: stressAnomaly,
                    deflection: deflectionAnomaly,
                    load: loadAnomaly,
                    any: stressAnomaly || deflectionAnomaly || loadAnomaly,
                },
            };
        });

        return res.status(200).json({
            success: true,
            totalRawRows: bundle.rows.length,
            count: series.length,
            maxPoints,
            thresholds: THRESHOLDS,
            series,
        });
    } catch (error) {
        console.error('Timeseries API error:', error);
        return res.status(500).json({ success: false, message: 'Server error fetching timeseries' });
    }
};

// GET /api/project/:id/stats
exports.getProjectStats = async (req, res) => {
    try {
        const bundle = await getProjectDataBundle(req.params.id);
        if (!bundle) {
            return res.status(404).json({ success: false, message: 'No SHM data found for this project' });
        }

        const stats = bundle.summaryStats || {};

        const cleanStatsBucket = (bucket) => {
            const cleaned = {};
            for (const [key, value] of Object.entries(bucket || {})) {
                const num = cleanNumber(value, 6);
                if (num !== null) cleaned[key] = num;
            }
            return cleaned;
        };

        const cleanedStats = {
            Mean: cleanStatsBucket(stats.Mean),
            Max: cleanStatsBucket(stats.Max),
            Min: cleanStatsBucket(stats.Min),
            StdDev: cleanStatsBucket(stats['Std Dev']),
        };

        const meanBarData = [
            { name: 'Stress Beam', value: cleanedStats.Mean['Stress Beam (MPa)'] ?? null, unit: 'MPa' },
            { name: 'Stress PIER3A', value: cleanedStats.Mean['Stress PIER3A (MPa)'] ?? null, unit: 'MPa' },
            { name: 'Stress PIER3B', value: cleanedStats.Mean['Stress PIER3B (MPa)'] ?? null, unit: 'MPa' },
            { name: 'Deflection Beam', value: cleanedStats.Mean['Deflection Beam (mm)'] ?? null, unit: 'mm' },
            { name: 'Total Load', value: cleanedStats.Mean['Total Load (kN)'] ?? null, unit: 'kN' },
        ].filter((item) => item.value !== null);

        const channelCodes = getChannelCodes(bundle.rows);
        const strainBoxPlot = channelCodes
            .map((channel) => {
                const strainKey = `${channel} (me)`;
                const values = bundle.rows
                    .map((row) => cleanNumber(row[strainKey], 6))
                    .filter((v) => v !== null)
                    .sort((a, b) => a - b);

                if (!values.length) return null;

                return {
                    channel,
                    min: cleanNumber(values[0], 6),
                    q1: cleanNumber(quantile(values, 0.25), 6),
                    median: cleanNumber(quantile(values, 0.5), 6),
                    q3: cleanNumber(quantile(values, 0.75), 6),
                    max: cleanNumber(values[values.length - 1], 6),
                };
            })
            .filter(Boolean);

        return res.status(200).json({
            success: true,
            stats: cleanedStats,
            meanBarData,
            strainBoxPlot,
        });
    } catch (error) {
        console.error('Stats API error:', error);
        return res.status(500).json({ success: false, message: 'Server error fetching stats' });
    }
};

// GET /api/project/:id/channels
exports.getProjectChannels = async (req, res) => {
    try {
        const bundle = await getProjectDataBundle(req.params.id);
        if (!bundle) {
            return res.status(404).json({ success: false, message: 'No SHM data found for this project' });
        }

        const maxPoints = Math.min(Math.max(Number(req.query.maxPoints) || 800, 50), 5000);
        const channelCodes = getChannelCodes(bundle.rows);

        if (!channelCodes.length) {
            return res.status(200).json({
                success: true,
                channels: [],
                selectedChannel: null,
                count: 0,
                channelData: [],
            });
        }

        const requested = String(req.query.channel || '').toUpperCase();
        const selectedChannel = channelCodes.includes(requested) ? requested : channelCodes[0];

        const strainKey = `${selectedChannel} (me)`;
        const temperatureKey = `${selectedChannel} Temp`;

        const sampledRows = downsampleRows(bundle.rows, maxPoints);

        const plainData = sampledRows.map((row) => ({
            timestamp: parseTimestamp(row['Date/Time']),
            strain: cleanNumber(row[strainKey], 6),
            temperature: cleanNumber(row[temperatureKey], 6),
        }));

        const strainStats = getMeanAndStd(plainData.map((p) => p.strain));
        const temperatureStats = getMeanAndStd(plainData.map((p) => p.temperature));

        const channelData = plainData.map((point) => {
            const strainZ =
                strainStats.std && point.strain !== null
                    ? Math.abs((point.strain - strainStats.mean) / strainStats.std)
                    : null;
            const tempZ =
                temperatureStats.std && point.temperature !== null
                    ? Math.abs((point.temperature - temperatureStats.mean) / temperatureStats.std)
                    : null;

            return {
                ...point,
                anomaly: {
                    strain: strainZ !== null && strainZ >= THRESHOLDS.anomalyZScore,
                    temperature: tempZ !== null && tempZ >= THRESHOLDS.anomalyZScore,
                    any:
                        (strainZ !== null && strainZ >= THRESHOLDS.anomalyZScore) ||
                        (tempZ !== null && tempZ >= THRESHOLDS.anomalyZScore),
                },
            };
        });

        return res.status(200).json({
            success: true,
            channels: channelCodes,
            selectedChannel,
            count: channelData.length,
            units: {
                strain: 'microstrain',
                temperature: 'C',
            },
            thresholds: {
                strain: {
                    mean: strainStats.mean,
                    std: strainStats.std,
                    upper: strainStats.mean !== null && strainStats.std !== null
                        ? cleanNumber(strainStats.mean + THRESHOLDS.anomalyZScore * strainStats.std, 6)
                        : null,
                    lower: strainStats.mean !== null && strainStats.std !== null
                        ? cleanNumber(strainStats.mean - THRESHOLDS.anomalyZScore * strainStats.std, 6)
                        : null,
                },
                temperature: {
                    mean: temperatureStats.mean,
                    std: temperatureStats.std,
                    upper: temperatureStats.mean !== null && temperatureStats.std !== null
                        ? cleanNumber(temperatureStats.mean + THRESHOLDS.anomalyZScore * temperatureStats.std, 6)
                        : null,
                    lower: temperatureStats.mean !== null && temperatureStats.std !== null
                        ? cleanNumber(temperatureStats.mean - THRESHOLDS.anomalyZScore * temperatureStats.std, 6)
                        : null,
                },
            },
            channelData,
        });
    } catch (error) {
        console.error('Channels API error:', error);
        return res.status(500).json({ success: false, message: 'Server error fetching channel data' });
    }
};

// GET /api/project/:id/data?reportId=<id>&channel=CH01&type=strain&graphType=line
exports.getProjectData = async (req, res) => {
    try {
        const projectId = req.params.id;
        const requestedReportId = String(req.query.reportId || '');
        const bundle = await getProjectDataBundle(projectId, requestedReportId);

        if (!bundle) {
            return res.status(404).json({ success: false, message: 'No SHM data found for this project' });
        }

        const selectedType = normalizeDataType(req.query.type);
        const graphType = normalizeGraphType(req.query.graphType);
        const requestedElement = req.query.element;

        const channels = getChannelCodes(bundle.rows);
        const requestedChannel = String(req.query.channel || '').toUpperCase();
        const selectedChannel = channels.includes(requestedChannel)
            ? requestedChannel
            : channels[0] || 'CH01';

        const startDate = parseDateSafe(req.query.start);
        const endDate = parseDateSafe(req.query.end);
        const rangedRows = filterRowsByRange(bundle.rows, startDate, endDate);

        const maxPoints = Math.min(Math.max(Number(req.query.maxPoints) || 900, 50), 5000);
        const sampledRows = downsampleRows(rangedRows, maxPoints);

        const reportMeta = normalizeReportSummary(bundle.reportDoc);

        const result = buildFilteredSeries({
            rows: sampledRows,
            selectedChannel,
            selectedType,
            graphType,
            requestedElement,
        });
        const analysis = buildRealtimeAnalysis({
            result,
            selectedType,
            selectedChannel,
            selectedElement: result.selectedElement,
        });

        return res.status(200).json({
            success: true,
            report: reportMeta,
            selectedChannel,
            selectedType,
            selectedElement: result.selectedElement,
            availableElements: result.availableElements,
            graphType: result.chartType,
            fields: result.fields,
            series: result.series,
            unit: result.unit,
            channels,
            count: result.data.length,
            maxPoints,
            range: {
                start: startDate ? startDate.toISOString() : null,
                end: endDate ? endDate.toISOString() : null,
            },
            analysis,
            data: result.data,
        });
    } catch (error) {
        console.error('Project filtered data API error:', error);
        return res.status(500).json({ success: false, message: 'Server error fetching filtered data' });
    }
};
