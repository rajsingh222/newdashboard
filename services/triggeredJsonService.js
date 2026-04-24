const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const DEFAULT_EVENT_NAME = process.env.TRIGGERED_JSON_SOCKET_EVENT || 'TRIGGERED_JSON_UPDATED';
const ROOT_DIR = path.resolve(__dirname, '..', '..');
const DEFAULT_WATCH_DIR = process.env.TRIGGERED_JSON_WATCH_DIR
	? path.resolve(process.env.TRIGGERED_JSON_WATCH_DIR)
	: ROOT_DIR;

const isTriggeredJsonFile = (fileName = '') => {
	const name = String(fileName || '').toLowerCase();
	if (!name.endsWith('.json')) return false;
	return name === 'output.json' || name.startsWith('output_');
};

const toPayload = ({ fileName = '', eventType = 'change' } = {}) => ({
	fileName: String(fileName || ''),
	eventType: String(eventType || 'change'),
	timestamp: new Date().toISOString(),
});

const startTriggeredJsonWatcher = (io) => {
	if (!io || typeof io.emit !== 'function') {
		logger.warn('Triggered JSON watcher skipped: socket.io instance is not available');
		return () => {};
	}

	let watcher = null;
	let debounceTimer = null;
	let lastPayloadKey = '';

	const stop = () => {
		if (debounceTimer) {
			clearTimeout(debounceTimer);
			debounceTimer = null;
		}

		if (watcher) {
			try {
				watcher.close();
			} catch (error) {
				logger.warn('Triggered JSON watcher close failed', { error: error.message });
			}
			watcher = null;
		}
	};

	try {
		watcher = fs.watch(DEFAULT_WATCH_DIR, (eventType, fileName) => {
			if (!isTriggeredJsonFile(fileName)) return;

			const payload = toPayload({ fileName, eventType });
			const payloadKey = `${payload.fileName}|${payload.eventType}`;

			if (debounceTimer) {
				clearTimeout(debounceTimer);
			}

			debounceTimer = setTimeout(() => {
				if (payloadKey === lastPayloadKey) return;
				lastPayloadKey = payloadKey;
				io.emit(DEFAULT_EVENT_NAME, payload);
			}, 150);
		});

		watcher.on('error', (error) => {
			logger.warn('Triggered JSON watcher error', { error: error.message });
		});

		logger.info('Triggered JSON watcher initialized', {
			watchDir: DEFAULT_WATCH_DIR,
			eventName: DEFAULT_EVENT_NAME,
		});
	} catch (error) {
		logger.warn('Triggered JSON watcher could not start', {
			watchDir: DEFAULT_WATCH_DIR,
			error: error.message,
		});
		return () => {};
	}

	return stop;
};

module.exports = {
	startTriggeredJsonWatcher,
};
