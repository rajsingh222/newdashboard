const mongoose = require('mongoose');

const reportSchema = new mongoose.Schema(
    {
        title: {
            type: String,
            required: [true, 'Report title is required'],
            trim: true,
            maxlength: [200, 'Title cannot exceed 200 characters'],
        },
        description: {
            type: String,
            default: '',
        },
        projectId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Project',
            required: true,
            index: true,
        },
        uploadedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
        filePath: {
            type: String,
            required: [true, 'File path is required'],
        },
        fileName: {
            type: String,
            required: [true, 'File name is required'],
        },
        fileSize: {
            type: Number,
            default: 0,
        },
        analysis: {
            summary: {
                type: String,
                default: '',
            },
            metrics: [
                {
                    key: { type: String, default: '' },
                    value: { type: String, default: '' },
                },
            ],
            charts: [
                {
                    title: { type: String, default: '' },
                    description: { type: String, default: '' },
                    imagePath: { type: String, default: '' },
                },
            ],
        },
    },
    {
        timestamps: true,
    }
);

reportSchema.index({ projectId: 1, createdAt: -1 });

module.exports = mongoose.model('Report', reportSchema);
