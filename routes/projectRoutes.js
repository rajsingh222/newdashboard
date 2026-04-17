const express = require('express');
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { protect, authorize } = require('../middleware/auth');
const Project = require('../models/Project');

const router = express.Router();

const toProjectCode = (name = '') => String(name || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 20) || `PRJ-${Date.now()}`;

router.use(protect);

router.get('/', async (req, res) => {
    try {
        const query = req.user.role === 'admin' ? {} : { assignedUsers: req.user._id };

        const projects = await Project.find(query)
            .select('projectName projectCode ftp type isActive lastFetchedAt processedFiles')
            .sort({ createdAt: -1 })
            .lean();

        return res.json({
            success: true,
            count: projects.length,
            projects: projects.map((p) => ({
                id: p._id,
                name: p.projectName,
                projectCode: p.projectCode,
                ftp: p.ftp || {},
                type: p.type || 'mseed',
                isActive: Boolean(p.isActive),
                lastFetchedAt: p.lastFetchedAt || null,
                processedFilesCount: Array.isArray(p.processedFiles) ? p.processedFiles.length : 0,
            })),
        });
    } catch (error) {
        console.error('Get ingestion projects error:', error);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
});

router.post(
    '/',
    authorize('admin'),
    validate([
        body('name').notEmpty().withMessage('Project name is required'),
        body('type').isIn(['excel', 'mseed']).withMessage('type must be excel or mseed'),
        body('ftp.host').notEmpty().withMessage('ftp.host is required'),
        body('ftp.user').notEmpty().withMessage('ftp.user is required'),
        body('ftp.password').notEmpty().withMessage('ftp.password is required'),
        body('ftp.path').notEmpty().withMessage('ftp.path is required'),
    ]),
    async (req, res) => {
        try {
            const name = String(req.body.name || '').trim();
            const projectCode = String(req.body.projectCode || '').trim().toUpperCase() || toProjectCode(name);

            const existing = await Project.findOne({ projectCode });
            if (existing) {
                return res.status(400).json({ success: false, message: 'Project code already exists' });
            }

            const project = await Project.create({
                projectName: name,
                projectCode,
                description: String(req.body.description || ''),
                createdBy: req.user._id,
                assignedUsers: Array.isArray(req.body.assignedUsers) ? req.body.assignedUsers : [],
                ftp: {
                    host: String(req.body?.ftp?.host || '').trim(),
                    port: Number(req.body?.ftp?.port || 21),
                    user: String(req.body?.ftp?.user || '').trim(),
                    password: String(req.body?.ftp?.password || ''),
                    path: String(req.body?.ftp?.path || '/').trim() || '/',
                },
                type: String(req.body.type || 'mseed').toLowerCase(),
                isActive: Boolean(req.body.isActive),
                lastFetchedAt: null,
                processedFiles: [],
            });

            return res.status(201).json({
                success: true,
                project: {
                    id: project._id,
                    name: project.projectName,
                    projectCode: project.projectCode,
                    ftp: project.ftp,
                    type: project.type,
                    isActive: project.isActive,
                    lastFetchedAt: project.lastFetchedAt,
                },
            });
        } catch (error) {
            console.error('Create ingestion project error:', error);
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }
);

module.exports = router;
