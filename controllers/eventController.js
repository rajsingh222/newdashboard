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
