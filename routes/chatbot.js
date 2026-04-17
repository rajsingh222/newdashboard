const express = require('express');
const { body } = require('express-validator');
const { protect } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { askChatbot, getPrefilledQuestions } = require('../controllers/chatbotController');

const router = express.Router();

router.use(protect);

router.get('/prefilled', getPrefilledQuestions);

router.post(
    '/ask',
    validate([
        body('question')
            .isString()
            .withMessage('Question must be a string')
            .trim()
            .notEmpty()
            .withMessage('Question is required')
            .isLength({ max: 1000 })
            .withMessage('Question cannot exceed 1000 characters'),
    ]),
    askChatbot
);

module.exports = router;
