const { processEventTrigger } = require('../services/eventTriggerService');

const isUnauthorized = (req) => {
    const configuredKey = String(process.env.EVENT_TRIGGER_API_KEY || '').trim();
    if (!configuredKey) return false;

    const incomingKey = String(req.headers['x-event-trigger-key'] || '').trim();
    return incomingKey !== configuredKey;
};

exports.handleEventTrigger = async (req, res) => {
    try {
        if (isUnauthorized(req)) {
            return res.status(401).json({
                success: false,
                message: 'Unauthorized event trigger key',
            });
        }

        const { projectId, fileName } = req.body || {};

        const result = await processEventTrigger({
            projectId,
            fileName,
            triggerSource: 'api',
        });

        if (result.duplicate) {
            return res.status(202).json({
                success: true,
                duplicate: true,
                message: 'File processing already in progress',
                ...result,
            });
        }

        if (result.skipped) {
            return res.status(202).json({
                success: true,
                skipped: true,
                message: 'File parsed but no usable signal samples found',
                ...result,
            });
        }

        return res.status(201).json({
            success: true,
            message: 'Event processed successfully',
            ...result,
        });
    } catch (error) {
        const statusCode = Number(error.statusCode || 500);
        return res.status(statusCode).json({
            success: false,
            message: error.message || 'Failed to process event trigger',
        });
    }
};
