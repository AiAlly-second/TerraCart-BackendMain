const mongoose = require("mongoose");
const { DEFAULT_BUSINESS_TIMEZONE } = require("../utils/businessTime");

const backupJobSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    scopeType: {
      type: String,
      enum: ["system", "franchise", "cart"],
      required: true,
      index: true,
    },
    scopeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
      sparse: true,
    },
    frequency: {
      type: String,
      enum: ["daily", "weekly", "custom"],
      default: "daily",
    },
    scheduleTimeIST: { type: String, required: true, trim: true },
    cronExpression: { type: String, default: null, trim: true },
    timezone: { type: String, default: DEFAULT_BUSINESS_TIMEZONE },
    isEnabled: { type: Boolean, default: true, index: true },
    replaceDailyBackup: { type: Boolean, default: false },
    retentionPolicy: {
      daysToKeep: { type: Number, default: 7, min: 1 },
      keepDailySnapshots: { type: Number, default: 7, min: 1 },
    },
    lastRunAt: { type: Date, default: null },
    nextRunAt: { type: Date, default: null, index: true },
    lastStatus: {
      type: String,
      enum: ["idle", "running", "success", "failed"],
      default: "idle",
      index: true,
    },
    lastError: { type: String, default: null },
    retryCount: { type: Number, default: 0, min: 0 },
    maxRetries: { type: Number, default: 3, min: 0, max: 10 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

backupJobSchema.index({ isEnabled: 1, nextRunAt: 1, createdAt: -1 });
backupJobSchema.index({ scopeType: 1, scopeId: 1, isEnabled: 1 });

module.exports = mongoose.model("BackupJob", backupJobSchema);
