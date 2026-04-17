const mongoose = require('mongoose');

const reportArtifactSchema = new mongoose.Schema(
    {
        filename: { type: String, default: '' },
        contentType: { type: String, default: '' },
        length: { type: Number, default: 0 },
        uploadDate: { type: Date, default: Date.now },
        metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    },
    {
        strict: false,
        collection: 'report_files.files',
    }
);

module.exports = mongoose.model('ReportArtifact', reportArtifactSchema);
