const express = require('express');
const { body } = require('express-validator');
const { login, getMe, logout } = require('../controllers/authController');
const { protect } = require('../middleware/auth');
const validate = require('../middleware/validate');

const router = express.Router();

router.post(
    '/login',
    validate([
        body('login').notEmpty().withMessage('Email or username is required'),
        body('password').notEmpty().withMessage('Password is required'),
    ]),
    login
);

router.get('/me', protect, getMe);
router.post('/logout', protect, logout);

module.exports = router;
