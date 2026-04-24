const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const { parseMseedTraces } = require('../services/mseedParser');

const router = express.Router();
const OUTPUT_FILE_PATH = path.resolve(__dirname, '..', '..', 'output.json');
const TRIGGERED_MSEED_FILE_PATH = path.resolve(
    __dirname,
    '..',
    '..',
    'frontend',
    'Z63qb_T_data_20260420_094102_20260420_094106.mseed'
);
const TRIGGERED_JSON_FILE_PATH = path.resolve(
    __dirname,
    '..',
    '..',
    'output_20260421_160307.json'
);

const sanitizeNonJsonNumbers = (raw = '') =>
    raw
        .replace(/\bNaN\b/g, 'null')
        .replace(/\b-Infinity\b/g, 'null')
        .replace(/\bInfinity\b/g, 'null');

const getChannelOrder = (channelName = '') => {
    const match = String(channelName || '').match(/(\d+)/);
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
};

const median = (arr = []) => {
    if (!arr.length) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const detectSpikes = (signal = [], timestamps = [], threshold = 6, radius = 4) => {
    if (!Array.isArray(signal) || signal.length < 3) return { spikes: [], scoreThreshold: 0 };

    const clean = signal.map((v) => Number(v)).filter(Number.isFinite);
    if (!clean.length) return { spikes: [], scoreThreshold: 0 };

    const med = median(clean);
    const deviations = clean.map((v) => Math.abs(v - med));
    const mad = median(deviations);
    const std = Math.sqrt(clean.reduce((acc, v) => acc + ((v - med) ** 2), 0) / clean.length);

    const denom = mad > 1e-9 ? mad : (std > 1e-9 ? std : 1);
    const scoreMultiplier = mad > 1e-9 ? 0.6745 : 1;
    const scores = signal.map((raw) => {
        const value = Number(raw);
        if (!Number.isFinite(value)) return 0;
        return scoreMultiplier * Math.abs(value - med) / denom;
    });

    const spikes = [];
    for (let i = 0; i < signal.length; i += 1) {
        const score = scores[i];
        if (score < threshold) continue;

        const current = Math.abs(Number(signal[i]));
        if (!Number.isFinite(current)) continue;

        let localPeak = true;
        const left = Math.max(0, i - radius);
        const right = Math.min(signal.length - 1, i + radius);
        for (let j = left; j <= right; j += 1) {
            if (j === i) continue;
            const neighbor = Math.abs(Number(signal[j]));
            if (Number.isFinite(neighbor) && neighbor > current) {
                localPeak = false;
                break;
            }
        }
        if (!localPeak) continue;

        spikes.push({
            index: i,
            timestamp: timestamps[i] || null,
            value: Number(signal[i]),
            score: Number(score.toFixed(3)),
        });
    }

    return { spikes, scoreThreshold: threshold };
};

router.get('/triggered-spikes', async (req, res) => {
    try {
        const traces = await parseMseedTraces(TRIGGERED_MSEED_FILE_PATH);
        if (!Array.isArray(traces) || !traces.length) {
            return res.status(404).json({
                success: false,
                message: 'No traces parsed from triggered MiniSEED file',
            });
        }

        const sorted = [...traces].sort((a, b) => getChannelOrder(a.channel) - getChannelOrder(b.channel));
        const groups = [];
        for (let i = 0; i < sorted.length; i += 3) {
            const chunk = sorted.slice(i, i + 3);
            if (chunk.length !== 3) continue;

            groups.push({
                sensorId: groups.length + 1,
                channels: chunk.map((trace) => {
                    const points = trace.signal.map((value, idx) => ({
                        x: idx,
                        timestamp: trace.timestamps[idx] || null,
                        y: Number(value),
                    }));
                    const spikeInfo = detectSpikes(trace.signal, trace.timestamps);
                    return {
                        channel: trace.channel,
                        traceId: trace.traceId,
                        sampleRate: Number(trace.sampleRate || 0),
                        pointCount: points.length,
                        points,
                        spikes: spikeInfo.spikes,
                        spikeCount: spikeInfo.spikes.length,
                        scoreThreshold: spikeInfo.scoreThreshold,
                    };
                }),
            });
        }

        return res.json({
            success: true,
            filePath: TRIGGERED_MSEED_FILE_PATH,
            totalSensors: groups.length,
            sensors: groups,
        });
    } catch (error) {
        console.error('Failed to build triggered spikes response:', error);
        return res.status(500).json({
            success: false,
            message: 'Unable to parse triggered MiniSEED spikes',
        });
    }
});

router.get('/test-output-stream', async (req, res) => {
    try {
        const raw = await fs.readFile(OUTPUT_FILE_PATH, 'utf8');
        let parsed;

        try {
            parsed = JSON.parse(raw);
        } catch {
            const sanitized = sanitizeNonJsonNumbers(raw);
            parsed = JSON.parse(sanitized);
        }

        if (!Array.isArray(parsed)) {
            return res.status(500).json({
                success: false,
                message: 'Invalid output stream format in output.json',
            });
        }

        res.setHeader('Cache-Control', 'no-store');
        return res.json(parsed);
    } catch (error) {
        console.error('Failed to load output.json for test stream:', error);
        return res.status(500).json({
            success: false,
            message: 'Unable to load output stream data',
        });
    }
});

router.get('/triggered-json', async (req, res) => {
    try {
        const raw = await fs.readFile(TRIGGERED_JSON_FILE_PATH, 'utf8');
        let parsed;

        try {
            parsed = JSON.parse(raw);
        } catch {
            const sanitized = sanitizeNonJsonNumbers(raw);
            parsed = JSON.parse(sanitized);
        }

        if (!Array.isArray(parsed)) {
            return res.status(500).json({
                success: false,
                message: 'Invalid JSON format in triggered output file',
            });
        }

        // Transform the JSON to include enhanced analysis data
        const enriched = parsed.map((item) => ({
            ...item,
            metadata: {
                processedAt: new Date().toISOString(),
                fileType: 'json',
                source: 'triggered-processing'
            }
        }));

        res.setHeader('Cache-Control', 'no-store');
        return res.json({
            success: true,
            fileSource: TRIGGERED_JSON_FILE_PATH,
            totalTraces: enriched.length,
            data: enriched
        });
    } catch (error) {
        console.error('Failed to load triggered JSON file:', error);
        return res.status(500).json({
            success: false,
            message: 'Unable to load triggered JSON data',
            error: error.message
        });
    }
});

module.exports = router;
