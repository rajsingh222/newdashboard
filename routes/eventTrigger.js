const express = require('express');
const { body } = require('express-validator');
const { handleEventTrigger } = require('../controllers/eventTriggerController');
const validate = require('../middleware/validate');

const router = express.Router();

router.post(
    '/event-trigger',
    validate([
        body('projectId').notEmpty().withMessage('projectId is required').isMongoId().withMessage('projectId must be a valid Mongo ID'),
        body('fileName').notEmpty().withMessage('fileName is required').isString().withMessage('fileName must be a string'),
    ]),
    handleEventTrigger
);

module.exports = router;
