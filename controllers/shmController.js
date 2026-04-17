const SHMConfig = require('../models/SHMConfig');

const normalizeType = (rawType = '') => {
    const t = String(rawType).trim().toLowerCase();
    if (t === 'static' || t === 'static-monitoring' || t === 'staticmonitoring') return 'static';
    if (t === 'dynamic' || t === 'dynamic-monitoring' || t === 'dynamicmonitoring') return 'dynamic';
    return null;
};

const normalizeHealthStatus = (value) => {
    if (value === undefined) return undefined;
    const normalized = String(value).trim().toLowerCase();
    if (['safe', 'warning', 'unsafe'].includes(normalized)) return normalized;
    return null;
};

const normalizeSeverity = (value) => {
    const normalized = String(value || 'normal').trim().toLowerCase();
    if (['normal', 'warning', 'critical'].includes(normalized)) return normalized;
    return 'normal';
};

const isRajeshKumarUser = (user) => {
    const normalizedName = String(user?.name || '').trim().toLowerCase();
    const normalizedUsername = String(user?.username || '').trim().toLowerCase();
    return normalizedName === 'rajesh kumar' || normalizedUsername === 'rajesh';
};

const getRajeshDynamicDefaultConfig = () => {
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
        type: 'dynamic',
    };
};

const normalizeSensors = (sensors) => {
    if (sensors === undefined) return undefined;
    if (!Array.isArray(sensors)) return null;

    return sensors
        .map((sensor) => {
            const entry = sensor || {};
            const name = (entry.name || entry.sensorName || '').toString().trim();
            if (!name) return null;

            return {
                sensorId: (entry.sensorId || '').toString().trim(),
                name,
                sensorType: (entry.sensorType || '').toString().trim(),
                location: (entry.location || '').toString().trim(),
                frequency: (entry.frequency || '').toString().trim(),
                dimension: (entry.dimension || '').toString().trim(),
                isActive: entry.isActive !== undefined ? Boolean(entry.isActive) : true,
                thresholdValue: (entry.thresholdValue || '').toString().trim(),
                unit: (entry.unit || '').toString().trim(),
                lastReading: (entry.lastReading || '').toString().trim(),
                changePercent: (entry.changePercent || '').toString().trim(),
            };
        })
        .filter(Boolean);
};

const normalizeAlarms = (alarms) => {
    if (alarms === undefined) return undefined;
    if (!Array.isArray(alarms)) return null;

    return alarms
        .map((alarm) => {
            const entry = alarm || {};
            const sensorName = (entry.sensorName || entry.sensorId || '').toString().trim();
            if (!sensorName) return null;

            return {
                sensorName,
                alertType: (entry.alertType || 'SENSOR CHANGE').toString().trim(),
                value: (entry.value || '').toString().trim(),
                severity: normalizeSeverity(entry.severity),
            };
        })
        .filter(Boolean);
};

// GET config for a project + type (static or dynamic)
exports.getSHMConfig = async (req, res) => {
    try {
        const { projectId } = req.params;
        const type = normalizeType(req.params.type);
        if (!type) {
            return res.status(400).json({
                success: false,
                message: 'Invalid SHM type. Use static or dynamic',
            });
        }

        let config = await SHMConfig.findOne({ project: projectId, type });
        if (!config) {
            if (type === 'dynamic' && isRajeshKumarUser(req.user)) {
                return res.json({
                    success: true,
                    config: getRajeshDynamicDefaultConfig(),
                });
            }

            return res.json({
                success: true,
                config: { sensors: [], alarms: [], healthStatus: 'safe', healthNote: '', details: '', type },
            });
        }

        if (
            type === 'dynamic'
            && isRajeshKumarUser(req.user)
            && Array.isArray(config.sensors)
            && config.sensors.length === 0
            && Array.isArray(config.alarms)
            && config.alarms.length === 0
        ) {
            return res.json({
                success: true,
                config: getRajeshDynamicDefaultConfig(),
            });
        }

        res.json({ success: true, config });
    } catch (error) {
        console.error('Get SHM config error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// PUT (upsert) full config
exports.updateSHMConfig = async (req, res) => {
    try {
        const { projectId } = req.params;
        const type = normalizeType(req.params.type);
        if (!type) {
            return res.status(400).json({
                success: false,
                message: 'Invalid SHM type. Use static or dynamic',
            });
        }

        const { sensors, alarms, healthStatus, healthNote, details } = req.body;

        const updateData = {};

        const normalizedSensors = normalizeSensors(sensors);
        if (normalizedSensors === null) {
            return res.status(400).json({ success: false, message: 'sensors must be an array' });
        }
        if (normalizedSensors !== undefined) updateData.sensors = normalizedSensors;

        const normalizedAlarms = normalizeAlarms(alarms);
        if (normalizedAlarms === null) {
            return res.status(400).json({ success: false, message: 'alarms must be an array' });
        }
        if (normalizedAlarms !== undefined) updateData.alarms = normalizedAlarms;

        const normalizedHealthStatus = normalizeHealthStatus(healthStatus);
        if (normalizedHealthStatus === null) {
            return res.status(400).json({
                success: false,
                message: 'healthStatus must be one of safe, warning, unsafe',
            });
        }
        if (normalizedHealthStatus !== undefined) updateData.healthStatus = normalizedHealthStatus;

        if (healthNote !== undefined) updateData.healthNote = healthNote;
        if (details !== undefined) updateData.details = details;

        const config = await SHMConfig.findOneAndUpdate(
            { project: projectId, type },
            { $set: updateData },
            { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
        );

        res.json({ success: true, config });
    } catch (error) {
        console.error('Update SHM config error:', error);
        res.status(500).json({ success: false, message: error.message || 'Server error' });
    }
};
