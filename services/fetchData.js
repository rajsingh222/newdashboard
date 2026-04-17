const fs = require('fs');
const path = require('path');
const Project = require('../models/Project');
const Data = require('../models/Data');
const logger = require('../utils/logger');
const { parseByProjectType, inferFileTypeFromName } = require('./parser');
const { withProjectFtp, downloadRemoteFile } = require('./ftpService');

const DOWNLOAD_BASE_DIR = path.join(__dirname, '..', 'downloads');
const MAX_PROCESSED_FILES = Number(process.env.SHM_MAX_PROCESSED_FILES || 5000);
const INSERT_BATCH_SIZE = Number(process.env.SHM_INSERT_BATCH_SIZE || 2000);

const ensureDir = (dirPath) => fs.mkdirSync(dirPath, { recursive: true });

const toDateMillis = (value) => {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value.getTime();
    if (!value) return 0;
    const parsed = Date.parse(String(value));
    return Number.isNaN(parsed) ? 0 : parsed;
};

const isAllowedTypeFile = (projectType, fileName) => inferFileTypeFromName(fileName) === projectType;

const splitChunks = (items, size) => {
    const chunks = [];
    for (let i = 0; i < items.length; i += size) {
        chunks.push(items.slice(i, i + size));
    }
    return chunks;
};

const buildDataDocs = (project, sourceFileName, rows) => {
    const projectName = project.projectName || project.name || 'Unnamed Project';

    return rows.map((row, index) => ({
        projectId: project._id,
        projectName,
        timestamp: row.timestamp,
        value: row.value,
        sensor: row.sensor || '',
        sourceFile: sourceFileName,
        sourceIndex: index,
    }));
};

const insertInBatches = async (docs) => {
    const chunks = splitChunks(docs, INSERT_BATCH_SIZE);
    let insertedCount = 0;

    for (const chunk of chunks) {
        try {
            const inserted = await Data.insertMany(chunk, { ordered: false });
            insertedCount += inserted.length;
        } catch (error) {
            // Continue on duplicate key errors while still counting successful inserts.
            if (error?.writeErrors?.length) {
                const duplicateOnly = error.writeErrors.every((w) => w.code === 11000);
                if (!duplicateOnly) throw error;
                insertedCount += chunk.length - error.writeErrors.length;
            } else {
                throw error;
            }
        }
    }

    return insertedCount;
};

const processProject = async (project) => {
    const projectLabel = `${project.projectName || project.name || project._id} (${project._id})`;
    const projectType = String(project.type || '').toLowerCase();

    logger.info(`Starting project fetch`, { project: projectLabel, type: projectType });

    const processedFileSet = new Set(Array.isArray(project.processedFiles) ? project.processedFiles : []);
    const downloadedFiles = [];
    const downloadDir = path.join(DOWNLOAD_BASE_DIR, String(project._id));
    ensureDir(downloadDir);

    let listedFiles = [];
    let newestFileTime = toDateMillis(project.lastFetchedAt);
    let processedNow = 0;
    let insertedRows = 0;

    try {
        await withProjectFtp(project, async (client, remoteBasePath) => {
            const remoteEntries = await client.list(remoteBasePath);
            listedFiles = remoteEntries
                .filter((entry) => {
                    const fileName = entry?.name || '';
                    if (!fileName) return false;

                    const isFile = entry?.isFile === true || entry?.type === 1 || entry?.type === '-' || entry?.type === 0;
                    return isFile && isAllowedTypeFile(projectType, fileName);
                })
                .map((entry) => {
                    const modifiedAt = entry?.modifiedAt ? new Date(entry.modifiedAt) : null;
                    return {
                        name: entry.name,
                        size: Number(entry.size || 0),
                        modifiedAt: modifiedAt && !Number.isNaN(modifiedAt.getTime()) ? modifiedAt : null,
                    };
                })
                .sort((a, b) => toDateMillis(a.modifiedAt) - toDateMillis(b.modifiedAt));

            logger.info(`Remote file scan complete`, {
                project: projectLabel,
                filesFound: listedFiles.length,
            });

            const filesToProcess = listedFiles.filter((file) => {
                if (processedFileSet.has(file.name)) return false;

                const fileTime = toDateMillis(file.modifiedAt);
                if (fileTime && project.lastFetchedAt) {
                    return fileTime > toDateMillis(project.lastFetchedAt);
                }

                return true;
            });

            for (const file of filesToProcess) {
                let localPath = null;

                try {
                    localPath = await downloadRemoteFile(client, project.ftp.path || '/', file.name, downloadDir, file.name);
                    downloadedFiles.push(localPath);

                    const rows = await parseByProjectType(projectType, localPath);
                    const docs = buildDataDocs(project, file.name, rows);
                    const inserted = docs.length ? await insertInBatches(docs) : 0;

                    insertedRows += inserted;
                    processedNow += 1;
                    processedFileSet.add(file.name);

                    const fileTime = toDateMillis(file.modifiedAt);
                    if (fileTime > newestFileTime) newestFileTime = fileTime;

                    logger.info(`Processed file`, {
                        project: projectLabel,
                        file: file.name,
                        parsedRows: rows.length,
                        insertedRows: inserted,
                    });
                } catch (error) {
                    logger.error(`Failed processing file`, {
                        project: projectLabel,
                        file: file.name,
                        error: error.message,
                    });
                }
            }
        });

        project.lastFetchedAt = newestFileTime ? new Date(newestFileTime) : project.lastFetchedAt;
        project.processedFiles = Array.from(processedFileSet).slice(-MAX_PROCESSED_FILES);
        await project.save();

        logger.info(`Project fetch complete`, {
            project: projectLabel,
            listedFiles: listedFiles.length,
            processedFiles: processedNow,
            insertedRows,
        });

        return {
            projectId: project._id,
            listedFiles: listedFiles.length,
            processedFiles: processedNow,
            insertedRows,
        };
    } finally {
        for (const localFilePath of downloadedFiles) {
            try {
                if (fs.existsSync(localFilePath)) fs.unlinkSync(localFilePath);
            } catch (error) {
                logger.warn(`Cleanup failed`, { file: localFilePath, error: error.message });
            }
        }
    }
};

const fetchAndProcessActiveProjects = async () => {
    ensureDir(DOWNLOAD_BASE_DIR);

    const activeProjects = await Project.find({
        isActive: true,
        type: { $in: ['excel', 'mseed'] },
        'ftp.host': { $nin: ['', null] },
        'ftp.user': { $nin: ['', null] },
        'ftp.password': { $nin: ['', null] },
    });

    logger.info(`Ingestion cycle started`, { projects: activeProjects.length });

    const results = await Promise.all(
        activeProjects.map(async (project) => {
            try {
                return await processProject(project);
            } catch (error) {
                logger.error(`Project ingestion failed`, {
                    projectId: project._id,
                    projectName: project.projectName,
                    error: error.message,
                });
                return {
                    projectId: project._id,
                    failed: true,
                    error: error.message,
                };
            }
        })
    );

    const successCount = results.filter((r) => !r.failed).length;
    const failureCount = results.length - successCount;

    logger.info(`Ingestion cycle finished`, {
        totalProjects: results.length,
        successCount,
        failureCount,
    });

    return {
        totalProjects: results.length,
        successCount,
        failureCount,
        results,
    };
};

module.exports = {
    fetchAndProcessActiveProjects,
};
