const path = require('path');
const ftp = require('basic-ftp');

const FTP_TIMEOUT_MS = Number(process.env.SHM_FTP_TIMEOUT_MS || 20000);
const FTP_DEFAULT_PORT = 21;

const normalizeRemotePath = (rawPath = '/') => {
    const cleaned = String(rawPath || '/').trim().replace(/\\/g, '/');
    if (!cleaned) return '/';
    return cleaned.startsWith('/') ? cleaned : `/${cleaned}`;
};

const joinRemotePath = (folder, fileName) => {
    const normalizedFolder = normalizeRemotePath(folder);
    if (normalizedFolder === '/') return `/${fileName}`;
    return `${normalizedFolder.replace(/\/+$/, '')}/${fileName}`;
};

const createClient = () => {
    const client = new ftp.Client(FTP_TIMEOUT_MS);
    client.ftp.verbose = false;
    return client;
};

const withProjectFtp = async (project, handler) => {
    const client = createClient();
    const ftpConfig = project?.ftp || {};

    try {
        await client.access({
            host: String(ftpConfig.host || '').trim(),
            port: Number(ftpConfig.port || FTP_DEFAULT_PORT),
            user: String(ftpConfig.user || '').trim(),
            password: String(ftpConfig.password || ''),
            secure: false,
        });

        const remoteBasePath = normalizeRemotePath(ftpConfig.path || '/');
        return await handler(client, remoteBasePath);
    } finally {
        client.close();
    }
};

const mapRemoteEntry = (entry) => {
    const modifiedRaw = entry?.modifiedAt || entry?.rawModifiedAt || null;
    const modifiedAt = modifiedRaw ? new Date(modifiedRaw) : null;

    return {
        name: entry?.name || '',
        size: Number(entry?.size || 0),
        type: entry?.type,
        isFile: entry?.isFile === true || entry?.type === 1 || entry?.type === '-' || entry?.type === 0,
        modifiedAt: modifiedAt && !Number.isNaN(modifiedAt.getTime()) ? modifiedAt : null,
        raw: entry,
    };
};

const listRemoteFiles = async (project) => withProjectFtp(project, async (client, remoteBasePath) => {
    const entries = await client.list(remoteBasePath);
    return entries.map(mapRemoteEntry);
});

const downloadRemoteFile = async (client, remoteBasePath, remoteFileName, localDir, localFileName) => {
    const safeLocalFileName = String(localFileName || remoteFileName).replace(/[^a-zA-Z0-9._-]/g, '_');
    const localPath = path.join(localDir, `${Date.now()}-${safeLocalFileName}`);
    const remotePath = joinRemotePath(remoteBasePath, remoteFileName);

    await client.downloadTo(localPath, remotePath);
    return localPath;
};

module.exports = {
    FTP_DEFAULT_PORT,
    normalizeRemotePath,
    joinRemotePath,
    withProjectFtp,
    listRemoteFiles,
    downloadRemoteFile,
};
