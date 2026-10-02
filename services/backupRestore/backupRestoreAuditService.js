const BackupRestoreAuditLog = require("../../models/backupRestoreAuditLogModel");

function getRequestMetadata(req) {
  const ipAddress =
    req?.headers?.["x-forwarded-for"]?.toString?.().split(",")[0]?.trim() ||
    req?.ip ||
    req?.socket?.remoteAddress ||
    null;
  const userAgent = req?.headers?.["user-agent"] || null;
  return { ipAddress, userAgent };
}

async function writeBackupRestoreAuditLog({
  req = null,
  actorUserId,
  actorRole,
  action,
  status,
  scopeType = null,
  scopeId = null,
  backupId = null,
  restoreId = null,
  details = {},
}) {
  if (!actorUserId || !actorRole || !action || !status) return null;
  const requestMetadata = getRequestMetadata(req);
  return BackupRestoreAuditLog.create({
    action,
    actorUserId,
    actorRole,
    ipAddress: requestMetadata.ipAddress,
    userAgent: requestMetadata.userAgent,
    scopeType,
    scopeId,
    backupId,
    restoreId,
    status,
    details,
  });
}

module.exports = {
  writeBackupRestoreAuditLog,
};
