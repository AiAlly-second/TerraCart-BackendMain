const os = require("os");
const crypto = require("crypto");
const BackupRestoreLock = require("../../models/backupRestoreLockModel");

const LOCK_TIMEOUT_MINUTES = Number(process.env.BACKUP_LOCK_TIMEOUT_MINUTES || 60);
const OWNER_ID = `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString("hex")}`;

function buildLockKey(operationType, scopeType, scopeId = null) {
  return `${operationType}:${scopeType}:${scopeId ? String(scopeId) : "system"}`;
}

function getExpiryDate() {
  return new Date(Date.now() + LOCK_TIMEOUT_MINUTES * 60 * 1000);
}

async function acquireLock({ operationType, scopeType, scopeId = null, metadata = {} }) {
  const lockKey = buildLockKey(operationType, scopeType, scopeId);
  const now = new Date();
  const expiresAt = getExpiryDate();

  const existing = await BackupRestoreLock.findOne({ lockKey, status: "acquired" }).lean();
  if (existing && existing.expiresAt && new Date(existing.expiresAt).getTime() > now.getTime()) {
    return { ok: false, reason: "LOCK_ALREADY_HELD", lockKey };
  }

  const lock = await BackupRestoreLock.findOneAndUpdate(
    {
      lockKey,
      $or: [
        { status: { $ne: "acquired" } },
        { expiresAt: { $lte: now } },
        { expiresAt: { $exists: false } },
      ],
    },
    {
      $set: {
        scopeType,
        scopeId,
        operationType,
        status: "acquired",
        owner: OWNER_ID,
        acquiredAt: now,
        heartbeatAt: now,
        expiresAt,
        metadata,
      },
      $setOnInsert: { lockKey },
    },
    { upsert: true, new: true }
  );

  if (!lock || lock.owner !== OWNER_ID) {
    return { ok: false, reason: "LOCK_ACQUIRE_FAILED", lockKey };
  }
  return { ok: true, lockKey, owner: OWNER_ID };
}

async function heartbeatLock(lockKey) {
  if (!lockKey) return;
  await BackupRestoreLock.updateOne(
    { lockKey, owner: OWNER_ID, status: "acquired" },
    { $set: { heartbeatAt: new Date(), expiresAt: getExpiryDate() } }
  );
}

async function releaseLock(lockKey) {
  if (!lockKey) return;
  await BackupRestoreLock.updateOne(
    { lockKey, owner: OWNER_ID, status: "acquired" },
    { $set: { status: "released", heartbeatAt: new Date() } }
  );
}

async function forceReleaseLock(lockKey) {
  if (!lockKey) return;
  await BackupRestoreLock.updateOne(
    { lockKey, status: "acquired" },
    { $set: { status: "released", heartbeatAt: new Date() } }
  );
}

module.exports = {
  acquireLock,
  heartbeatLock,
  releaseLock,
  forceReleaseLock,
  buildLockKey,
};
