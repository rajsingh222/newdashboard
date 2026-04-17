const path = require('path');
const fs = require('fs');
const multer = require('multer');
const mongoose = require('mongoose');
const Report = require('../models/Report');
const {
    isCloudinaryReady,
    uploadLocalFileToCloudinary,
    cleanupLocalFile,
} = require('../utils/cloudinaryStorage');

const buildProjectFilter = (projectId) => {
    const filter = [
        { projectId },
        { project_id: projectId },
    ];

    if (mongoose.Types.ObjectId.isValid(projectId)) {
        filter.push({ projectId: new mongoose.Types.ObjectId(projectId) });
        filter.push({ project_id: new mongoose.Types.ObjectId(projectId) });
    }

    return { $or: filter };
};

const buildUserScopedFilter = (user) => {
    const clauses = [];

    const userId = user?._id ? String(user._id) : '';
    const userName = typeof user?.name === 'string' ? user.name.trim() : '';

    if (userId) {
        clauses.push({ uploadedBy: userId });
        clauses.push({ uploaded_by: userId });
        clauses.push({ user_id: userId });

        if (mongoose.Types.ObjectId.isValid(userId)) {
            const objectId = new mongoose.Types.ObjectId(userId);
            clauses.push({ uploadedBy: objectId });
            clauses.push({ uploaded_by: objectId });
            clauses.push({ user_id: objectId });
        }
    }

    if (userName) {
        clauses.push({ user_name: userName });
    }

    return clauses.length ? { $or: clauses } : null;
};

const normalizeReportListItem = (doc) => {
    const createdAt = doc.createdAt || doc.created_at || doc.generated_at || new Date();
    const title = doc.title || doc.report_type || doc.fileName || doc.file_name || 'Untitled Report';
    const fileName = doc.fileName || doc.file_name || doc.report_file_name || doc.report_file_path || 'report';
    const uploadedByName =
        doc?.uploadedBy?.name ||
        doc?.uploaded_by?.name ||
        doc?.uploadedByName ||
        doc?.user_name ||
        'Unknown';

    return {
        _id: doc._id,
        title,
        reportType: doc.report_type || doc.type || title,
        status: doc.status || doc.processing_status || 'READY',
        fileName,
        createdAt,
        filePath: doc.filePath || doc.file_path || doc.report_file_path || '',
        fileSize: doc.fileSize || doc.file_size || 0,
        uploadedBy: { name: uploadedByName },
    };
};

const normalizeAnalysis = (doc) => {
    if (doc.analysis && (doc.analysis.summary || doc.analysis.metrics || doc.analysis.charts)) {
        return {
            summary: doc.analysis.summary || '',
            metrics: doc.analysis.metrics || [],
            charts: doc.analysis.charts || [],
            channelSeries: doc.analysis.channelSeries || [],
            xCategories: doc.analysis.xCategories || ['Mean', 'Max', 'Min', 'Std Dev'],
        };
    }

    const summaryObj = doc.summary || {};
    const rows = summaryObj.rows;
    const channels = Array.isArray(summaryObj.channels) ? summaryObj.channels.length : 0;
    const reportType = doc.report_type || 'Report';
    const workspace = doc.workspace || 'N/A';

    const summary = [
        `Type: ${reportType}`,
        `Workspace: ${workspace}`,
        rows !== undefined ? `Rows analyzed: ${rows}` : null,
        channels ? `Channels: ${channels}` : null,
    ].filter(Boolean).join(' | ');

    const statsObj = summaryObj?.stats || {};

    const toChartPoints = (bucketObj) => {
        return Object.entries(bucketObj || {})
            .filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
            .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
            .slice(0, 14)
            .map(([label, value]) => ({ label, value }));
    };

    const statsOrder = ['Mean', 'Max', 'Min', 'Std Dev'];
    const charts = [
        { key: 'Mean', title: 'Mean Values' },
        { key: 'Max', title: 'Max Values' },
        { key: 'Min', title: 'Min Values' },
        { key: 'Std Dev', title: 'Standard Deviation' },
    ]
        .map(({ key, title }) => {
            const points = toChartPoints(statsObj[key]);
            if (points.length === 0) return null;
            return {
                title,
                description: `Top channels by ${key.toLowerCase()} magnitude`,
                points,
            };
        })
        .filter(Boolean);

    const seriesMap = {};
    for (const statName of statsOrder) {
        const bucket = statsObj[statName] || {};
        for (const [channel, value] of Object.entries(bucket)) {
            if (typeof value !== 'number' || !Number.isFinite(value)) continue;
            if (!seriesMap[channel]) seriesMap[channel] = {};
            seriesMap[channel][statName] = value;
        }
    }

    const channelSeries = Object.entries(seriesMap)
        .map(([channel, values]) => {
            const points = statsOrder
                .filter((name) => values[name] !== undefined)
                .map((name) => ({ x: name, y: values[name] }));
            const magnitude = points.reduce((max, p) => Math.max(max, Math.abs(p.y)), 0);
            return {
                channel,
                points,
                values,
                magnitude,
            };
        })
        .filter((series) => series.points.length > 0)
        .sort((a, b) => b.magnitude - a.magnitude)
        .slice(0, 50);

    const xCategories = statsOrder.filter((statName) =>
        channelSeries.some((series) => series.values[statName] !== undefined)
    );

    return {
        summary,
        metrics: [],
        charts,
        channelSeries,
        xCategories,
    };
};

// Multer config — stores in /uploads/{projectId}/
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const projectId = req.params.projectId;
        const uploadDir = path.join(__dirname, '..', 'uploads', projectId);
        fs.mkdirSync(uploadDir, { recursive: true });
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        const ext = path.extname(file.originalname);
        cb(null, `${uniqueSuffix}${ext}`);
    },
});

const fileFilter = (req, file, cb) => {
    const allowed = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.csv', '.png', '.jpg', '.jpeg', '.zip'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
        cb(null, true);
    } else {
        cb(new Error('File type not allowed'), false);
    }
};

const upload = multer({
    storage,
    fileFilter,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

exports.uploadMiddleware = upload.single('file');

// @desc    Upload report for a project
// @route   POST /api/projects/:projectId/reports
// @access  Private (admin, superadmin) + verifyProjectAccess
exports.uploadReport = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No file uploaded' });
        }

        const { title, description } = req.body;

        if (!title) {
            return res.status(400).json({ success: false, message: 'Report title is required' });
        }

        const resourceType = (req.file.mimetype || '').startsWith('image/') ? 'image' : 'raw';
        const storedFilePath = isCloudinaryReady()
            ? (await uploadLocalFileToCloudinary(req.file.path, {
                subfolder: `projects/${req.params.projectId}/reports`,
                resourceType,
            })).secure_url
            : `/uploads/${req.params.projectId}/${req.file.filename}`;

        if (isCloudinaryReady()) {
            cleanupLocalFile(req.file.path);
        }

        const report = await Report.create({
            title,
            description: description || '',
            projectId: req.params.projectId,
            uploadedBy: req.user.id,
            filePath: storedFilePath,
            fileName: req.file.originalname,
            fileSize: req.file.size,
        });

        const populated = await Report.findById(report._id)
            .populate('uploadedBy', 'name email')
            .populate('projectId', 'projectName projectCode');

        res.status(201).json({ success: true, report: populated });
    } catch (error) {
        console.error('Upload report error:', error);
        res.status(500).json({ success: false, message: 'Server error uploading report' });
    }
};

// @desc    Get reports for a project
// @route   GET /api/projects/:projectId/reports
// @access  Private + verifyProjectAccess
exports.getReports = async (req, res) => {
    try {
        const scope = String(req.query.scope || 'all').toLowerCase();
        let filter = buildProjectFilter(req.params.projectId);

        if (scope === 'user') {
            const userFilter = buildUserScopedFilter(req.user);
            if (userFilter) {
                filter = {
                    $and: [
                        buildProjectFilter(req.params.projectId),
                        userFilter,
                    ],
                };
            }
        }

        const rawReports = await mongoose.connection.db
            .collection('reports')
            .find(filter)
            .sort({ createdAt: -1, created_at: -1, generated_at: -1 })
            .toArray();

        const reports = rawReports.map(normalizeReportListItem);

        res.status(200).json({ success: true, count: reports.length, reports });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error fetching reports' });
    }
};

// @desc    Get analysis JSON for a specific report
// @route   GET /api/projects/:projectId/reports/:reportId/analysis
// @access  Private + verifyProjectAccess
exports.getReportAnalysis = async (req, res) => {
    try {
        const report = await mongoose.connection.db
            .collection('reports')
            .findOne({
                _id: new mongoose.Types.ObjectId(req.params.reportId),
                ...buildProjectFilter(req.params.projectId),
            });

        if (!report) {
            return res.status(404).json({ success: false, message: 'Report not found' });
        }

        const normalized = normalizeReportListItem(report);
        const analysis = normalizeAnalysis(report);

        res.status(200).json({
            success: true,
            report: {
                _id: normalized._id,
                title: normalized.title,
                fileName: normalized.fileName,
                filePath: normalized.filePath,
                createdAt: normalized.createdAt,
            },
            analysis,
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error fetching report analysis' });
    }
};
