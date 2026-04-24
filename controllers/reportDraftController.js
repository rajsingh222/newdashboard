const ReportDraft = require('../models/ReportDraft');
const logger = require('../utils/logger');

// @desc    Get report draft for a project
// @route   GET /api/projects/:projectId/report-draft
// @access  Private
exports.getReportDraft = async (req, res) => {
    try {
        let draft = await ReportDraft.findOne({ projectId: req.params.projectId });
        
        if (!draft) {
            draft = await ReportDraft.create({ projectId: req.params.projectId, items: [] });
        }

        res.status(200).json({ success: true, draft });
    } catch (error) {
        logger.error('Get report draft error:', error);
        res.status(500).json({ success: false, message: 'Server error fetching report draft' });
    }
};

// @desc    Add item to report draft
// @route   POST /api/projects/:projectId/report-draft/items
// @access  Private
exports.addItemToDraft = async (req, res) => {
    try {
        const { moduleName, moduleType, content } = req.body;

        if (!moduleName || !moduleType || !content) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        let draft = await ReportDraft.findOne({ projectId: req.params.projectId });
        
        if (!draft) {
            draft = new ReportDraft({ projectId: req.params.projectId, items: [] });
        }

        // Calculate order (next available)
        const nextOrder = draft.items.length > 0 
            ? Math.max(...draft.items.map(i => i.order || 0)) + 1 
            : 0;

        draft.items.push({
            moduleName,
            moduleType,
            content,
            order: nextOrder
        });

        draft.lastUpdated = Date.now();
        await draft.save();

        res.status(200).json({ success: true, draft });
    } catch (error) {
        logger.error('Add item to draft error:', error);
        res.status(500).json({ success: false, message: 'Server error adding item to report draft' });
    }
};

// @desc    Remove item from report draft
// @route   DELETE /api/projects/:projectId/report-draft/items/:itemId
// @access  Private
exports.removeItemFromDraft = async (req, res) => {
    try {
        const draft = await ReportDraft.findOne({ projectId: req.params.projectId });
        
        if (!draft) {
            return res.status(404).json({ success: false, message: 'Draft not found' });
        }

        draft.items = draft.items.filter(item => item._id.toString() !== req.params.itemId);
        draft.lastUpdated = Date.now();
        await draft.save();

        res.status(200).json({ success: true, draft });
    } catch (error) {
        logger.error('Remove item from draft error:', error);
        res.status(500).json({ success: false, message: 'Server error removing item from report draft' });
    }
};

// @desc    Clear report draft
// @route   DELETE /api/projects/:projectId/report-draft
// @access  Private
exports.clearReportDraft = async (req, res) => {
    try {
        const draft = await ReportDraft.findOne({ projectId: req.params.projectId });
        
        if (!draft) {
            return res.status(404).json({ success: false, message: 'Draft not found' });
        }

        draft.items = [];
        draft.lastUpdated = Date.now();
        await draft.save();

        res.status(200).json({ success: true, message: 'Draft cleared' });
    } catch (error) {
        logger.error('Clear report draft error:', error);
        res.status(500).json({ success: false, message: 'Server error clearing report draft' });
    }
};
