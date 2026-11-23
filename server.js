const express = require('express');
const http = require('http');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');
const dotenv = require('dotenv');
const connectDB = require('./config/db');
const Module = require('./models/Module');
const { initSocket } = require('./socket/socket');

// Load env vars
dotenv.config();

const defaultModules = [
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
    ]

const ensureDefaultModules = async () => {
    for (const moduleData of defaultModules) {
        await Module.findOneAndUpdate(
            { routePath: moduleData.routePath },
            { $setOnInsert: moduleData },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
    }
};

const app = express();

// Rate limiting
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20, // 20 failed login attempts per 15 mins
    // Only failed logins count, so many people signing in from one office IP
    // (or one account on several devices) are never locked out; guessing still is.
    skipSuccessfulRequests: true,
    message: {
        success: false,
        message: 'Too many login attempts, please try again after 15 minutes',
    },
});

const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5000, // Higher capacity for real-time telemetry dashboard polling
    message: {
        success: false,
        message: 'Too many requests, please try again later',
    },
});
// Middleware
// Trust proxy (required for Render, AWS ALB, etc.)
app.set('trust proxy', 1);

// CORS — supports comma-separated CLIENT_URL for multiple origins
const allowedOrigins = process.env.NODE_ENV === 'production'
    ? (process.env.CLIENT_URL || '').split(',').map(u => u.trim()).filter(Boolean)
    : ['http://localhost:5173', 'http://localhost:3000'];

// Explicitly add known production domains to prevent CORS blocks if env vars are missing
allowedOrigins.push('https://newdashboard.spplindia.org');
allowedOrigins.push('http://newdashboard.spplindia.org');

// Helper to identify local development origins
const isLocalOrigin = (originUrl) => {
    try {
        const url = new URL(originUrl);
        const hostname = url.hostname;
        return (
            hostname === 'localhost' ||
            hostname === '127.0.0.1' ||
            hostname.startsWith('192.168.') ||
            hostname.startsWith('10.') ||
            hostname.startsWith('172.') ||
            hostname === '::1'
        );
    } catch {
        return false;
    }
};

app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (mobile apps, curl, etc.)
        if (!origin) return callback(null, true);

        // In development, automatically allow all local/LAN origins on any port
        if (process.env.NODE_ENV !== 'production' && isLocalOrigin(origin)) {
            return callback(null, true);
        }

        if (allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        // As a fallback for subdomains, allow anything ending in spplindia.org
        if (origin.endsWith('.spplindia.org') || origin === 'https://spplindia.org') {
            return callback(null, true);
        }

        const err = new Error(`Not allowed by CORS: ${origin}`);
        err.status = 403; // return 403 Forbidden instead of 500 Internal Server Error
        callback(err);
    },
    credentials: true,
}));

// Security headers
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Apply rate limiters
app.use('/api/auth/login', loginLimiter);
app.use('/api/', apiLimiter);

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/modules', require('./routes/modules'));
app.use('/api', require('./routes/eventTrigger'));
app.use('/api/projects', require('./routes/projects'));
app.use('/api/ingestion/projects', require('./routes/projectRoutes'));
app.use('/api/data', require('./routes/dataRoutes'));
app.use('/api/project', require('./routes/projectDashboard'));
app.use('/api/chatbot', require('./routes/chatbot'));
app.use('/api/waveforms', require('./routes/waveforms'));
app.use('/api', require('./routes/testOutputStream'));

// Serve uploaded files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/uploads', (req, res, next) => {
    const ext = path.extname(req.path).toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.webp', '.svg', '.gif'].includes(ext)) {
        res.setHeader('Content-Type', 'image/svg+xml');
        return res.status(200).send(`
            <svg xmlns="http://www.w3.org/2000/svg" width="300" height="200" viewBox="0 0 300 200">
                <rect width="100%" height="100%" fill="#1e293b"/>
                <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#94a3b8" font-family="sans-serif" font-size="14" font-weight="bold">
                    Sanrachna Prahari Asset Placeholder
                </text>
            </svg>
        `);
    }
    next();
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ success: true, message: 'API is running', timestamp: new Date() });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: `Route ${req.originalUrl} not found`,
    });
});

// Global error handler
app.use((err, req, res, next) => {
    console.error(`Unhandled error on ${req.method} ${req.originalUrl}:`, err);
    if (process.env.NODE_ENV !== 'production') {
        console.error(err.stack);
    }

    const statusCode = err.status || 500;
    const message = process.env.NODE_ENV !== 'production' ? (err.message || 'Internal server error') : 'Internal server error';

    const payload = { success: false, message };
    if (process.env.NODE_ENV !== 'production') payload.error = err.stack;

    res.status(statusCode).json(payload);
});

const PORT = process.env.PORT || 5000;

const startServer = async () => {
    try {
        await connectDB();
        await ensureDefaultModules();

        const httpServer = http.createServer(app);
        initSocket(httpServer, allowedOrigins);

        httpServer.listen(PORT, () => {
            console.log(`Server running on port ${PORT} in ${process.env.NODE_ENV || 'development'} mode`);
        });
    } catch (error) {
        console.error('Startup error:', error);
        process.exit(1);
    }
};

startServer();

module.exports = app;
