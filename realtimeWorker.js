const dotenv = require('dotenv');
const mongoose = require('mongoose');
const cron = require('node-cron');
const connectDB = require('./config/db');
const logger = require('./utils/logger');
const { runRealtimeDetectionCycle } = require('./services/realtimeService');

dotenv.config();

const REALTIME_SCHEDULE = process.env.REALTIME_WORKER_SCHEDULE || '*/5 * * * * *';
let cycleRunning = false;

const runCycle = async () => {
    if (cycleRunning) {
        logger.warn('Realtime cycle already running, skipping current tick');
        return;
    }

    cycleRunning = true;
    try {
        await runRealtimeDetectionCycle();
    } catch (error) {
        logger.error('Realtime cycle crashed', { error: error.message });
    } finally {
        cycleRunning = false;
    }
};

const startWorker = async () => {
    try {
        await connectDB();

        cron.schedule(REALTIME_SCHEDULE, runCycle, {
            timezone: process.env.CRON_TZ || 'UTC',
        });

        logger.info('Realtime worker started', {
            schedule: REALTIME_SCHEDULE,
            timezone: process.env.CRON_TZ || 'UTC',
        });

        await runCycle();
    } catch (error) {
        logger.error('Realtime worker startup failed', { error: error.message });
        process.exit(1);
    }
};

const shutdown = async () => {
    try {
        logger.info('Realtime worker shutdown signal received');
        await mongoose.connection.close();
    } catch (error) {
        logger.warn('Realtime worker shutdown error', { error: error.message });
    } finally {
        process.exit(0);
    }
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

startWorker();
