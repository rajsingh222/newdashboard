const dotenv = require('dotenv');
const mongoose = require('mongoose');
const cron = require('node-cron');
const connectDB = require('./config/db');
const logger = require('./utils/logger');
const { fetchAndProcessActiveProjects } = require('./services/fetchData');

dotenv.config();

let cycleRunning = false;

const runCycle = async () => {
    if (cycleRunning) {
        logger.warn('Previous ingestion cycle still running, skipping this schedule tick');
        return;
    }

    cycleRunning = true;
    try {
        await fetchAndProcessActiveProjects();
    } catch (error) {
        logger.error('Ingestion cycle crashed', { error: error.message });
    } finally {
        cycleRunning = false;
    }
};

const startWorker = async () => {
    try {
        await connectDB();

        // Every 10 minutes.
        cron.schedule('*/10 * * * *', runCycle, {
            timezone: process.env.CRON_TZ || 'UTC',
        });

        logger.info('SHM ingestion worker started', {
            schedule: '*/10 * * * *',
            timezone: process.env.CRON_TZ || 'UTC',
        });

        // Run once immediately when worker boots.
        await runCycle();
    } catch (error) {
        logger.error('Worker startup failed', { error: error.message });
        process.exit(1);
    }
};

const shutdown = async () => {
    try {
        logger.info('Worker shutdown signal received');
        await mongoose.connection.close();
    } finally {
        process.exit(0);
    }
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

startWorker();
