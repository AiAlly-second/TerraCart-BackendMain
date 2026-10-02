const { Upload } = require("@aws-sdk/lib-storage");
const { PutObjectCommand, HeadObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { s3 } = require("../../config/uploadConfig");

function getBackupBucket() {
  return String(process.env.AWS_BUCKET_NAME || "").trim();
}

function getBackupPrefix() {
  return String(process.env.BACKUP_S3_PREFIX || "backups").trim().replace(/^\/+|\/+$/g, "");
}

function buildS3Key({ scopeType, scopeId = null, backupType, fileName }) {
  const prefix = getBackupPrefix();
  const safeFile = String(fileName || "").replace(/[^a-zA-Z0-9._/-]/g, "_");
  if (scopeType === "system") {
    return `${prefix}/system/${backupType}/${safeFile}`;
  }
  if (scopeType === "franchise") {
    return `${prefix}/franchises/${scopeId}/${backupType}/${safeFile}`;
  }
  return `${prefix}/carts/${scopeId}/${backupType}/${safeFile}`;
}

async function uploadStreamToS3({ key, body, contentType = "application/octet-stream" }) {
  const bucket = getBackupBucket();
  const upload = new Upload({
    client: s3,
    params: { Bucket: bucket, Key: key, Body: body, ContentType: contentType },
  });
  await upload.done();
  return { bucket, key };
}

async function uploadBufferToS3({ key, body, contentType = "application/json" }) {
  const bucket = getBackupBucket();
  await s3.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType })
  );
  return { bucket, key };
}

async function headS3Object(key) {
  const bucket = getBackupBucket();
  return s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
}

async function getS3ObjectBody(key) {
  const bucket = getBackupBucket();
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const chunks = [];
  for await (const chunk of response.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function getS3ObjectStream(key) {
  const bucket = getBackupBucket();
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return response.Body;
}

function assertBackupStorageConfigured() {
  if (String(process.env.USE_S3 || "").toLowerCase() !== "true") {
    throw new Error("S3 backup storage is not enabled. Set USE_S3=true in backend environment.");
  }
  return assertBackupStorageReadable();
}

function assertBackupStorageReadable() {
  const bucket = getBackupBucket();
  if (!bucket) {
    throw new Error("AWS_BUCKET_NAME is not configured for backup storage.");
  }
  if (!process.env.AWS_REGION || !process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    throw new Error("AWS credentials or region are not configured for backup storage.");
  }
  return bucket;
}

module.exports = {
  getBackupBucket,
  buildS3Key,
  uploadStreamToS3,
  uploadBufferToS3,
  headS3Object,
  getS3ObjectBody,
  getS3ObjectStream,
  assertBackupStorageConfigured,
  assertBackupStorageReadable,
};
