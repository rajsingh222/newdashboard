const fs = require('fs');
const path = require('path');
const multer = require('multer');
const readline = require('readline');
const { spawn } = require('child_process');
const ftp = require('basic-ftp');
const SHMLiveSource = require('../models/SHMLiveSource');
const Project = require('../models/Project');

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

const syncLatestFromFtp = async (projectId, type, sourceDoc) => {
    if (!sourceDoc || !sourceDoc.isActive) return;
    if (!sourceDoc.ftpHost || !sourceDoc.ftpUser || !sourceDoc.ftpPassword) return;

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
    } catch (error) {
        sourceDoc.lastSyncError = error.message || 'FTP sync failed';
        sourceDoc.lastSyncedAt = new Date();
        await sourceDoc.save();
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
    if (!type) {
        return res.status(400).json({ success: false, message: 'Invalid SHM type. Use static or dynamic' });
    }

    let source = await SHMLiveSource.findOne({ project: projectId, type });
    if (!source && type === 'dynamic') {
        source = await buildDynamicSourceFromProject(projectId);
    }
    await syncLatestFromFtp(projectId, type, source);

    const requestedFile = (req.query.file || '').toString().trim();
    const candidates = getCandidateFiles(projectId, type, source);

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

    if (!fs.existsSync(STREAM_SCRIPT)) {
        return res.status(500).json({ success: false, message: 'MiniSEED stream script not found on server' });
    }

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
            sourceName: source?.sourceName || 'Local Upload',
        },
    });

    const py = spawn(
        pythonExec,
        [STREAM_SCRIPT, fullPath, '--chunk-duration', chunkDuration, '--downsample', downsample, '--speed', speed],
        {
        cwd: path.join(__dirname, '..'),
        stdio: ['ignore', 'pipe', 'pipe'],
        }
    );

    const stdoutReader = readline.createInterface({ input: py.stdout });
    stdoutReader.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        try {
            const parsed = JSON.parse(trimmed);
            sendSSE(parsed);
        } catch (error) {
            sendSSE({ type: 'parser_log', data: { message: trimmed } });
        }
    });

    py.stderr.on('data', (buf) => {
        const msg = String(buf || '').trim();
        if (!msg) return;
        sendSSE({ type: 'error', data: { message: msg } });
    });

    py.on('error', (error) => {
        sendSSE({ type: 'error', data: { message: `Failed to start parser: ${error.message}` } });
        res.end();
    });

    py.on('close', (code) => {
        sendSSE({ type: 'stream_end', data: { code } });
        res.end();
    });

    req.on('close', () => {
        if (!py.killed) {
            py.kill();
        }
    });
};
