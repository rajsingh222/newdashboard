const Module = require('../models/Module');

const DEFAULT_MODULES = [
    {
        moduleName: 'Design Proof Check',
        routePath: '/modules/design-proof-check',
        icon: 'HiOutlineClipboardCheck',
        description: 'Verify and validate design proofs against engineering standards',
    },
    {
        moduleName: 'Non-Destructive Evaluation',
        routePath: '/modules/non-destructive-evaluation',
        icon: 'HiOutlineSearchCircle',
        description: 'Perform non-destructive testing and evaluation procedures',
    },
    {
        moduleName: 'Load Testing',
        routePath: '/modules/load-testing',
        icon: 'HiOutlineScale',
        description: 'Conduct load testing and structural analysis',
    },
    {
        moduleName: 'Structural Health Monitoring',
        routePath: '/modules/structural-health-monitoring',
        icon: 'HiOutlineHeart',
        description: 'Monitor real-time structural health indicators and metrics',
    },
    {
        moduleName: 'Threshold Based Alerts',
        routePath: '/modules/threshold-alerts',
        icon: 'HiOutlineBell',
        description: 'Configure and manage threshold-based alert systems',
    },
    {
        moduleName: 'Reports',
        routePath: '/modules/reports',
        icon: 'HiOutlineDocumentReport',
        description: 'Generate and view comprehensive reports and analytics',
    },
    {
        moduleName: 'Report Analysis',
        routePath: '/modules/report-analysis',
        icon: 'HiOutlineDocumentReport',
        description: 'Analyze reports and extract insights for decision-making',
    },
    {
        moduleName: 'Advance Features',
        routePath: '/modules/advance-features',
        icon: 'HiOutlineSparkles',
        description: 'Advanced monitoring utilities including configurable MP4 feature panels',
    },
];

const ensureDefaultModules = async () => {
    if (!DEFAULT_MODULES.length) return;

    const ops = DEFAULT_MODULES.map((mod) => ({
        updateOne: {
            filter: { routePath: mod.routePath },
            update: { $setOnInsert: mod },
            upsert: true,
        },
    }));

    await Module.bulkWrite(ops, { ordered: false });
};

// @desc    Get all modules
// @route   GET /api/modules
// @access  Private
exports.getModules = async (req, res) => {
    try {
        await ensureDefaultModules();
        const modules = await Module.find().sort({ moduleName: 1 });

        res.status(200).json({
            success: true,
            count: modules.length,
            modules,
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Server error fetching modules',
        });
    }
};

// @desc    Create module
// @route   POST /api/modules
// @access  Private (superadmin)
exports.createModule = async (req, res) => {
    try {
        const { moduleName, routePath, icon, description } = req.body;

        const existingModule = await Module.findOne({
            $or: [{ moduleName }, { routePath }],
        });

        if (existingModule) {
            return res.status(400).json({
                success: false,
                message: 'Module with that name or route already exists',
            });
        }

        const module = await Module.create({
            moduleName,
            routePath,
            icon,
            description,
        });

        res.status(201).json({
            success: true,
            module,
        });
    } catch (error) {
        console.error('Create module error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error creating module',
        });
    }
};
