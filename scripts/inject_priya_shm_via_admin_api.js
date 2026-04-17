require('dotenv').config();

const API_BASE_URL = (process.env.API_BASE_URL || 'http://localhost:5000/api').replace(/\/$/, '');
const ADMIN_LOGIN = process.env.ADMIN_LOGIN || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Password123!';
const TARGET_USER = (process.env.TARGET_USER || process.argv[2] || 'priya').trim().toLowerCase();

const buildDynamicPayload = () => {
    const sensors = Array.from({ length: 6 }, (_, index) => {
        const id = index + 1;
        return {
            sensorId: `ACC-${id}`,
            name: `Accelerometer ${id}`,
            sensorType: 'Accelerometer',
            location: `Location ${id}`,
            frequency: '200hz',
            dimension: '3D',
            isActive: true,
            thresholdValue: '',
            unit: '',
            lastReading: '',
            changePercent: '',
        };
    });

    const alarms = sensors.map((sensor) => ({
        sensorName: sensor.name,
        alertType: 'SENSOR ACTIVE',
        value: '',
        severity: 'normal',
    }));

    return {
        sensors,
        alarms,
        healthStatus: 'safe',
        healthNote: '',
        details: '',
    };
};

const requestJson = async (path, { method = 'GET', token, body } = {}) => {
    if (typeof fetch !== 'function') {
        throw new Error('Global fetch is unavailable. Use Node.js 18+ to run this script.');
    }

    const response = await fetch(`${API_BASE_URL}${path}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const message = data?.message || `Request failed: ${method} ${path}`;
        throw new Error(message);
    }

    return data;
};

const findTargetUser = (users) => {
    return users.find((user) => {
        const username = String(user?.username || '').trim().toLowerCase();
        const name = String(user?.name || '').trim().toLowerCase();
        return username === TARGET_USER || name === TARGET_USER || name.includes(TARGET_USER);
    });
};

const getProjectId = (project) => {
    if (!project) return null;
    if (typeof project === 'string') return project;
    return project._id || null;
};

const run = async () => {
    console.log(`Using API: ${API_BASE_URL}`);
    console.log(`Logging in as admin user: ${ADMIN_LOGIN}`);

    const loginData = await requestJson('/auth/login', {
        method: 'POST',
        body: { login: ADMIN_LOGIN, password: ADMIN_PASSWORD },
    });

    const token = loginData?.token;
    if (!token) {
        throw new Error('Admin login succeeded but no token was returned.');
    }

    const usersData = await requestJson('/users', { token });
    const users = usersData?.users || [];
    const targetUser = findTargetUser(users);

    if (!targetUser) {
        throw new Error(`Target user not found for: ${TARGET_USER}`);
    }

    const assignedProjects = Array.isArray(targetUser.assignedProjects)
        ? targetUser.assignedProjects
        : [];

    if (assignedProjects.length === 0) {
        console.log(`User ${targetUser.username} has no assigned projects. Nothing to inject.`);
        return;
    }

    const payload = buildDynamicPayload();

    let successCount = 0;
    for (const project of assignedProjects) {
        const projectId = getProjectId(project);
        if (!projectId) continue;

        await requestJson(`/projects/${projectId}/shm/dynamic`, {
            method: 'PUT',
            token,
            body: payload,
        });

        successCount += 1;
        console.log(`Injected dynamic SHM config into project ${projectId}`);
    }

    console.log(`Done. Updated ${successCount} project(s) for user ${targetUser.username}.`);
};

run()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('Injection failed:', error.message);
        process.exit(1);
    });
