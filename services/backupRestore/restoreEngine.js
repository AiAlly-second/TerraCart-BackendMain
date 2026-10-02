const zlib = require("zlib");
const readline = require("readline");
const { EJSON } = require("bson");
const mongoose = require("mongoose");
const { Readable } = require("stream");
const BackupRecord = require("../../models/backupRecordModel");
const RestoreRecord = require("../../models/restoreRecordModel");
const { runBackup } = require("./backupEngine");
const { getS3ObjectBody } = require("./backupStorageService");
const { acquireLock, releaseLock, heartbeatLock } = require("./backupRestoreLockService");
const { writeBackupRestoreAuditLog } = require("./backupRestoreAuditService");
const { updateRestoreProgress } = require("./backupRestoreProgressService");

const RESTORE_BATCH_SIZE = Number(process.env.RESTORE_BATCH_SIZE || 250);

function expectedConfirmationPhrase(scopeType, scopeId = null) {
  if (scopeType === "system") return "RESTORE system";
  return `RESTORE ${scopeType} ${scopeId}`;
}

function normalizeLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed) return null;
  try {
    return EJSON.parse(trimmed);
  } catch (_error) {
    return null;
  }
}

async function applyCollectionMerge(model, gzBuffer) {
  const gunzip = zlib.createGunzip();
  const input = Readable.from(gzBuffer);
  input.pipe(gunzip);
  const rl = readline.createInterface({ input: gunzip, crlfDelay: Infinity });

  let processed = 0;
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  const ops = [];

  const flush = async () => {
    if (!ops.length) return;
    const result = await model.bulkWrite(ops, { ordered: false });
    inserted += Number(result.upsertedCount || 0);
    updated += Number(result.modifiedCount || 0);
    ops.length = 0;
  };

  for await (const line of rl) {
    const doc = normalizeLine(line);
    if (!doc || !doc._id) {
      skipped += 1;
      continue;
    }
    const _id = doc._id;
    delete doc.__v;
    ops.push({
      updateOne: {
        filter: { _id },
        update: { $set: doc },
        upsert: true,
      },
    });
    processed += 1;
    if (ops.length >= RESTORE_BATCH_SIZE) await flush();
  }
  await flush();
  return { processed, inserted, updated, skipped };
}

async function executeRestore({
  req,
  actorUserId,
  actorRole,
  restoreRecordId,
  backupId,
  confirmationPhrase,
  acknowledgeRisk,
}) {
  const restoreRecord = await RestoreRecord.findById(restoreRecordId);
  if (!restoreRecord) throw new Error("Restore record not found");
  if (!["preview_ready", "queued", "running"].includes(restoreRecord.status)) {
    throw new Error("Restore record is not executable");
  }
  if (String(restoreRecord.backupId) !== String(backupId)) {
    throw new Error("Restore backup mismatch");
  }
  if (!acknowledgeRisk) throw new Error("Risk acknowledgement required");

  const expectedPhrase = expectedConfirmationPhrase(restoreRecord.scopeType, restoreRecord.scopeId);
  if (String(confirmationPhrase || "").trim() !== expectedPhrase) {
    throw new Error("Invalid confirmation phrase");
  }

  const lock = await acquireLock({
    operationType: "restore",
    scopeType: restoreRecord.scopeType,
    scopeId: restoreRecord.scopeId,
    metadata: { restoreRecordId },
  });
  if (!lock.ok) throw new Error(`Restore lock not acquired: ${lock.reason}`);

  try {
    await RestoreRecord.findByIdAndUpdate(restoreRecordId, {
      $set: { status: "running", startedAt: new Date(), confirmationPhrase },
    });

    const preRestoreBackup = await runBackup({
      req,
      actorUserId,
      actorRole,
      backupType: "pre_restore",
      scopeType: restoreRecord.scopeType,
      scopeId: restoreRecord.scopeId,
      replaceDailyBackup: false,
      notes: `pre_restore_snapshot_for_${restoreRecordId}`,
    });
    await RestoreRecord.findByIdAndUpdate(restoreRecordId, {
      $set: { preRestoreBackupId: preRestoreBackup._id },
    });

    const backup = await BackupRecord.findById(backupId).lean();
    if (!backup?.manifestS3Key) throw new Error("Backup manifest missing");
    const checksumBuffer = await getS3ObjectBody(backup.checksumS3Key);
    const checksumFromFile = String(checksumBuffer.toString("utf8") || "").trim();
    if (
      !backup.checksumSha256 ||
      checksumFromFile !== String(backup.checksumSha256).trim()
    ) {
      throw new Error("Checksum validation failed before restore execution");
    }
    const manifestBuffer = await getS3ObjectBody(backup.manifestS3Key);
    const manifest = JSON.parse(manifestBuffer.toString("utf8"));

    const collectionOrder = [
      "Franchise",
      "Cart",
      "User",
      "MenuCategory",
      "MenuItem",
      "InventoryItem",
      "Table",
      "Waitlist",
      "Customer",
      "Order",
      "Payment",
      "PrintQueue",
      "PaymentQR",
      "DeviceToken",
    ];

    const fileByCollection = new Map((manifest.files || []).map((f) => [f.collection, f]));
    const orderedCollections = collectionOrder.filter((name) => fileByCollection.has(name));
    const restCollections = Array.from(fileByCollection.keys()).filter((name) => !collectionOrder.includes(name));
    const applyOrder = [...orderedCollections, ...restCollections];

    const affectedRecordCounts = {};
    let index = 0;
    for (const collectionName of applyOrder) {
      await heartbeatLock(lock.lockKey);
      const file = fileByCollection.get(collectionName);
      const model = mongoose.models[collectionName];
      if (!file || !model) continue;
      const raw = await getS3ObjectBody(file.key);
      const result = await applyCollectionMerge(model, raw);
      affectedRecordCounts[collectionName] = result;
      index += 1;
      await updateRestoreProgress(restoreRecordId, {
        phase: "restoring",
        percentage: Math.round((index / applyOrder.length) * 100),
        currentCollection: collectionName,
        processedRecords: result.processed,
      });
    }

    const completedAt = new Date();
    await RestoreRecord.findByIdAndUpdate(restoreRecordId, {
      $set: {
        status: "success",
        completedAt,
        durationMs: completedAt.getTime() - new Date(restoreRecord.startedAt || Date.now()).getTime(),
        affectedRecordCounts,
      },
    });

    await writeBackupRestoreAuditLog({
      req,
      actorUserId,
      actorRole,
      action: "restore_succeeded",
      status: "success",
      scopeType: restoreRecord.scopeType,
      scopeId: restoreRecord.scopeId,
      backupId,
      restoreId: restoreRecord._id,
      details: { preRestoreBackupId: preRestoreBackup._id },
    });

    return await RestoreRecord.findById(restoreRecordId).lean();
  } catch (error) {
    await RestoreRecord.findByIdAndUpdate(restoreRecordId, {
      $set: { status: "failed", completedAt: new Date(), errorMessage: error.message || "Restore failed" },
    });
    await writeBackupRestoreAuditLog({
      req,
      actorUserId,
      actorRole,
      action: "restore_failed",
      status: "failed",
      scopeType: restoreRecord.scopeType,
      scopeId: restoreRecord.scopeId,
      backupId,
      restoreId: restoreRecord._id,
      details: { error: error.message || "unknown" },
    });
    throw error;
  } finally {
    await releaseLock(lock.lockKey);
  }
}

module.exports = {
  executeRestore,
  expectedConfirmationPhrase,
};
