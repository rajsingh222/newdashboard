const ModuleContent = require('../models/ModuleContent');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const {
    isCloudinaryReady,
    uploadLocalFileToCloudinary,
    deleteCloudinaryAssetByUrl,
    cleanupLocalFile,
} = require('../utils/cloudinaryStorage');

const getDiskPathFromPublicPath = (publicPath) => {
    if (!publicPath || typeof publicPath !== 'string' || !publicPath.startsWith('/uploads/')) {
        return null;
    }
    const normalized = publicPath.replace(/^\/+/, '');
    return path.join(__dirname, '..', normalized);
};

const uploadStoredFile = async (file, { subfolder, resourceType, localPublicPath }) => {
    if (isCloudinaryReady()) {
        const uploaded = await uploadLocalFileToCloudinary(file.path, {
            subfolder,
            resourceType,
        });
        cleanupLocalFile(file.path);
        return uploaded.secure_url || uploaded.url;
    }
    return localPublicPath;
};

const deleteStoredAsset = async (storedPath) => {
    if (!storedPath || typeof storedPath !== 'string') return;

    if (storedPath.startsWith('http://') || storedPath.startsWith('https://')) {
        await deleteCloudinaryAssetByUrl(storedPath);
        return;
    }

    const diskPath = getDiskPathFromPublicPath(storedPath);
    if (diskPath && fs.existsSync(diskPath)) fs.unlinkSync(diskPath);
};

// ── Multer for module images ──
const imageStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, '..', 'uploads', 'modules', 'images');
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + path.extname(file.originalname));
    },
});

exports.imageUploadMiddleware = multer({
    storage: imageStorage,
    fileFilter: (req, file, cb) => {
        const ok = /jpeg|jpg|png|gif|webp/.test(path.extname(file.originalname).toLowerCase());
        cb(null, ok);
    },
    limits: { fileSize: 10 * 1024 * 1024 },
}).array('images', 10);

// ── Multer for module reports ──
const reportStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, '..', 'uploads', 'modules', 'reports');
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + path.extname(file.originalname));
    },
});

exports.reportUploadMiddleware = multer({
    storage: reportStorage,
    limits: { fileSize: 50 * 1024 * 1024 },
}).array('reports', 10);

// ── Multer for graph images ──
const graphStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, '..', 'uploads', 'modules', 'graphs');
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + path.extname(file.originalname));
    },
});

exports.graphUploadMiddleware = multer({
    storage: graphStorage,
    fileFilter: (req, file, cb) => {
        const ok = /jpeg|jpg|png|gif|webp|svg/.test(path.extname(file.originalname).toLowerCase());
        cb(null, ok);
    },
    limits: { fileSize: 10 * 1024 * 1024 },
}).single('graph');

// ── GET content ──
exports.getModuleContent = async (req, res) => {
    try {
        const { projectId, moduleId } = req.params;
        let content = await ModuleContent.findOne({ project: projectId, module: moduleId });
        if (!content) {
            return res.json({ success: true, content: { details: '', keyValues: [], images: [], graphs: [], reports: [] } });
        }
        res.json({ success: true, content });
    } catch (error) {
        console.error('Get module content error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// ── PUT (upsert) content details + keyValues ──
exports.updateModuleContent = async (req, res) => {
    try {
        const { projectId, moduleId } = req.params;
        const { details, keyValues } = req.body;

        const updateObj = {};
        if (details !== undefined) updateObj.details = details || '';
        if (keyValues !== undefined) updateObj.keyValues = keyValues;

        let content = await ModuleContent.findOneAndUpdate(
            { project: projectId, module: moduleId },
            { $set: updateObj },
            { upsert: true, new: true }
        );

        res.json({ success: true, content });
    } catch (error) {
        console.error('Update module content error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// ── POST images ──
exports.uploadModuleImages = async (req, res) => {
    try {
        const { projectId, moduleId } = req.params;
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ success: false, message: 'No images uploaded' });
        }

        const projectModuleFolder = `projects/${projectId}/modules/${moduleId}`;
        const imagePaths = await Promise.all(
            req.files.map((f) => uploadStoredFile(f, {
                subfolder: `${projectModuleFolder}/images`,
                resourceType: 'image',
                localPublicPath: `/uploads/modules/images/${f.filename}`,
            }))
        );

        let content = await ModuleContent.findOneAndUpdate(
            { project: projectId, module: moduleId },
            { $push: { images: { $each: imagePaths } } },
            { upsert: true, new: true }
        );

        res.json({ success: true, content });
    } catch (error) {
        console.error('Upload module images error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// ── DELETE image ──
exports.deleteModuleImage = async (req, res) => {
    try {
        const { projectId, moduleId } = req.params;
        const { imagePath } = req.body;

        await ModuleContent.findOneAndUpdate(
            { project: projectId, module: moduleId },
            { $pull: { images: imagePath } }
        );

        await deleteStoredAsset(imagePath);

        const content = await ModuleContent.findOne({ project: projectId, module: moduleId });
        res.json({ success: true, content });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// ── POST graph (single image + title + description) ──
exports.uploadGraph = async (req, res) => {
    try {
        const { projectId, moduleId } = req.params;
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No graph image uploaded' });
        }

        const graphImagePath = await uploadStoredFile(req.file, {
            subfolder: `projects/${projectId}/modules/${moduleId}/graphs`,
            resourceType: 'image',
            localPublicPath: `/uploads/modules/graphs/${req.file.filename}`,
        });

        const graphEntry = {
            title: req.body.title || '',
            description: req.body.description || '',
            imagePath: graphImagePath,
            uploadedAt: new Date(),
        };

        let content = await ModuleContent.findOneAndUpdate(
            { project: projectId, module: moduleId },
            { $push: { graphs: graphEntry } },
            { upsert: true, new: true }
        );

        res.json({ success: true, content });
    } catch (error) {
        console.error('Upload graph error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// ── DELETE graph ──
exports.deleteGraph = async (req, res) => {
    try {
        const { projectId, moduleId } = req.params;
        const { graphId } = req.body;

        const content = await ModuleContent.findOne({ project: projectId, module: moduleId });
        if (!content) return res.status(404).json({ success: false, message: 'Not found' });

        const graph = content.graphs.id(graphId);
        if (graph) {
            await deleteStoredAsset(graph.imagePath);
            content.graphs.pull(graphId);
            await content.save();
        }

        res.json({ success: true, content });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// ── POST reports ──
exports.uploadModuleReports = async (req, res) => {
    try {
        const { projectId, moduleId } = req.params;
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ success: false, message: 'No reports uploaded' });
        }

        const projectModuleFolder = `projects/${projectId}/modules/${moduleId}`;
        const reportEntries = await Promise.all(
            req.files.map(async (f) => ({
                name: f.originalname,
                filePath: await uploadStoredFile(f, {
                    subfolder: `${projectModuleFolder}/reports`,
                    resourceType: 'raw',
                    localPublicPath: `/uploads/modules/reports/${f.filename}`,
                }),
                uploadedAt: new Date(),
            }))
        );

        let content = await ModuleContent.findOneAndUpdate(
            { project: projectId, module: moduleId },
            { $push: { reports: { $each: reportEntries } } },
            { upsert: true, new: true }
        );

        res.json({ success: true, content });
    } catch (error) {
        console.error('Upload module reports error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// ── DELETE report ──
exports.deleteModuleReport = async (req, res) => {
    try {
        const { projectId, moduleId } = req.params;
        const { reportId } = req.body;

        const content = await ModuleContent.findOne({ project: projectId, module: moduleId });
        if (!content) return res.status(404).json({ success: false, message: 'Not found' });

        const report = content.reports.id(reportId);
        if (report) {
            await deleteStoredAsset(report.filePath);
            content.reports.pull(reportId);
            await content.save();
        }

        res.json({ success: true, content });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
};
