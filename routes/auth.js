const express = require('express');
const { body } = require('express-validator');
const { login, getMe, logout } = require('../controllers/authController');
const { protect } = require('../middleware/auth');
const validate = require('../middleware/validate');

const router = express.Router();

// Accounts are created by an administrator (POST /api/users).
// There is intentionally no public signup, forgot-password or reset-password route:
// administrators issue and reset credentials from the admin panel.

router.post(
    '/login',
    validate([
        body('login').notEmpty().withMessage('Login ID or email is required'),
        body('password').notEmpty().withMessage('Password is required'),
    ]),
    login
);

router.get('/me', protect, getMe);
router.post('/logout', protect, logout);

module.exports = router;
