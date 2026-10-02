const mongoose = require("mongoose");

const restoreRecordSchema = new mongoose.Schema(
  {
    backupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BackupRecord",
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
    restoreMode: {
      type: String,
      enum: ["merge_with_validation", "create_missing_only"],
      default: "merge_with_validation",
    },
    status: {
      type: String,
      enum: [
        "previewing",
        "preview_ready",
        "queued",
        "running",
        "success",
        "failed",
        "blocked",
      ],
      default: "previewing",
      index: true,
    },
    dryRunSummary: { type: mongoose.Schema.Types.Mixed, default: {} },
    validationResults: { type: mongoose.Schema.Types.Mixed, default: {} },
    confirmationPhrase: { type: String, default: null },
    preRestoreBackupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BackupRecord",
      default: null,
    },
    affectedRecordCounts: { type: mongoose.Schema.Types.Mixed, default: {} },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    durationMs: { type: Number, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    errorMessage: { type: String, default: null },
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

restoreRecordSchema.index({ status: 1, createdAt: -1 });
restoreRecordSchema.index({ scopeType: 1, scopeId: 1, createdAt: -1 });

module.exports = mongoose.model("RestoreRecord", restoreRecordSchema);
