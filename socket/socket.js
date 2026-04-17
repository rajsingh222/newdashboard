const { Server } = require('socket.io');
const logger = require('../utils/logger');

let io = null;
let eventChangeStream = null;
let eventPollingTimer = null;
let pollingInProgress = false;
let lastBroadcastedEventId = null;
let eventProcessStatusHistory = [];
let emittedEventIds = new Set();

const EVENT_POLL_INTERVAL_MS = Number(process.env.EVENT_BROADCAST_POLL_INTERVAL_MS || 2000);
const EVENT_PROCESS_STATUS_HISTORY_LIMIT = Number(process.env.EVENT_PROCESS_STATUS_HISTORY_LIMIT || 1500);
const EVENT_EMIT_DEDUPE_LIMIT = Number(process.env.EVENT_EMIT_DEDUPE_LIMIT || 2000);

const formatEventPayload = (eventDoc) => ({
    _id: eventDoc?._id,
    projectId: eventDoc?.projectId,
    projectName: eventDoc?.projectName,
    timestamp: eventDoc?.timestamp,
    peak: eventDoc?.peak,
    rms: eventDoc?.rms,
    duration: eventDoc?.duration,
    dominantFrequency: eventDoc?.dominantFrequency,
    eventType: eventDoc?.eventType,
    severity: eventDoc?.severity,
    isCritical: Boolean(eventDoc?.isCritical),
    sourceFile: eventDoc?.sourceFile || '',
    createdAt: eventDoc?.createdAt,
});

const toMillis = (value) => {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value.getTime();
    if (!value) return 0;
    const parsed = Date.parse(String(value));
    return Number.isNaN(parsed) ? 0 : parsed;
};

const normalizeProcessStatusPayload = (statusPayload = {}) => ({
    projectId: String(statusPayload.projectId || ''),
    fileName: String(statusPayload.fileName || ''),
    stage: String(statusPayload.stage || 'UNKNOWN'),
    triggerSource: String(statusPayload.triggerSource || 'unknown'),
    details: statusPayload.details && typeof statusPayload.details === 'object' ? statusPayload.details : {},
    timestamp: statusPayload.timestamp || new Date(),
});

const parseHistoryLimit = (rawLimit, fallback = 80) => {
    const parsed = Number(rawLimit);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(1, Math.min(500, Math.floor(parsed)));
};

const appendProcessStatusHistory = (statusPayload = {}) => {
    eventProcessStatusHistory.push(statusPayload);
    if (eventProcessStatusHistory.length > EVENT_PROCESS_STATUS_HISTORY_LIMIT) {
        eventProcessStatusHistory = eventProcessStatusHistory.slice(-EVENT_PROCESS_STATUS_HISTORY_LIMIT);
    }
};

const rememberEmittedEventId = (eventId = '') => {
    if (!eventId) return;
    emittedEventIds.add(eventId);
    if (emittedEventIds.size > EVENT_EMIT_DEDUPE_LIMIT) {
        const next = Array.from(emittedEventIds).slice(-EVENT_EMIT_DEDUPE_LIMIT);
        emittedEventIds = new Set(next);
    }
};

const initSocket = (httpServer, allowedOrigins = []) => {
    io = new Server(httpServer, {
        cors: {
            origin: allowedOrigins.length ? allowedOrigins : true,
            credentials: true,
        },
    });

    io.on('connection', (socket) => {
        logger.info('Socket client connected', { socketId: socket.id });

        socket.on('disconnect', () => {
            logger.info('Socket client disconnected', { socketId: socket.id });
        });
    });

    return io;
};

const getIo = () => io;

const emitEventDetected = (eventDoc) => {
    if (!io) return;
    const payload = formatEventPayload(eventDoc);
    const eventId = String(payload?._id || '');
    if (eventId && emittedEventIds.has(eventId)) return;
    rememberEmittedEventId(eventId);
    io.emit('EVENT_DETECTED', payload);
};

const emitEventProcessStatus = (statusPayload = {}) => {
    const payload = normalizeProcessStatusPayload(statusPayload);
    appendProcessStatusHistory(payload);

    if (!io) return;
    io.emit('EVENT_PROCESS_STATUS', payload);
};

const getRecentEventProcessStatuses = ({ projectId = '', limit = 80, since = 0 } = {}) => {
    const projectKey = String(projectId || '');
    const safeLimit = parseHistoryLimit(limit, 80);
    const sinceMs = toMillis(since);

    const filtered = eventProcessStatusHistory.filter((item) => {
        if (projectKey && String(item.projectId || '') !== projectKey) return false;
        if (sinceMs && toMillis(item.timestamp) <= sinceMs) return false;
        return true;
    });

    return filtered.slice(-safeLimit);
};

const stopEventPollingFallback = () => {
    if (!eventPollingTimer) return;
    clearInterval(eventPollingTimer);
    eventPollingTimer = null;
    pollingInProgress = false;
};

const startEventPollingFallback = async () => {
    if (!io || eventPollingTimer) return;

    const Event = require('../models/Event');

    try {
        const latest = await Event.findOne({}, { _id: 1 }).sort({ _id: -1 }).lean();
        lastBroadcastedEventId = latest?._id || lastBroadcastedEventId;
    } catch (error) {
        logger.warn('Event polling fallback seed failed', { error: error.message });
    }

    eventPollingTimer = setInterval(async () => {
        if (!io || pollingInProgress) return;
        pollingInProgress = true;

        try {
            const query = lastBroadcastedEventId ? { _id: { $gt: lastBroadcastedEventId } } : {};
            const events = await Event.find(query).sort({ _id: 1 }).limit(200).lean();

            for (const eventDoc of events) {
                emitEventDetected(eventDoc);
                lastBroadcastedEventId = eventDoc._id;
            }
        } catch (error) {
            logger.warn('Event polling fallback tick failed', { error: error.message });
        } finally {
            pollingInProgress = false;
        }
    }, EVENT_POLL_INTERVAL_MS);

    logger.warn('Event socket broadcast running with polling fallback', {
        intervalMs: EVENT_POLL_INTERVAL_MS,
    });
};

const startEventBroadcastWatcher = () => {
    if (!io) {
        logger.warn('Socket watcher skipped because io is not initialized');
        return;
    }

    const Event = require('../models/Event');

    try {
        eventChangeStream = Event.watch([], { fullDocument: 'updateLookup' });
        eventChangeStream.on('change', (change) => {
            if (change?.operationType !== 'insert') return;
            emitEventDetected(change.fullDocument || {});
        });

        eventChangeStream.on('error', async (error) => {
            logger.error('Event change stream error', { error: error.message });

            try {
                await eventChangeStream?.close();
            } catch {
                // No-op: stream may already be closed.
            }
            eventChangeStream = null;
            await startEventPollingFallback();
        });

        logger.info('Event socket broadcast watcher started');
    } catch (error) {
        logger.warn('Event change stream not available', { error: error.message });
        startEventPollingFallback();
    }
};

const stopEventBroadcastWatcher = async () => {
    stopEventPollingFallback();
    if (!eventChangeStream) return;
    try {
        await eventChangeStream.close();
    } catch (error) {
        logger.warn('Event change stream close failed', { error: error.message });
    }
    eventChangeStream = null;
};

module.exports = {
    initSocket,
    getIo,
    emitEventDetected,
    emitEventProcessStatus,
    getRecentEventProcessStatuses,
    startEventBroadcastWatcher,
    stopEventBroadcastWatcher,
};
