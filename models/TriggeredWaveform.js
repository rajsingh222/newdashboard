const mongoose = require('mongoose');

const triggeredWaveformSchema = new mongoose.Schema(
  {
    timestamp: {
      type: Date,
      default: Date.now,
      index: true,
    },
    sensor: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    channel: {
      type: String,
      enum: ['X', 'Y', 'Z'],
      required: true,
    },
    values: {
      type: [Number],
      required: true,
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0,
        message: 'values array must not be empty',
      },
    },
    metadata: {
      packetId: String,
      index: Number,
      sampleRate: Number,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    collection: 'newtriggered',
  }
);

triggeredWaveformSchema.index({ sensor: 1, channel: 1, timestamp: -1 });
triggeredWaveformSchema.index({ timestamp: -1 });

module.exports = mongoose.model('TriggeredWaveform', triggeredWaveformSchema);
