const mongoose = require('mongoose');

const moduleContentSchema = new mongoose.Schema(
    {
        project: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Project',
            required: true,
        },
        module: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Module',
            required: true,
        },
        details: {
            type: String,
            default: '',
        },
        keyValues: [
            {
                key: { type: String, required: true },
                value: { type: String, default: '' },
            },
        ],
        images: [
            {
                type: String, // file path
            },
        ],
        graphs: [
            {
                title: { type: String, default: '' },
                description: { type: String, default: '' },
                imagePath: { type: String, required: true },
                uploadedAt: { type: Date, default: Date.now },
            },
        ],
        reports: [
            {
                name: { type: String, required: true },
                filePath: { type: String, required: true },
                uploadedAt: { type: Date, default: Date.now },
            },
        ],
    },
    {
        timestamps: true,
    }
);

// One content doc per project+module combo
moduleContentSchema.index({ project: 1, module: 1 }, { unique: true });

module.exports = mongoose.model('ModuleContent', moduleContentSchema);
