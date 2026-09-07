const { getFirebaseAdmin } = require('../config/firebaseAdmin');
const Project = require('../models/Project');
const User = require('../models/User');
const logger = require('../utils/logger');

const chunk = (items, size) => {
    const chunks = [];
    for (let index = 0; index < items.length; index += size) {
        chunks.push(items.slice(index, index + size));
    }
    return chunks;
};

const compactTokenDocs = (users) => {
    const tokenMap = new Map();

    for (const user of users) {
        for (const tokenDoc of user.fcmTokens || []) {
            const token = String(tokenDoc?.token || '').trim();
            if (token) tokenMap.set(token, user._id);
        }
    }

    return Array.from(tokenMap.keys());
};

const removeInvalidTokens = async (tokens = []) => {
    if (!tokens.length) return;

    await User.updateMany(
        { 'fcmTokens.token': { $in: tokens } },
        { $pull: { fcmTokens: { token: { $in: tokens } } } }
    );
};

exports.sendEventNotificationToProjectUsers = async ({ projectId, eventDoc }) => {
    const admin = getFirebaseAdmin();
    if (!admin) {
        logger.warn('Skipping FCM notification because Firebase Admin is not configured');
        return;
    }

    const project = await Project.findById(projectId).select('assignedUsers projectName');
    const assignedUserIds = Array.isArray(project?.assignedUsers) ? project.assignedUsers : [];

    const users = await User.find({
        isActive: true,
        'fcmTokens.0': { $exists: true },
        $or: [
            { assignedProjects: projectId },
            { _id: { $in: assignedUserIds } },
        ],
    }).select('+fcmTokens');

    const tokens = compactTokenDocs(users);
    if (!tokens.length) {
        logger.warn('No FCM tokens found for event notification targets', {
            projectId: String(projectId || ''),
            eventId: String(eventDoc?._id || ''),
            assignedUsers: assignedUserIds.length,
        });
        return {
            sent: false,
            recipientCount: users.length,
            tokenCount: 0,
            message: 'No FCM tokens found for event notification targets',
        };
    }

    const title = `${eventDoc.severity || 'New'} Event Detected`;
    const body = `${eventDoc.eventType || 'Event'} detected in ${eventDoc.projectName || project?.projectName || 'project'}`;
    const invalidTokens = [];

    for (const tokenBatch of chunk(tokens, 500)) {
        const response = await admin.messaging().sendEachForMulticast({
            tokens: tokenBatch,
            notification: {
                title,
                body,
            },
            data: {
                eventId: String(eventDoc._id || ''),
                projectId: String(eventDoc.projectId || projectId || ''),
                eventType: String(eventDoc.eventType || ''),
                severity: String(eventDoc.severity || ''),
                url: `/project/${String(eventDoc.projectId || projectId)}/modules/threshold-alerts`,
            },
        });

        response.responses.forEach((sendResponse, index) => {
            if (sendResponse.success) return;

            const code = sendResponse.error?.code;
            if (
                code === 'messaging/registration-token-not-registered' ||
                code === 'messaging/invalid-registration-token'
            ) {
                invalidTokens.push(tokenBatch[index]);
            }
        });

        logger.info('FCM event notification sent', {
            projectId: String(projectId),
            eventId: String(eventDoc?._id || ''),
            recipientCount: users.length,
            tokenCount: tokens.length,
            successCount: response.successCount,
            failureCount: response.failureCount,
        });
    }

    await removeInvalidTokens(invalidTokens);

    return {
        sent: true,
        recipientCount: users.length,
        tokenCount: tokens.length,
        invalidTokenCount: invalidTokens.length,
        message: 'Event notification attempted',
    };
};

exports.sendTestNotificationToUser = async (userId) => {
    const admin = getFirebaseAdmin();
    if (!admin) {
        throw new Error('Firebase Admin is not configured');
    }

    const user = await User.findById(userId).select('+fcmTokens');
    const tokens = compactTokenDocs(user ? [user] : []);

    if (!tokens.length) {
        return {
            sent: false,
            tokenCount: 0,
            message: 'No FCM tokens saved for this user. Log in again and allow notifications.',
        };
    }

    const response = await admin.messaging().sendEachForMulticast({
        tokens,
        notification: {
            title: 'Dashboard notification test',
            body: 'FCM is connected for your logged-in account.',
        },
        data: {
            url: '/home',
            type: 'test',
        },
    });

    const invalidTokens = [];
    response.responses.forEach((sendResponse, index) => {
        if (sendResponse.success) return;

        const code = sendResponse.error?.code;
        if (
            code === 'messaging/registration-token-not-registered' ||
            code === 'messaging/invalid-registration-token'
        ) {
            invalidTokens.push(tokens[index]);
        }
    });

    await removeInvalidTokens(invalidTokens);

    return {
        sent: response.successCount > 0,
        tokenCount: tokens.length,
        successCount: response.successCount,
        failureCount: response.failureCount,
        invalidTokenCount: invalidTokens.length,
        message: response.successCount > 0
            ? 'Test notification sent'
            : 'Firebase attempted to send, but every token failed',
    };
};
