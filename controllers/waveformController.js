const TriggeredWaveform = require('../models/TriggeredWaveform');

// @desc    Save waveform data from socket event
// @route   POST /api/waveforms/save
// @access  Public
exports.saveWaveformData = async (req, res) => {
  try {
    const { sensor, channel, values, metadata } = req.body;

    if (!sensor || !channel || !Array.isArray(values) || values.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: sensor, channel, values (non-empty array)',
      });
    }

    if (!['X', 'Y', 'Z'].includes(channel)) {
      return res.status(400).json({
        success: false,
        message: 'Channel must be X, Y, or Z',
      });
    }

    const waveform = new TriggeredWaveform({
      sensor: String(sensor).trim(),
      channel,
      values: values.map((v) => Number(v)).filter((v) => Number.isFinite(v)),
      metadata: metadata || {},
    });

    await waveform.save();

    res.status(201).json({
      success: true,
      message: 'Waveform data saved',
      data: waveform,
    });
  } catch (error) {
    console.error('Error saving waveform:', error);
    res.status(500).json({
      success: false,
      message: 'Server error saving waveform',
      error: error.message,
    });
  }
};

// @desc    Get recent waveform data for a specific sensor and channel
// @route   GET /api/waveforms/:sensor/:channel
// @access  Public
exports.getWaveformData = async (req, res) => {
  try {
    const { sensor, channel } = req.params;
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const minutesBack = Number(req.query.minutes) || 60;

    console.log('[getWaveformData] Query:', { sensor, channel, limit, minutesBack });

    const since = new Date(Date.now() - minutesBack * 60 * 1000);

    const waveforms = await TriggeredWaveform.find({
      sensor,
      channel,
      timestamp: { $gte: since },
    })
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean();

    console.log('[getWaveformData] Found records:', {
      count: waveforms.length,
      sensor,
      channel,
      sampleRecord: waveforms[0],
    });

    res.json({
      success: true,
      data: waveforms,
      count: waveforms.length,
    });
  } catch (error) {
    console.error('Error fetching waveforms:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching waveforms',
      error: error.message,
    });
  }
};

// @desc    Get 3 most recent waveforms for combined chart (sequentially concatenated)
// @route   GET /api/waveforms/combined/:sensor/:channel
// @access  Public
exports.getCombinedWaveforms = async (req, res) => {
  try {
    const { sensor, channel } = req.params;

    console.log('[getCombinedWaveforms] Query:', { sensor, channel });

    // Fetch the 3 most recent waveforms
    const waveforms = await TriggeredWaveform.find({
      sensor,
      channel,
    })
      .sort({ timestamp: -1 })
      .limit(3)
      .lean();

    console.log('[getCombinedWaveforms] Found records:', {
      count: waveforms.length,
      timestamps: waveforms.map((w) => w.timestamp),
    });

    // Return them in reverse order (oldest first) so they display chronologically
    const orderedWaveforms = waveforms.reverse();

    res.json({
      success: true,
      data: orderedWaveforms,
      count: orderedWaveforms.length,
    });
  } catch (error) {
    console.error('Error fetching combined waveforms:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching combined waveforms',
      error: error.message,
    });
  }
};

// @desc    Get all unique sensors with recent data
// @route   GET /api/waveforms/sensors
// @access  Public
exports.getSensors = async (req, res) => {
  try {
    const minutesBack = Number(req.query.minutes) || 60;
    const since = new Date(Date.now() - minutesBack * 60 * 1000);

    const sensors = await TriggeredWaveform.distinct('sensor', {
      timestamp: { $gte: since },
    });

    res.json({
      success: true,
      data: sensors.sort(),
    });
  } catch (error) {
    console.error('Error fetching sensors:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching sensors',
      error: error.message,
    });
  }
};

// @desc    Clear old waveform data (older than X hours)
// @route   DELETE /api/waveforms/cleanup
// @access  Private
exports.cleanupOldWaveforms = async (req, res) => {
  try {
    const hoursBack = Number(req.query.hours) || 24;
    const cutoffDate = new Date(Date.now() - hoursBack * 60 * 60 * 1000);

    const result = await TriggeredWaveform.deleteMany({
      timestamp: { $lt: cutoffDate },
    });

    res.json({
      success: true,
      message: `Deleted ${result.deletedCount} old waveform records`,
    });
  } catch (error) {
    console.error('Error cleaning up waveforms:', error);
    res.status(500).json({
      success: false,
      message: 'Server error cleaning up waveforms',
      error: error.message,
    });
  }
};
