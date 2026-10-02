const fs = require("fs");
const os = require("os");
const path = require("path");
const { ZipArchive } = require("archiver");
const { pipeline } = require("stream/promises");
const {
  getS3ObjectBody,
  getS3ObjectStream,
  headS3Object,
  assertBackupStorageReadable,
} = require("./backupStorageService");

function buildDownloadFileName(backup) {
  const scopePart = backup.scopeId ? String(backup.scopeId) : "system";
  const timestamp = backup.completedAt
    ? new Date(backup.completedAt).toISOString().replace(/[:.]/g, "-")
    : String(backup._id);
  return `terracart-backup-${backup.scopeType}-${scopePart}-${timestamp}.zip`;
}

async function resolveBackupManifest(backup) {
  if (backup?.manifest && Array.isArray(backup.manifest.files) && backup.manifest.files.length > 0) {
    return backup.manifest;
  }
  if (backup?.manifestS3Key) {
    const manifestBody = await getS3ObjectBody(backup.manifestS3Key);
    const parsed = JSON.parse(manifestBody.toString("utf8"));
    if (Array.isArray(parsed?.files) && parsed.files.length > 0) {
      return parsed;
    }
  }
  throw new Error("Backup manifest is missing or has no collection files");
}

async function prepareBackupDownload(backup) {
  assertBackupStorageReadable();

  if (!backup || backup.status !== "success") {
    throw new Error("Only successful backups can be downloaded");
  }

  const manifest = await resolveBackupManifest(backup);
  const files = manifest.files.filter((file) => file?.key);
  if (!files.length) {
    throw new Error("Backup manifest has no downloadable collection files");
  }

  for (const file of files) {
    try {
      await headS3Object(file.key);
    } catch (error) {
      const reason = error?.name || error?.Code || error?.message || "unknown";
      throw new Error(`Backup file missing in S3 (${file.collection || file.key}): ${reason}`);
    }
  }

  let checksumBody = null;
  if (backup.checksumS3Key) {
    try {
      checksumBody = await getS3ObjectBody(backup.checksumS3Key);
    } catch (error) {
      const reason = error?.name || error?.Code || error?.message || "unknown";
      throw new Error(`Backup checksum file missing in S3: ${reason}`);
    }
  }

  return { manifest, files, checksumBody };
}

function buildZipReadme({ backup, manifest }) {
  const collectionList = (manifest.files || [])
    .map((file) => `- ${file.collection}: ${file.records ?? "?"} records`)
    .join("\n");

  return `TerraCart Database Backup Archive
================================

Backup ID: ${manifest.backupId || backup._id}
Scope: ${manifest.scopeType}${manifest.scopeId ? ` (${manifest.scopeId})` : ""}
Type: ${manifest.backupType || backup.backupType}
Created: ${manifest.completedAt || backup.completedAt || "unknown"}
Database: ${manifest.dbType || "mongodb"}
Format version: ${manifest.version || 1}

Archive layout
--------------
manifest.json     Backup metadata and file index (required for restore)
checksum.sha256   SHA-256 hash of all collection file bytes (integrity check)
collections/      One gzip-compressed NDJSON file per MongoDB collection

Each file in collections/ is named:
  backup-<scope>-<scopeId>-<timestamp>-<CollectionName>.ndjson.gz

Inside each .ndjson.gz file, every line is one MongoDB document in BSON Extended JSON format.

Collections in this backup
--------------------------
${collectionList || "(none listed)"}

How to inspect locally
----------------------
1. Extract this ZIP.
2. Open manifest.json in a text editor for metadata and record counts.
3. Decompress any collections/*.ndjson.gz file (7-Zip, gunzip, etc.).
4. Open the resulting .ndjson file: one JSON document per line.

How restore works in TerraCart Admin
------------------------------------
- Admin restore reads the backup from S3 using the backup record in Backup History.
- This downloaded ZIP contains the same collection data as that S3 backup.
- Use Backup History > Restore in the SuperAdmin panel to restore (preview first, then confirm).
- Keep this ZIP as an offsite/disaster-recovery copy of the same backup.
`;
}

async function buildBackupZipTempFile({ backup, manifest, files, checksumBody }) {
  const tmpZip = path.join(os.tmpdir(), `terracart-download-${backup._id}-${Date.now()}.zip`);
  const output = fs.createWriteStream(tmpZip);
  const archive = new ZipArchive({ zlib: { level: 6 } });

  const archiveFinished = new Promise((resolve, reject) => {
    output.on("close", resolve);
    output.on("error", reject);
    archive.on("error", reject);
  });

  archive.pipe(output);
  archive.append(buildZipReadme({ backup, manifest }), { name: "README.txt" });
  archive.append(JSON.stringify(manifest, null, 2), { name: "manifest.json" });

  if (checksumBody) {
    archive.append(checksumBody, { name: "checksum.sha256" });
  } else if (backup.checksumSha256) {
    archive.append(`${backup.checksumSha256}\n`, { name: "checksum.sha256" });
  }

  for (const file of files) {
    const entryName = `collections/${path.basename(String(file.key))}`;
    const stream = await getS3ObjectStream(file.key);
    archive.append(stream, { name: entryName });
  }

  archive.finalize();
  await archiveFinished;
  return tmpZip;
}

async function streamBackupZipToResponse({ backup, res }) {
  const prepared = await prepareBackupDownload(backup);
  const tmpZip = await buildBackupZipTempFile({ backup, ...prepared });

  try {
    const stat = await fs.promises.stat(tmpZip);
    const downloadName = backup.fileName?.endsWith(".zip")
      ? backup.fileName
      : buildDownloadFileName(backup);

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${downloadName}"`);
    res.setHeader("Content-Length", String(stat.size));

    await pipeline(fs.createReadStream(tmpZip), res);
  } finally {
    await fs.promises.rm(tmpZip, { force: true });
  }
}

module.exports = {
  streamBackupZipToResponse,
  buildDownloadFileName,
  resolveBackupManifest,
  prepareBackupDownload,
};
