const mongoose = require("mongoose");

const backupRestoreLockSchema = new mongoose.Schema(
  {
    lockKey: { type: String, required: true, unique: true, index: true },
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
      sparse: true,
      index: true,
    },
    operationType: {
      type: String,
      enum: ["backup", "restore"],
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["acquired", "released", "expired"],
      default: "acquired",
      index: true,
    },
    owner: { type: String, required: true },
    acquiredAt: { type: Date, required: true, index: true },
    expiresAt: { type: Date, required: true, index: true },
    heartbeatAt: { type: Date, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

backupRestoreLockSchema.index({ operationType: 1, scopeType: 1, scopeId: 1, status: 1 });

module.exports = mongoose.model("BackupRestoreLock", backupRestoreLockSchema);
