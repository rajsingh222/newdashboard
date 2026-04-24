const express = require('express');
const {
  saveWaveformData,
  getWaveformData,
  getSensors,
  cleanupOldWaveforms,
  getCombinedWaveforms,
} = require('../controllers/waveformController');

const router = express.Router();

// Save waveform data
router.post('/save', saveWaveformData);

// Get 3 most recent waveforms for combined chart
router.get('/combined/:sensor/:channel', getCombinedWaveforms);

// Get waveform data for a sensor and channel
router.get('/:sensor/:channel', getWaveformData);

// Get all sensors with recent data
router.get('/sensors/list', getSensors);

// Cleanup old data
router.delete('/cleanup', cleanupOldWaveforms);

module.exports = router;
