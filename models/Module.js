const mongoose = require('mongoose');

const moduleSchema = new mongoose.Schema(
    {
        moduleName: {
            type: String,
            required: [true, 'Module name is required'],
            unique: true,
            trim: true,
        },
        routePath: {
            type: String,
            required: [true, 'Route path is required'],
            unique: true,
            trim: true,
        },
        icon: {
            type: String,
            default: 'HiOutlineCube',
        },
        description: {
            type: String,
            default: '',
        },
    },
    {
        timestamps: true,
    }
);

module.exports = mongoose.model('Module', moduleSchema);
