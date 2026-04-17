const dotenv = require('dotenv');
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const { fetchAndProcessActiveProjects } = require('../services/fetchData');

dotenv.config();

(async () => {
    try {
        await connectDB();
        const summary = await fetchAndProcessActiveProjects();
        console.log('Fetch cycle summary:', JSON.stringify(summary, null, 2));
        await mongoose.connection.close();
        process.exit(0);
    } catch (error) {
        console.error('Fetch once failed:', error);
        try {
            await mongoose.connection.close();
        } catch (closeError) {
            // no-op
        }
        process.exit(1);
    }
})();
