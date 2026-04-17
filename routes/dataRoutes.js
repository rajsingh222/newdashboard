const express = require('express');
const mongoose = require('mongoose');
const Data = require('../models/Data');
const Project = require('../models/Project');
const { protect } = require('../middleware/auth');

const router = express.Router();

router.use(protect);

router.get('/', async (req, res) => {
    try {
        const { projectId } = req.query;
        const query = {};

        if (projectId) {
            if (!mongoose.Types.ObjectId.isValid(projectId)) {
                return res.status(400).json({ success: false, message: 'Invalid projectId' });
            }

            if (req.user.role !== 'admin') {
                const canAccess = await Project.exists({
                    _id: projectId,
                    assignedUsers: req.user._id,
                });

                if (!canAccess) {
                    return res.status(403).json({ success: false, message: 'You do not have access to this project' });
                }
            }

            query.projectId = projectId;
        } else if (req.user.role !== 'admin') {
            const assignedProjectIds = (req.user.assignedProjects || []).map((p) => String(p._id || p));
            if (!assignedProjectIds.length) {
                return res.json({ success: true, count: 0, data: [] });
            }
            query.projectId = { $in: assignedProjectIds };
        }

        const data = await Data.find(query)
            .sort({ timestamp: -1 })
            .limit(100)
            .lean();

        return res.json({ success: true, count: data.length, data });
    } catch (error) {
        console.error('Get data error:', error);
        return res.status(500).json({ success: false, message: 'Server error fetching data' });
    }
});

module.exports = router;
