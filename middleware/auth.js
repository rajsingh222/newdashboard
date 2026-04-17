const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Project = require('../models/Project');

// Protect routes - verify JWT token
const protect = async (req, res, next) => {
    let token;

    // Check for token in Authorization header
    if (
        req.headers.authorization &&
        req.headers.authorization.startsWith('Bearer')
    ) {
        token = req.headers.authorization.split(' ')[1];
    }

    // SSE/EventSource clients cannot set custom Authorization headers.
    // Allow token via query param for GET streaming endpoints.
    if (!token && req.method === 'GET' && typeof req.query?.token === 'string') {
        token = req.query.token;
    }

    if (!token) {
        return res.status(401).json({
            success: false,
            message: 'Not authorized to access this route',
        });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = await User.findById(decoded.id)
            .populate('assignedModules')
            .populate('assignedProjects');

        if (!req.user) {
            return res.status(401).json({
                success: false,
                message: 'User not found',
            });
        }

        if (!req.user.isActive) {
            return res.status(401).json({
                success: false,
                message: 'Account has been deactivated. Contact your administrator.',
            });
        }

        next();
    } catch (error) {
        return res.status(401).json({
            success: false,
            message: 'Not authorized to access this route',
        });
    }
};

// Authorize by role
const authorize = (...roles) => {
    return (req, res, next) => {
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({
                success: false,
                message: `Role '${req.user.role}' is not authorized to access this route`,
            });
        }
        next();
    };
};

// Verify project access - check user is assigned to the project
const verifyProjectAccess = async (req, res, next) => {
    try {
        const projectId = req.params.projectId || req.params.id;

        if (!projectId) {
            return res.status(400).json({
                success: false,
                message: 'Project ID is required',
            });
        }

        const project = await Project.findById(projectId)
            .populate('allowedModules')
            .populate('assignedUsers', 'name email username role');

        if (!project) {
            return res.status(404).json({
                success: false,
                message: 'Project not found',
            });
        }

        // Admin bypasses project access check
        if (req.user.role === 'admin') {
            req.project = project;
            return next();
        }

        // Check if user is assigned to this project
        const isAssigned = project.assignedUsers.some(
            (u) => u._id.toString() === req.user._id.toString()
        );

        if (!isAssigned) {
            return res.status(403).json({
                success: false,
                message: 'You do not have access to this project',
            });
        }

        req.project = project;
        next();
    } catch (error) {
        console.error('Project access verification error:', error);
        return res.status(500).json({
            success: false,
            message: 'Error verifying project access',
        });
    }
};

module.exports = { protect, authorize, verifyProjectAccess };

