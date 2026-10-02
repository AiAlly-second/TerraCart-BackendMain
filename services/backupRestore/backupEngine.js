const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { PassThrough } = require("stream");
const { EJSON } = require("bson");
const mongoose = require("mongoose");
const { pipeline } = require("stream/promises");
const BackupRecord = require("../../models/backupRecordModel");
const {
  buildS3Key,
  uploadStreamToS3,
  uploadBufferToS3,
  headS3Object,
  assertBackupStorageConfigured,
} = require("./backupStorageService");
const { resolveScope } = require("./backupScopeResolver");
const { createChecksumStream, buildManifest } = require("./backupManifestService");
const { acquireLock, releaseLock, heartbeatLock } = require("./backupRestoreLockService");
const { writeBackupRestoreAuditLog } = require("./backupRestoreAuditService");
const { updateBackupProgress } = require("./backupRestoreProgressService");
const { updateJobAfterBackup } = require("./backupJobSyncService");

const BACKUP_BATCH_SIZE = Number(process.env.BACKUP_BATCH_SIZE || 500);
const BACKUP_PROGRESS_EVERY = Number(process.env.BACKUP_PROGRESS_EVERY || 250);

function toSafeScopeId(scopeId) {
  return scopeId ? String(scopeId) : "system";
}

function buildCollectionTempFilePath(backupId, collectionName) {
  return path.join(os.tmpdir(), `terracart-backup-${backupId}-${collectionName}.ndjson.gz`);
}

function serializeDocument(doc) {
  return `${EJSON.stringify(doc, { relaxed: false })}\n`;
}

async function writeToGzip(gzip, data) {
  if (!gzip.write(data)) {
    await new Promise((resolve, reject) => {
      gzip.once("drain", resolve);
      gzip.once("error", reject);
    });
  }
}

async function exportCollectionToGzipFile({ model, query, outPath, onProgress }) {
  await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
  const gzip = zlib.createGzip({ level: zlib.constants.Z_BEST_SPEED });
  const out = fs.createWriteStream(outPath);
  const source = model.collection.find(query).batchSize(BACKUP_BATCH_SIZE);
  let count = 0;

  gzip.pipe(out);
  for await (const doc of source) {
    await writeToGzip(gzip, serializeDocument(doc));
    count += 1;
    if (onProgress && count % BACKUP_PROGRESS_EVERY === 0) {
      await onProgress(count);
    }
  }
  gzip.end();
  await new Promise((resolve, reject) => {
    out.on("finish", resolve);
    out.on("error", reject);
    gzip.on("error", reject);
  });
  if (onProgress) {
    await onProgress(count);
  }
  return count;
}

async function uploadCollectionFileWithChecksum({ tempPath, key, checksum, onProgress }) {
  const pass = new PassThrough();
  pass.on("data", (chunk) => checksum.update(chunk));
  const uploadPromise = uploadStreamToS3({
    key,
    body: pass,
    contentType: "application/gzip",
  });
  await pipeline(fs.createReadStream(tempPath), pass);
  await uploadPromise;
  await headS3Object(key);
  if (onProgress) await onProgress();
  const stats = await fs.promises.stat(tempPath);
  return stats.size;
}

function sumRecordCounts(recordCounts) {
  return Object.values(recordCounts).reduce((total, value) => total + Number(value || 0), 0);
}

async function runBackup({
  req = null,
  actorUserId,
  actorRole,
  backupType,
  scopeType,
  scopeId = null,
  replaceDailyBackup = false,
  notes = null,
  sourceJobId = null,
  backupRecordId = null,
}) {
  assertBackupStorageConfigured();

  const lock = await acquireLock({
    operationType: "backup",
    scopeType,
    scopeId,
    metadata: { backupType, sourceJobId },
  });
  if (!lock.ok) throw new Error(`Backup lock not acquired: ${lock.reason}`);

  let backupRecord = null;
  if (backupRecordId) {
    backupRecord = await BackupRecord.findByIdAndUpdate(
      backupRecordId,
      {
        $set: {
          status: "running",
          startedAt: new Date(),
          errorMessage: null,
        },
      },
      { new: true }
    );
    if (!backupRecord) {
      throw new Error("Backup record not found for queued backup");
    }
  } else {
    backupRecord = await BackupRecord.create({
      backupType,
      scopeType,
      scopeId,
      status: "running",
      startedAt: new Date(),
      createdBy: actorUserId,
      notes,
    });
  }

  const backupFileName = `backup-${scopeType}-${toSafeScopeId(scopeId)}-${Date.now()}.zip`;

  try {
    await updateBackupProgress(backupRecord._id, {
      phase: "initializing",
      percentage: 0,
      currentCollection: null,
      processedRecords: 0,
    });

    const scope = await resolveScope({ scopeType, scopeId });
    const collectionNames = Array.from(scope.collectionQueryMap.keys()).filter((name) => {
      const model = mongoose.models[name];
      return Boolean(model?.collection?.name);
    });

    if (!collectionNames.length) {
      throw new Error("No operational collections found for backup scope");
    }

    const checksum = createChecksumStream();
    const files = [];
    const recordCounts = {};
    const totalCollections = collectionNames.length;

    let processedCollections = 0;
    for (const name of collectionNames) {
      await heartbeatLock(lock.lockKey);
      const model = mongoose.models[name];
      const query = scope.collectionQueryMap.get(name) || {};
      const tempPath = buildCollectionTempFilePath(backupRecord._id, name);
      const recordsBeforeCollection = sumRecordCounts(recordCounts);

      await updateBackupProgress(backupRecord._id, {
        phase: "exporting",
        percentage: Math.round((processedCollections / totalCollections) * 85),
        currentCollection: name,
        processedRecords: recordsBeforeCollection,
        totalRecords: totalCollections,
      });

      let count = 0;
      try {
        count = await exportCollectionToGzipFile({
          model,
          query,
          outPath: tempPath,
          onProgress: async (collectionCount) => {
            await heartbeatLock(lock.lockKey);
            await updateBackupProgress(backupRecord._id, {
              phase: "exporting",
              percentage: Math.min(
                89,
                Math.round(((processedCollections + 0.5) / totalCollections) * 85)
              ),
              currentCollection: name,
              processedRecords: recordsBeforeCollection + collectionCount,
              totalRecords: totalCollections,
            });
          },
        });
      } catch (exportError) {
        throw new Error(`Failed exporting collection ${name}: ${exportError.message}`);
      }
      recordCounts[name] = count;

      const baseFileName = `backup-${scopeType}-${toSafeScopeId(scope.scopeId)}-${Date.now()}-${name}.ndjson.gz`;
      const key = buildS3Key({
        scopeType,
        scopeId: toSafeScopeId(scope.scopeId),
        backupType: replaceDailyBackup ? "daily" : backupType,
        fileName: `collections/${baseFileName}`,
      });

      await updateBackupProgress(backupRecord._id, {
        phase: "uploading",
        percentage: Math.round(((processedCollections + 0.85) / totalCollections) * 90),
        currentCollection: name,
        processedRecords: recordsBeforeCollection + count,
        totalRecords: totalCollections,
      });

      const fileSize = await uploadCollectionFileWithChecksum({
        tempPath,
        key,
        checksum,
        onProgress: async () => {
          await heartbeatLock(lock.lockKey);
          await updateBackupProgress(backupRecord._id, {
            phase: "uploading",
            percentage: Math.round(((processedCollections + 0.95) / totalCollections) * 90),
            currentCollection: name,
            processedRecords: recordsBeforeCollection + count,
            totalRecords: totalCollections,
          });
        },
      });
      files.push({ collection: name, key, fileSize, records: count });
      await fs.promises.rm(tempPath, { force: true });

      processedCollections += 1;
      await updateBackupProgress(backupRecord._id, {
        phase: "exporting",
        percentage: Math.round((processedCollections / totalCollections) * 90),
        currentCollection: name,
        processedRecords: sumRecordCounts(recordCounts),
        totalRecords: totalCollections,
      });
    }

    await updateBackupProgress(backupRecord._id, {
      phase: "finalizing",
      percentage: 95,
      currentCollection: null,
      processedRecords: sumRecordCounts(recordCounts),
      totalRecords: totalCollections,
    });

    const completedAt = new Date();
    const checksumSha256 = checksum.digestHex();
    const manifest = buildManifest({
      backupId: backupRecord._id,
      backupType,
      scopeType,
      scopeId,
      createdBy: actorUserId,
      startedAt: backupRecord.startedAt,
      completedAt,
      recordCounts,
      files,
      s3: { bucket: process.env.AWS_BUCKET_NAME, prefix: process.env.BACKUP_S3_PREFIX || "backups" },
    });

    const manifestKey = buildS3Key({
      scopeType,
      scopeId: toSafeScopeId(scopeId),
      backupType: replaceDailyBackup ? "daily" : backupType,
      fileName: `manifests/${backupRecord._id}.manifest.json`,
    });
    const checksumKey = buildS3Key({
      scopeType,
      scopeId: toSafeScopeId(scopeId),
      backupType: replaceDailyBackup ? "daily" : backupType,
      fileName: `checksums/${backupRecord._id}.sha256`,
    });

    await uploadBufferToS3({
      key: manifestKey,
      body: Buffer.from(JSON.stringify(manifest, null, 2)),
      contentType: "application/json",
    });
    await uploadBufferToS3({
      key: checksumKey,
      body: Buffer.from(`${checksumSha256}\n`),
      contentType: "text/plain",
    });

    await BackupRecord.findByIdAndUpdate(backupRecord._id, {
      $set: {
        status: "success",
        completedAt,
        durationMs: completedAt.getTime() - backupRecord.startedAt.getTime(),
        manifest,
        manifestS3Key: manifestKey,
        checksumS3Key: checksumKey,
        checksumSha256,
        fileName: backupFileName,
        fileSize: files.reduce((sum, file) => sum + Number(file.fileSize || 0), 0),
        s3Bucket: process.env.AWS_BUCKET_NAME || null,
        s3Key: files[0]?.key || null,
        recordCounts,
        progress: {
          phase: "completed",
          percentage: 100,
          currentCollection: null,
          processedRecords: sumRecordCounts(recordCounts),
          totalRecords: totalCollections,
          updatedAt: completedAt,
        },
      },
    });

    await writeBackupRestoreAuditLog({
      req,
      actorUserId,
      actorRole,
      action: "backup_succeeded",
      status: "success",
      scopeType,
      scopeId,
      backupId: backupRecord._id,
      details: { backupType, replaceDailyBackup, sourceJobId },
    });

    try {
      await updateJobAfterBackup(sourceJobId, "success");
    } catch (postSuccessError) {
      console.error("[backup] post-success job update failed:", postSuccessError.message);
    }

    return await BackupRecord.findById(backupRecord._id).lean();
  } catch (error) {
    const current = await BackupRecord.findById(backupRecord._id).select("status").lean();
    const alreadySucceeded = current?.status === "success";

    if (!alreadySucceeded) {
      await BackupRecord.findByIdAndUpdate(backupRecord._id, {
        $set: {
          status: "failed",
          completedAt: new Date(),
          errorMessage: error.message || "Backup failed",
          progress: {
            phase: "failed",
            percentage: 0,
            currentCollection: null,
            processedRecords: 0,
            totalRecords: 0,
            updatedAt: new Date(),
          },
        },
      });
      await writeBackupRestoreAuditLog({
        req,
        actorUserId,
        actorRole,
        action: "backup_failed",
        status: "failed",
        scopeType,
        scopeId,
        backupId: backupRecord._id,
        details: { error: error.message || "unknown" },
      });
    } else {
      console.error("[backup] error after successful backup:", error.message);
    }

    try {
      await updateJobAfterBackup(
        sourceJobId,
        alreadySucceeded ? "success" : "failed",
        alreadySucceeded ? null : error.message || "Backup failed"
      );
    } catch (jobUpdateError) {
      console.error("[backup] job status update failed:", jobUpdateError.message);
    }

    if (alreadySucceeded) {
      return await BackupRecord.findById(backupRecord._id).lean();
    }
    throw error;
  } finally {
    await releaseLock(lock.lockKey);
  }
}

module.exports = {
  runBackup,
};
