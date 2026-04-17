const express = require('express');
const { body } = require('express-validator');
const {
    getUsers,
    getUser,
    createUser,
    updateUser,
    deleteUser,
} = require('../controllers/userController');
const { protect, authorize } = require('../middleware/auth');
const validate = require('../middleware/validate');

const router = express.Router();

// All routes below are protected
router.use(protect);
router.use(authorize('admin'));

router.get('/', getUsers);
router.get('/:id', getUser);

router.post(
    '/',
    validate([
        body('name').notEmpty().withMessage('Name is required'),
        body('email').isEmail().withMessage('Valid email is required'),
        body('username')
            .isLength({ min: 3 })
            .withMessage('Username must be at least 3 characters'),
        body('password')
            .isLength({ min: 6 })
            .withMessage('Password must be at least 6 characters'),
    ]),
    createUser
);

router.put('/:id', updateUser);

router.delete('/:id', protect, authorize('admin'), deleteUser);

module.exports = router;
