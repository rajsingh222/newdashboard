const mongoose = require('mongoose');

const sensorSchema = new mongoose.Schema({
    sensorId: { type: String, default: '' },
    name: { type: String, required: true },
    sensorType: { type: String, default: '' },
    location: { type: String, default: '' },
    frequency: { type: String, default: '' },
    dimension: { type: String, default: '' },
    isActive: { type: Boolean, default: true },
    thresholdValue: { type: String, default: '' },
    unit: { type: String, default: '' },
    lastReading: { type: String, default: '' },
    changePercent: { type: String, default: '' },
});

const alarmSchema = new mongoose.Schema({
    sensorName: { type: String, required: true },
    alertType: { type: String, default: 'SENSOR CHANGE' },
    value: { type: String, default: '' },
    severity: { type: String, enum: ['normal', 'warning', 'critical'], default: 'normal' },
});

const shmConfigSchema = new mongoose.Schema(
    {
        project: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Project',
            required: true,
        },
        type: {
            type: String,
            enum: ['static', 'dynamic'],
            required: true,
        },
        sensors: [sensorSchema],
        alarms: [alarmSchema],
        healthStatus: {
            type: String,
            enum: ['safe', 'warning', 'unsafe'],
            default: 'safe',
        },
        healthNote: {
            type: String,
            default: '',
        },
        details: {
            type: String,
            default: '',
        },
    },
    {
        timestamps: true,
    }
);

shmConfigSchema.index({ project: 1, type: 1 }, { unique: true });

module.exports = mongoose.model('SHMConfig', shmConfigSchema);
