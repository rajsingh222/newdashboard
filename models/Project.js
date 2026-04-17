const mongoose = require('mongoose');

const projectSchema = new mongoose.Schema(
    {
        projectName: {
            type: String,
            required: [true, 'Project name is required'],
            trim: true,
            maxlength: [100, 'Project name cannot exceed 100 characters'],
        },
        projectCode: {
            type: String,
            required: [true, 'Project code is required'],
            unique: true,
            uppercase: true,
            trim: true,
            maxlength: [20, 'Project code cannot exceed 20 characters'],
        },
        description: {
            type: String,
            default: '',
            maxlength: [500, 'Description cannot exceed 500 characters'],
        },
        location: {
            type: String,
            default: '',
            trim: true,
        },
        latitude: {
            type: Number,
            default: null,
        },
        longitude: {
            type: Number,
            default: null,
        },
        structureType: {
            type: String,
            default: '',
            trim: true,
        },
        projectType: {
            type: String,
            default: '',
            trim: true,
        },
        clientName: {
            type: String,
            default: '',
            trim: true,
        },
        ftp: {
            host: {
                type: String,
                default: '',
                trim: true,
                maxlength: [255, 'FTP host cannot exceed 255 characters'],
            },
            port: {
                type: Number,
                default: 21,
                min: [1, 'FTP port must be between 1 and 65535'],
                max: [65535, 'FTP port must be between 1 and 65535'],
            },
            user: {
                type: String,
                default: '',
                trim: true,
                maxlength: [255, 'FTP user cannot exceed 255 characters'],
            },
            password: {
                type: String,
                default: '',
                trim: true,
                maxlength: [1024, 'FTP password cannot exceed 1024 characters'],
            },
            path: {
                type: String,
                default: '/',
                trim: true,
                maxlength: [1024, 'FTP path cannot exceed 1024 characters'],
            },
        },
        type: {
            type: String,
            enum: ['excel', 'mseed'],
            default: 'mseed',
            index: true,
        },
        isActive: {
            type: Boolean,
            default: false,
            index: true,
        },
        lastFetchedAt: {
            type: Date,
            default: null,
        },
        lastRealtimeFile: {
            type: String,
            default: '',
            trim: true,
            maxlength: [255, 'Realtime file name cannot exceed 255 characters'],
        },
        lastRealtimeFileSize: {
            type: Number,
            default: 0,
            min: 0,
        },
        eventThresholds: {
            peakSevere: {
                type: Number,
                default: 2000,
            },
            peakImpact: {
                type: Number,
                default: 1000,
            },
            impactDurationSec: {
                type: Number,
                default: 2,
            },
            rmsContinuous: {
                type: Number,
                default: 300,
            },
            continuousDurationSec: {
                type: Number,
                default: 10,
            },
        },
        processedFiles: [
            {
                type: String,
                trim: true,
            },
        ],
        images: [
            {
                type: String, // file path or URL
            },
        ],
        thresholdAlertPdf: {
            type: String,
            default: '',
            trim: true,
        },
        startDate: {
            type: Date,
            default: Date.now,
        },
        endDate: {
            type: Date,
            default: null,
        },
        status: {
            type: String,
            enum: ['active', 'completed', 'on-hold'],
            default: 'active',
        },
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
        assignedUsers: [
            {
                type: mongoose.Schema.Types.ObjectId,
                ref: 'User',
            },
        ],
        allowedModules: [
            {
                type: mongoose.Schema.Types.ObjectId,
                ref: 'Module',
            },
        ],
    },
    {
        timestamps: true,
    }
);

// Indexes for fast lookups
projectSchema.index({ assignedUsers: 1 });
projectSchema.index({ status: 1 });
projectSchema.index({ isActive: 1, type: 1 });

module.exports = mongoose.model('Project', projectSchema);
