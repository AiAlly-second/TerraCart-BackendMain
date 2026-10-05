const mongoose = require("mongoose");
const { DEFAULT_BUSINESS_TIMEZONE } = require("../utils/businessTime");
const BackupJob = require("../models/backupJobModel");
const BackupRecord = require("../models/backupRecordModel");
const RestoreRecord = require("../models/restoreRecordModel");
const BackupRestoreAuditLog = require("../models/backupRestoreAuditLogModel");
const { runBackup } = require("../services/backupRestore/backupEngine");
const { previewRestore } = require("../services/backupRestore/restorePreviewService");
const { executeRestore } = require("../services/backupRestore/restoreEngine");
const { computeNextRunAt, syncStuckRunningJobs } = require("../services/backupRestore/backupSchedulerService");
const { writeBackupRestoreAuditLog } = require("../services/backupRestore/backupRestoreAuditService");
const { streamBackupZipToResponse } = require("../services/backupRestore/backupDownloadService");
const { reconcileStaleBackup } = require("../services/backupRestore/backupStaleService");

function normalizeScope({ scopeType, scopeId }) {
  const normalizedType = String(scopeType || "").trim().toLowerCase();
  if (!["system", "franchise", "cart"].includes(normalizedType)) {
    throw new Error("Invalid scopeType");
  }
  if (normalizedType !== "system") {
    if (!scopeId || !mongoose.Types.ObjectId.isValid(String(scopeId))) {
      throw new Error("scopeId is required and must be valid for franchise/cart scopes");
    }
  }
  return {
    scopeType: normalizedType,
    scopeId: normalizedType === "system" ? null : new mongoose.Types.ObjectId(String(scopeId)),
  };
}

function validateScheduleTimeIST(value) {
  const safe = String(value || "").trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(safe)) {
    throw new Error("scheduleTimeIST must be in HH:MM format (24-hour, Asia/Kolkata)");
  }
  return safe;
}

function buildJobUpdates(body, existingJob = null) {
  const updates = {};
  if (body.name !== undefined) {
    const name = String(body.name || "").trim();
    if (!name) throw new Error("Job name is required");
    updates.name = name;
  }
  if (body.frequency !== undefined) {
    const frequency = String(body.frequency || "daily").trim().toLowerCase();
    if (!["daily", "weekly", "custom"].includes(frequency)) {
      throw new Error("Invalid frequency");
    }
    updates.frequency = frequency;
  }
  if (body.scheduleTimeIST !== undefined) {
    updates.scheduleTimeIST = validateScheduleTimeIST(body.scheduleTimeIST);
  }
  if (body.isEnabled !== undefined) updates.isEnabled = Boolean(body.isEnabled);
  if (body.replaceDailyBackup !== undefined) {
    updates.replaceDailyBackup = Boolean(body.replaceDailyBackup);
  }
  if (body.maxRetries !== undefined) {
    updates.maxRetries = Math.max(0, Math.min(10, Number(body.maxRetries || 3)));
  }
  if (body.scopeType !== undefined || body.scopeId !== undefined) {
    const normalizedScope = normalizeScope({
      scopeType: body.scopeType ?? existingJob?.scopeType,
      scopeId: body.scopeId ?? existingJob?.scopeId,
    });
    updates.scopeType = normalizedScope.scopeType;
    updates.scopeId = normalizedScope.scopeId;
  }
  return updates;
}

exports.createManualBackup = async (req, res) => {
  try {
    const normalizedScope = normalizeScope(req.body || {});
    const queuedRecord = await BackupRecord.create({
      backupType: "manual",
      scopeType: normalizedScope.scopeType,
      scopeId: normalizedScope.scopeId,
      status: "queued",
      createdBy: req.user._id,
      notes: req.body?.notes || null,
    });

    runBackup({
      req,
      actorUserId: req.user._id,
      actorRole: req.user.role,
      backupType: "manual",
      scopeType: normalizedScope.scopeType,
      scopeId: normalizedScope.scopeId,
      replaceDailyBackup: Boolean(req.body?.replaceDailyBackup),
      notes: req.body?.notes || null,
      backupRecordId: queuedRecord._id,
    }).catch((error) => {
      console.error("[backup] manual backup async run failed:", error.message);
    });

    await writeBackupRestoreAuditLog({
      req,
      actorUserId: req.user._id,
      actorRole: req.user.role,
      action: "manual_backup_requested",
      status: "queued",
      scopeType: normalizedScope.scopeType,
      scopeId: normalizedScope.scopeId,
      backupId: queuedRecord._id,
      details: { replaceDailyBackup: Boolean(req.body?.replaceDailyBackup) },
    });

    return res.status(202).json({
      success: true,
      message: "Backup queued successfully",
      data: queuedRecord,
    });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

exports.listBackups = async (req, res) => {
  const backups = await BackupRecord.find({}).sort({ createdAt: -1 }).limit(200).lean();
  res.json({ success: true, data: backups });
};

exports.getBackupById = async (req, res) => {
  const backup = await BackupRecord.findById(req.params.backupId).lean();
  if (!backup) return res.status(404).json({ success: false, message: "Backup not found" });
  res.json({ success: true, data: backup });
};

exports.getBackupStatus = async (req, res) => {
  let backup = await BackupRecord.findById(req.params.backupId)
    .select("status progress startedAt completedAt errorMessage scopeType scopeId backupType updatedAt fileName fileSize manifest manifestS3Key")
    .lean();
  if (!backup) return res.status(404).json({ success: false, message: "Backup not found" });
  backup = await reconcileStaleBackup(backup);
  res.json({ success: true, data: backup });
};

exports.downloadBackup = async (req, res) => {
  try {
    let backup = await BackupRecord.findById(req.params.backupId).lean();
    if (!backup) return res.status(404).json({ success: false, message: "Backup not found" });
    backup = await reconcileStaleBackup(backup);
    if (backup.status !== "success") {
      return res.status(400).json({
        success: false,
        message:
          backup.status === "running" || backup.status === "queued"
            ? "Backup is still in progress. Download is available after it completes successfully."
            : "Only successful backups can be downloaded",
      });
    }

    await writeBackupRestoreAuditLog({
      req,
      actorUserId: req.user._id,
      actorRole: req.user.role,
      action: "backup_download_requested",
      status: "success",
      scopeType: backup.scopeType,
      scopeId: backup.scopeId,
      backupId: backup._id,
      details: { fileName: backup.fileName },
    });

    await streamBackupZipToResponse({ backup, res });
  } catch (error) {
    console.error("[backup-download] failed:", error.message || error);
    if (!res.headersSent) {
      return res.status(400).json({ success: false, message: error.message || "Failed to download backup" });
    }
    res.end();
  }
};

exports.deleteBackup = async (req, res) => {
  const backup = await BackupRecord.findByIdAndUpdate(
    req.params.backupId,
    { $set: { status: "deleted" } },
    { new: true }
  ).lean();
  if (!backup) return res.status(404).json({ success: false, message: "Backup not found" });
  await writeBackupRestoreAuditLog({
    req,
    actorUserId: req.user._id,
    actorRole: req.user.role,
    action: "backup_deleted",
    status: "success",
    scopeType: backup.scopeType,
    scopeId: backup.scopeId,
    backupId: backup._id,
    details: {},
  });
  res.json({ success: true, data: backup });
};

exports.createBackupJob = async (req, res) => {
  try {
    const normalizedScope = normalizeScope(req.body || {});
    const scheduleTimeIST = validateScheduleTimeIST(req.body?.scheduleTimeIST || "01:00");
    const job = await BackupJob.create({
      name: req.body?.name?.trim() || `Backup ${normalizedScope.scopeType}`,
      scopeType: normalizedScope.scopeType,
      scopeId: normalizedScope.scopeId,
      frequency: req.body?.frequency || "daily",
      scheduleTimeIST,
      cronExpression: req.body?.cronExpression || null,
      timezone: DEFAULT_BUSINESS_TIMEZONE,
      isEnabled: req.body?.isEnabled !== false,
      replaceDailyBackup: Boolean(req.body?.replaceDailyBackup),
      retentionPolicy: req.body?.retentionPolicy || undefined,
      maxRetries: Number(req.body?.maxRetries || 3),
      createdBy: req.user._id,
      updatedBy: req.user._id,
    });
    const nextRunAt = computeNextRunAt(job);
    await BackupJob.findByIdAndUpdate(job._id, { $set: { nextRunAt } });
    await writeBackupRestoreAuditLog({
      req,
      actorUserId: req.user._id,
      actorRole: req.user.role,
      action: "backup_job_created",
      status: "success",
      scopeType: job.scopeType,
      scopeId: job.scopeId,
      details: { jobId: job._id },
    });
    res.status(201).json({ success: true, data: await BackupJob.findById(job._id).lean() });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

exports.listBackupJobs = async (_req, res) => {
  await syncStuckRunningJobs();
  const jobs = await BackupJob.find({}).sort({ createdAt: -1 }).lean();
  res.json({ success: true, data: jobs });
};

exports.getSchedulerStatus = async (_req, res) => {
  const enabled = String(process.env.BACKUP_SCHEDULER_ENABLED || "false").toLowerCase() === "true";
  res.json({
    success: true,
    data: {
      enabled,
      timezone: DEFAULT_BUSINESS_TIMEZONE,
      pollIntervalSeconds: 30,
      envFlag: "BACKUP_SCHEDULER_ENABLED",
    },
  });
};

exports.getBackupJobById = async (req, res) => {
  const job = await BackupJob.findById(req.params.jobId).lean();
  if (!job) return res.status(404).json({ success: false, message: "Backup job not found" });
  res.json({ success: true, data: job });
};

exports.updateBackupJob = async (req, res) => {
  try {
    const existingJob = await BackupJob.findById(req.params.jobId).lean();
    if (!existingJob) return res.status(404).json({ success: false, message: "Backup job not found" });

    const updates = buildJobUpdates(req.body || {}, existingJob);
    updates.updatedBy = req.user._id;

    const job = await BackupJob.findByIdAndUpdate(req.params.jobId, { $set: updates }, { new: true });
    const nextRunAt = computeNextRunAt(job);
    await BackupJob.findByIdAndUpdate(job._id, { $set: { nextRunAt } });
    await writeBackupRestoreAuditLog({
      req,
      actorUserId: req.user._id,
      actorRole: req.user.role,
      action: "backup_job_updated",
      status: "success",
      scopeType: job.scopeType,
      scopeId: job.scopeId,
      details: { jobId: job._id },
    });
    res.json({ success: true, data: await BackupJob.findById(job._id).lean() });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

exports.deleteBackupJob = async (req, res) => {
  const job = await BackupJob.findByIdAndDelete(req.params.jobId).lean();
  if (!job) return res.status(404).json({ success: false, message: "Backup job not found" });
  await writeBackupRestoreAuditLog({
    req,
    actorUserId: req.user._id,
    actorRole: req.user.role,
    action: "backup_job_deleted",
    status: "success",
    scopeType: job.scopeType,
    scopeId: job.scopeId,
    details: { jobId: job._id },
  });
  res.json({ success: true });
};

exports.runBackupJobNow = async (req, res) => {
  try {
    const job = await BackupJob.findById(req.params.jobId).lean();
    if (!job) return res.status(404).json({ success: false, message: "Backup job not found" });

    const claimed = await BackupJob.findOneAndUpdate(
      { _id: job._id, lastStatus: { $ne: "running" } },
      { $set: { lastStatus: "running", lastRunAt: new Date(), lastError: null } },
      { new: true }
    );
    if (!claimed) {
      return res.status(409).json({ success: false, message: "Backup job is already running" });
    }

    const queuedRecord = await BackupRecord.create({
      backupType: "scheduled",
      scopeType: job.scopeType,
      scopeId: job.scopeId,
      status: "queued",
      createdBy: req.user._id,
      notes: `run-now from job ${job._id}`,
    });

    runBackup({
      req,
      actorUserId: req.user._id,
      actorRole: req.user.role,
      backupType: "scheduled",
      scopeType: job.scopeType,
      scopeId: job.scopeId,
      replaceDailyBackup: Boolean(job.replaceDailyBackup),
      sourceJobId: job._id,
      backupRecordId: queuedRecord._id,
    }).catch((error) => {
      console.error("[backup] scheduled run-now async run failed:", error.message);
    });

    await writeBackupRestoreAuditLog({
      req,
      actorUserId: req.user._id,
      actorRole: req.user.role,
      action: "scheduled_backup_run_now",
      status: "queued",
      scopeType: job.scopeType,
      scopeId: job.scopeId,
      backupId: queuedRecord._id,
      details: { jobId: job._id },
    });

    return res.status(202).json({
      success: true,
      message: "Scheduled backup queued",
      data: { job, backupRecord: queuedRecord },
    });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

exports.previewRestore = async (req, res) => {
  try {
    const result = await previewRestore({
      req,
      actorUserId: req.user._id,
      actorRole: req.user.role,
      backupId: req.body?.backupId,
      targetScopeType: req.body?.targetScopeType,
      targetScopeId: req.body?.targetScopeId || null,
      restoreMode: req.body?.restoreMode || "merge_with_validation",
    });
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

exports.executeRestore = async (req, res) => {
  try {
    const result = await executeRestore({
      req,
      actorUserId: req.user._id,
      actorRole: req.user.role,
      restoreRecordId: req.body?.restoreRecordId,
      backupId: req.body?.backupId,
      confirmationPhrase: req.body?.confirmationPhrase,
      acknowledgeRisk: Boolean(req.body?.acknowledgeRisk),
    });
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

exports.getRestoreStatus = async (req, res) => {
  const restore = await RestoreRecord.findById(req.params.restoreId)
    .select("status progress dryRunSummary validationResults startedAt completedAt errorMessage preRestoreBackupId")
    .lean();
  if (!restore) return res.status(404).json({ success: false, message: "Restore record not found" });
  res.json({ success: true, data: restore });
};

exports.listAuditLogs = async (_req, res) => {
  const logs = await BackupRestoreAuditLog.find({}).sort({ createdAt: -1 }).limit(500).lean();
  res.json({ success: true, data: logs });
};
