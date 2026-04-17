const now = () => new Date().toISOString();

const format = (level, message, meta) => {
    const base = `[${now()}] [${level}] ${message}`;
    if (!meta || (typeof meta === 'object' && Object.keys(meta).length === 0)) {
        return base;
    }

    if (typeof meta === 'string') {
        return `${base} ${meta}`;
    }

    return `${base} ${JSON.stringify(meta)}`;
};

const logger = {
    info: (message, meta = null) => console.log(format('INFO', message, meta)),
    warn: (message, meta = null) => console.warn(format('WARN', message, meta)),
    error: (message, meta = null) => console.error(format('ERROR', message, meta)),
    debug: (message, meta = null) => {
        if (String(process.env.LOG_LEVEL || '').toLowerCase() === 'debug') {
            console.debug(format('DEBUG', message, meta));
        }
    },
};

module.exports = logger;
