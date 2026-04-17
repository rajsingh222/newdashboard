const { fft, util: fftUtil } = require('fft-js');

const DEFAULT_THRESHOLDS = {
    peakSevere: 2000,
    peakImpact: 1000,
    impactDurationSec: 2,
    rmsContinuous: 300,
    continuousDurationSec: 10,
};

const toFiniteNumber = (value, fallback = 0) => {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
};

const getPeakValue = (signal = []) => {
    if (!Array.isArray(signal) || signal.length === 0) return 0;
    let maxAbs = 0;
    for (const sample of signal) {
        const abs = Math.abs(toFiniteNumber(sample, 0));
        if (abs > maxAbs) maxAbs = abs;
    }
    return maxAbs;
};

const getRms = (signal = []) => {
    if (!Array.isArray(signal) || signal.length === 0) return 0;
    const sumSq = signal.reduce((acc, sample) => {
        const val = toFiniteNumber(sample, 0);
        return acc + (val * val);
    }, 0);
    return Math.sqrt(sumSq / signal.length);
};

const getDurationSec = ({ timestamps = [], sampleRate = 0, signalLength = 0 } = {}) => {
    if (Array.isArray(timestamps) && timestamps.length >= 2) {
        const start = toFiniteNumber(timestamps[0], 0);
        const end = toFiniteNumber(timestamps[timestamps.length - 1], 0);
        if (end > start) return (end - start) / 1000;
    }

    const sr = toFiniteNumber(sampleRate, 0);
    if (sr > 0 && signalLength > 1) {
        return (signalLength - 1) / sr;
    }

    return 0;
};

const getDominantFrequency = ({ signal = [], sampleRate = 0 } = {}) => {
    const sr = toFiniteNumber(sampleRate, 0);
    if (!Array.isArray(signal) || signal.length < 4 || sr <= 0) return 0;

    // FFT is fastest and most stable with bounded input; 4096 retains dominant behavior.
    const maxPoints = 4096;
    const step = Math.max(1, Math.floor(signal.length / maxPoints));
    const clipped = signal.filter((_, index) => index % step === 0).slice(0, maxPoints);
    if (clipped.length < 4) return 0;

    const phasors = fft(clipped);
    const magnitudes = fftUtil.fftMag(phasors);
    const freqs = fftUtil.fftFreq(phasors, sr / step);

    let bestMag = -1;
    let bestFreq = 0;

    for (let i = 1; i < magnitudes.length; i += 1) {
        const mag = toFiniteNumber(magnitudes[i], 0);
        const freq = Math.abs(toFiniteNumber(freqs[i], 0));
        if (freq <= 0) continue;

        if (mag > bestMag) {
            bestMag = mag;
            bestFreq = freq;
        }
    }

    return toFiniteNumber(bestFreq, 0);
};

const classifyEvent = ({ peak = 0, rms = 0, duration = 0 }, thresholds = {}) => {
    const t = {
        ...DEFAULT_THRESHOLDS,
        ...thresholds,
    };

    if (peak > t.peakSevere) {
        return { eventType: 'Severe Event', severity: 'High', isCritical: true };
    }

    if (peak > t.peakImpact && duration < t.impactDurationSec) {
        return { eventType: 'Impact Event', severity: 'Medium', isCritical: false };
    }

    if (rms > t.rmsContinuous && duration > t.continuousDurationSec) {
        return { eventType: 'Continuous Vibration', severity: 'Medium', isCritical: false };
    }

    return { eventType: 'Normal', severity: 'Low', isCritical: false };
};

const analyzeSignal = ({ signal = [], timestamps = [], sampleRate = 0 } = {}) => {
    const peak = getPeakValue(signal);
    const rms = getRms(signal);
    const duration = getDurationSec({ timestamps, sampleRate, signalLength: signal.length });
    const dominantFrequency = getDominantFrequency({ signal, sampleRate });

    return {
        peak,
        rms,
        duration,
        dominantFrequency,
    };
};

module.exports = {
    DEFAULT_THRESHOLDS,
    analyzeSignal,
    classifyEvent,
    getPeakValue,
    getRms,
    getDurationSec,
    getDominantFrequency,
};
