const cron = require('node-cron');
const Project = require('../models/Project');
const logger = require('../utils/logger');
const { processEventTrigger, listProjectRemoteMseedFiles } = require('./eventTriggerService');

const BACKUP_SCHEDULE = process.env.EVENT_TRIGGER_BACKUP_SCHEDULE || '0 * * * * *';
const BACKUP_MAX_FILES_PER_PROJECT = Number(process.env.EVENT_TRIGGER_BACKUP_MAX_FILES_PER_PROJECT || 1);

let backupTask = null;
let backupCycleRunning = false;

const runBackupCycle = async () => {
    if (backupCycleRunning) {
        logger.warn('Event trigger backup cycle already running, skipping current tick');
        return;
    }

    backupCycleRunning = true;

    try {
        const projects = await Project.find({
            isActive: true,
            type: 'mseed',
            'ftp.host': { $nin: ['', null] },
            'ftp.user': { $nin: ['', null] },
            'ftp.password': { $nin: ['', null] },
        });

        let processedCount = 0;
        let duplicateCount = 0;
        let skippedCount = 0;
        let failedCount = 0;

        for (const project of projects) {
            try {
                const remoteFiles = await listProjectRemoteMseedFiles(project);
                const candidateFiles = remoteFiles
                    .slice(0, Math.max(1, BACKUP_MAX_FILES_PER_PROJECT))
                    .reverse();

                for (const remoteFile of candidateFiles) {
                    try {
                        const result = await processEventTrigger({
                            projectId: project._id,
                            fileName: remoteFile.name,
                            remoteFileHint: remoteFile,
                            triggerSource: 'backup-cron',
                        });

                        if (result?.duplicate) {
                            duplicateCount += 1;
                        } else if (result?.skipped) {
                            skippedCount += 1;
                        } else if (result?.success) {
                            processedCount += 1;
                        }
                    } catch (error) {
                        failedCount += 1;
                        logger.warn('Backup trigger failed for file', {
                            projectId: String(project._id),
                            fileName: remoteFile.name,
                            error: error.message,
                        });
                    }
                }
            } catch (error) {
                failedCount += 1;
                logger.warn('Backup trigger failed for project', {
                    projectId: String(project._id),
                    error: error.message,
                });
            }
        }

        logger.info('Event trigger backup cycle finished', {
            projects: projects.length,
            processedCount,
            duplicateCount,
            skippedCount,
            failedCount,
        });
    } catch (error) {
        logger.error('Event trigger backup cycle crashed', { error: error.message });
    } finally {
        backupCycleRunning = false;
    }
};

const startEventTriggerBackupJob = () => {
    const isEnabled = String(process.env.EVENT_TRIGGER_BACKUP_ENABLED || 'false').toLowerCase() === 'true';
    if (!isEnabled) {
        logger.info('Event trigger backup job is disabled');
        return;
    }

    if (backupTask) {
        logger.warn('Event trigger backup job already running');
        return;
    }

    backupTask = cron.schedule(BACKUP_SCHEDULE, runBackupCycle, {
        timezone: process.env.CRON_TZ || 'UTC',
    });

    logger.info('Event trigger backup job started', {
        schedule: BACKUP_SCHEDULE,
        timezone: process.env.CRON_TZ || 'UTC',
        maxFilesPerProject: BACKUP_MAX_FILES_PER_PROJECT,
    });
};

module.exports = {
    startEventTriggerBackupJob,
    runBackupCycle,
};
