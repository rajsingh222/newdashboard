const express = require('express');
const {
    registerFcmToken,
    removeFcmToken,
    sendProjectEventTestNotification,
    sendTestNotification,
} = require('../controllers/notificationController');
const { protect } = require('../middleware/auth');

const router = express.Router();

router.use(protect);

router.post('/fcm-token', registerFcmToken);
router.delete('/fcm-token', removeFcmToken);
router.post('/test', sendTestNotification);
router.post('/projects/:projectId/test-event', sendProjectEventTestNotification);

module.exports = router;
