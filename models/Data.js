const mongoose = require('mongoose');

const dataSchema = new mongoose.Schema(
    {
        projectId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Project',
            required: true,
            index: true,
        },
        projectName: {
            type: String,
            required: true,
            trim: true,
            maxlength: 150,
        },
        timestamp: {
            type: Date,
            required: true,
            index: true,
        },
        value: {
            type: Number,
            required: true,
        },
        sensor: {
            type: String,
            default: '',
            trim: true,
            maxlength: 120,
        },
        sourceFile: {
            type: String,
            required: true,
            trim: true,
            maxlength: 255,
        },
        sourceIndex: {
            type: Number,
            required: true,
            min: 0,
        },
    },
    {
        timestamps: { createdAt: true, updatedAt: false },
    }
);

dataSchema.index({ projectId: 1, timestamp: -1 });
dataSchema.index({ projectId: 1, sourceFile: 1, sourceIndex: 1 }, { unique: true });

module.exports = mongoose.model('Data', dataSchema);
