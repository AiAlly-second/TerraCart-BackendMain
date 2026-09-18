const mongoose = require("mongoose");

const backupRecordSchema = new mongoose.Schema(
  {
    backupType: {
      type: String,
      enum: ["manual", "scheduled", "pre_restore"],
      required: true,
      index: true,
    },
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
    status: {
      type: String,
      enum: ["queued", "running", "success", "failed", "invalid", "deleted"],
      default: "queued",
      index: true,
    },
    s3Bucket: { type: String, default: null },
    s3Key: { type: String, default: null },
    manifestS3Key: { type: String, default: null },
    checksumS3Key: { type: String, default: null },
    fileName: { type: String, default: null },
    fileSize: { type: Number, default: null },
    checksumSha256: { type: String, default: null },
    dbType: { type: String, default: "mongodb" },
    appVersion: { type: String, default: null },
    manifest: { type: mongoose.Schema.Types.Mixed, default: null },
    recordCounts: { type: mongoose.Schema.Types.Mixed, default: {} },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    durationMs: { type: Number, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    replacedBackupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BackupRecord",
      default: null,
    },
    errorMessage: { type: String, default: null },
    notes: { type: String, default: null },
    progress: {
      phase: { type: String, default: "idle" },
      percentage: { type: Number, default: 0, min: 0, max: 100 },
      currentCollection: { type: String, default: null },
      processedRecords: { type: Number, default: 0 },
      totalRecords: { type: Number, default: 0 },
      updatedAt: { type: Date, default: null },
    },
  },
  { timestamps: true }
);

backupRecordSchema.index({ scopeType: 1, scopeId: 1, createdAt: -1 });
backupRecordSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model("BackupRecord", backupRecordSchema);
