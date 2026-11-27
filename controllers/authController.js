const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../models/User');
const sendEmail = require('../utils/sendEmail');
const { loginIdQuery } = require('../utils/loginId');

// Generate JWT Token
const generateToken = (id) => {
    return jwt.sign({ id }, process.env.JWT_SECRET, {
        expiresIn: process.env.JWT_EXPIRE || '7d',
    });
};

// @desc    Login user
// @route   POST /api/auth/login
// @access  Public
exports.login = async (req, res) => {
    try {
        const { login, password } = req.body;

        if (!login || !password) {
            return res.status(400).json({
                success: false,
                message: 'Please provide email/username and password',
            });
        }

        // Find user by email or login ID (username) — both case-insensitive
        const loginValue = String(login).trim();
        const user = await User.findOne({
            $or: [{ email: loginValue.toLowerCase() }, loginIdQuery(loginValue)],
        }).select('+password').populate('assignedModules').populate('assignedProjects');

        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials',
            });
        }

        if (!user.isActive) {
            return res.status(401).json({
                success: false,
                message: 'Account has been deactivated. Contact your administrator.',
            });
        }

        // Check password
        const isMatch = await user.comparePassword(password);
        if (!isMatch) {
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials',
            });
        }

        const token = generateToken(user._id);

        // Remove password from response
        const userResponse = user.toObject();
        delete userResponse.password;

        res.status(200).json({
            success: true,
            token,
            user: userResponse,
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error during login',
        });
    }
};

// @desc    Get current logged-in user
// @route   GET /api/auth/me
// @access  Private
exports.getMe = async (req, res) => {
    try {
        const user = await User.findById(req.user.id)
            .populate('assignedModules')
            .populate('assignedProjects');
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

// @desc    Register a new user (Signup)
// @route   POST /api/auth/signup
// @access  Public
exports.signup = async (req, res) => {
    try {
        const { name, email, username, password, phoneNumber, organization, designation } = req.body;

        if (!name || !email || !username || !password) {
            return res.status(400).json({
                success: false,
                message: 'Please provide all required fields: name, email, username, password',
            });
        }

        // Check if user with email or username already exists
        const existingEmail = await User.findOne({ email: email.toLowerCase().trim() });
        if (existingEmail) {
            return res.status(400).json({
                success: false,
                message: 'An account with this email already exists',
            });
        }

        const existingUsername = await User.findOne({ username: username.trim() });
        if (existingUsername) {
            return res.status(400).json({
                success: false,
                message: 'This username is already taken',
            });
        }

        // Create new user (default role: user, isActive: true, empty projects/modules)
        const user = await User.create({
            name: name.trim(),
            email: email.toLowerCase().trim(),
            username: username.trim(),
            password: password,
            phoneNumber: (phoneNumber || '').trim(),
            organization: (organization || '').trim(),
            designation: (designation || '').trim(),
            role: 'user',
            isActive: true,
            assignedProjects: [],
            assignedModules: [],
        });

        const token = generateToken(user._id);
        const userResponse = user.toObject();
        delete userResponse.password;

        res.status(201).json({
            success: true,
            token,
            user: userResponse,
            message: 'Registration successful! Welcome to Sanrachna Prahari.',
        });
    } catch (error) {
        console.error('Signup error:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Server error during registration',
        });
    }
};

// @desc    Logout user (client-side token removal)
// @route   POST /api/auth/logout
// @access  Private
exports.logout = async (req, res) => {
    res.status(200).json({
        success: true,
        message: 'Logged out successfully',
    });
};

// @desc    Forgot Password - Send Reset Token Email
// @route   POST /api/auth/forgotpassword
// @access  Public
exports.forgotPassword = async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({
                success: false,
                message: 'Please provide a valid email address',
            });
        }

        const user = await User.findOne({ email: email.toLowerCase().trim() });
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'There is no user registered with that email address',
            });
        }

        // Get reset token from user instance method
        const resetToken = user.getResetPasswordToken();
        await user.save({ validateBeforeSave: false });

        // Build reset URL using CLIENT_URL (Hostinger domain in production, localhost in dev)
        const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
        const resetUrl = `${clientUrl.replace(/\/$/, '')}/reset-password/${resetToken}`;

        const message = `You are receiving this email because you (or someone else) requested a password reset for your Sanrachna Prahari account.\n\nPlease click the link below or paste it into your browser to complete the process:\n\n${resetUrl}\n\nThis link will expire in 10 minutes.\nIf you did not request this, please ignore this email.`;

        const html = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e5e7eb; border-radius: 12px; background: #ffffff;">
                <div style="text-align: center; padding-bottom: 20px; border-bottom: 1px solid #f3f4f6;">
                    <h2 style="color: #1a1a2e; margin: 0; font-size: 22px; font-weight: 800;">Sanrachna Prahari</h2>
                    <p style="color: #d4a017; margin: 5px 0 0 0; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px;">An IIT Delhi Incubated Company</p>
                </div>
                <div style="padding: 25px 0; color: #374151; line-height: 1.6;">
                    <h3 style="color: #111827; margin-top: 0;">Password Reset Request</h3>
                    <p>Hello <strong>${user.name}</strong>,</p>
                    <p>We received a request to reset the password for your Sanrachna Prahari Portal account (<code>${user.email}</code>).</p>
                    <div style="text-align: center; margin: 30px 0;">
                        <a href="${resetUrl}" target="_blank" style="background: linear-gradient(135deg, #1a1a2e, #2d2d44); color: #ffffff; text-decoration: none; padding: 14px 28px; border-radius: 10px; font-weight: bold; display: inline-block; font-size: 15px; border: 1px solid #d4a017;">Reset Password</a>
                    </div>
                    <p style="font-size: 13px; color: #6b7280;">If the button above does not work, copy and paste this URL into your browser:</p>
                    <p style="font-size: 12px; word-break: break-all; color: #3b82f6; background: #f8fafc; padding: 10px; border-radius: 6px;">${resetUrl}</p>
                    <p style="font-size: 13px; color: #dc2626; font-weight: 600;">⏰ Note: This reset link will expire in 10 minutes.</p>
                    <p style="font-size: 13px; color: #6b7280;">If you did not request a password reset, please ignore this email or contact support if you have concerns.</p>
                </div>
                <div style="border-top: 1px solid #f3f4f6; padding-top: 15px; text-align: center; font-size: 12px; color: #9ca3af;">
                    &copy; ${new Date().getFullYear()} Sanrachna Prahari Private Limited. All rights reserved.
                </div>
            </div>
        `;

        try {
            await sendEmail({
                email: user.email,
                subject: 'Sanrachna Prahari - Password Reset Request',
                message,
                html,
            });

            res.status(200).json({
                success: true,
                message: 'Password reset link sent to your email address',
            });
        } catch (err) {
            console.error('Email send error:', err);
            user.resetPasswordToken = undefined;
            user.resetPasswordExpire = undefined;
            await user.save({ validateBeforeSave: false });

            return res.status(500).json({
                success: false,
                message: 'Email could not be sent. Please check server configuration.',
            });
        }
    } catch (error) {
        console.error('Forgot password error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error during forgot password request',
        });
    }
};

// @desc    Reset Password
// @route   PUT /api/auth/resetpassword/:resettoken
// @access  Public
exports.resetPassword = async (req, res) => {
    try {
        const { password } = req.body;
        if (!password || password.length < 6) {
            return res.status(400).json({
                success: false,
                message: 'Please provide a valid password (minimum 6 characters)',
            });
        }

        // Get hashed token
        const resetPasswordToken = crypto
            .createHash('sha256')
            .update(req.params.resettoken)
            .digest('hex');

        const user = await User.findOne({
            resetPasswordToken,
            resetPasswordExpire: { $gt: Date.now() },
        });

        if (!user) {
            return res.status(400).json({
                success: false,
                message: 'Invalid or expired password reset token',
            });
        }

        // Set new password (pre-save hook will hash it)
        user.password = password;
        user.resetPasswordToken = undefined;
        user.resetPasswordExpire = undefined;
        await user.save();

        const token = generateToken(user._id);
        const userResponse = user.toObject();
        delete userResponse.password;

        res.status(200).json({
            success: true,
            token,
            user: userResponse,
            message: 'Password updated successfully! You are now logged in.',
        });
    } catch (error) {
        console.error('Reset password error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error during password reset',
        });
    }
};


// @desc    Change own password
// @route   PUT /api/auth/change-password
// @access  Private
exports.changePassword = async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ success: false, message: 'Current and new password are required' });
        }
        if (String(newPassword).length < 8) {
            return res.status(400).json({ success: false, message: 'New password must be at least 8 characters' });
        }
        const user = await User.findById(req.user._id).select('+password');
        if (!(await user.comparePassword(currentPassword))) {
            return res.status(401).json({ success: false, message: 'Current password is incorrect' });
        }
        user.password = newPassword; // hashed by the pre-save hook
        await user.save();
        res.status(200).json({ success: true, message: 'Password changed successfully' });
    } catch (error) {
        console.error('Change password error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// @desc    Admin signs in as another user (works whatever that user's password is)
// @route   POST /api/auth/impersonate/:userId
// @access  Admin
exports.impersonate = async (req, res) => {
    try {
        const target = await User.findById(req.params.userId)
            .populate('assignedModules')
            .populate('assignedProjects');
        if (!target) return res.status(404).json({ success: false, message: 'User not found' });
        if (target.role === 'admin') {
            return res.status(400).json({ success: false, message: 'Cannot impersonate an admin account' });
        }
        if (!target.isActive) {
            return res.status(400).json({ success: false, message: 'This account is deactivated' });
        }
        const token = jwt.sign({ id: target._id, impersonatedBy: req.user._id }, process.env.JWT_SECRET, {
            expiresIn: '2h',
        });
        console.log(`[AUDIT] admin ${req.user.username || req.user._id} impersonated ${target.username || target._id}`);
        const userResponse = target.toObject();
        delete userResponse.password;
        res.status(200).json({ success: true, token, user: userResponse });
    } catch (error) {
        console.error('Impersonate error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};
