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

// All routes below are admin-only
router.use(protect);
router.use(authorize('admin'));

router.get('/', getUsers);
router.get('/:id', getUser);

// Validation of login ID / password rules lives in the controller so the
// messages stay identical for create and update.
router.post(
    '/',
    validate([
        body('name').notEmpty().withMessage('Name is required'),
        body('username').notEmpty().withMessage('Login ID is required'),
        body('password').notEmpty().withMessage('Password is required'),
    ]),
    createUser
);

router.put('/:id', updateUser);

router.delete('/:id', deleteUser);

module.exports = router;
