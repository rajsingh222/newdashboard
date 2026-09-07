const express = require('express');
const { body } = require('express-validator');
const { login, signup, getMe, logout, forgotPassword, resetPassword } = require('../controllers/authController');
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

router.post(
    '/signup',
    validate([
        body('name').notEmpty().withMessage('Full Name is required'),
        body('email').isEmail().withMessage('Please provide a valid email address'),
        body('username').isLength({ min: 3 }).withMessage('Username must be at least 3 characters'),
        body('phoneNumber').notEmpty().withMessage('Mobile/Phone Number is required'),
        body('password')
            .isLength({ min: 8 }).withMessage('Password must be at least 8 characters long')
            .matches(/[A-Z]/).withMessage('Password must contain at least one uppercase letter (A-Z)')
            .matches(/[a-z]/).withMessage('Password must contain at least one lowercase letter (a-z)')
            .matches(/[0-9]/).withMessage('Password must contain at least one number (0-9)')
            .matches(/[^A-Za-z0-9]/).withMessage('Password must contain at least one special character (@, $, !, %, etc.)'),
    ]),
    signup
);

router.get('/me', protect, getMe);
router.post('/logout', protect, logout);

router.post('/forgotpassword', forgotPassword);
router.put('/resetpassword/:resettoken', resetPassword);

module.exports = router;
