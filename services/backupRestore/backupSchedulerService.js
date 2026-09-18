const BackupJob = require("../../models/backupJobModel");
const BackupRecord = require("../../models/backupRecordModel");
const { runBackup } = require("./backupEngine");
const { computeNextRunAt } = require("./backupScheduleUtils");
const { syncStuckRunningJobs } = require("./backupJobSyncService");

let timer = null;
let started = false;

const STUCK_RUNNING_MS = Number(process.env.BACKUP_JOB_STUCK_MS || 15 * 60 * 1000);

async function releaseStuckRunningJobs() {
  const stuckBefore = new Date(Date.now() - STUCK_RUNNING_MS);
  await BackupJob.updateMany(
    { lastStatus: "running", lastRunAt: { $lt: stuckBefore } },
    { $set: { lastStatus: "failed", lastError: "Scheduled job run timed out" } }
  );
}

async function reconcileJobs() {
  const enabledJobs = await BackupJob.find({ isEnabled: true }).lean();
  await Promise.all(
    enabledJobs.map((job) =>
      BackupJob.findByIdAndUpdate(job._id, { $set: { nextRunAt: computeNextRunAt(job) } })
    )
  );
}

async function tickScheduler() {
  if (String(process.env.BACKUP_SCHEDULER_ENABLED || "false").toLowerCase() !== "true") return;
  await syncStuckRunningJobs();
  await releaseStuckRunningJobs();
  const now = new Date();
  const dueJobs = await BackupJob.find({
    isEnabled: true,
    nextRunAt: { $lte: now },
    lastStatus: { $ne: "running" },
  });

  for (const job of dueJobs) {
    const claimed = await BackupJob.findOneAndUpdate(
      {
        _id: job._id,
        isEnabled: true,
        nextRunAt: { $lte: now },
        lastStatus: { $ne: "running" },
      },
      { $set: { lastStatus: "running", lastRunAt: new Date(), lastError: null } },
      { new: true }
    );
    if (!claimed) continue;

    try {
      const queuedRecord = await BackupRecord.create({
        backupType: "scheduled",
        scopeType: claimed.scopeType,
        scopeId: claimed.scopeId,
        status: "queued",
        createdBy: claimed.createdBy,
        notes: `scheduled run from job ${claimed._id}`,
      });

      await runBackup({
        req: null,
        actorUserId: claimed.createdBy,
        actorRole: "super_admin",
        backupType: "scheduled",
        scopeType: claimed.scopeType,
        scopeId: claimed.scopeId,
        replaceDailyBackup: Boolean(claimed.replaceDailyBackup),
        sourceJobId: claimed._id,
        backupRecordId: queuedRecord._id,
      });
    } catch (error) {
      console.error(`[scheduler] backup failed for job ${claimed._id}:`, error.message);
    }
  }
}

async function startBackupSchedulerService() {
  if (started) return;
  started = true;
  await reconcileJobs();
  timer = setInterval(() => {
    tickScheduler().catch(() => {});
  }, 30 * 1000);
  if (typeof timer.unref === "function") timer.unref();
}

function stopBackupSchedulerService() {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}

module.exports = {
  startBackupSchedulerService,
  stopBackupSchedulerService,
  computeNextRunAt,
  reconcileJobs,
  syncStuckRunningJobs,
};
