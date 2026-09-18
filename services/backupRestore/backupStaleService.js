const BackupRecord = require("../../models/backupRecordModel");
const { buildLockKey, forceReleaseLock } = require("./backupRestoreLockService");

const ACTIVE_BACKUP_STATUSES = new Set(["queued", "running"]);
const BACKUP_STALE_PROGRESS_MS = Number(process.env.BACKUP_STALE_PROGRESS_MS || 45 * 60 * 1000);
const BACKUP_MAX_RUNTIME_MS = Number(process.env.BACKUP_MAX_RUNTIME_MS || 3 * 60 * 60 * 1000);

async function markBackupFailed(backup, errorMessage) {
  const updated = await BackupRecord.findByIdAndUpdate(
    backup._id,
    {
      $set: {
        status: "failed",
        completedAt: new Date(),
        errorMessage,
        progress: {
          phase: "failed",
          percentage: 0,
          currentCollection: backup.progress?.currentCollection || null,
          processedRecords: Number(backup.progress?.processedRecords || 0),
          totalRecords: Number(backup.progress?.totalRecords || 0),
          updatedAt: new Date(),
        },
      },
    },
    { new: true }
  ).lean();

  const lockKey = buildLockKey("backup", backup.scopeType, backup.scopeId);
  await forceReleaseLock(lockKey);
  return updated;
}

async function reconcileStaleBackup(backup) {
  if (!backup || !ACTIVE_BACKUP_STATUSES.has(backup.status)) {
    return backup;
  }

  const now = Date.now();
  const startedAtMs = backup.startedAt ? new Date(backup.startedAt).getTime() : null;
  const lastProgressMs = backup.progress?.updatedAt
    ? new Date(backup.progress.updatedAt).getTime()
    : startedAtMs;

  if (startedAtMs && now - startedAtMs > BACKUP_MAX_RUNTIME_MS) {
    return markBackupFailed(
      backup,
      "Backup exceeded maximum runtime and was stopped automatically"
    );
  }

  if (lastProgressMs && now - lastProgressMs > BACKUP_STALE_PROGRESS_MS) {
    return markBackupFailed(
      backup,
      "Backup timed out due to no progress updates. Please retry after restarting the backend."
    );
  }

  return backup;
}

module.exports = {
  reconcileStaleBackup,
};
