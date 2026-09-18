const BackupJob = require("../../models/backupJobModel");
const BackupRecord = require("../../models/backupRecordModel");
const { computeNextRunAt } = require("./backupScheduleUtils");

const STUCK_RUNNING_MS = Number(process.env.BACKUP_JOB_STUCK_MS || 15 * 60 * 1000);

async function updateJobAfterBackup(sourceJobId, status, errorMessage = null) {
  if (!sourceJobId) return;
  const job = await BackupJob.findById(sourceJobId).lean();
  if (!job) return;

  const updates = {
    lastStatus: status,
    lastError: errorMessage,
    nextRunAt: computeNextRunAt(job),
  };
  if (status === "success") {
    updates.retryCount = 0;
    updates.lastRunAt = new Date();
    await BackupJob.findByIdAndUpdate(sourceJobId, { $set: updates });
    return;
  }
  await BackupJob.findByIdAndUpdate(sourceJobId, {
    $set: updates,
    $inc: { retryCount: 1 },
  });
}

function buildScopeQuery(job) {
  const query = {
    backupType: "scheduled",
    scopeType: job.scopeType,
  };
  if (job.scopeId) {
    query.scopeId = job.scopeId;
  } else {
    query.scopeId = null;
  }
  return query;
}

async function syncStuckRunningJobs() {
  const runningJobs = await BackupJob.find({ lastStatus: "running" }).lean();
  if (!runningJobs.length) return;

  const now = Date.now();
  for (const job of runningJobs) {
    if (!job.lastRunAt) continue;

    const scopeQuery = buildScopeQuery(job);
    const terminalBackup = await BackupRecord.findOne({
      ...scopeQuery,
      status: { $in: ["success", "failed"] },
      completedAt: { $gte: job.lastRunAt },
    })
      .sort({ completedAt: -1 })
      .lean();

    if (terminalBackup?.status === "success") {
      await updateJobAfterBackup(job._id, "success");
      continue;
    }
    if (terminalBackup?.status === "failed") {
      await updateJobAfterBackup(job._id, "failed", terminalBackup.errorMessage || "Backup failed");
      continue;
    }

    if (now - job.lastRunAt.getTime() > STUCK_RUNNING_MS) {
      await BackupJob.findByIdAndUpdate(job._id, {
        $set: { lastStatus: "failed", lastError: "Scheduled job run timed out" },
      });
    }
  }
}

module.exports = {
  updateJobAfterBackup,
  syncStuckRunningJobs,
};
