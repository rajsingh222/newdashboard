const fs = require('fs');
const { v2: cloudinary } = require('cloudinary');

const CLOUDINARY_FOLDER_ROOT = (process.env.CLOUDINARY_FOLDER_ROOT || 'Dashboard').trim() || 'Dashboard';

const isCloudinaryReady = () => {
    return Boolean(
        (process.env.CLOUDINARY_CLOUD_NAME || '').trim()
        && (process.env.CLOUDINARY_API_KEY || '').trim()
        && (process.env.CLOUDINARY_API_SECRET || '').trim()
    );
};

let configured = false;

const ensureCloudinaryConfig = () => {
    if (configured) return;
    if (!isCloudinaryReady()) return;

    cloudinary.config({
        cloud_name: (process.env.CLOUDINARY_CLOUD_NAME || '').trim(),
        api_key: (process.env.CLOUDINARY_API_KEY || '').trim(),
        api_secret: (process.env.CLOUDINARY_API_SECRET || '').trim(),
        secure: true,
    });

    configured = true;
};

const buildFolderPath = (subfolder = '') => {
    const cleanSubfolder = String(subfolder || '').replace(/^\/+|\/+$/g, '');
    return cleanSubfolder ? `${CLOUDINARY_FOLDER_ROOT}/${cleanSubfolder}` : CLOUDINARY_FOLDER_ROOT;
};

const cleanupLocalFile = (filePath) => {
    try {
        if (filePath && fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch {
        // Ignore cleanup errors.
    }
};

const uploadLocalFileToCloudinary = async (filePath, { subfolder = '', resourceType = 'auto' } = {}) => {
    if (!filePath) throw new Error('File path is required for Cloudinary upload');
    if (!isCloudinaryReady()) {
        throw new Error('Cloudinary credentials are not configured');
    }

    ensureCloudinaryConfig();

    return cloudinary.uploader.upload(filePath, {
        folder: buildFolderPath(subfolder),
        resource_type: resourceType,
        use_filename: true,
        unique_filename: true,
        overwrite: false,
    });
};

const parsePublicIdCandidatesFromUrl = (assetUrl = '') => {
    try {
        const parsed = new URL(String(assetUrl || ''));
        if (!parsed.hostname.includes('res.cloudinary.com')) return [];

        const uploadSplit = parsed.pathname.split('/upload/');
        if (uploadSplit.length < 2) return [];

        let tail = uploadSplit[1].replace(/^\/+/, '');
        if (/^v\d+\//.test(tail)) {
            tail = tail.replace(/^v\d+\//, '');
        }

        const noQueryTail = decodeURIComponent(tail);
        const withoutExt = noQueryTail.includes('.') ? noQueryTail.replace(/\.[^./]+$/, '') : noQueryTail;

        return [...new Set([noQueryTail, withoutExt].filter(Boolean))];
    } catch {
        return [];
    }
};

const deleteCloudinaryAssetByUrl = async (assetUrl = '') => {
    if (!assetUrl || typeof assetUrl !== 'string') return false;
    if (!assetUrl.startsWith('http://') && !assetUrl.startsWith('https://')) return false;
    if (!isCloudinaryReady()) return false;

    ensureCloudinaryConfig();

    const candidates = parsePublicIdCandidatesFromUrl(assetUrl);
    if (!candidates.length) return false;

    const resourceTypes = ['image', 'raw', 'video'];
    for (const publicId of candidates) {
        for (const resourceType of resourceTypes) {
            try {
                const result = await cloudinary.uploader.destroy(publicId, {
                    resource_type: resourceType,
                    invalidate: true,
                });
                if (result?.result === 'ok') {
                    return true;
                }
            } catch {
                // Try next combination.
            }
        }
    }

    return false;
};

module.exports = {
    isCloudinaryReady,
    uploadLocalFileToCloudinary,
    deleteCloudinaryAssetByUrl,
    cleanupLocalFile,
};
