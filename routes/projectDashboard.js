const express = require('express');
const {
    getProjectSummary,
    getProjectTimeseries,
    getProjectStats,
    getProjectChannels,
    getProjectData,
} = require('../controllers/projectDashboardController');
const { protect, verifyProjectAccess } = require('../middleware/auth');

const router = express.Router();

router.use(protect);

router.get('/:id/summary', verifyProjectAccess, getProjectSummary);
router.get('/:id/timeseries', verifyProjectAccess, getProjectTimeseries);
router.get('/:id/stats', verifyProjectAccess, getProjectStats);
router.get('/:id/channels', verifyProjectAccess, getProjectChannels);
router.get('/:id/data', verifyProjectAccess, getProjectData);

module.exports = router;
