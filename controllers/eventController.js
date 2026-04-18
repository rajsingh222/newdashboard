const Event = require('../models/Event');
const { getRecentEventProcessStatuses } = require('../socket/socket');

const parseLimit = (rawValue, fallback = 20) => {
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(1, Math.min(200, Math.floor(parsed)));
};

const parseSince = (rawValue) => {
    if (!rawValue) return 0;
    const numeric = Number(rawValue);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    const parsed = Date.parse(String(rawValue));
    return Number.isNaN(parsed) ? 0 : parsed;
};

// @desc    Get recent realtime events for a project
// @route   GET /api/projects/:projectId/events/recent
// @access  Private (verifyProjectAccess)
exports.getRecentProjectEvents = async (req, res) => {
    try {
        const { projectId } = req.params;
        const limit = parseLimit(req.query.limit, 20);

        const events = await Event.find({ projectId })
            .sort({ createdAt: -1 })
            .limit(limit)
            .lean();

        return res.status(200).json({
            success: true,
            count: events.length,
            events,
        });
    } catch (error) {
        console.error('Get recent project events error:', error);
        return res.status(500).json({
            success: false,
            message: 'Server error fetching project events',
        });
    }
};

// @desc    Get recent realtime event processing status updates for a project
// @route   GET /api/projects/:projectId/events/process-status/recent
// @access  Private (verifyProjectAccess)
exports.getRecentProjectEventProcessStatuses = async (req, res) => {
    try {
        const { projectId } = req.params;
        const limit = parseLimit(req.query.limit, 80);
        const since = parseSince(req.query.since);

        const statuses = getRecentEventProcessStatuses({
            projectId,
            limit,
            since,
        });

        return res.status(200).json({
            success: true,
            count: statuses.length,
            statuses,
        });
    } catch (error) {
        console.error('Get recent project event process statuses error:', error);
        return res.status(500).json({
            success: false,
            message: 'Server error fetching event process statuses',
        });
    }
};

// @desc    Manually insert a realtime event (e.g. from frontend custom socket)
// @route   POST /api/projects/:projectId/events
// @access  Private (verifyProjectAccess)
exports.createProjectEvent = async (req, res) => {
    try {
        const { projectId } = req.params;
        const { eventType, severity, peak, rms, duration, dominantFrequency, timestamp, filename } = req.body;

        const projectName = req.project ? req.project.projectName : 'Unknown Project';

        // map severity to schema enum (Low, Medium, High)
        let mappedSeverity = 'Medium';
        if (severity) {
            const lower = severity.toLowerCase();
            if (lower.includes('high') || lower.includes('critical')) mappedSeverity = 'High';
            else if (lower.includes('low')) mappedSeverity = 'Low';
        }

        // map eventType to schema enum (Severe Event, Impact Event, Continuous Vibration, Normal)
        let mappedEventType = 'Normal';
        if (eventType) {
            const lower = eventType.toLowerCase();
            if (lower.includes('sever')) mappedEventType = 'Severe Event';
            else if (lower.includes('impact')) mappedEventType = 'Impact Event';
            else if (lower.includes('continu')) mappedEventType = 'Continuous Vibration';
            else if (lower.includes('trigger')) mappedEventType = 'Severe Event'; // fallback for 'Triggered Event'
        }

        const newEvent = await Event.create({
            projectId,
            projectName,
            timestamp: timestamp || new Date(),
            peak: peak || 0,
            rms: rms || 0,
            duration: duration || 0,
            dominantFrequency: dominantFrequency || 0,
            eventType: mappedEventType,
            severity: mappedSeverity,
            sourceFile: filename || '',
        });

        return res.status(201).json({
            success: true,
            event: newEvent
        });
    } catch (error) {
        console.error('Create project event error:', error);
        return res.status(500).json({
            success: false,
            message: 'Server error creating project event',
        });
    }
};
