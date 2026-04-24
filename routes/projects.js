const express = require('express');
const { body } = require('express-validator');
const {
    createProject,
    getProjects,
    getProject,
    updateProject,
    deleteProject,
    assignUser,
    uploadImages,
    deleteImage,
    imageUpload,
    thresholdAlertPdfUpload,
    uploadThresholdAlertPdf,
    deleteThresholdAlertPdf,
} = require('../controllers/projectController');
const { uploadMiddleware, uploadReport, getReports, getReportAnalysis } = require('../controllers/reportController');
const {
    getModuleContent,
    updateModuleContent,
    uploadModuleImages,
    deleteModuleImage,
    uploadModuleReports,
    deleteModuleReport,
    uploadGraph,
    deleteGraph,
    imageUploadMiddleware,
    reportUploadMiddleware,
    graphUploadMiddleware,
} = require('../controllers/moduleContentController');
const {
    mseedUploadMiddleware,
    uploadLiveMseedFile,
    listLiveMseedFiles,
    streamLiveMseed,
    getLiveSourceConfig,
    updateLiveSourceConfig,
} = require('../controllers/shmLiveController');
const { getRecentProjectEvents, getRecentProjectEventProcessStatuses } = require('../controllers/eventController');
const { protect, authorize, verifyProjectAccess } = require('../middleware/auth');
const {
    getReportDraft,
    addItemToDraft,
    removeItemFromDraft,
    clearReportDraft
} = require('../controllers/reportDraftController');
const validate = require('../middleware/validate');


const router = express.Router();

// All routes are protected
router.use(protect);

// Project CRUD
router.get('/', getProjects);

router.post(
    '/',
    authorize('admin'),
    validate([
        body('projectName').notEmpty().withMessage('Project name is required'),
        body('projectCode').notEmpty().withMessage('Project code is required'),
        body('type').optional().isIn(['excel', 'mseed']).withMessage('type must be excel or mseed'),
        body('ftp.port').optional().isInt({ min: 1, max: 65535 }).withMessage('ftp.port must be between 1 and 65535'),
        body('ftp.host').optional().isString(),
        body('ftp.user').optional().isString(),
        body('ftp.password').optional().isString(),
        body('ftp.path').optional().isString(),
        body('lastRealtimeFile').optional().isString(),
        body('eventThresholds.peakSevere').optional().isNumeric(),
        body('eventThresholds.peakImpact').optional().isNumeric(),
        body('eventThresholds.impactDurationSec').optional().isNumeric(),
        body('eventThresholds.rmsContinuous').optional().isNumeric(),
        body('eventThresholds.continuousDurationSec').optional().isNumeric(),
    ]),
    createProject
);

router.get('/:id', verifyProjectAccess, getProject);
router.put('/:id', authorize('admin'), updateProject);
router.delete('/:id', authorize('admin'), deleteProject);

// Assign user to project
router.post(
    '/:id/assign-user',
    authorize('admin'),
    validate([
        body('userId').notEmpty().withMessage('User ID is required'),
    ]),
    assignUser
);

// Project images
router.post('/:id/images', authorize('admin'), imageUpload, uploadImages);
router.delete('/:id/images', authorize('admin'), deleteImage);
router.post('/:id/threshold-alerts/pdf', authorize('admin'), thresholdAlertPdfUpload, uploadThresholdAlertPdf);
router.delete('/:id/threshold-alerts/pdf', authorize('admin'), deleteThresholdAlertPdf);

// ── Module content routes (per-project, per-module) ──
router.get('/:projectId/modules/:moduleId/content', getModuleContent);
router.put('/:projectId/modules/:moduleId/content', authorize('admin'), updateModuleContent);
router.post('/:projectId/modules/:moduleId/content/images', authorize('admin'), imageUploadMiddleware, uploadModuleImages);
router.delete('/:projectId/modules/:moduleId/content/images', authorize('admin'), deleteModuleImage);
router.post('/:projectId/modules/:moduleId/content/reports', authorize('admin'), reportUploadMiddleware, uploadModuleReports);
router.delete('/:projectId/modules/:moduleId/content/reports', authorize('admin'), deleteModuleReport);
router.post('/:projectId/modules/:moduleId/content/graphs', authorize('admin'), graphUploadMiddleware, uploadGraph);
router.delete('/:projectId/modules/:moduleId/content/graphs', authorize('admin'), deleteGraph);

// ── SHM config routes ──
const { getSHMConfig, updateSHMConfig } = require('../controllers/shmController');
router.get('/:projectId/shm/:type', verifyProjectAccess, getSHMConfig);
router.put('/:projectId/shm/:type', authorize('admin'), verifyProjectAccess, updateSHMConfig);

// ── SHM live MiniSEED routes ──
router.get('/:projectId/shm/:type/live/source', verifyProjectAccess, getLiveSourceConfig);
router.put('/:projectId/shm/:type/live/source', authorize('admin'), verifyProjectAccess, updateLiveSourceConfig);
router.get('/:projectId/shm/:type/live/files', verifyProjectAccess, listLiveMseedFiles);
router.post('/:projectId/shm/:type/live/upload', authorize('admin'), verifyProjectAccess, mseedUploadMiddleware, uploadLiveMseedFile);
router.get('/:projectId/shm/:type/live/stream', verifyProjectAccess, streamLiveMseed);
router.get('/:projectId/events/recent', verifyProjectAccess, getRecentProjectEvents);
router.post('/:projectId/events', verifyProjectAccess, require('../controllers/eventController').createProjectEvent);
router.get('/:projectId/events/process-status/recent', verifyProjectAccess, getRecentProjectEventProcessStatuses);

// Report sub-routes (project-scoped)
router.get('/:projectId/reports', verifyProjectAccess, getReports);
router.get('/:projectId/reports/:reportId/analysis', verifyProjectAccess, getReportAnalysis);
router.post(
    '/:projectId/reports',
    authorize('admin'),
    verifyProjectAccess,
    uploadMiddleware,
    uploadReport
);

// Report draft routes
router.get('/:projectId/report-draft', verifyProjectAccess, getReportDraft);
router.post('/:projectId/report-draft/items', verifyProjectAccess, addItemToDraft);
router.delete('/:projectId/report-draft/items/:itemId', verifyProjectAccess, removeItemFromDraft);
router.delete('/:projectId/report-draft', verifyProjectAccess, clearReportDraft);

module.exports = router;

