const User = require('../models/User');
const Project = require('../models/Project');
const {
    sendEventNotificationToProjectUsers,
    sendTestNotificationToUser,
} = require('../services/notificationService');

exports.registerFcmToken = async (req, res) => {
    try {
        const token = String(req.body?.token || '').trim();
        const platform = String(req.body?.platform || 'web').trim() || 'web';
        const userAgent = String(req.headers['user-agent'] || '').slice(0, 500);

        if (!token) {
            return res.status(400).json({
                success: false,
                message: 'FCM token is required',
            });
        }

        await User.updateOne(
            { _id: req.user._id },
            {
                $pull: { fcmTokens: { token } },
            }
        );

        await User.updateOne(
            { _id: req.user._id },
            {
                $push: {
                    fcmTokens: {
                        token,
                        platform,
                        userAgent,
                        createdAt: new Date(),
                        lastUsedAt: new Date(),
                    },
                },
            }
        );

        return res.status(200).json({
            success: true,
            message: 'Notification token registered',
        });
    } catch (error) {
        console.error('Register FCM token error:', error);
        return res.status(500).json({
            success: false,
            message: 'Server error registering notification token',
        });
    }
};

exports.removeFcmToken = async (req, res) => {
    try {
        const token = String(req.body?.token || '').trim();

        if (!token) {
            return res.status(400).json({
                success: false,
                message: 'FCM token is required',
            });
        }

        await User.updateOne(
            { _id: req.user._id },
            {
                $pull: { fcmTokens: { token } },
            }
        );

        return res.status(200).json({
            success: true,
            message: 'Notification token removed',
        });
    } catch (error) {
        console.error('Remove FCM token error:', error);
        return res.status(500).json({
            success: false,
            message: 'Server error removing notification token',
        });
    }
};

exports.sendTestNotification = async (req, res) => {
    try {
        const result = await sendTestNotificationToUser(req.user._id);

        return res.status(200).json({
            success: true,
            ...result,
        });
    } catch (error) {
        console.error('Send test notification error:', error);
        return res.status(500).json({
            success: false,
            message: error.message || 'Server error sending test notification',
        });
    }
};

exports.sendProjectEventTestNotification = async (req, res) => {
    try {
        const { projectId } = req.params;
        const project = await Project.findById(projectId).select('projectName');

        if (!project) {
            return res.status(404).json({
                success: false,
                message: 'Project not found',
            });
        }

        const fakeEvent = {
            _id: 'test-event',
            projectId,
            projectName: project.projectName,
            eventType: 'Impact Event',
            severity: 'High',
        };

        const result = await sendEventNotificationToProjectUsers({
            projectId,
            eventDoc: fakeEvent,
        });

        return res.status(200).json({
            success: true,
            message: 'Project event test notification attempted',
            result: result || null,
        });
    } catch (error) {
        console.error('Send project event test notification error:', error);
        return res.status(500).json({
            success: false,
            message: error.message || 'Server error sending project event test notification',
        });
    }
};
