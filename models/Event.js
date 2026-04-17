const mongoose = require('mongoose');

const eventSchema = new mongoose.Schema(
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
        peak: {
            type: Number,
            required: true,
        },
        rms: {
            type: Number,
            required: true,
        },
        duration: {
            type: Number,
            required: true,
        },
        dominantFrequency: {
            type: Number,
            required: true,
            default: 0,
        },
        eventType: {
            type: String,
            enum: ['Severe Event', 'Impact Event', 'Continuous Vibration', 'Normal'],
            required: true,
        },
        severity: {
            type: String,
            enum: ['Low', 'Medium', 'High'],
            required: true,
        },
        isCritical: {
            type: Boolean,
            default: false,
            index: true,
        },
        sourceFile: {
            type: String,
            default: '',
            trim: true,
            maxlength: 255,
        },
        sourceFileFingerprint: {
            type: String,
            default: '',
            trim: true,
            maxlength: 600,
            index: true,
        },
        rawSignal: {
            type: [Number],
            default: [],
        },
    },
    {
        timestamps: { createdAt: true, updatedAt: false },
    }
);

eventSchema.index({ projectId: 1, timestamp: -1 });
eventSchema.index(
    { projectId: 1, sourceFileFingerprint: 1 },
    { partialFilterExpression: { sourceFileFingerprint: { $type: 'string', $ne: '' } } }
);

eventSchema.statics.ensureReprocessFriendlyIndexes = async function ensureReprocessFriendlyIndexes() {
    const indexName = 'projectId_1_sourceFileFingerprint_1';

    try {
        const indexes = await this.collection.indexes();
        const fingerprintIndex = indexes.find((idx) => idx?.name === indexName);

        if (fingerprintIndex?.unique) {
            await this.collection.dropIndex(indexName);
            await this.collection.createIndex(
                { projectId: 1, sourceFileFingerprint: 1 },
                {
                    name: indexName,
                    background: true,
                    partialFilterExpression: { sourceFileFingerprint: { $type: 'string', $ne: '' } },
                }
            );
        }
    } catch {
        // Ignore index migration errors so event processing can still proceed.
    }
};

module.exports = mongoose.model('Event', eventSchema);
