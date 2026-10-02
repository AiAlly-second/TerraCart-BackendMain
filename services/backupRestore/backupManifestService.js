const crypto = require("crypto");

function createChecksumStream() {
  const hash = crypto.createHash("sha256");
  return {
    update: (chunk) => hash.update(chunk),
    digestHex: () => hash.digest("hex"),
  };
}

function buildManifest({
  backupId,
  backupType,
  scopeType,
  scopeId = null,
  dbType = "mongodb",
  appVersion = null,
  createdBy,
  startedAt,
  completedAt,
  recordCounts = {},
  files = [],
  s3 = {},
}) {
  return {
    version: 1,
    backupId: String(backupId),
    backupType,
    scopeType,
    scopeId: scopeId ? String(scopeId) : null,
    dbType,
    appVersion: appVersion || process.env.npm_package_version || "unknown",
    createdBy: createdBy ? String(createdBy) : null,
    startedAt: startedAt ? new Date(startedAt).toISOString() : null,
    completedAt: completedAt ? new Date(completedAt).toISOString() : null,
    recordCounts,
    files,
    s3,
  };
}

module.exports = {
  createChecksumStream,
  buildManifest,
};
