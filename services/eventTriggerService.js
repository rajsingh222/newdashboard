const fs = require('fs');
const path = require('path');
const Project = require('../models/Project');
const Event = require('../models/Event');
const logger = require('../utils/logger');
const { withProjectFtp, downloadRemoteFile } = require('./ftpService');
const { parseMseedFile } = require('./mseedParser');
const { analyzeSignal, classifyEvent } = require('./analysisService');
const { emitEventDetected, emitEventProcessStatus } = require('../socket/socket');

const EVENT_TRIGGER_DOWNLOAD_DIR = path.join(__dirname, '..', 'downloads', 'event-trigger');
const RAW_SIGNAL_LIMIT = Number(process.env.SHM_RAW_SIGNAL_LIMIT || 2048);
const MAX_PROCESSED_FILE_KEYS = Number(process.env.MAX_PROCESSED_FILE_KEYS || 5000);
const inFlightEventKeys = new Set();
let ensureEventIndexesPromise = null;

const ensureDir = (dirPath) => {
    fs.mkdirSync(dirPath, { recursive: true });
};

const isMseedFile = (name = '') => /\.(mseed|miniseed)$/i.test(name);

const toMillis = (value) => {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value.getTime();
    if (!value) return 0;
    const parsed = Date.parse(String(value));
    return Number.isNaN(parsed) ? 0 : parsed;
};

const resolveRemoteModifiedAt = (entry = {}) => {
    const fromModifiedAt = toMillis(entry?.modifiedAt);
    if (fromModifiedAt) return new Date(fromModifiedAt);

    const fromRawModifiedAt = toMillis(entry?.rawModifiedAt);
    if (fromRawModifiedAt) return new Date(fromRawModifiedAt);

    return null;
};

const toRemoteEntry = (entry = {}) => ({
    name: String(entry?.name || ''),
    size: Number(entry?.size || 0),
    modifiedAt: resolveRemoteModifiedAt(entry),
    isFile: entry?.isFile === true || entry?.type === 1 || entry?.type === '-' || entry?.type === 0,
});

const buildSourceFileFingerprint = ({ fileName = '', modifiedAt = null, size = 0 }) => {
    return `${String(fileName).trim()}|${toMillis(modifiedAt)}|${Number(size || 0)}`;
};

const createHttpError = (statusCode, message) => {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
};

const ensureReprocessFriendlyEventIndexes = async () => {
    if (!ensureEventIndexesPromise) {
        ensureEventIndexesPromise = (async () => {
            if (typeof Event.ensureReprocessFriendlyIndexes === 'function') {
                await Event.ensureReprocessFriendlyIndexes();
            }
        })().catch((error) => {
            logger.warn('Unable to verify Event indexes for reprocessing support', {
                error: error.message,
            });
        });
    }

    await ensureEventIndexesPromise;
};

const getProjectThresholds = (project) => {
    const t = project?.eventThresholds || {};
    return {
        peakSevere: Number.isFinite(Number(t.peakSevere)) ? Number(t.peakSevere) : 2000,
        peakImpact: Number.isFinite(Number(t.peakImpact)) ? Number(t.peakImpact) : 1000,
        impactDurationSec: Number.isFinite(Number(t.impactDurationSec)) ? Number(t.impactDurationSec) : 2,
        rmsContinuous: Number.isFinite(Number(t.rmsContinuous)) ? Number(t.rmsContinuous) : 300,
        continuousDurationSec: Number.isFinite(Number(t.continuousDurationSec)) ? Number(t.continuousDurationSec) : 10,
    };
};

const hasFtpCredentials = (project) => {
    return Boolean(project?.ftp?.host && project?.ftp?.user && project?.ftp?.password);
};

const listProjectRemoteMseedFiles = async (project) => {
    if (!hasFtpCredentials(project)) return [];

    return withProjectFtp(project, async (client, remoteBasePath) => {
        const entries = await client.list(remoteBasePath);
        return entries
            .map(toRemoteEntry)
            .filter((entry) => entry.isFile && isMseedFile(entry.name))
            .sort((a, b) => toMillis(b.modifiedAt) - toMillis(a.modifiedAt));
    });
};

const processEventTrigger = async ({ projectId, fileName, remoteFileHint = null, triggerSource = 'api' }) => {
    if (!projectId) throw createHttpError(400, 'projectId is required');
    if (!fileName || !String(fileName).trim()) throw createHttpError(400, 'fileName is required');

    const requestedFile = String(fileName).trim();

    if (!isMseedFile(requestedFile)) {
        throw createHttpError(400, 'fileName must be a .mseed or .miniseed file');
    }

    if (requestedFile.includes('/') || requestedFile.includes('\\') || requestedFile.includes('..')) {
        throw createHttpError(400, 'fileName must be a plain file name, not a path');
    }

    const project = await Project.findById(projectId);
    if (!project) throw createHttpError(404, 'Project not found');

    if (!hasFtpCredentials(project)) {
        throw createHttpError(400, 'FTP credentials are not configured for this project');
    }

    await ensureReprocessFriendlyEventIndexes();

    ensureDir(EVENT_TRIGGER_DOWNLOAD_DIR);
    const projectDir = path.join(EVENT_TRIGGER_DOWNLOAD_DIR, String(project._id));
    ensureDir(projectDir);

    let downloadedPath = null;

    const emitStage = (stage, details = {}) => {
        emitEventProcessStatus({
            projectId: String(project?._id || projectId || ''),
            fileName: requestedFile,
            stage,
            triggerSource,
            details,
            timestamp: new Date(),
        });
    };

    try {
        return await withProjectFtp(project, async (client, remoteBasePath) => {
            let remoteFile = remoteFileHint ? toRemoteEntry(remoteFileHint) : null;

            if (!remoteFile || !remoteFile.name) {
                const remoteEntries = await client.list(remoteBasePath);
                const found = remoteEntries.find((entry) => String(entry?.name || '') === requestedFile);
                if (!found) {
                    throw createHttpError(404, `Remote file not found on FTP: ${requestedFile}`);
                }
                remoteFile = toRemoteEntry(found);
            }

            const sourceFileFingerprint = buildSourceFileFingerprint({
                fileName: requestedFile,
                modifiedAt: remoteFile.modifiedAt,
                size: remoteFile.size,
            });

            const lockKey = `${String(project._id)}|${sourceFileFingerprint}`;
            if (inFlightEventKeys.has(lockKey)) {
                emitStage('DUPLICATE_SKIPPED', {
                    reason: 'IN_PROGRESS',
                });

                return {
                    success: true,
                    duplicate: true,
                    eventId: null,
                    sourceFile: requestedFile,
                    sourceFileFingerprint,
                };
            }
            inFlightEventKeys.add(lockKey);

            try {
                emitStage('FILE_ARRIVED', {
                    modifiedAt: remoteFile.modifiedAt,
                    size: Number(remoteFile.size || 0),
                });

                emitStage('DOWNLOAD_STARTED');

                downloadedPath = await downloadRemoteFile(
                    client,
                    project.ftp.path || '/',
                    requestedFile,
                    projectDir,
                    requestedFile
                );

                emitStage('DOWNLOAD_COMPLETED');

                emitStage('PARSING_STARTED');

                const parsed = await parseMseedFile(downloadedPath);
                const signal = Array.isArray(parsed.signal) ? parsed.signal : [];

                emitStage('PARSING_COMPLETED', {
                    signalPoints: signal.length,
                    sampleRate: Number(parsed.sampleRate || 0),
                });

                if (!signal.length) {
                    logger.warn('Event trigger parsed empty signal', {
                        projectId: String(project._id),
                        file: requestedFile,
                    });

                    emitStage('EMPTY_SIGNAL_SKIPPED');

                    return {
                        success: true,
                        skipped: true,
                        reason: 'EMPTY_SIGNAL',
                        sourceFile: requestedFile,
                        sourceFileFingerprint,
                    };
                }

                emitStage('ANALYSIS_STARTED');

                const analysis = analyzeSignal({
                    signal,
                    timestamps: parsed.timestamps || [],
                    sampleRate: parsed.sampleRate || 0,
                });

                const classification = classifyEvent(analysis, getProjectThresholds(project));

                emitStage('ANALYSIS_COMPLETED', {
                    peak: analysis.peak,
                    rms: analysis.rms,
                    duration: analysis.duration,
                    eventType: classification.eventType,
                    severity: classification.severity,
                });

                const eventDoc = await Event.create({
                    projectId: project._id,
                    projectName: project.projectName || 'Unnamed Project',
                    timestamp: parsed.timestamp || new Date(),
                    peak: analysis.peak,
                    rms: analysis.rms,
                    duration: analysis.duration,
                    dominantFrequency: analysis.dominantFrequency,
                    eventType: classification.eventType,
                    severity: classification.severity,
                    isCritical: classification.isCritical,
                    sourceFile: requestedFile,
                    sourceFileFingerprint,
                    rawSignal: signal.slice(0, RAW_SIGNAL_LIMIT),
                });

                emitStage('EVENT_STORED', {
                    eventId: String(eventDoc._id || ''),
                    eventType: eventDoc.eventType,
                    severity: eventDoc.severity,
                });

                project.lastRealtimeFile = requestedFile;
                project.lastRealtimeFileSize = Number(remoteFile.size || 0);
                project.lastFetchedAt = remoteFile.modifiedAt || new Date();

                const processedKeys = Array.isArray(project.processedFiles) ? [...project.processedFiles] : [];
                if (!processedKeys.includes(sourceFileFingerprint)) {
                    processedKeys.push(sourceFileFingerprint);
                    if (processedKeys.length > MAX_PROCESSED_FILE_KEYS) {
                        project.processedFiles = processedKeys.slice(-MAX_PROCESSED_FILE_KEYS);
                    } else {
                        project.processedFiles = processedKeys;
                    }
                }

                await project.save();

                emitEventDetected(eventDoc);
                emitStage('EVENT_EMITTED', {
                    eventId: String(eventDoc._id || ''),
                });

                logger.info('Event trigger processed', {
                    projectId: String(project._id),
                    fileName: requestedFile,
                    eventId: String(eventDoc._id),
                    eventType: eventDoc.eventType,
                    severity: eventDoc.severity,
                    triggerSource,
                });

                return {
                    success: true,
                    duplicate: false,
                    skipped: false,
                    eventId: eventDoc._id,
                    eventType: eventDoc.eventType,
                    severity: eventDoc.severity,
                    peak: eventDoc.peak,
                    rms: eventDoc.rms,
                    duration: eventDoc.duration,
                    sourceFile: requestedFile,
                    sourceFileFingerprint,
                };
            } finally {
                inFlightEventKeys.delete(lockKey);
            }
        });
    } catch (error) {
        logger.error('Event trigger processing failed', {
            projectId: String(projectId),
            fileName: requestedFile,
            error: error.message,
            triggerSource,
        });

        emitStage('PROCESSING_FAILED', {
            message: error.message,
            statusCode: Number(error.statusCode || 500),
        });

        throw error;
    } finally {
        if (downloadedPath) {
            try {
                if (fs.existsSync(downloadedPath)) fs.unlinkSync(downloadedPath);
            } catch (cleanupError) {
                logger.warn('Event trigger cleanup failed', {
                    projectId: String(projectId),
                    filePath: downloadedPath,
                    error: cleanupError.message,
                });
            }
        }
    }
};

module.exports = {
    processEventTrigger,
    listProjectRemoteMseedFiles,
    buildSourceFileFingerprint,
};
