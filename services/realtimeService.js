const Project = require('../models/Project');
const logger = require('../utils/logger');
const { withProjectFtp } = require('./ftpService');
const { processEventTrigger } = require('./eventTriggerService');

const isMseedFile = (name = '') => /\.(mseed|miniseed)$/i.test(name);
const REALTIME_MAX_FILES_PER_PROJECT = Math.max(1, Number(process.env.REALTIME_MAX_FILES_PER_PROJECT || 5));

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

const toRemoteCandidates = (remoteEntries = []) => {
    return remoteEntries
        .filter((entry) => {
            const fileName = entry?.name || '';
            const isFile = entry?.isFile === true || entry?.type === 1 || entry?.type === '-' || entry?.type === 0;
            return isFile && isMseedFile(fileName);
        })
        .map((entry) => {
            const modifiedAt = resolveRemoteModifiedAt(entry);
            return {
                name: entry.name,
                size: Number(entry.size || 0),
                modifiedAt: modifiedAt && !Number.isNaN(modifiedAt.getTime()) ? modifiedAt : null,
            };
        })
        .sort((a, b) => toMillis(b.modifiedAt) - toMillis(a.modifiedAt));
};

const pickNewFiles = (remoteEntries = [], project = null) => {
    const candidates = toRemoteCandidates(remoteEntries);
    if (!candidates.length) return [];

    const lastFetchedMs = toMillis(project?.lastFetchedAt);
    const lastFileName = String(project?.lastRealtimeFile || '').trim();
    const lastFileSize = Number(project?.lastRealtimeFileSize || 0);

    // First cycle for a project: process a small chronological batch to avoid missing files.
    if (!lastFetchedMs && !lastFileName) {
        return candidates.slice(0, REALTIME_MAX_FILES_PER_PROJECT);
    }

    const nextFiles = candidates.filter((file) => {
        const fileModifiedMs = toMillis(file.modifiedAt);
        const sameName = lastFileName && lastFileName === String(file.name || '');
        const sameSize = lastFileSize > 0 && lastFileSize === Number(file.size || 0);

        if (fileModifiedMs > lastFetchedMs) return true;

        // Some FTP servers expose coarse timestamp precision. If timestamp ties but file identity differs,
        // treat it as new so it still gets processed and emitted.
        if (fileModifiedMs && fileModifiedMs === lastFetchedMs && (!sameName || !sameSize)) return true;

        // If modified time is missing, fall back to file identity.
        if (!fileModifiedMs && (!sameName || !sameSize)) return true;

        return false;
    });

    if (nextFiles.length > 0) {
        return nextFiles.slice(0, REALTIME_MAX_FILES_PER_PROJECT);
    }

    // Fallback for FTP servers with unstable or coarse modified-time values:
    // walk by listing order relative to last seen file identity.
    if (lastFileName) {
        const lastSeenIndex = candidates.findIndex((file) => {
            if (String(file.name || '') !== lastFileName) return false;
            if (lastFileSize <= 0) return true;
            return Number(file.size || 0) === lastFileSize;
        });

        if (lastSeenIndex > 0) {
            return candidates.slice(0, Math.min(lastSeenIndex, REALTIME_MAX_FILES_PER_PROJECT));
        }
    }

    const latest = candidates[0];
    const latestName = String(latest?.name || '');
    const latestSize = Number(latest?.size || 0);
    const latestChanged = latestName && (latestName !== lastFileName || (lastFileSize > 0 && latestSize !== lastFileSize));

    return latestChanged ? [latest] : [];
};

const processProjectRealtime = async (project) => {
    const projectLabel = `${project.projectName || project._id}`;

    try {
        return await withProjectFtp(project, async (client, remoteBasePath) => {
            const remoteEntries = await client.list(remoteBasePath);
            const availableFiles = toRemoteCandidates(remoteEntries);
            const newFiles = pickNewFiles(remoteEntries, project);

            if (!newFiles.length) {
                if (!availableFiles.length) {
                    logger.info('Realtime: no MSEED file found', { project: projectLabel });
                    return { projectId: project._id, skipped: true, reason: 'NO_FILE' };
                }

                return { projectId: project._id, skipped: true, reason: 'NO_NEW_FILE' };
            }

            const orderedFiles = [...newFiles].reverse();
            const processedItems = [];
            let hadInProgress = false;
            let lastSkippedReason = '';

            for (const file of orderedFiles) {
                const result = await processEventTrigger({
                    projectId: project._id,
                    fileName: file.name,
                    remoteFileHint: file,
                    triggerSource: 'realtime-worker',
                });

                if (result?.duplicate) {
                    hadInProgress = true;
                    continue;
                }

                if (result?.skipped) {
                    lastSkippedReason = result.reason || 'SKIPPED';
                    continue;
                }

                if (result?.success) {
                    processedItems.push({
                        file: file.name,
                        eventId: result.eventId,
                        eventType: result.eventType,
                        severity: result.severity,
                    });
                }
            }

            if (processedItems.length > 0) {
                return {
                    projectId: project._id,
                    processed: true,
                    fileCount: processedItems.length,
                    files: processedItems.map((item) => item.file),
                    latestEventId: processedItems[processedItems.length - 1].eventId,
                };
            }

            if (hadInProgress) {
                return { projectId: project._id, skipped: true, reason: 'IN_PROGRESS' };
            }

            return { projectId: project._id, skipped: true, reason: lastSkippedReason || 'NO_NEW_FILE' };
        });
    } catch (error) {
        logger.error('Realtime processing failed', {
            project: projectLabel,
            error: error.message,
        });

        return {
            projectId: project._id,
            failed: true,
            error: error.message,
        };
    }
};

const runRealtimeDetectionCycle = async () => {
    const projects = await Project.find({
        isActive: true,
        type: 'mseed',
        'ftp.host': { $nin: ['', null] },
        'ftp.user': { $nin: ['', null] },
        'ftp.password': { $nin: ['', null] },
    });

    logger.info('Realtime cycle started', { projects: projects.length });

    const results = await Promise.all(projects.map((project) => processProjectRealtime(project)));

    const processedCount = results.filter((r) => r?.processed).length;
    const failedCount = results.filter((r) => r?.failed).length;

    logger.info('Realtime cycle finished', {
        projects: projects.length,
        processedCount,
        failedCount,
    });

    return {
        totalProjects: projects.length,
        processedCount,
        failedCount,
        results,
    };
};

module.exports = {
    runRealtimeDetectionCycle,
};
