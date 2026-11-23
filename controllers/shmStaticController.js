const { getStaticData } = require('../services/staticFtpService');

// @desc    Latest static SHM data (strain/temperature/tilt) from the project's static FTP source
// @route   GET /api/projects/:projectId/shm/static/data
// @access  Private (verifyProjectAccess)
exports.getStaticFtpData = async (req, res) => {
    try {
        const result = await getStaticData(req.params.projectId);
        return res.json({ success: true, ...result });
    } catch (error) {
        console.error('Get static FTP data error:', error);
        return res.status(500).json({ success: false, message: 'Server error fetching static data' });
    }
};
