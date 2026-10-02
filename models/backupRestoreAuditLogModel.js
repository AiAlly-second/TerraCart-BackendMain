const mongoose = require("mongoose");

const backupRestoreAuditLogSchema = new mongoose.Schema(
  {
    action: { type: String, required: true, index: true },
    actorUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    actorRole: { type: String, required: true, index: true },
    ipAddress: { type: String, default: null },
    userAgent: { type: String, default: null },
    scopeType: {
      type: String,
      enum: ["system", "franchise", "cart", null],
      default: null,
      index: true,
    },
    scopeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      sparse: true,
      index: true,
    },
    backupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BackupRecord",
      default: null,
      index: true,
    },
    restoreId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "RestoreRecord",
      default: null,
      index: true,
    },
    status: { type: String, required: true, index: true },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

backupRestoreAuditLogSchema.index({ createdAt: -1, actorUserId: 1 });
backupRestoreAuditLogSchema.index({ action: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model("BackupRestoreAuditLog", backupRestoreAuditLogSchema);
