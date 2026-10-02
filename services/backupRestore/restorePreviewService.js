const zlib = require("zlib");
const readline = require("readline");
const { Readable } = require("stream");
const mongoose = require("mongoose");
const BackupRecord = require("../../models/backupRecordModel");
const RestoreRecord = require("../../models/restoreRecordModel");
const { getS3ObjectBody, headS3Object } = require("./backupStorageService");
const { writeBackupRestoreAuditLog } = require("./backupRestoreAuditService");

function toObjectId(value) {
  if (!value) return null;
  if (value instanceof mongoose.Types.ObjectId) return value;
  if (!mongoose.Types.ObjectId.isValid(String(value))) return null;
  return new mongoose.Types.ObjectId(String(value));
}

async function countNdjsonGzipRecords(buffer) {
  const gunzip = zlib.createGunzip();
  const input = Readable.from(buffer);
  input.pipe(gunzip);
  const rl = readline.createInterface({ input: gunzip, crlfDelay: Infinity });
  let count = 0;
  for await (const line of rl) {
    if (String(line || "").trim()) count += 1;
  }
  return count;
}

function validateScopeMatch(backup, targetScopeType, targetScopeId) {
  if (backup.scopeType !== targetScopeType) return { ok: false, reason: "Scope type mismatch" };
  if (backup.scopeType === "system") return { ok: true };
  if (String(backup.scopeId || "") !== String(targetScopeId || "")) {
    return { ok: false, reason: "Scope id mismatch" };
  }
  return { ok: true };
}

async function previewRestore({
  req,
  actorUserId,
  actorRole,
  backupId,
  targetScopeType,
  targetScopeId = null,
  restoreMode = "merge_with_validation",
}) {
  const backup = await BackupRecord.findById(backupId).lean();
  if (!backup) throw new Error("Backup not found");
  if (backup.status !== "success") throw new Error("Backup is not in success state");
  if (!backup.manifestS3Key || !backup.checksumS3Key) throw new Error("Backup manifest/checksum missing");

  await headS3Object(backup.manifestS3Key);
  await headS3Object(backup.checksumS3Key);

  const checksumBuffer = await getS3ObjectBody(backup.checksumS3Key);
  const checksumFromFile = String(checksumBuffer.toString("utf8") || "").trim();
  const checksumVerified =
    Boolean(backup.checksumSha256) && checksumFromFile === String(backup.checksumSha256).trim();

  const scopeValidation = validateScopeMatch(backup, targetScopeType, targetScopeId);
  const validationResults = {
    scopeValidation,
    checksumVerified,
    manifestAvailable: true,
    blockedReasons: [],
  };
  if (!scopeValidation.ok) validationResults.blockedReasons.push(scopeValidation.reason);
  if (!checksumVerified) validationResults.blockedReasons.push("Checksum validation failed");

  const manifestBuffer = await getS3ObjectBody(backup.manifestS3Key);
  const manifest = JSON.parse(manifestBuffer.toString("utf8"));

  const summary = {
    recordsToCreate: 0,
    recordsToUpdate: 0,
    recordsToSkip: 0,
    conflicts: 0,
    missingReferences: 0,
    byCollection: {},
  };

  for (const file of manifest.files || []) {
    if (!file?.collection || !file?.key) continue;
    const model = mongoose.models[file.collection];
    if (!model) continue;
    const raw = await getS3ObjectBody(file.key);
    const countFromBackup = await countNdjsonGzipRecords(raw);
    const existingCount = await model.countDocuments({});
    const toCreate = Math.max(0, countFromBackup - existingCount);
    const toUpdate = Math.min(countFromBackup, existingCount);
    summary.recordsToCreate += toCreate;
    summary.recordsToUpdate += toUpdate;
    summary.byCollection[file.collection] = {
      backupRecords: countFromBackup,
      existingRecords: existingCount,
      toCreate,
      toUpdate,
      toSkip: 0,
      conflicts: 0,
    };
  }

  const status = validationResults.blockedReasons.length ? "blocked" : "preview_ready";
  const restoreRecord = await RestoreRecord.create({
    backupId: backup._id,
    scopeType: targetScopeType,
    scopeId: toObjectId(targetScopeId),
    restoreMode,
    status: status === "blocked" ? "blocked" : "preview_ready",
    dryRunSummary: summary,
    validationResults,
    createdBy: actorUserId,
  });

  await writeBackupRestoreAuditLog({
    req,
    actorUserId,
    actorRole,
    action: status === "blocked" ? "restore_preview_blocked" : "restore_preview_completed",
    status,
    scopeType: targetScopeType,
    scopeId: targetScopeId,
    backupId,
    restoreId: restoreRecord._id,
    details: { restoreMode },
  });

  return restoreRecord.toObject();
}

module.exports = {
  previewRestore,
};
