const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const MSeedRecord = require('libmseedjs');

const normalizeObjectKeys = (obj = {}) => {
    const out = {};
    Object.keys(obj || {}).forEach((key) => {
        out[String(key || '').trim().toLowerCase()] = obj[key];
    });
    return out;
};

const excelSerialToDate = (serialValue) => {
    // Excel stores dates as days from 1899-12-30.
    const epoch = new Date(Date.UTC(1899, 11, 30));
    const ms = Math.round(Number(serialValue) * 24 * 60 * 60 * 1000);
    return new Date(epoch.getTime() + ms);
};

const toTimestamp = (value) => {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value;

    if (typeof value === 'number' && Number.isFinite(value)) {
        if (value > 100000000000) {
            const fromMs = new Date(value);
            if (!Number.isNaN(fromMs.getTime())) return fromMs;
        }

        if (value > 1000000000 && value <= 99999999999) {
            const fromSec = new Date(value * 1000);
            if (!Number.isNaN(fromSec.getTime())) return fromSec;
        }

        if (value > 20000 && value < 100000) {
            const fromExcelSerial = excelSerialToDate(value);
            if (!Number.isNaN(fromExcelSerial.getTime())) return fromExcelSerial;
        }
    }

    if (typeof value === 'string' && value.trim()) {
        const parsed = new Date(value.trim());
        if (!Number.isNaN(parsed.getTime())) return parsed;
    }

    return null;
};

const toNumber = (value) => {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
};

const parseExcelFile = async (filePath) => {
    const workbook = XLSX.readFile(filePath, { cellDates: true });
    const firstSheetName = workbook.SheetNames?.[0];
    if (!firstSheetName) return [];

    const sheet = workbook.Sheets[firstSheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: null, raw: true });

    return rows
        .map((row) => {
            const normalized = normalizeObjectKeys(row);
            const timestampRaw = normalized.timestamp ?? normalized.time ?? normalized.datetime ?? normalized.date;
            const valueRaw = normalized.value ?? normalized.reading ?? normalized.val;
            const sensorRaw = normalized.sensor ?? normalized.channel ?? normalized.station ?? normalized.id;

            const timestamp = toTimestamp(timestampRaw);
            const value = toNumber(valueRaw);

            if (!timestamp || value === null) return null;

            return {
                timestamp,
                value,
                sensor: sensorRaw ? String(sensorRaw).trim() : '',
            };
        })
        .filter(Boolean);
};

const detectRecordLength = (recordBuffer) => {
    if (!recordBuffer || recordBuffer.length < 64) return 512;

    try {
        let blocketteStart = recordBuffer.readUInt16BE(46);
        let safety = 0;

        while (blocketteStart && safety < 16) {
            safety += 1;
            if (blocketteStart + 7 >= recordBuffer.length) break;

            const blocketteType = recordBuffer.readUInt16BE(blocketteStart);
            const next = recordBuffer.readUInt16BE(blocketteStart + 2);
            if (blocketteType === 1000) {
                const exponent = recordBuffer.readUInt8(blocketteStart + 6);
                const candidate = 2 ** exponent;
                if (candidate >= 256 && candidate <= 65536) {
                    return candidate;
                }
                break;
            }

            blocketteStart = next;
        }
    } catch (error) {
        return 512;
    }

    return 512;
};

const parseMseedFile = async (filePath) => {
    const fileBuffer = fs.readFileSync(filePath);
    if (!fileBuffer || fileBuffer.length < 64) return [];

    const parsedPoints = [];
    let offset = 0;
    let recordLength = detectRecordLength(fileBuffer.slice(0, Math.min(fileBuffer.length, 4096)));

    while (offset + 64 <= fileBuffer.length) {
        if (offset + recordLength > fileBuffer.length) break;

        const recordBuffer = fileBuffer.slice(offset, offset + recordLength);

        try {
            const record = new MSeedRecord(recordBuffer);
            const data = Array.isArray(record.data) ? record.data : [];
            const startEpochMs = Number(record?.header?.start || 0);
            const sampleRate = Number(record?.header?.sampleRate || 0);
            const stepMs = sampleRate > 0 ? (1000 / sampleRate) : 0;
            const sensor = typeof record.id === 'function'
                ? String(record.id()).trim()
                : [record?.header?.network, record?.header?.station, record?.header?.location, record?.header?.channel]
                    .filter(Boolean)
                    .join('.');

            for (let i = 0; i < data.length; i += 1) {
                const value = toNumber(data[i]);
                if (value === null) continue;

                const timestamp = new Date(startEpochMs + Math.round(i * stepMs));
                if (Number.isNaN(timestamp.getTime())) continue;

                parsedPoints.push({
                    timestamp,
                    value,
                    sensor,
                });
            }

            recordLength = detectRecordLength(recordBuffer);
        } catch (error) {
            // Skip malformed records and continue with the next fixed-size record window.
        }

        offset += recordLength;
    }

    return parsedPoints;
};

const parseByProjectType = async (type, filePath) => {
    const normalizedType = String(type || '').toLowerCase();
    if (normalizedType === 'excel') return parseExcelFile(filePath);
    if (normalizedType === 'mseed') return parseMseedFile(filePath);

    throw new Error(`Unsupported project type: ${normalizedType}`);
};

const inferFileTypeFromName = (fileName) => {
    const ext = path.extname(String(fileName || '')).toLowerCase();
    if (ext === '.xlsx' || ext === '.xls' || ext === '.csv') return 'excel';
    if (ext === '.mseed' || ext === '.miniseed') return 'mseed';
    return null;
};

module.exports = {
    parseExcelFile,
    parseMseedFile,
    parseByProjectType,
    inferFileTypeFromName,
};
