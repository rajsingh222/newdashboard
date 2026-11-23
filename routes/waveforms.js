const express = require('express');
const {
  saveWaveformData,
  getWaveformData,
  getSensors,
  cleanupOldWaveforms,
  getCombinedWaveforms,
} = require('../controllers/waveformController');

const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

// Login required for every waveform route
router.use(protect);

// Save waveform data
router.post('/save', saveWaveformData);

// Get 3 most recent waveforms for combined chart
router.get('/combined/:sensor/:channel', getCombinedWaveforms);

// Get waveform data for a sensor and channel
router.get('/:sensor/:channel', getWaveformData);

// Get all sensors with recent data
router.get('/sensors/list', getSensors);

// Cleanup old data
router.delete('/cleanup', authorize('admin'), cleanupOldWaveforms);

module.exports = router;
