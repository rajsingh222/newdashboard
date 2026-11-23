const { Writable } = require('stream');
const ftp = require('basic-ftp');
const XLSX = require('xlsx');
const SHMLiveSource = require('../models/SHMLiveSource');
const logger = require('../utils/logger');

/**
 * Static SHM data from FTP.
 *
 * Reads the newest strain/temperature/tilt files (CSV, TXT, JSON, XLSX) from the
 * project's "static" FTP source and returns them in the row shape the frontend
 * already understands:
 *   [{ datetime, channels: { CH01: { strain, temperature, tilt }, ... } }, ...]
 */

const FTP_TIMEOUT_MS = Number(process.env.SHM_FTP_TIMEOUT_MS || 20000);
const CACHE_TTL_MS = Number(process.env.SHM_STATIC_CACHE_MS || 5000);
const MAX_FILES = Math.max(1, Number(process.env.SHM_STATIC_MAX_FILES || 3));
const MAX_ROWS = Math.max(10, Number(process.env.SHM_STATIC_MAX_ROWS || 600));
const MAX_FILE_BYTES = Number(process.env.SHM_STATIC_MAX_FILE_BYTES || 15 * 1024 * 1024);

const SUPPORTED_EXT = /\.(csv|txt|json|xlsx|xls)$/i;

const METRIC_PATTERNS = [
    { key: 'strain', re: /strain/i },
    { key: 'temperature', re: /temp/i },
    { key: 'tilt', re: /tilt|inclin/i },
];

const TIME_KEY_RE = /^(date_?time|timestamp|time|date|datetime)$/i;
const CHANNEL_KEY_RE = /^(channel|sensor|ch|name|channel_?name|sensor_?name)$/i;

// per-project cache: avoids hitting FTP once per polling client
const resultCache = new Map(); // projectId -> { at, payload }
const parsedFileCache = new Map(); // `${projectId}|${name}|${size}|${mtime}` -> rows

const normalizeRemotePath = (rawPath = '/') => {
    const cleaned = String(rawPath || '/').trim().replace(/\\/g, '/');
    if (!cleaned) return '/';
    return cleaned.startsWith('/') ? cleaned : `/${cleaned}`;
};

const joinRemotePath = (folder, file) => {
    const base = normalizeRemotePath(folder);
    return base === '/' ? `/${file}` : `${base.replace(/\/+$/, '')}/${file}`;
};

/* ───────────────────────── parsing ───────────────────────── */

const toNumber = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const n = typeof value === 'number' ? value : Number(String(value).trim().replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
};

const detectDelimiter = (headerLine) => {
    const counts = { ',': 0, ';': 0, '\t': 0, '|': 0 };
    for (const ch of headerLine) if (ch in counts) counts[ch] += 1;
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
};

const splitCsvLine = (line, delimiter) => {
    const out = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (ch === '"') {
            if (quoted && line[i + 1] === '"') { cur += '"'; i += 1; } else quoted = !quoted;
        } else if (ch === delimiter && !quoted) {
            out.push(cur);
            cur = '';
        } else {
            cur += ch;
        }
    }
    out.push(cur);
    return out.map((cell) => cell.trim());
};

const parseDelimitedText = (text) => {
    const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) return [];
    const delimiter = detectDelimiter(lines[0]);
    const headers = splitCsvLine(lines[0], delimiter);
    return lines.slice(1).map((line) => {
        const cells = splitCsvLine(line, delimiter);
        const row = {};
        headers.forEach((h, idx) => { if (h) row[h] = cells[idx] ?? ''; });
        return row;
    });
};

const parseJsonRows = (text) => {
    const json = JSON.parse(String(text).replace(/^﻿/, ''));
    const root = json?.data ?? json;
    if (Array.isArray(root)) return root.filter((r) => r && typeof r === 'object');
    if (root && typeof root === 'object') {
        const arr = root.rows || root.records || root.readings;
        if (Array.isArray(arr)) return arr.filter((r) => r && typeof r === 'object');
        return [root];
    }
    return [];
};

const parseXlsxRows = (buffer) => {
    const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    const rows = [];
    wb.SheetNames.forEach((sheetName) => {
        rows.push(...XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '', raw: true }));
    });
    return rows;
};

const toIso = (value) => {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
    if (typeof value === 'number' && Number.isFinite(value)) {
        const ms = value > 1e11 ? value : value > 1e9 ? value * 1000 : null;
        if (ms) return new Date(ms).toISOString();
    }
    const str = String(value ?? '').trim();
    const parsed = Date.parse(str);
    if (Number.isNaN(parsed)) return null;
    // No timezone in the source string: keep it as written so the displayed time
    // doesn't depend on the server's timezone. ISO-like strings still sort correctly.
    if (!/(z|[+-]\d{2}:?\d{2})$/i.test(str)) return str;
    return new Date(parsed).toISOString();
};

const classifyHeader = (header) => {
    const metric = METRIC_PATTERNS.find((m) => m.re.test(header));
    if (!metric) return null;
    const channel = String(header)
        .replace(metric.re, '')
        .replace(/\(.*?\)|\[.*?\]/g, '')
        .replace(/^[\s_\-:.]+|[\s_\-:.]+$/g, '')
        .trim();
    return { metric: metric.key, channel: channel || 'CH01' };
};

/**
 * Convert generic row objects into [{ datetime, channels }].
 * Handles: already-shaped rows ({channels}), "long" rows (one row per channel),
 * and "wide" rows (CH01_strain, CH01_temp, ... columns).
 */
const rowsToChannelRows = (rows) => {
    const byTime = new Map();

    const put = (datetime, channel, metric, value) => {
        const v = toNumber(value);
        if (v === null) return;
        if (!byTime.has(datetime)) byTime.set(datetime, { datetime, channels: {} });
        const entry = byTime.get(datetime);
        if (!entry.channels[channel]) entry.channels[channel] = {};
        entry.channels[channel][metric] = v;
    };

    rows.forEach((row, idx) => {
        const keys = Object.keys(row);
        const timeKey = keys.find((k) => TIME_KEY_RE.test(k.trim()));
        const datetime = (timeKey && toIso(row[timeKey])) || String(idx + 1);

        // already in channel shape
        if (row.channels && typeof row.channels === 'object') {
            Object.entries(row.channels).forEach(([channel, values]) => {
                if (values && typeof values === 'object') {
                    Object.entries(values).forEach(([k, v]) => {
                        const metric = METRIC_PATTERNS.find((m) => m.re.test(k));
                        if (metric) put(datetime, channel, metric.key, v);
                    });
                } else {
                    put(datetime, channel, 'strain', values);
                }
            });
            return;
        }

        const channelKey = keys.find((k) => CHANNEL_KEY_RE.test(k.trim()));
        if (channelKey && row[channelKey] !== '') {
            // long format: one row per channel with strain/temp/tilt columns
            const channel = String(row[channelKey]).trim();
            keys.forEach((k) => {
                const cls = classifyHeader(k);
                if (cls) put(datetime, channel, cls.metric, row[k]);
            });
            return;
        }

        // wide format
        keys.forEach((k) => {
            if (k === timeKey) return;
            const cls = classifyHeader(k);
            if (cls) put(datetime, cls.channel, cls.metric, row[k]);
        });
    });

    return Array.from(byTime.values()).sort((a, b) => String(a.datetime).localeCompare(String(b.datetime)));
};

const parseFileBuffer = (fileName, buffer) => {
    const lower = fileName.toLowerCase();
    let rows;
    if (lower.endsWith('.json')) rows = parseJsonRows(buffer.toString('utf8'));
    else if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) rows = parseXlsxRows(buffer);
    else rows = parseDelimitedText(buffer.toString('utf8'));
    return rowsToChannelRows(rows);
};

/* ───────────────────────── FTP ───────────────────────── */

const downloadToBuffer = async (client, remotePath) => {
    const chunks = [];
    let total = 0;
    const sink = new Writable({
        write(chunk, _enc, cb) {
            total += chunk.length;
            if (total > MAX_FILE_BYTES) return cb(new Error(`File exceeds ${MAX_FILE_BYTES} bytes`));
            chunks.push(chunk);
            return cb();
        },
    });
    await client.downloadTo(sink, remotePath);
    return Buffer.concat(chunks);
};

const entryTime = (entry) => {
    if (entry?.modifiedAt instanceof Date && !Number.isNaN(entry.modifiedAt.getTime())) return entry.modifiedAt.getTime();
    const raw = Date.parse(String(entry?.rawModifiedAt || ''));
    return Number.isNaN(raw) ? 0 : raw;
};

const fetchFromFtp = async (projectId, source) => {
    const client = new ftp.Client(FTP_TIMEOUT_MS);
    client.ftp.verbose = false;

    try {
        await client.access({
            host: source.ftpHost,
            port: source.ftpPort || 21,
            user: source.ftpUser,
            password: source.ftpPassword,
            secure: false,
        });

        const folder = normalizeRemotePath(source.ftpPath || '/');
        const entries = await client.list(folder);
        const files = entries
            .filter((e) => e && (e.isFile || e.type === 1) && SUPPORTED_EXT.test(e.name || ''))
            .sort((a, b) => entryTime(b) - entryTime(a))
            .slice(0, MAX_FILES);

        const merged = new Map();
        // oldest first so newer files overwrite duplicate timestamps
        for (const entry of [...files].reverse()) {
            const cacheKey = `${projectId}|${entry.name}|${entry.size}|${entryTime(entry)}`;
            let rows = parsedFileCache.get(cacheKey);
            if (!rows) {
                const buffer = await downloadToBuffer(client, joinRemotePath(folder, entry.name));
                rows = parseFileBuffer(entry.name, buffer);
                parsedFileCache.set(cacheKey, rows);
                if (parsedFileCache.size > 50) parsedFileCache.delete(parsedFileCache.keys().next().value);
            }
            rows.forEach((row) => {
                const existing = merged.get(row.datetime);
                merged.set(row.datetime, existing
                    ? { datetime: row.datetime, channels: { ...existing.channels, ...row.channels } }
                    : row);
            });
        }

        const data = Array.from(merged.values())
            .sort((a, b) => String(a.datetime).localeCompare(String(b.datetime)))
            .slice(-MAX_ROWS);

        return { data, files: files.map((f) => f.name), latestFile: files[0]?.name || '' };
    } finally {
        client.close();
    }
};

/**
 * @returns {Promise<{configured:boolean, data:Array, files?:string[], error?:string, cached?:boolean}>}
 */
const getStaticData = async (projectId) => {
    const source = await SHMLiveSource.findOne({ project: projectId, type: 'static' });
    if (!source || !source.isActive || !source.ftpHost || !source.ftpUser || !source.ftpPassword) {
        return { configured: false, data: [] };
    }

    const cached = resultCache.get(String(projectId));
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return { ...cached.payload, cached: true };

    try {
        const result = await fetchFromFtp(String(projectId), source);
        const payload = { configured: true, ...result, fetchedAt: new Date().toISOString() };
        resultCache.set(String(projectId), { at: Date.now(), payload });

        await SHMLiveSource.updateOne(
            { _id: source._id },
            { $set: { lastSyncedAt: new Date(), lastRemoteFile: result.latestFile, lastSyncError: '' } }
        );
        return payload;
    } catch (error) {
        logger.warn('Static FTP fetch failed', { projectId: String(projectId), error: error.message });
        await SHMLiveSource.updateOne(
            { _id: source._id },
            { $set: { lastSyncedAt: new Date(), lastSyncError: error.message.slice(0, 1000) } }
        ).catch(() => {});
        // serve stale data if we have any
        if (cached) return { ...cached.payload, stale: true, error: error.message };
        return { configured: true, data: [], error: error.message };
    }
};

module.exports = { getStaticData, parseFileBuffer, rowsToChannelRows };
