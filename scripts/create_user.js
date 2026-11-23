/**
 * Create (or reset) a login from the command line.
 *
 *   node scripts/create_user.js --login markandaproject@sppl --name "Markanda Project" \
 *        --password 'S0me!Passw0rd' --modules all --projects MARKANDA
 *
 * Options
 *   --login      Login ID (required) — letters, numbers and . _ @ -  (3-30 chars)
 *   --name       Display name (default: the login ID)
 *   --password   Password, min 8 chars (required)
 *   --email      Optional real email
 *   --role       user | admin   (default: user)
 *   --modules    "all" or comma-separated module names/route paths (default: none)
 *   --projects   Comma-separated project codes (default: none)
 *   --reset      If the login already exists, reset its password/modules/projects
 *   --dry-run    Validate and show what would happen, without touching the database
 *
 * Uses MONGO_URI from backend/.env.
 */
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const {
    EMAIL_RE,
    isValidLoginId,
    placeholderEmail,
    loginIdQuery,
} = require('../utils/loginId');

const parseArgs = (argv) => {
    const out = {};
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (!arg.startsWith('--')) continue;
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) out[key] = true;
        else { out[key] = next; i += 1; }
    }
    return out;
};

const fail = (message) => {
    console.error(`\nERROR: ${message}\n`);
    process.exit(1);
};

const main = async () => {
    const args = parseArgs(process.argv.slice(2));

    const login = String(args.login || '').trim();
    const password = typeof args.password === 'string' ? args.password : '';
    const role = args.role === 'admin' ? 'admin' : 'user';
    const email = String(args.email || '').trim().toLowerCase() || placeholderEmail(login);
    const name = String(args.name || login).trim();

    if (!isValidLoginId(login)) fail('--login is required: 3-30 characters, letters/numbers and . _ @ - only');
    if (password.length < 8) fail('--password is required and must be at least 8 characters');
    if (!EMAIL_RE.test(email)) fail('--email is not a valid email address');

    const moduleArg = String(args.modules || '').trim();
    const projectCodes = String(args.projects || '').split(',').map((c) => c.trim().toUpperCase()).filter(Boolean);

    if (args['dry-run']) {
        console.log('DRY RUN — nothing written.');
        console.log({ login, name, email, role, modules: moduleArg || '(none)', projects: projectCodes });
        return;
    }

    if (!process.env.MONGO_URI) fail('MONGO_URI is not set in backend/.env');

    const mongoose = require('mongoose');
    const User = require('../models/User');
    const Module = require('../models/Module');
    const Project = require('../models/Project');

    await mongoose.connect(process.env.MONGO_URI);
    console.log(`Connected to ${mongoose.connection.host}/${mongoose.connection.name}`);

    try {
        // modules
        let moduleDocs = [];
        if (moduleArg.toLowerCase() === 'all') {
            moduleDocs = await Module.find({});
        } else if (moduleArg) {
            const wanted = moduleArg.split(',').map((m) => m.trim().toLowerCase()).filter(Boolean);
            const all = await Module.find({});
            moduleDocs = all.filter((m) =>
                wanted.includes(String(m.moduleName).toLowerCase()) || wanted.includes(String(m.routePath).toLowerCase())
            );
            const found = moduleDocs.map((m) => String(m.moduleName).toLowerCase());
            const missing = wanted.filter((w) => !found.includes(w) && !moduleDocs.some((m) => String(m.routePath).toLowerCase() === w));
            if (missing.length) fail(`Unknown module(s): ${missing.join(', ')}`);
        }

        // projects
        const projectDocs = projectCodes.length ? await Project.find({ projectCode: { $in: projectCodes } }) : [];
        const missingProjects = projectCodes.filter((c) => !projectDocs.some((p) => p.projectCode === c));
        if (missingProjects.length) fail(`Unknown project code(s): ${missingProjects.join(', ')}`);

        let user = await User.findOne({ $or: [loginIdQuery(login), { email }] }).select('+password');
        if (user && !args.reset) {
            fail(`A user with login "${user.username}" already exists. Add --reset to reset its password, modules and projects.`);
        }

        const previousProjects = user ? (user.assignedProjects || []).map(String) : [];

        if (user) {
            user.name = name;
            user.role = role;
            user.isActive = true;
            user.password = password; // hashed by the pre-save hook
            user.assignedModules = moduleDocs.map((m) => m._id);
            user.assignedProjects = projectDocs.map((p) => p._id);
            await user.save();
            console.log('Existing user updated.');
        } else {
            user = await User.create({
                name,
                email,
                username: login,
                password,
                role,
                isActive: true,
                assignedModules: moduleDocs.map((m) => m._id),
                assignedProjects: projectDocs.map((p) => p._id),
            });
            console.log('User created.');
        }

        // keep Project.assignedUsers (what access checks use) in step with the user
        const nextIds = projectDocs.map((p) => String(p._id));
        const removed = previousProjects.filter((id) => !nextIds.includes(id));
        if (removed.length) await Project.updateMany({ _id: { $in: removed } }, { $pull: { assignedUsers: user._id } });
        if (nextIds.length) await Project.updateMany({ _id: { $in: nextIds } }, { $addToSet: { assignedUsers: user._id } });

        console.log('\n  Login ID :', user.username);
        console.log('  Password :', password);
        console.log('  Role     :', user.role);
        console.log('  Modules  :', moduleDocs.map((m) => m.moduleName).join(', ') || '(none)');
        console.log('  Projects :', projectDocs.map((p) => `${p.projectName} [${p.projectCode}]`).join(', ') || '(none)');
        console.log('');
    } finally {
        await mongoose.disconnect();
    }
};

main().catch((error) => {
    console.error('Failed:', error.message);
    process.exit(1);
});
