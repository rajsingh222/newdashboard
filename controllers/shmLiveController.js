const fs = require('fs');
const path = require('path');
const multer = require('multer');
const readline = require('readline');
const { spawn } = require('child_process');
const ftp = require('basic-ftp');
const SHMLiveSource = require('../models/SHMLiveSource');
const Project = require('../models/Project');
const { parseMseedFile, parseMseedTraces } = require('../services/mseedParser');
const logger = require('../utils/logger');

const LIVE_BASE_DIR = path.join(__dirname, '..', 'uploads', 'shm-live');
const STREAM_SCRIPT = path.join(__dirname, '..', 'scripts', 'mseed_streamer.py');
const WORKSPACE_ROOT = path.join(__dirname, '..', '..');
const FTP_TIMEOUT_MS = Number(process.env.SHM_FTP_TIMEOUT_MS || 20000);
const FTP_DEFAULT_PORT = 21;

const resolvePythonExecutable = () => {
    const fromEnv = (process.env.PYTHON_EXECUTABLE || '').trim();
    if (fromEnv) return fromEnv;

    const candidates = [
        path.join(WORKSPACE_ROOT, '.venv', 'Scripts', 'python.exe'),
        path.join(__dirname, '..', '.venv', 'Scripts', 'python.exe'),
        path.join(WORKSPACE_ROOT, '.venv', 'bin', 'python3'),
        path.join(WORKSPACE_ROOT, '.venv', 'bin', 'python'),
        path.join(__dirname, '..', '.venv', 'bin', 'python3'),
        path.join(__dirname, '..', '.venv', 'bin', 'python'),
    ];

    const found = candidates.find((candidate) => fs.existsSync(candidate));
    if (found) return found;

    return process.platform === 'win32' ? 'python' : 'python3';
};

const normalizeType = (rawType = '') => {
    const t = String(rawType).trim().toLowerCase();
    if (t === 'static' || t === 'static-monitoring' || t === 'staticmonitoring') return 'static';
    if (t === 'dynamic' || t === 'dynamic-monitoring' || t === 'dynamicmonitoring') return 'dynamic';
    return null;
};

const ensureDir = (dirPath) => {
    fs.mkdirSync(dirPath, { recursive: true });
};

const isMiniSeed = (name = '') => /\.(mseed|miniseed)$/i.test(name);

const getProjectTypeDir = (projectId, type) => path.join(LIVE_BASE_DIR, projectId, type);
const getSourceDir = (projectId, type, sourceId) => path.join(getProjectTypeDir(projectId, type), String(sourceId));

const sanitizeFileName = (name = '') => String(name).replace(/[^a-zA-Z0-9._-]/g, '_');

const normalizeRemotePath = (rawPath = '/') => {
    const cleaned = String(rawPath || '/').trim().replace(/\\/g, '/');
    if (!cleaned) return '/';
    return cleaned.startsWith('/') ? cleaned : `/${cleaned}`;
};

const normalizeSourceConfig = (payload = {}) => {
    const next = {
        sourceName: (payload.sourceName || 'Primary Source').toString().trim() || 'Primary Source',
        ftpHost: (payload.ftpHost || '').toString().trim(),
        ftpPort: Number(payload.ftpPort || FTP_DEFAULT_PORT),
        ftpUser: (payload.ftpUser || '').toString().trim(),
        ftpPassword: (payload.ftpPassword || '').toString(),
        ftpPath: normalizeRemotePath(payload.ftpPath || '/'),
        isActive: Boolean(payload.isActive),
    };

    if (!Number.isFinite(next.ftpPort) || next.ftpPort < 1 || next.ftpPort > 65535) {
        next.ftpPort = FTP_DEFAULT_PORT;
    }

    return next;
};

const toProjectFtpPayload = (sourceDoc) => ({
    host: (sourceDoc?.ftpHost || '').toString().trim(),
    port: Number(sourceDoc?.ftpPort || FTP_DEFAULT_PORT),
    user: (sourceDoc?.ftpUser || '').toString().trim(),
    password: (sourceDoc?.ftpPassword || '').toString(),
    path: normalizeRemotePath(sourceDoc?.ftpPath || '/'),
});

const syncProjectRealtimeFromDynamicSource = async (sourceDoc) => {
    if (!sourceDoc || sourceDoc.type !== 'dynamic') return;

    await Project.findByIdAndUpdate(
        sourceDoc.project,
        {
            $set: {
                ftp: toProjectFtpPayload(sourceDoc),
                type: 'mseed',
                isActive: Boolean(sourceDoc.isActive),
            },
        },
        { runValidators: true }
    );
};

const buildDynamicSourceFromProject = async (projectId) => {
    const project = await Project.findById(projectId);
    if (!project) return null;

    const ftpConfig = project.ftp || {};
    const source = await SHMLiveSource.findOneAndUpdate(
        { project: projectId, type: 'dynamic' },
        {
            $setOnInsert: {
                sourceName: 'Primary Source',
            },
            $set: {
                ftpHost: (ftpConfig.host || '').toString().trim(),
                ftpPort: Number(ftpConfig.port || FTP_DEFAULT_PORT),
                ftpUser: (ftpConfig.user || '').toString().trim(),
                ftpPassword: (ftpConfig.password || '').toString(),
                ftpPath: normalizeRemotePath(ftpConfig.path || '/'),
                isActive: Boolean(project.isActive) && String(project.type || 'mseed') === 'mseed',
            },
        },
        { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    );

    return source;
};

const sanitizeSourceForResponse = (sourceDoc, includeSecrets = false) => {
    if (!sourceDoc) {
        return {
            _id: null,
            sourceName: 'Primary Source',
            ftpHost: '',
            ftpPort: FTP_DEFAULT_PORT,
            ftpUser: '',
            ftpPassword: '',
            ftpPath: '/',
            isActive: false,
            lastSyncedAt: null,
            lastRemoteFile: '',
            lastLocalFile: '',
            lastSyncError: '',
        };
    }

    return {
        _id: sourceDoc._id,
        sourceName: sourceDoc.sourceName || 'Primary Source',
        ftpHost: sourceDoc.ftpHost || '',
        ftpPort: sourceDoc.ftpPort || FTP_DEFAULT_PORT,
        ftpUser: sourceDoc.ftpUser || '',
        ftpPassword: includeSecrets ? (sourceDoc.ftpPassword || '') : (sourceDoc.ftpPassword ? '********' : ''),
        ftpPath: normalizeRemotePath(sourceDoc.ftpPath || '/'),
        isActive: Boolean(sourceDoc.isActive),
        lastSyncedAt: sourceDoc.lastSyncedAt || null,
        lastRemoteFile: sourceDoc.lastRemoteFile || '',
        lastLocalFile: sourceDoc.lastLocalFile || '',
        lastSyncError: sourceDoc.lastSyncError || '',
    };
};

const listMiniSeedFromDir = (dir) => {
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir)
        .filter(isMiniSeed)
        .map((name) => {
            const fullPath = path.join(dir, name);
            const stat = fs.statSync(fullPath);
            return {
                name,
                fullPath,
                size: stat.size,
                modifiedAt: stat.mtime,
                sourceDir: dir,
            };
        });
};

const getCandidateFiles = (projectId, type, sourceDoc = null) => {
    const projectTypeDir = getProjectTypeDir(projectId, type);
    ensureDir(projectTypeDir);

    const projectUploads = listMiniSeedFromDir(projectTypeDir);
    const sourceUploads = sourceDoc?._id
        ? listMiniSeedFromDir(getSourceDir(projectId, type, sourceDoc._id))
        : [];

    return [...sourceUploads, ...projectUploads].sort(
        (a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt)
    );
};

const resolveRemoteEntryTime = (entry) => {
    if (entry?.modifiedAt instanceof Date && !Number.isNaN(entry.modifiedAt.getTime())) {
        return entry.modifiedAt.getTime();
    }

    const fromRaw = Date.parse(String(entry?.rawModifiedAt || ''));
    if (!Number.isNaN(fromRaw)) return fromRaw;

    return 0;
};

const joinRemotePath = (folder, file) => {
    const normalizedFolder = normalizeRemotePath(folder || '/');
    if (normalizedFolder === '/') return `/${file}`;
    return `${normalizedFolder.replace(/\/+$/, '')}/${file}`;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const toEpochMs = (value) => {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value.getTime();
    if (typeof value === 'number' && Number.isFinite(value)) {
        if (value > 100000000000) return value;
        if (value > 1000000000) return value * 1000;
    }
    const parsed = Date.parse(String(value || ''));
    return Number.isNaN(parsed) ? 0 : parsed;
};

const inferSampleRate = (parsed = {}) => {
    const direct = Number(parsed.sampleRate || 0);
    if (direct > 0) return direct;

    const ts = Array.isArray(parsed.timestamps) ? parsed.timestamps : [];
    if (ts.length >= 2) {
        const firstMs = toEpochMs(ts[0]);
        const lastMs = toEpochMs(ts[ts.length - 1]);
        const spanSec = (lastMs - firstMs) / 1000;
        if (spanSec > 0) {
            const inferred = (ts.length - 1) / spanSec;
            if (Number.isFinite(inferred) && inferred > 0) return inferred;
        }
    }

    return 100;
};

const buildJsSensorTraces = (traces = []) => {
    const sorted = [...traces].sort((a, b) => String(a.channel || a.traceId).localeCompare(String(b.channel || b.traceId)));
    if (!sorted.length) return [];

    const sensors = [];
    for (let i = 0; i < sorted.length; i += 3) {
        const tx = sorted[i] || null;
        const ty = sorted[i + 1] || null;
        const tz = sorted[i + 2] || null;
        if (!tx) continue;

        const maxLen = Math.max(tx?.signal?.length || 0, ty?.signal?.length || 0, tz?.signal?.length || 0);
        const sampleRate = Number(tx?.sampleRate || ty?.sampleRate || tz?.sampleRate || 100);
        const stepMs = sampleRate > 0 ? (1000 / sampleRate) : 10;
        const fallbackStart =
            toEpochMs(tx?.timestamp)
            || toEpochMs(ty?.timestamp)
            || toEpochMs(tz?.timestamp)
            || Date.now();

        const X = [];
        const Y = [];
        const Z = [];
        const timestamps = [];

        for (let idx = 0; idx < maxLen; idx += 1) {
            const xVal = Number(tx?.signal?.[idx]);
            const yVal = Number(ty?.signal?.[idx]);
            const zVal = Number(tz?.signal?.[idx]);

            X.push(Number.isFinite(xVal) ? xVal : 0);
            Y.push(Number.isFinite(yVal) ? yVal : 0);
            Z.push(Number.isFinite(zVal) ? zVal : 0);

            const ts =
                toEpochMs(tx?.timestamps?.[idx])
                || toEpochMs(ty?.timestamps?.[idx])
                || toEpochMs(tz?.timestamps?.[idx])
                || (fallbackStart + Math.round(idx * stepMs));
            timestamps.push(ts / 1000);
        }

        const base = String(tx?.baseId || tx?.traceId || `Sensor_${sensors.length + 1}`);
        sensors.push({
            name: `${base}-${Math.floor(i / 3) + 1}`,
            sampleRate: sampleRate > 0 ? sampleRate : 100,
            X,
            Y,
            Z,
            timestamps,
            channelX: tx?.channel || 'X',
            channelY: ty?.channel || 'Y',
            channelZ: tz?.channel || 'Z',
        });
    }

    return sensors;
};

const streamLiveWithJsParser = async ({
    streamId,
    filePath,
    selectedFile,
    projectId,
    type,
    source,
    chunkDuration,
    downsample,
    speed,
    sendSSE,
    isClientClosed,
}) => {
    logger.info('SHM live JS parser start', {
        streamId,
        projectId,
        type,
        file: selectedFile,
        chunkDuration,
        downsample,
        speed,
    });

    let traces = await parseMseedTraces(filePath);
    if (!Array.isArray(traces) || !traces.length) {
        const parsed = await parseMseedFile(filePath);
        const signal = Array.isArray(parsed?.signal) ? parsed.signal : [];
        const timestamps = Array.isArray(parsed?.timestamps) ? parsed.timestamps : [];

        if (signal.length) {
            traces = [{
                traceId: 'Sensor_1.X',
                channel: 'X',
                baseId: 'Sensor_1',
                sampleRate: Number(parsed?.sampleRate || 100),
                timestamp: parsed?.timestamp || new Date(),
                signal,
                timestamps,
            }];
        }
    }

    const sensors = buildJsSensorTraces(traces || []);
    if (!sensors.length) {
        sendSSE({ type: 'error', data: { message: 'JS parser found no usable sensor traces in MiniSEED file' } });
        sendSSE({ type: 'stream_end', data: { code: 1, parser: 'js' } });
        return;
    }

    const samplingRate = Number(sensors[0]?.sampleRate || 100);
    const firstTs = sensors[0]?.timestamps?.[0] || (Date.now() / 1000);
    const lastTs = sensors[0]?.timestamps?.[(sensors[0]?.timestamps?.length || 1) - 1] || firstTs;
    const startMs = Math.round(Number(firstTs) * 1000);
    const endMs = Math.round(Number(lastTs) * 1000);

    const safeChunkDuration = Math.max(0.05, Number(chunkDuration || 0.25));
    const safeDownsample = Math.max(1, Number.parseInt(downsample, 10) || 1);
    const safeSpeed = Math.max(0.01, Number(speed || 1));
    const chunkSamples = Math.max(1, Math.floor(samplingRate * safeChunkDuration));
    const totalSamples = Math.max(...sensors.map((s) => s.timestamps.length));
    const totalChunks = Math.ceil(totalSamples / chunkSamples);

    logger.info('SHM live JS parser metadata', {
        streamId,
        projectId,
        type,
        file: selectedFile,
        samplingRate,
        samples: totalSamples,
        sensors: sensors.length,
        totalChunks,
    });

    sendSSE({
        type: 'metadata',
        data: {
            filename: selectedFile,
            sampling_rate: samplingRate,
            npts: totalSamples,
            duration_sec: Number((totalSamples / Math.max(1, samplingRate)).toFixed(3)),
            start_time: new Date(startMs).toISOString(),
            end_time: new Date(endMs).toISOString(),
            num_sensors: sensors.length,
            sensor_names: sensors.map((s) => s.name),
        },
    });

    const runStartMs = Date.now();
    let chunkIndex = 0;

    for (let startIdx = 0; startIdx < totalSamples; startIdx += chunkSamples) {
        if (isClientClosed()) return;

        const endIdx = Math.min(startIdx + chunkSamples, totalSamples);

        const payloadSensors = {};
        for (const sensor of sensors) {
            payloadSensors[sensor.name] = {
                X: [],
                Y: [],
                Z: [],
                timestamps: [],
                channelX: sensor.channelX || 'X',
                channelY: sensor.channelY || 'Y',
                channelZ: sensor.channelZ || 'Z',
            };

            for (let i = startIdx; i < endIdx; i += safeDownsample) {
                const xVal = Number(sensor.X[i]);
                const yVal = Number(sensor.Y[i]);
                const zVal = Number(sensor.Z[i]);
                const tsVal = Number(sensor.timestamps[i]);

                payloadSensors[sensor.name].X.push(Number.isFinite(xVal) ? xVal : 0);
                payloadSensors[sensor.name].Y.push(Number.isFinite(yVal) ? yVal : 0);
                payloadSensors[sensor.name].Z.push(Number.isFinite(zVal) ? zVal : 0);

                const pointTs = Number.isFinite(tsVal)
                    ? tsVal
                    : ((startMs + Math.round((i * 1000) / Math.max(1, samplingRate))) / 1000);
                payloadSensors[sensor.name].timestamps.push(pointTs);
            }
        }

        const chunkStartMs = startMs + Math.round((startIdx * 1000) / Math.max(1, samplingRate));
        const chunkEndMs = startMs + Math.round((endIdx * 1000) / Math.max(1, samplingRate));
        const lastSampleMs = startMs + Math.round((Math.max(startIdx, endIdx - 1) * 1000) / Math.max(1, samplingRate));

        sendSSE({
            type: 'data_chunk',
            data: {
                chunk_index: chunkIndex,
                total_chunks: totalChunks,
                start_sample: startIdx,
                end_sample: endIdx,
                total_samples: totalSamples,
                progress: Number((endIdx / totalSamples).toFixed(6)),
                elapsed_sec: Number((endIdx / Math.max(1, samplingRate)).toFixed(6)),
                chunk_start_time: new Date(chunkStartMs).toISOString(),
                chunk_end_time: new Date(chunkEndMs).toISOString(),
                last_sample_time: new Date(lastSampleMs).toISOString(),
                sensors: payloadSensors,
            },
        });

        chunkIndex += 1;

        if (chunkIndex % 25 === 0) {
            logger.debug('SHM live JS parser chunk progress', {
                streamId,
                projectId,
                type,
                chunkIndex,
                totalChunks,
            });
        }

        const expectedMs = ((endIdx / Math.max(1, samplingRate)) * 1000) / safeSpeed;
        const actualMs = Date.now() - runStartMs;
        const waitMs = expectedMs - actualMs;
        if (waitMs > 0) await sleep(waitMs);
    }

    if (!isClientClosed()) {
        logger.info('SHM live JS parser finished', {
            streamId,
            projectId,
            type,
            file: selectedFile,
            totalChunks,
        });
        sendSSE({
            type: 'stream_end',
            data: {
                code: 0,
                parser: 'js',
                projectId,
                type,
                sourceName: source?.sourceName || 'Local Upload',
            },
        });
    }
};

const syncLatestFromFtp = async (projectId, type, sourceDoc) => {
    if (!sourceDoc || !sourceDoc.isActive) return;
    if (!sourceDoc.ftpHost || !sourceDoc.ftpUser || !sourceDoc.ftpPassword) return;

    logger.info('SHM live FTP sync start', {
        projectId,
        type,
        sourceId: sourceDoc?._id ? String(sourceDoc._id) : null,
        ftpHost: sourceDoc.ftpHost,
        ftpPath: sourceDoc.ftpPath,
    });

    const client = new ftp.Client(FTP_TIMEOUT_MS);
    client.ftp.verbose = false;

    try {
        await client.access({
            host: sourceDoc.ftpHost,
            port: sourceDoc.ftpPort || FTP_DEFAULT_PORT,
            user: sourceDoc.ftpUser,
            password: sourceDoc.ftpPassword,
            secure: false,
        });

        const remoteFolder = normalizeRemotePath(sourceDoc.ftpPath || '/');
        const remoteEntries = await client.list(remoteFolder);
        const mseedEntries = remoteEntries
            .filter((entry) => entry && entry.type === 1 && isMiniSeed(entry.name))
            .sort((a, b) => resolveRemoteEntryTime(b) - resolveRemoteEntryTime(a));

        logger.info('SHM live FTP sync listed files', {
            projectId,
            type,
            sourceId: String(sourceDoc._id),
            mseedCount: mseedEntries.length,
        });

        if (!mseedEntries.length) {
            sourceDoc.lastSyncError = 'No .mseed file found on configured FTP path';
            sourceDoc.lastSyncedAt = new Date();
            await sourceDoc.save();
            return;
        }

        const latest = mseedEntries[0];
        const latestRemoteTs = resolveRemoteEntryTime(latest);
        const latestRemoteModifiedAt = latestRemoteTs ? new Date(latestRemoteTs) : null;
        const latestRemoteSize = Number(latest?.size || 0);
        const previousRemoteTs = resolveRemoteEntryTime({ modifiedAt: sourceDoc.lastRemoteModifiedAt });
        const remoteNotUpdated = latestRemoteTs ? latestRemoteTs <= previousRemoteTs : false;
        const sameRemoteSize = Number(sourceDoc.lastRemoteSize || 0) === latestRemoteSize;
        const sourceId = String(sourceDoc._id);
        const sourceDir = getSourceDir(projectId, type, sourceId);
        ensureDir(sourceDir);

        if (
            sourceDoc.lastRemoteFile === latest.name
            && sourceDoc.lastLocalFile
            && fs.existsSync(path.join(sourceDir, sourceDoc.lastLocalFile))
            && (remoteNotUpdated || (!latestRemoteTs && sameRemoteSize))
        ) {
            if (latestRemoteModifiedAt) {
                const existingLocalPath = path.join(sourceDir, sourceDoc.lastLocalFile);
                fs.utimesSync(existingLocalPath, latestRemoteModifiedAt, latestRemoteModifiedAt);
            }
            sourceDoc.lastSyncedAt = new Date();
            sourceDoc.lastSyncError = '';
            await sourceDoc.save();
            return;
        }

        const safeRemoteName = sanitizeFileName(latest.name);
        const localFileName = `${Date.now()}-${safeRemoteName}`;
        const localPath = path.join(sourceDir, localFileName);
        const remotePath = joinRemotePath(remoteFolder, latest.name);

        await client.downloadTo(localPath, remotePath);

        if (latestRemoteModifiedAt) {
            fs.utimesSync(localPath, latestRemoteModifiedAt, latestRemoteModifiedAt);
        }

        sourceDoc.lastRemoteFile = latest.name;
        sourceDoc.lastLocalFile = localFileName;
        sourceDoc.lastRemoteModifiedAt = latestRemoteModifiedAt || null;
        sourceDoc.lastRemoteSize = latestRemoteSize;
        sourceDoc.lastSyncedAt = new Date();
        sourceDoc.lastSyncError = '';
        await sourceDoc.save();

        logger.info('SHM live FTP sync downloaded latest file', {
            projectId,
            type,
            sourceId: String(sourceDoc._id),
            remoteFile: latest.name,
            localFile: localFileName,
            remoteSize: latestRemoteSize,
        });
    } catch (error) {
        sourceDoc.lastSyncError = error.message || 'FTP sync failed';
        sourceDoc.lastSyncedAt = new Date();
        await sourceDoc.save();
        logger.warn('SHM live FTP sync failed', {
            projectId,
            type,
            sourceId: sourceDoc?._id ? String(sourceDoc._id) : null,
            error: error.message,
        });
    } finally {
        client.close();
    }
};

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const type = normalizeType(req.params.type) || 'dynamic';
        const dir = getProjectTypeDir(req.params.projectId, type);
        ensureDir(dir);
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname || '').toLowerCase();
        const base = path.basename(file.originalname || 'stream', ext).replace(/[^a-zA-Z0-9-_]/g, '_');
        cb(null, `${Date.now()}-${base}${ext || '.mseed'}`);
    },
});

exports.mseedUploadMiddleware = multer({
    storage,
    fileFilter: (req, file, cb) => {
        cb(null, isMiniSeed(file.originalname));
    },
    limits: { fileSize: 300 * 1024 * 1024 },
}).single('mseedFile');

exports.getLiveSourceConfig = async (req, res) => {
    try {
        const { projectId } = req.params;
        const type = normalizeType(req.params.type);
        if (!type) {
            return res.status(400).json({ success: false, message: 'Invalid SHM type. Use static or dynamic' });
        }

        let source = await SHMLiveSource.findOne({ project: projectId, type });
        if (!source && type === 'dynamic') {
            source = await buildDynamicSourceFromProject(projectId);
        }
        const includeSecrets = req.user?.role === 'admin';

        return res.json({
            success: true,
            source: sanitizeSourceForResponse(source, includeSecrets),
        });
    } catch (error) {
        console.error('Get live source config error:', error);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};

exports.updateLiveSourceConfig = async (req, res) => {
    try {
        const { projectId } = req.params;
        const type = normalizeType(req.params.type);
        if (!type) {
            return res.status(400).json({ success: false, message: 'Invalid SHM type. Use static or dynamic' });
        }

        const payload = normalizeSourceConfig(req.body || {});

        if (payload.isActive) {
            if (!payload.ftpHost || !payload.ftpUser || !payload.ftpPassword || !payload.ftpPath) {
                return res.status(400).json({
                    success: false,
                    message: 'ftpHost, ftpUser, ftpPassword and ftpPath are required when source is active',
                });
            }
        }

        const source = await SHMLiveSource.findOneAndUpdate(
            { project: projectId, type },
            {
                $set: {
                    sourceName: payload.sourceName,
                    ftpHost: payload.ftpHost,
                    ftpPort: payload.ftpPort,
                    ftpUser: payload.ftpUser,
                    ftpPassword: payload.ftpPassword,
                    ftpPath: payload.ftpPath,
                    isActive: payload.isActive,
                },
            },
            { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
        );

        if (type === 'dynamic') {
            await syncProjectRealtimeFromDynamicSource(source);
        }

        return res.json({
            success: true,
            source: sanitizeSourceForResponse(source, true),
        });
    } catch (error) {
        console.error('Update live source config error:', error);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};

exports.uploadLiveMseedFile = async (req, res) => {
    try {
        const type = normalizeType(req.params.type);
        if (!type) {
            return res.status(400).json({ success: false, message: 'Invalid SHM type. Use static or dynamic' });
        }

        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No .mseed file uploaded' });
        }

        const relativePath = path
            .relative(path.join(__dirname, '..'), req.file.path)
            .replace(/\\/g, '/');

        return res.json({
            success: true,
            message: 'MiniSEED uploaded successfully',
            file: {
                filename: req.file.filename,
                originalName: req.file.originalname,
                size: req.file.size,
                path: `/${relativePath}`,
                type,
            },
        });
    } catch (error) {
        console.error('Upload live MiniSEED error:', error);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};

exports.listLiveMseedFiles = async (req, res) => {
    try {
        const { projectId } = req.params;
        const type = normalizeType(req.params.type);
        if (!type) {
            return res.status(400).json({ success: false, message: 'Invalid SHM type. Use static or dynamic' });
        }

        let source = await SHMLiveSource.findOne({ project: projectId, type });
        if (!source && type === 'dynamic') {
            source = await buildDynamicSourceFromProject(projectId);
        }
        await syncLatestFromFtp(projectId, type, source);

        const files = getCandidateFiles(projectId, type, source).map((f) => ({
            name: f.name,
            size: f.size,
            modifiedAt: f.modifiedAt,
        }));

        return res.json({
            success: true,
            files,
            source: sanitizeSourceForResponse(source, req.user?.role === 'admin'),
        });
    } catch (error) {
        console.error('List live MiniSEED files error:', error);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};

exports.streamLiveMseed = async (req, res) => {
    const { projectId } = req.params;
    const type = normalizeType(req.params.type);
    const streamId = `${projectId}:${type || 'unknown'}:${Date.now()}`;

    logger.info('SHM live stream request', {
        streamId,
        projectId,
        type,
        requestedFile: (req.query.file || '').toString().trim() || null,
        chunkDuration: req.query.chunkDuration || '0.25',
        downsample: req.query.downsample || '4',
        speed: req.query.speed || '1',
        userId: req.user?._id ? String(req.user._id) : null,
    });

    if (!type) {
        logger.warn('SHM live stream invalid type', { streamId, projectId, rawType: req.params.type });
        return res.status(400).json({ success: false, message: 'Invalid SHM type. Use static or dynamic' });
    }

    let source = await SHMLiveSource.findOne({ project: projectId, type });
    if (!source && type === 'dynamic') {
        source = await buildDynamicSourceFromProject(projectId);
    }
    await syncLatestFromFtp(projectId, type, source);

    const requestedFile = (req.query.file || '').toString().trim();
    const candidates = getCandidateFiles(projectId, type, source);

    logger.info('SHM live stream candidate files', {
        streamId,
        projectId,
        type,
        candidates: candidates.length,
        latestCandidate: candidates[0]?.name || null,
    });

    if (!candidates.length) {
        return res.status(404).json({ success: false, message: 'No MiniSEED file found for this project source' });
    }

    let selected = null;
    if (!requestedFile) {
        selected = candidates[0];
    } else {
        if (!isMiniSeed(requestedFile) || requestedFile.includes('..') || requestedFile.includes('/') || requestedFile.includes('\\')) {
            return res.status(400).json({ success: false, message: 'Invalid file name' });
        }
        selected = candidates.find((f) => f.name === requestedFile);

        // Allow requesting by remote FTP file name when the local synced file is timestamp-prefixed.
        if (!selected && source?.lastRemoteFile === requestedFile && source?.lastLocalFile) {
            selected = candidates.find((f) => f.name === source.lastLocalFile);
        }

        if (!selected) {
            return res.status(404).json({ success: false, message: 'Requested MiniSEED file not found' });
        }
    }

    const fullPath = selected.fullPath;
    const selectedFile = selected.name;

    logger.info('SHM live stream selected file', {
        streamId,
        projectId,
        type,
        selectedFile,
        modifiedAt: selected.modifiedAt,
        parserPreference: String(process.env.SHM_LIVE_PARSER || 'python').trim().toLowerCase(),
    });

    const parserPreference = String(process.env.SHM_LIVE_PARSER || 'python').trim().toLowerCase();
    const pythonExec = resolvePythonExecutable();
    const chunkDuration = String(req.query.chunkDuration || '0.25');
    const downsample = String(req.query.downsample || '4');
    const speed = String(req.query.speed || '1');

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const sendSSE = (payload) => {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    sendSSE({
        type: 'stream_start',
        data: {
            projectId,
            type,
            filename: selectedFile,
            fileModifiedAt: selected.modifiedAt,
            python: pythonExec,
            parserPreference,
            sourceName: source?.sourceName || 'Local Upload',
        },
    });

    let clientClosed = false;
    let py = null;
    let fallbackStarted = false;
    let pythonEmittedDataChunk = false;
    let pythonChunkCount = 0;

    const isClientClosed = () => clientClosed || res.writableEnded || res.destroyed;
    const safeEnd = () => {
        if (!res.writableEnded) res.end();
    };

    const startJsFallback = async (reason = '') => {
        if (fallbackStarted || isClientClosed()) return;
        fallbackStarted = true;

        logger.warn('SHM live stream switching to JS fallback', {
            streamId,
            projectId,
            type,
            file: selectedFile,
            reason,
        });

        if (reason) {
            sendSSE({ type: 'parser_log', data: { message: `Using JS parser fallback: ${reason}` } });
        }

        try {
            await streamLiveWithJsParser({
                streamId,
                filePath: fullPath,
                selectedFile,
                projectId,
                type,
                source,
                chunkDuration,
                downsample,
                speed,
                sendSSE,
                isClientClosed,
            });
        } catch (error) {
            sendSSE({ type: 'error', data: { message: `JS parser failed: ${error.message}` } });
            sendSSE({ type: 'stream_end', data: { code: 1, parser: 'js' } });
        } finally {
            safeEnd();
        }
    };

    req.on('close', () => {
        clientClosed = true;
        logger.info('SHM live stream client disconnected', {
            streamId,
            projectId,
            type,
            file: selectedFile,
            pythonChunkCount,
        });
        if (py && !py.killed) py.kill();
    });

    const pythonUsable = fs.existsSync(STREAM_SCRIPT);
    logger.info('SHM live stream parser decision', {
        streamId,
        projectId,
        type,
        parserPreference,
        pythonUsable,
        pythonExec,
    });
    if (parserPreference === 'js' || !pythonUsable) {
        await startJsFallback(pythonUsable ? 'Parser preference set to js' : 'Python stream script not found');
        return;
    }

    py = spawn(
        pythonExec,
        [STREAM_SCRIPT, fullPath, '--chunk-duration', chunkDuration, '--downsample', downsample, '--speed', speed],
        {
            cwd: path.join(__dirname, '..'),
            stdio: ['ignore', 'pipe', 'pipe'],
        }
    );

    logger.info('SHM live stream python parser started', {
        streamId,
        projectId,
        type,
        file: selectedFile,
        pythonExec,
    });

    const stdoutReader = readline.createInterface({ input: py.stdout });
    stdoutReader.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        try {
            const parsed = JSON.parse(trimmed);
            if (parsed?.type === 'data_chunk') {
                pythonEmittedDataChunk = true;
                pythonChunkCount += 1;
                if (pythonChunkCount % 25 === 0) {
                    logger.debug('SHM live stream python chunk progress', {
                        streamId,
                        projectId,
                        type,
                        pythonChunkCount,
                        progress: parsed?.data?.progress,
                    });
                }
            }
            sendSSE(parsed);
        } catch (error) {
            sendSSE({ type: 'parser_log', data: { message: trimmed } });
        }
    });

    py.stderr.on('data', (buf) => {
        const msg = String(buf || '').trim();
        if (!msg) return;
        logger.warn('SHM live stream python stderr', {
            streamId,
            projectId,
            type,
            file: selectedFile,
            message: msg,
        });
        sendSSE({ type: 'error', data: { message: msg } });
    });

    py.on('error', async (error) => {
        logger.warn('SHM live stream python process error', {
            streamId,
            projectId,
            type,
            file: selectedFile,
            error: error.message,
        });
        await startJsFallback(`Failed to start python parser: ${error.message}`);
    });

    py.on('close', async (code) => {
        logger.info('SHM live stream python parser closed', {
            streamId,
            projectId,
            type,
            file: selectedFile,
            code,
            pythonChunkCount,
            pythonEmittedDataChunk,
            fallbackStarted,
        });
        if (isClientClosed() || fallbackStarted) return;

        if (code === 0) {
            sendSSE({ type: 'stream_end', data: { code, parser: 'python' } });
            safeEnd();
            return;
        }

        if (!pythonEmittedDataChunk) {
            await startJsFallback(`Python parser exited with code ${code}`);
            return;
        }

        sendSSE({ type: 'stream_end', data: { code, parser: 'python' } });
        safeEnd();
    });
};
