const fs = require('fs');
const MSeedRecord = require('libmseedjs');

let irisMseed = null;
try {
    // Optional dependency path: if available in runtime, this parser takes precedence.
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    irisMseed = require('@irisdsp/mseed');
} catch (error) {
    irisMseed = null;
}

const toMillis = (value) => {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value.getTime();
    if (typeof value === 'number' && Number.isFinite(value)) {
        if (value > 100000000000) return value;
        if (value > 1000000000) return value * 1000;
    }

    if (value && typeof value === 'object') {
        if (typeof value.toDate === 'function') {
            const dateObj = value.toDate();
            if (dateObj instanceof Date && !Number.isNaN(dateObj.getTime())) return dateObj.getTime();
        }
        if (typeof value.valueOf === 'function') {
            const maybe = Number(value.valueOf());
            if (Number.isFinite(maybe)) return maybe > 100000000000 ? maybe : maybe * 1000;
        }
    }

    const parsed = Date.parse(String(value || ''));
    return Number.isNaN(parsed) ? 0 : parsed;
};

const detectRecordLength = (recordBuffer) => {
    if (!recordBuffer || recordBuffer.length < 64) return 512;

    try {
        let blocketteStart = recordBuffer.readUInt16BE(46);
        let guard = 0;

        while (blocketteStart && guard < 16) {
            guard += 1;
            if (blocketteStart + 7 >= recordBuffer.length) break;

            const blocketteType = recordBuffer.readUInt16BE(blocketteStart);
            const next = recordBuffer.readUInt16BE(blocketteStart + 2);
            if (blocketteType === 1000) {
                const exponent = recordBuffer.readUInt8(blocketteStart + 6);
                const length = 2 ** exponent;
                if (length >= 256 && length <= 65536) return length;
                break;
            }

            blocketteStart = next;
        }
    } catch (error) {
        return 512;
    }

    return 512;
};

const parseWithLibmseed = (fileBuffer) => {
    const signal = [];
    const timestamps = [];
    let sampleRate = 0;
    let startMs = 0;
    let offset = 0;

    let recordLength = detectRecordLength(fileBuffer.slice(0, Math.min(fileBuffer.length, 4096)));

    while (offset + 64 <= fileBuffer.length) {
        if (offset + recordLength > fileBuffer.length) break;

        const recordBuffer = fileBuffer.slice(offset, offset + recordLength);

        try {
            const record = new MSeedRecord(recordBuffer);
            const recordData = Array.isArray(record.data) ? record.data : [];
            if (!recordData.length) {
                offset += recordLength;
                continue;
            }

            const sr = Number(record?.header?.sampleRate || sampleRate || 0);
            if (sr > 0) sampleRate = sr;

            const recordStart = toMillis(record?.header?.start);
            if (!startMs || (recordStart && recordStart < startMs)) startMs = recordStart;

            const stepMs = sampleRate > 0 ? (1000 / sampleRate) : 0;

            for (let i = 0; i < recordData.length; i += 1) {
                const value = Number(recordData[i]);
                if (!Number.isFinite(value)) continue;

                signal.push(value);
                if (recordStart && stepMs > 0) {
                    timestamps.push(recordStart + Math.round(i * stepMs));
                }
            }

            recordLength = detectRecordLength(recordBuffer);
        } catch (error) {
            // Keep scanning even if one record block is malformed.
        }

        offset += recordLength;
    }

    return {
        timestamp: startMs ? new Date(startMs) : new Date(),
        signal,
        timestamps,
        sampleRate,
    };
};

const parseWithIris = (fileBuffer) => {
    if (!irisMseed || typeof irisMseed.parseDataRecords !== 'function') return null;

    const records = irisMseed.parseDataRecords(fileBuffer);
    if (!Array.isArray(records) || !records.length) return null;

    const signal = [];
    const timestamps = [];
    let sampleRate = 0;
    let startMs = 0;

    for (const rec of records) {
        const samples = rec?.samples || rec?.data || rec?.y || [];
        const sr = Number(rec?.sampleRate || rec?.header?.sampleRate || 0);
        if (sr > 0) sampleRate = sr;

        const recStartMs = toMillis(rec?.startTime || rec?.header?.startTime || rec?.header?.start);
        if (!startMs || (recStartMs && recStartMs < startMs)) startMs = recStartMs;

        const stepMs = sampleRate > 0 ? (1000 / sampleRate) : 0;

        if (Array.isArray(samples)) {
            for (let i = 0; i < samples.length; i += 1) {
                const value = Number(samples[i]);
                if (!Number.isFinite(value)) continue;
                signal.push(value);
                if (recStartMs && stepMs > 0) timestamps.push(recStartMs + Math.round(i * stepMs));
            }
        }
    }

    return {
        timestamp: startMs ? new Date(startMs) : new Date(),
        signal,
        timestamps,
        sampleRate,
    };
};

const parseMseedFile = async (filePath) => {
    const fileBuffer = fs.readFileSync(filePath);
    if (!fileBuffer || fileBuffer.length < 64) {
        return {
            timestamp: new Date(),
            signal: [],
            timestamps: [],
            sampleRate: 0,
        };
    }

    const irisParsed = parseWithIris(fileBuffer);
    if (irisParsed && irisParsed.signal.length) return irisParsed;

    return parseWithLibmseed(fileBuffer);
};

module.exports = {
    parseMseedFile,
};
