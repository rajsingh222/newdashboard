const dotenv = require('dotenv');
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Event = require('../models/Event');
const Project = require('../models/Project');
const User = require('../models/User');
const { sendEventNotificationToProjectUsers } = require('../services/notificationService');

dotenv.config();

const getArgValue = (name) => {
    const prefixed = `--${name}=`;
    const inline = process.argv.find((arg) => arg.startsWith(prefixed));
    if (inline) return inline.slice(prefixed.length);

    const index = process.argv.indexOf(`--${name}`);
    if (index >= 0) return process.argv[index + 1];

    return '';
};

const main = async () => {
    const projectId = getArgValue('projectId');
    const shouldListProjects = process.argv.includes('--list');

    await connectDB();

    if (shouldListProjects) {
        const projects = await Project.find()
            .select('projectName projectCode assignedUsers isActive status')
            .sort({ createdAt: -1 })
            .limit(50);

        for (const project of projects) {
            const usersWithTokens = await User.countDocuments({
                isActive: true,
                'fcmTokens.0': { $exists: true },
                $or: [
                    { assignedProjects: project._id },
                    { _id: { $in: project.assignedUsers || [] } },
                ],
            });

            console.log({
                projectId: String(project._id),
                projectName: project.projectName,
                projectCode: project.projectCode,
                assignedUsers: Array.isArray(project.assignedUsers) ? project.assignedUsers.length : 0,
                usersWithTokens,
                isActive: project.isActive,
                status: project.status,
            });
        }

        return;
    }

    if (!projectId || !mongoose.Types.ObjectId.isValid(projectId)) {
        throw new Error('Usage: npm run test:trigger-notification -- --list OR -- --projectId=<projectMongoId>');
    }

    const project = await Project.findById(projectId).select('projectName assignedUsers');
    if (!project) {
        throw new Error(`Project not found: ${projectId}`);
    }

    const targetUsers = await User.find({
        isActive: true,
        'fcmTokens.0': { $exists: true },
        $or: [
            { assignedProjects: project._id },
            { _id: { $in: project.assignedUsers || [] } },
        ],
    }).select('name email +fcmTokens');

    console.log('Notification target preview:', {
        projectId: String(project._id),
        projectName: project.projectName,
        assignedUsers: Array.isArray(project.assignedUsers) ? project.assignedUsers.length : 0,
        usersWithTokens: targetUsers.length,
        tokenCount: targetUsers.reduce((sum, user) => sum + (user.fcmTokens?.length || 0), 0),
    });

    const eventDoc = await Event.create({
        projectId: project._id,
        projectName: project.projectName || 'Test Project',
        timestamp: new Date(),
        peak: 2500,
        rms: 450,
        duration: 3,
        dominantFrequency: 12,
        eventType: 'Impact Event',
        severity: 'High',
        isCritical: true,
        sourceFile: 'script-triggered-event-test.mseed',
        sourceFileFingerprint: `script-test-${Date.now()}`,
        rawSignal: [],
    });

    console.log('Created test triggered event:', {
        eventId: String(eventDoc._id),
        projectId: String(eventDoc.projectId),
    });

    const result = await sendEventNotificationToProjectUsers({
        projectId: project._id,
        eventDoc,
    });

    console.log('FCM notification result:', result);
};

main()
    .catch((error) => {
        console.error('Triggered event notification test failed:', error.message);
        process.exitCode = 1;
    })
    .finally(async () => {
        await mongoose.disconnect().catch(() => {});
    });
