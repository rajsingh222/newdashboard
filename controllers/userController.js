const User = require('../models/User');

// @desc    Get all users
// @route   GET /api/users
// @access  Private (admin)
exports.getUsers = async (req, res) => {
    try {
        const users = await User.find()
            .populate('assignedModules')
            .populate('assignedProjects')
            .populate('createdBy', 'name email')
            .sort({ createdAt: -1 });

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
        const user = await User.findById(req.params.id)
            .populate('assignedModules')
            .populate('assignedProjects')
            .populate('createdBy', 'name email');

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

// @desc    Create user
// @route   POST /api/users
// @access  Private (admin)
exports.createUser = async (req, res) => {
    try {
        const { name, email, username, password, role, assignedModules, assignedProjects } = req.body;

        // Check if email or username already exists
        const existingUser = await User.findOne({
            $or: [{ email: email.toLowerCase() }, { username }],
        });

        if (existingUser) {
            return res.status(400).json({
                success: false,
                message: 'A user with that email or username already exists',
            });
        }

        const user = await User.create({
            name,
            email,
            username,
            password,
            role: role || 'user',
            assignedModules: assignedModules || [],
            assignedProjects: assignedProjects || [],
            createdBy: req.user.id,
        });

        const populatedUser = await User.findById(user._id)
            .populate('assignedModules')
            .populate('assignedProjects')
            .populate('createdBy', 'name email');

        res.status(201).json({
            success: true,
            user: populatedUser,
        });
    } catch (error) {
        console.error('Create user error:', error);
        if (error.code === 11000) {
            return res.status(400).json({
                success: false,
                message: 'Duplicate field value entered',
            });
        }
        res.status(500).json({
            success: false,
            message: 'Server error creating user',
        });
    }
};

// @desc    Update user
// @route   PUT /api/users/:id
// @access  Private (admin)
exports.updateUser = async (req, res) => {
    try {
        const { name, email, username, role, isActive, assignedModules, assignedProjects, password } =
            req.body;

        let user = await User.findById(req.params.id);

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found',
            });
        }

        // Build update object
        const updateFields = {};
        if (name) updateFields.name = name;
        if (email) updateFields.email = email;
        if (username) updateFields.username = username;
        if (role) updateFields.role = role;
        if (typeof isActive === 'boolean') updateFields.isActive = isActive;
        if (assignedModules) updateFields.assignedModules = assignedModules;
        if (assignedProjects) updateFields.assignedProjects = assignedProjects;

        // Handle password reset
        if (password) {
            user.password = password;
            await user.save(); // triggers pre-save hook for hashing
        }

        user = await User.findByIdAndUpdate(req.params.id, updateFields, {
            new: true,
            runValidators: true,
        })
            .populate('assignedModules')
            .populate('assignedProjects')
            .populate('createdBy', 'name email');

        res.status(200).json({
            success: true,
            user,
        });
    } catch (error) {
        console.error('Update user error:', error);
        if (error.code === 11000) {
            return res.status(400).json({
                success: false,
                message: 'Duplicate field value entered',
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
