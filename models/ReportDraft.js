const mongoose = require('mongoose');

const reportDraftItemSchema = new mongoose.Schema({
    moduleName: {
        type: String,
        required: true,
    },
    moduleType: {
        type: String,
        required: true,
    },
    content: {
        type: mongoose.Schema.Types.Mixed,
        required: true,
    },
    order: {
        type: Number,
        default: 0,
    },
    addedAt: {
        type: Date,
        default: Date.now,
    },
});

const reportDraftSchema = new mongoose.Schema({
    projectId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Project',
        required: true,
        unique: true,
    },
    items: [reportDraftItemSchema],
    lastUpdated: {
        type: Date,
        default: Date.now,
    },
});

module.exports = mongoose.model('ReportDraft', reportDraftSchema);
