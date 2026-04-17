const Project = require('../models/Project');
const User = require('../models/User');
const SHMLiveSource = require('../models/SHMLiveSource');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const {
    isCloudinaryReady,
    uploadLocalFileToCloudinary,
    deleteCloudinaryAssetByUrl,
    cleanupLocalFile,
} = require('../utils/cloudinaryStorage');

// Multer config for project images
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, '..', 'uploads', 'projects');
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    },
});

const fileFilter = (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extOk = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimeOk = allowedTypes.test(file.mimetype);
    cb(null, extOk && mimeOk);
};

exports.imageUpload = multer({
    storage,
    fileFilter,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
}).array('images', 10);

const thresholdPdfStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, '..', 'uploads', 'projects', 'threshold-pdfs');
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        cb(null, `threshold-${uniqueSuffix}${path.extname(file.originalname).toLowerCase()}`);
    },
});

const thresholdPdfFilter = (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const isPdf = ext === '.pdf' && file.mimetype === 'application/pdf';
    cb(null, isPdf);
};

exports.thresholdAlertPdfUpload = multer({
    storage: thresholdPdfStorage,
    fileFilter: thresholdPdfFilter,
    limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
}).single('thresholdPdf');

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
    if (diskPath && fs.existsSync(diskPath)) {
        fs.unlinkSync(diskPath);
    }
};

const normalizeFtpPayload = (ftp = {}) => {
    const next = {
        host: (ftp.host || '').toString().trim(),
        port: Number(ftp.port || 21),
        user: (ftp.user || '').toString().trim(),
        password: (ftp.password || '').toString(),
        path: (ftp.path || '/').toString().trim() || '/',
    };

    if (!Number.isFinite(next.port) || next.port < 1 || next.port > 65535) {
        next.port = 21;
    }

    if (!next.path.startsWith('/')) {
        next.path = `/${next.path}`;
    }

    return next;
};

const normalizeEventThresholds = (thresholds = {}) => {
    const toNumberOrDefault = (value, fallback) => {
        const num = Number(value);
        return Number.isFinite(num) ? num : fallback;
    };

    return {
        peakSevere: toNumberOrDefault(thresholds.peakSevere, 2000),
        peakImpact: toNumberOrDefault(thresholds.peakImpact, 1000),
        impactDurationSec: toNumberOrDefault(thresholds.impactDurationSec, 2),
        rmsContinuous: toNumberOrDefault(thresholds.rmsContinuous, 300),
        continuousDurationSec: toNumberOrDefault(thresholds.continuousDurationSec, 10),
    };
};

const sanitizeProjectForRole = (projectDoc, role) => {
    if (role === 'admin' || !projectDoc) return projectDoc;

    const raw = typeof projectDoc.toObject === 'function' ? projectDoc.toObject() : { ...projectDoc };
    return {
        ...raw,
        ftp: {
            host: '',
            port: 21,
            user: '',
            password: '',
            path: '/',
        },
    };
};

const syncDynamicLiveSourceFromProject = async (projectDoc) => {
    if (!projectDoc?._id) return;

    const ftpConfig = normalizeFtpPayload(projectDoc.ftp || {});
    const activeForDynamic = Boolean(projectDoc.isActive) && String(projectDoc.type || 'mseed') === 'mseed';

    await SHMLiveSource.findOneAndUpdate(
        { project: projectDoc._id, type: 'dynamic' },
        {
            $set: {
                sourceName: 'Primary Source',
                ftpHost: ftpConfig.host,
                ftpPort: ftpConfig.port,
                ftpUser: ftpConfig.user,
                ftpPassword: ftpConfig.password,
                ftpPath: ftpConfig.path,
                isActive: activeForDynamic,
            },
        },
        {
            new: true,
            upsert: true,
            runValidators: true,
            setDefaultsOnInsert: true,
        }
    );
};

// @desc    Create project
// @route   POST /api/projects
// @access  Private (admin)
exports.createProject = async (req, res) => {
    try {
        const {
            projectName, projectCode, description, startDate, endDate,
            allowedModules, assignedUsers,
            location, latitude, longitude, structureType, projectType, clientName,
            thresholdAlertPdf,
            ftp, type, isActive, lastFetchedAt, lastRealtimeFile, processedFiles, eventThresholds,
        } = req.body;

        const existing = await Project.findOne({ projectCode: projectCode.toUpperCase() });
        if (existing) {
            return res.status(400).json({ success: false, message: 'Project code already exists' });
        }

        const project = await Project.create({
            projectName,
            projectCode: projectCode.toUpperCase(),
            description,
            startDate,
            endDate,
            allowedModules: allowedModules || [],
            assignedUsers: assignedUsers || [],
            location: location || '',
            latitude: latitude || null,
            longitude: longitude || null,
            structureType: structureType || '',
            projectType: projectType || '',
            clientName: clientName || '',
            thresholdAlertPdf: (thresholdAlertPdf || '').toString().trim(),
            ftp: normalizeFtpPayload(ftp || {}),
            type: (type === 'excel' || type === 'mseed') ? type : 'mseed',
            isActive: Boolean(isActive),
            lastFetchedAt: lastFetchedAt || null,
            lastRealtimeFile: (lastRealtimeFile || '').toString().trim(),
            processedFiles: Array.isArray(processedFiles)
                ? processedFiles.map((f) => String(f || '').trim()).filter(Boolean)
                : [],
            eventThresholds: normalizeEventThresholds(eventThresholds || {}),
            createdBy: req.user.id,
        });

        await syncDynamicLiveSourceFromProject(project);

        // Add project to each assigned user's assignedProjects
        if (assignedUsers && assignedUsers.length > 0) {
            await User.updateMany(
                { _id: { $in: assignedUsers } },
                { $addToSet: { assignedProjects: project._id } }
            );
        }

        const populated = await Project.findById(project._id)
            .populate('allowedModules')
            .populate('assignedUsers', 'name email username role')
            .populate('createdBy', 'name email');

        res.status(201).json({ success: true, project: populated });
    } catch (error) {
        console.error('Create project error:', error);
        res.status(500).json({ success: false, message: 'Server error creating project' });
    }
};

// @desc    Get all projects (filtered by user access)
// @route   GET /api/projects
// @access  Private
exports.getProjects = async (req, res) => {
    try {
        let query = {};

        // Regular users only see their assigned projects, admin sees all
        if (req.user.role !== 'admin') {
            query = { assignedUsers: req.user._id };
        }

        const projects = await Project.find(query)
            .populate('allowedModules')
            .populate('assignedUsers', 'name email username role')
            .populate('createdBy', 'name email')
            .sort({ createdAt: -1 });

        const sanitizedProjects = req.user.role === 'admin'
            ? projects
            : projects.map((project) => sanitizeProjectForRole(project, req.user.role));

        res.status(200).json({ success: true, count: sanitizedProjects.length, projects: sanitizedProjects });
    } catch (error) {
        console.error('Get projects error:', error);
        res.status(500).json({ success: false, message: 'Server error fetching projects' });
    }
};

// @desc    Get single project
// @route   GET /api/projects/:id
// @access  Private (verifyProjectAccess)
exports.getProject = async (req, res) => {
    try {
        const project = await Project.findById(req.params.id)
            .populate('allowedModules')
            .populate('assignedUsers', 'name email username role isActive')
            .populate('createdBy', 'name email');

        if (!project) {
            return res.status(404).json({ success: false, message: 'Project not found' });
        }

        const safeProject = sanitizeProjectForRole(project, req.user.role);
        res.status(200).json({ success: true, project: safeProject });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// @desc    Update project
// @route   PUT /api/projects/:id
// @access  Private (admin)
exports.updateProject = async (req, res) => {
    try {
        const {
            projectName, projectCode, description, startDate, endDate, status,
            allowedModules, assignedUsers,
            location, latitude, longitude, structureType, projectType, clientName,
            thresholdAlertPdf,
            ftp, type, isActive, lastFetchedAt, lastRealtimeFile, processedFiles, eventThresholds,
        } = req.body;

        let project = await Project.findById(req.params.id);
        if (!project) {
            return res.status(404).json({ success: false, message: 'Project not found' });
        }

        // Handle user assignment changes
        if (assignedUsers) {
            const oldUsers = project.assignedUsers.map(u => u.toString());
            const newUsers = assignedUsers;

            // Remove project from users who were unassigned
            const removedUsers = oldUsers.filter(u => !newUsers.includes(u));
            if (removedUsers.length > 0) {
                await User.updateMany(
                    { _id: { $in: removedUsers } },
                    { $pull: { assignedProjects: project._id } }
                );
            }

            // Add project to newly assigned users
            const addedUsers = newUsers.filter(u => !oldUsers.includes(u));
            if (addedUsers.length > 0) {
                await User.updateMany(
                    { _id: { $in: addedUsers } },
                    { $addToSet: { assignedProjects: project._id } }
                );
            }
        }

        const updateFields = {};
        if (projectName) updateFields.projectName = projectName;
        if (projectCode) updateFields.projectCode = projectCode.toUpperCase();
        if (description !== undefined) updateFields.description = description;
        if (startDate) updateFields.startDate = startDate;
        if (endDate) updateFields.endDate = endDate;
        if (status) updateFields.status = status;
        if (allowedModules) updateFields.allowedModules = allowedModules;
        if (assignedUsers) updateFields.assignedUsers = assignedUsers;
        if (location !== undefined) updateFields.location = location;
        if (latitude !== undefined) updateFields.latitude = latitude;
        if (longitude !== undefined) updateFields.longitude = longitude;
        if (structureType !== undefined) updateFields.structureType = structureType;
        if (projectType !== undefined) updateFields.projectType = projectType;
        if (clientName !== undefined) updateFields.clientName = clientName;
        if (thresholdAlertPdf !== undefined) {
            updateFields.thresholdAlertPdf = (thresholdAlertPdf || '').toString().trim();
        }
        if (ftp !== undefined) updateFields.ftp = normalizeFtpPayload(ftp || {});
        if (type !== undefined && ['excel', 'mseed'].includes(String(type).toLowerCase())) {
            updateFields.type = String(type).toLowerCase();
        }
        if (isActive !== undefined) updateFields.isActive = Boolean(isActive);
        if (lastFetchedAt !== undefined) updateFields.lastFetchedAt = lastFetchedAt || null;
        if (lastRealtimeFile !== undefined) updateFields.lastRealtimeFile = (lastRealtimeFile || '').toString().trim();
        if (processedFiles !== undefined) {
            updateFields.processedFiles = Array.isArray(processedFiles)
                ? processedFiles.map((f) => String(f || '').trim()).filter(Boolean)
                : [];
        }
        if (eventThresholds !== undefined) {
            updateFields.eventThresholds = normalizeEventThresholds(eventThresholds || {});
        }

        project = await Project.findByIdAndUpdate(req.params.id, updateFields, {
            new: true,
            runValidators: true,
        })
            .populate('allowedModules')
            .populate('assignedUsers', 'name email username role')
            .populate('createdBy', 'name email');

        await syncDynamicLiveSourceFromProject(project);

        res.status(200).json({ success: true, project });
    } catch (error) {
        console.error('Update project error:', error);
        res.status(500).json({ success: false, message: 'Server error updating project' });
    }
};

// @desc    Delete project
// @route   DELETE /api/projects/:id
// @access  Private (admin)
exports.deleteProject = async (req, res) => {
    try {
        const project = await Project.findById(req.params.id);
        if (!project) {
            return res.status(404).json({ success: false, message: 'Project not found' });
        }

        // Remove project from all assigned users
        await User.updateMany(
            { assignedProjects: project._id },
            { $pull: { assignedProjects: project._id } }
        );

        await deleteStoredAsset(project.thresholdAlertPdf);

        await Project.findByIdAndDelete(req.params.id);
        await SHMLiveSource.deleteMany({ project: project._id });
        res.status(200).json({ success: true, message: 'Project deleted successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error deleting project' });
    }
};

// @desc    Assign user to project
// @route   POST /api/projects/:id/assign-user
// @access  Private (admin)
exports.assignUser = async (req, res) => {
    try {
        const { userId } = req.body;
        const project = await Project.findById(req.params.id);

        if (!project) {
            return res.status(404).json({ success: false, message: 'Project not found' });
        }

        if (project.assignedUsers.includes(userId)) {
            return res.status(400).json({ success: false, message: 'User already assigned' });
        }

        project.assignedUsers.push(userId);
        await project.save();

        await User.findByIdAndUpdate(userId, {
            $addToSet: { assignedProjects: project._id },
        });

        const populated = await Project.findById(project._id)
            .populate('allowedModules')
            .populate('assignedUsers', 'name email username role')
            .populate('createdBy', 'name email');

        res.status(200).json({ success: true, project: populated });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// @desc    Upload project images
// @route   POST /api/projects/:id/images
// @access  Private (admin)
exports.uploadImages = async (req, res) => {
    try {
        const project = await Project.findById(req.params.id);
        if (!project) {
            return res.status(404).json({ success: false, message: 'Project not found' });
        }

        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ success: false, message: 'No images uploaded' });
        }

        const projectFolder = `projects/${req.params.id}`;
        const imagePaths = await Promise.all(
            req.files.map((f) => uploadStoredFile(f, {
                subfolder: `${projectFolder}/images`,
                resourceType: 'image',
                localPublicPath: `/uploads/projects/${f.filename}`,
            }))
        );
        project.images.push(...imagePaths);
        await project.save();

        res.status(200).json({ success: true, images: project.images });
    } catch (error) {
        console.error('Upload images error:', error);
        res.status(500).json({ success: false, message: 'Server error uploading images' });
    }
};

// @desc    Delete a project image
// @route   DELETE /api/projects/:id/images
// @access  Private (admin)
exports.deleteImage = async (req, res) => {
    try {
        const { imagePath } = req.body;
        const project = await Project.findById(req.params.id);
        if (!project) {
            return res.status(404).json({ success: false, message: 'Project not found' });
        }

        project.images = project.images.filter(img => img !== imagePath);
        await project.save();

        await deleteStoredAsset(imagePath);

        res.status(200).json({ success: true, images: project.images });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// @desc    Upload threshold alerts PDF for project
// @route   POST /api/projects/:id/threshold-alerts/pdf
// @access  Private (admin)
exports.uploadThresholdAlertPdf = async (req, res) => {
    try {
        const project = await Project.findById(req.params.id);
        if (!project) {
            return res.status(404).json({ success: false, message: 'Project not found' });
        }

        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No PDF file uploaded' });
        }

        const projectFolder = `projects/${req.params.id}`;
        const nextPdfPath = await uploadStoredFile(req.file, {
            subfolder: `${projectFolder}/threshold-pdfs`,
            resourceType: 'raw',
            localPublicPath: `/uploads/projects/threshold-pdfs/${req.file.filename}`,
        });
        await deleteStoredAsset(project.thresholdAlertPdf);

        project.thresholdAlertPdf = nextPdfPath;
        await project.save();

        return res.status(200).json({ success: true, thresholdAlertPdf: project.thresholdAlertPdf });
    } catch (error) {
        console.error('Upload threshold alert PDF error:', error);
        return res.status(500).json({ success: false, message: 'Server error uploading threshold PDF' });
    }
};

// @desc    Delete threshold alerts PDF for project
// @route   DELETE /api/projects/:id/threshold-alerts/pdf
// @access  Private (admin)
exports.deleteThresholdAlertPdf = async (req, res) => {
    try {
        const project = await Project.findById(req.params.id);
        if (!project) {
            return res.status(404).json({ success: false, message: 'Project not found' });
        }

        await deleteStoredAsset(project.thresholdAlertPdf);

        project.thresholdAlertPdf = '';
        await project.save();

        return res.status(200).json({ success: true, thresholdAlertPdf: '' });
    } catch (error) {
        console.error('Delete threshold alert PDF error:', error);
        return res.status(500).json({ success: false, message: 'Server error deleting threshold PDF' });
    }
};
