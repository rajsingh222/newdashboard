const mongoose = require('mongoose');
const dotenv = require('dotenv');
const User = require('./models/User');
const Module = require('./models/Module');
const Project = require('./models/Project');
const Report = require('./models/Report');

dotenv.config();

const modules = [
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

const seedDatabase = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('MongoDB Connected for seeding...');

        // Clear existing data
        await User.deleteMany({});
        await Module.deleteMany({});
        await Project.deleteMany({});
        await Report.deleteMany({});
        console.log('Cleared existing data');

        // Create modules
        const createdModules = await Module.insertMany(modules);
        console.log(`Created ${createdModules.length} modules`);

        const allModuleIds = createdModules.map((m) => m._id);

        // Create Admin (top-level role, all modules)
        const admin = await User.create({
            name: 'Admin User',
            email: 'admin@dashboard.com',
            username: 'admin',
            password: 'Password123!',
            role: 'admin',
            isActive: true,
            assignedModules: allModuleIds,
        });
        console.log('Created Admin: admin / Password123!');

        // Create User 1 (no modules assigned — admin will assign via UI)
        const user1 = await User.create({
            name: 'Rajesh Kumar',
            email: 'rajesh@dashboard.com',
            username: 'rajesh',
            password: 'Password123!',
            role: 'user',
            isActive: true,
            assignedModules: [],
            createdBy: admin._id,
        });
        console.log('Created User: rajesh / Password123! (no modules — assign via admin)');

        // Create User 2 (no modules assigned — admin will assign via UI)
        const user2 = await User.create({
            name: 'Priya Sharma',
            email: 'priya@dashboard.com',
            username: 'priya',
            password: 'Password123!',
            role: 'user',
            isActive: true,
            assignedModules: [],
            createdBy: admin._id,
        });
        console.log('Created User: priya / Password123! (no modules — assign via admin)');

        console.log('\n--- Seed Complete ---');
        console.log('Login Credentials:');
        console.log('  Admin:  admin / Password123!');
        console.log('  User 1: rajesh / Password123!');
        console.log('  User 2: priya / Password123!');
        console.log('\nNo projects created — admin can create and assign via the UI.');
        console.log('No modules assigned to users — admin can assign via User Management.');

        process.exit(0);
    } catch (error) {
        console.error('Seed error:', error);
        process.exit(1);
    }
};

seedDatabase();
