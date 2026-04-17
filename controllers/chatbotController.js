const PREFILLED_QUESTIONS = [
    'What does SHM mean for this project?',
    'How should I interpret threshold-based alerts?',
    'What do MIN, MAX, AVG, RMS, and STDev indicate?',
    'How do I read Z-score analysis in channel charts?',
    'What should I do if a channel is in the critical range?',
    'How can I validate whether sensor data is reliable?',
];

const SYSTEM_PROMPT = [
    'You are a concise engineering assistant for a structural monitoring dashboard.',
    'Focus on SHM, threshold alerts, sensors, channel statistics, reports, and safety interpretation.',
    'If information is missing, clearly state assumptions and suggest practical next checks.',
    'Respond in plain text only and do not use Markdown symbols such as **, _, #, or backticks.',
    'Avoid legal, medical, or unrelated advice.',
].join(' ');

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL_CANDIDATES = [
    'gemini-1.5-flash-latest',
    'gemini-1.5-flash',
    'gemini-2.0-flash-lite',
    'gemini-2.0-flash',
];

const getGeminiConfig = () => ({
    apiKey: (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_STUDIO_API_KEY || '').trim(),
    model: (process.env.GEMINI_MODEL || 'gemini-1.5-flash').trim(),
    maxOutputTokens: Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 450),
});

const normalizeModelName = (model = '') => String(model).trim().replace(/^models\//i, '');

const modelUnavailableRegex = /not found|not supported for generatecontent|unsupported/i;
const quotaExceededRegex = /quota exceeded|rate limit|resource_exhausted|too many requests/i;

const isModelUnavailableError = (message = '') => modelUnavailableRegex.test(String(message).toLowerCase());
const isQuotaExceededError = (message = '') => quotaExceededRegex.test(String(message).toLowerCase());

const getProviderErrorMessage = (payload) => payload?.error?.message || 'Gemini request failed';

const parseRetryAfterSeconds = (message = '') => {
    const match = String(message).match(/retry in\s*([0-9]+(?:\.[0-9]+)?)s/i);
    if (!match) return null;
    const value = Number(match[1]);
    return Number.isFinite(value) ? Math.max(1, Math.ceil(value)) : null;
};

const buildFallbackAnswer = (question = '') => {
    const q = String(question).toLowerCase();

    if (q.includes('threshold') || q.includes('alert')) {
        return [
            'Quick guidance for threshold alerts:',
            '1) Treat critical alerts as immediate checks for sensor health and structural condition.',
            '2) Verify whether exceedance is persistent across multiple chunks, not just one spike.',
            '3) Cross-check related channels and recent environmental/load changes.',
            '4) Escalate for field inspection if values remain above critical threshold.',
        ].join('\n');
    }

    if (q.includes('z-score') || q.includes('z score')) {
        return [
            'Quick guidance for Z-score interpretation:',
            '- Around 0: near expected behavior.',
            '- |z| >= 2: unusual trend, investigate context.',
            '- |z| >= 3: potential anomaly requiring immediate review.',
            'Always validate with trend over time and adjacent channels before final decision.',
        ].join('\n');
    }

    if (q.includes('rms') || q.includes('stdev') || q.includes('avg') || q.includes('max') || q.includes('min')) {
        return [
            'Quick metric refresher:',
            '- MIN/MAX: observed range bounds.',
            '- AVG: central tendency.',
            '- STDev: variability around average.',
            '- RMS: signal energy/magnitude indicator.',
            'Large STDev + rising RMS often indicates increasing dynamic activity.',
        ].join('\n');
    }

    return [
        'I can help with monitoring insights. Try one of these prompts:',
        '- Explain threshold alert severity handling',
        '- Explain channel statistics metrics',
        '- Explain anomaly detection using Z-score',
    ].join('\n');
};

const requestGenerateContent = async ({ apiKey, model, payload }) => {
    const normalizedModel = normalizeModelName(model);
    const endpoint = `${GEMINI_API_BASE}/models/${encodeURIComponent(normalizedModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });

    let data = {};
    try {
        data = await response.json();
    } catch {
        data = {};
    }

    return {
        ok: response.ok,
        status: response.status,
        data,
        model: normalizedModel,
        message: getProviderErrorMessage(data),
    };
};

const listGenerateModels = async (apiKey) => {
    try {
        const endpoint = `${GEMINI_API_BASE}/models?key=${encodeURIComponent(apiKey)}`;
        const response = await fetch(endpoint);
        if (!response.ok) return [];

        const data = await response.json();
        const models = Array.isArray(data?.models) ? data.models : [];

        return models
            .filter((m) => Array.isArray(m?.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
            .map((m) => normalizeModelName(m?.name || ''))
            .filter(Boolean);
    } catch {
        return [];
    }
};

const toGeminiMessage = (item) => ({
    role: item.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: item.content }],
});

const parseGeminiAnswer = (payload) => {
    const candidate = payload?.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const answer = parts
        .map((part) => part?.text || '')
        .join('')
        .trim();

    return answer;
};

exports.getPrefilledQuestions = async (req, res) => {
    return res.status(200).json({ success: true, questions: PREFILLED_QUESTIONS });
};

exports.askChatbot = async (req, res) => {
    try {
        const question = (req.body?.question || '').toString().trim();
        const rawHistory = Array.isArray(req.body?.history) ? req.body.history : [];

        if (!question) {
            return res.status(400).json({ success: false, message: 'Question is required' });
        }

        const history = rawHistory
            .filter((item) => item && typeof item.content === 'string')
            .map((item) => ({
                role: item.role === 'assistant' ? 'assistant' : 'user',
                content: item.content.trim(),
            }))
            .filter((item) => item.content)
            .slice(-8);

        const { apiKey, model, maxOutputTokens } = getGeminiConfig();
        if (!apiKey) {
            return res.status(500).json({
                success: false,
                message: 'Gemini API key is not configured on server',
            });
        }

        const payload = {
            systemInstruction: {
                parts: [{ text: SYSTEM_PROMPT }],
            },
            contents: [
                ...history.map(toGeminiMessage),
                { role: 'user', parts: [{ text: question }] },
            ],
            generationConfig: {
                temperature: 0.4,
                maxOutputTokens,
            },
        };

        const configuredModel = normalizeModelName(model);
        const discoveredModels = await listGenerateModels(apiKey);
        const candidateModels = [...new Set([configuredModel, ...DEFAULT_MODEL_CANDIDATES, ...discoveredModels].filter(Boolean))];

        let lastError = 'Gemini request failed';
        const quotaFailures = [];
        for (const candidateModel of candidateModels) {
            const result = await requestGenerateContent({
                apiKey,
                model: candidateModel,
                payload,
            });

            if (result.ok) {
                const answer = parseGeminiAnswer(result.data);
                if (!answer) {
                    return res.status(502).json({ success: false, message: 'No response generated by Gemini' });
                }
                return res.status(200).json({ success: true, answer });
            }

            lastError = result.message;

            if (result.status === 429 || isQuotaExceededError(result.message)) {
                quotaFailures.push({
                    model: candidateModel,
                    message: result.message,
                    retryAfterSec: parseRetryAfterSeconds(result.message),
                });
                continue;
            }

            if (!isModelUnavailableError(result.message)) {
                return res.status(result.status || 502).json({ success: false, message: result.message });
            }
        }

        if (quotaFailures.length > 0) {
            const retryCandidates = quotaFailures
                .map((item) => item.retryAfterSec)
                .filter((value) => Number.isFinite(value));
            const retryAfterSec = retryCandidates.length ? Math.min(...retryCandidates) : null;
            const fallback = buildFallbackAnswer(question);

            return res.status(200).json({
                success: true,
                answer: fallback,
                fallback: true,
                quotaLimited: true,
                retryAfterSec,
            });
        }

        return res.status(502).json({
            success: false,
            message: `No compatible Gemini model available for generateContent. Last error: ${lastError}`,
        });
    } catch (error) {
        console.error('Chatbot ask error:', error);
        return res.status(500).json({ success: false, message: 'Failed to generate chatbot response' });
    }
};
