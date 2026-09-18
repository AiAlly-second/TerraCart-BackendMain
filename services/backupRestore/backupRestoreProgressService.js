const BackupRecord = require("../../models/backupRecordModel");
const RestoreRecord = require("../../models/restoreRecordModel");

const buildProgressPayload = ({
  phase,
  percentage,
  currentCollection,
  processedRecords,
  totalRecords,
}) => ({
  phase: phase || "idle",
  percentage: Number.isFinite(percentage) ? Math.max(0, Math.min(100, percentage)) : 0,
  currentCollection: currentCollection || null,
  processedRecords: Number(processedRecords || 0),
  totalRecords: Number(totalRecords || 0),
  updatedAt: new Date(),
});

async function updateBackupProgress(backupId, progressInput) {
  if (!backupId) return;
  await BackupRecord.findByIdAndUpdate(backupId, {
    $set: { progress: buildProgressPayload(progressInput) },
  });
}

async function updateRestoreProgress(restoreId, progressInput) {
  if (!restoreId) return;
  await RestoreRecord.findByIdAndUpdate(restoreId, {
    $set: { progress: buildProgressPayload(progressInput) },
  });
}

module.exports = {
  updateBackupProgress,
  updateRestoreProgress,
};
