const mongoose = require('mongoose');

const shmLiveSourceSchema = new mongoose.Schema(
    {
        project: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Project',
            required: true,
            index: true,
        },
        type: {
            type: String,
            enum: ['static', 'dynamic'],
            required: true,
            index: true,
        },
        sourceName: {
            type: String,
            default: 'Primary Source',
            trim: true,
            maxlength: 120,
        },
        ftpHost: {
            type: String,
            default: '',
            trim: true,
            maxlength: 255,
        },
        ftpPort: {
            type: Number,
            default: 21,
            min: 1,
            max: 65535,
        },
        ftpUser: {
            type: String,
            default: '',
            trim: true,
            maxlength: 255,
        },
        ftpPassword: {
            type: String,
            default: '',
            trim: true,
            maxlength: 1024,
        },
        ftpPath: {
            type: String,
            default: '/',
            trim: true,
            maxlength: 1024,
        },
        isActive: {
            type: Boolean,
            default: false,
        },
        lastSyncedAt: {
            type: Date,
            default: null,
        },
        lastRemoteFile: {
            type: String,
            default: '',
            trim: true,
        },
        lastLocalFile: {
            type: String,
            default: '',
            trim: true,
        },
        lastRemoteModifiedAt: {
            type: Date,
            default: null,
        },
        lastRemoteSize: {
            type: Number,
            default: 0,
            min: 0,
        },
        lastSyncError: {
            type: String,
            default: '',
            trim: true,
            maxlength: 2000,
        },
    },
    {
        timestamps: true,
    }
);

shmLiveSourceSchema.index({ project: 1, type: 1 }, { unique: true });

module.exports = mongoose.model('SHMLiveSource', shmLiveSourceSchema);
