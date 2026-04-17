const express = require('express');
const { body } = require('express-validator');
const { getModules, createModule } = require('../controllers/moduleController');
const { protect, authorize } = require('../middleware/auth');
const validate = require('../middleware/validate');

const router = express.Router();

router.use(protect);

router.get('/', getModules);

router.post(
    '/',
    authorize('admin'),
    validate([
        body('moduleName').notEmpty().withMessage('Module name is required'),
        body('routePath').notEmpty().withMessage('Route path is required'),
    ]),
    createModule
);

module.exports = router;
