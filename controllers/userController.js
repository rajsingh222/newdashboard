const mongoose = require('mongoose');
const User = require('../models/User');
const Project = require('../models/Project');
const {
    EMAIL_RE,
    isValidLoginId,
    placeholderEmail,
    isPlaceholderEmail,
    loginIdQuery,
} = require('../utils/loginId');

const MIN_PASSWORD_LENGTH = 8;
const LOGIN_ID_MESSAGE =
    'Login ID must be 3-30 characters: letters, numbers and . _ @ - only (e.g. markandaproject@sppl)';

const populateUser = (query) =>
    query
        .populate('assignedModules')
        .populate('assignedProjects')
        .populate('createdBy', 'name email');

const toIdList = (value) =>
    (Array.isArray(value) ? value : [])
        .map((v) => (v && typeof v === 'object' ? v._id : v))
        .filter((v) => mongoose.isValidObjectId(v))
        .map(String);

/**
 * Keep Project.assignedUsers in step with User.assignedProjects.
 * Project.assignedUsers is what verifyProjectAccess checks, so both sides must agree.
 */
const syncProjectAssignments = async (userId, previousProjectIds, nextProjectIds) => {
    const prev = new Set(previousProjectIds.map(String));
    const next = new Set(nextProjectIds.map(String));
    const removed = [...prev].filter((id) => !next.has(id));
    const added = [...next].filter((id) => !prev.has(id));

    if (removed.length) {
        await Project.updateMany({ _id: { $in: removed } }, { $pull: { assignedUsers: userId } });
    }
    if (added.length) {
        await Project.updateMany({ _id: { $in: added } }, { $addToSet: { assignedUsers: userId } });
    }
};

const validatePassword = (password) =>
    typeof password === 'string' && password.length >= MIN_PASSWORD_LENGTH
        ? null
        : `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;

// @desc    Get all users
// @route   GET /api/users
// @access  Private (admin)
exports.getUsers = async (req, res) => {
    try {
        const users = await populateUser(User.find()).sort({ createdAt: -1 });

        res.status(200).json({
            success: true,
            count: users.length,
            users,
        });
    } catch (error) {
        console.error('Get users error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error fetching users',
        });
    }
};

// @desc    Get single user
// @route   GET /api/users/:id
// @access  Private (admin)
exports.getUser = async (req, res) => {
    try {
        const user = await populateUser(User.findById(req.params.id));

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found',
            });
        }

        res.status(200).json({
            success: true,
            user,
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Server error',
        });
    }
};

// @desc    Create user (login ID + password issued by an administrator)
// @route   POST /api/users
// @access  Private (admin)
exports.createUser = async (req, res) => {
    try {
        const { name, email, username, password, role, assignedModules, assignedProjects } = req.body;

        const loginId = String(username || '').trim();
        if (!isValidLoginId(loginId)) {
            return res.status(400).json({ success: false, message: LOGIN_ID_MESSAGE });
        }

        const passwordError = validatePassword(password);
        if (passwordError) {
            return res.status(400).json({ success: false, message: passwordError });
        }

        const emailValue = String(email || '').trim().toLowerCase() || placeholderEmail(loginId);
        if (!EMAIL_RE.test(emailValue)) {
            return res.status(400).json({ success: false, message: 'Please provide a valid email address or leave it blank' });
        }

        const existingUser = await User.findOne({
            $or: [{ email: emailValue }, loginIdQuery(loginId)],
        });
        if (existingUser) {
            return res.status(400).json({
                success: false,
                message: 'A user with that login ID or email already exists',
            });
        }

        const moduleIds = toIdList(assignedModules);
        const projectIds = toIdList(assignedProjects);

        const user = await User.create({
            name: String(name || '').trim(),
            email: emailValue,
            username: loginId,
            password,
            role: role === 'admin' ? 'admin' : 'user',
            assignedModules: moduleIds,
            assignedProjects: projectIds,
            createdBy: req.user.id,
        });

        await syncProjectAssignments(user._id, [], projectIds);

        const populatedUser = await populateUser(User.findById(user._id));

        res.status(201).json({
            success: true,
            user: populatedUser,
        });
    } catch (error) {
        console.error('Create user error:', error);
        if (error.code === 11000) {
            return res.status(400).json({
                success: false,
                message: 'A user with that login ID or email already exists',
            });
        }
        if (error.name === 'ValidationError') {
            return res.status(400).json({
                success: false,
                message: Object.values(error.errors).map((e) => e.message).join(', '),
            });
        }
        res.status(500).json({
            success: false,
            message: 'Server error creating user',
        });
    }
};

// @desc    Update user (details, password reset, module + project access)
// @route   PUT /api/users/:id
// @access  Private (admin)
exports.updateUser = async (req, res) => {
    try {
        const { name, email, username, role, isActive, assignedModules, assignedProjects, password } =
            req.body;

        const user = await User.findById(req.params.id);

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found',
            });
        }

        const isSelf = user._id.toString() === req.user._id.toString();
        if (isSelf && isActive === false) {
            return res.status(403).json({ success: false, message: 'You cannot deactivate your own account' });
        }
        if (isSelf && role && role !== 'admin') {
            return res.status(403).json({ success: false, message: 'You cannot remove your own admin role' });
        }

        const updateFields = {};
        if (name) updateFields.name = String(name).trim();
        if (role) updateFields.role = role === 'admin' ? 'admin' : 'user';
        if (typeof isActive === 'boolean') updateFields.isActive = isActive;

        // Login ID (username) change
        let nextLoginId = user.username;
        if (username && String(username).trim() !== user.username) {
            nextLoginId = String(username).trim();
            if (!isValidLoginId(nextLoginId)) {
                return res.status(400).json({ success: false, message: LOGIN_ID_MESSAGE });
            }
            const clash = await User.findOne({ ...loginIdQuery(nextLoginId), _id: { $ne: user._id } });
            if (clash) {
                return res.status(400).json({ success: false, message: 'That login ID is already taken' });
            }
            updateFields.username = nextLoginId;
        }

        // Email: explicit value wins; blank keeps/regenerates the placeholder
        const emailInput = email === undefined ? undefined : String(email).trim().toLowerCase();
        let nextEmail = user.email;
        if (emailInput) {
            nextEmail = emailInput;
        } else if (emailInput === '' || (updateFields.username && isPlaceholderEmail(user.email))) {
            nextEmail = placeholderEmail(nextLoginId);
        }
        if (nextEmail !== user.email) {
            if (!EMAIL_RE.test(nextEmail)) {
                return res.status(400).json({ success: false, message: 'Please provide a valid email address or leave it blank' });
            }
            const clash = await User.findOne({ email: nextEmail, _id: { $ne: user._id } });
            if (clash) {
                return res.status(400).json({ success: false, message: 'That email is already in use' });
            }
            updateFields.email = nextEmail;
        }

        if (assignedModules !== undefined) updateFields.assignedModules = toIdList(assignedModules);

        if (assignedProjects !== undefined) {
            const nextProjects = toIdList(assignedProjects);
            await syncProjectAssignments(user._id, (user.assignedProjects || []).map(String), nextProjects);
            updateFields.assignedProjects = nextProjects;
        }

        // Password reset (hashed by the pre-save hook)
        if (password) {
            const passwordError = validatePassword(password);
            if (passwordError) {
                return res.status(400).json({ success: false, message: passwordError });
            }
            user.password = password;
            await user.save();
        }

        const updated = await populateUser(
            User.findByIdAndUpdate(req.params.id, updateFields, { new: true, runValidators: true })
        );

        res.status(200).json({
            success: true,
            user: updated,
        });
    } catch (error) {
        console.error('Update user error:', error);
        if (error.code === 11000) {
            return res.status(400).json({
                success: false,
                message: 'A user with that login ID or email already exists',
            });
        }
        if (error.name === 'ValidationError') {
            return res.status(400).json({
                success: false,
                message: Object.values(error.errors).map((e) => e.message).join(', '),
            });
        }
        res.status(500).json({
            success: false,
            message: 'Server error updating user',
        });
    }
};

// @desc    Delete user
// @route   DELETE /api/users/:id
// @access  Private (admin)
exports.deleteUser = async (req, res) => {
    try {
        const user = await User.findById(req.params.id);

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found',
            });
        }

        // Prevent deleting yourself
        if (user._id.toString() === req.user._id.toString()) {
            return res.status(403).json({
                success: false,
                message: 'Cannot delete your own account',
            });
        }

        await User.findByIdAndDelete(req.params.id);
        await Project.updateMany({ assignedUsers: user._id }, { $pull: { assignedUsers: user._id } });

        res.status(200).json({
            success: true,
            message: 'User deleted successfully',
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Server error deleting user',
        });
    }
};
