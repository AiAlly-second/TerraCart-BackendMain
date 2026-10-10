const fs = require('node:fs');
const crypto = require('node:crypto');

function canonicalPayload(metadata) {
  const keys = Object.keys(metadata).filter(key => !['metadataSignature', 'signatureAlgorithm'].includes(key)).sort();
  const payload = {};
  for (const key of keys) {
    if (metadata[key] !== null && typeof metadata[key] === 'object') throw new Error('APP_UPDATE_SIGNATURE_INVALID');
    payload[key] = metadata[key];
  }
  return JSON.stringify(payload);
}

function signMetadata(metadata, keyFile, { now = Date.now(), applicationId = "com.example.terra_admin_app", channel = "production_private" } = {}) {
  // Existing clients remain compatible. New release clients require a signature.
  if (!keyFile) return metadata;
  if (!Number.isSafeInteger(metadata.latestBuildNumber) || metadata.latestBuildNumber <= 0 ||
      !Number.isSafeInteger(metadata.fileSizeBytes) || metadata.fileSizeBytes <= 0 ||
      !['production_private', 'internal_qa'].includes(channel)) throw new Error('APP_UPDATE_SIGNATURE_INVALID');
  // Android versionCode is the monotonic release sequence. Policy changes need a new build.
  metadata = { ...metadata, schemaVersion: 2, applicationId, channel,
    releaseSequence: metadata.latestBuildNumber,
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 6 * 60 * 60 * 1000).toISOString() };
  const stat = fs.statSync(keyFile);
  if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('APP_UPDATE_KEY_PERMISSIONS_INVALID');
  const real = fs.realpathSync(keyFile);
  const repo = fs.realpathSync(require('node:path').join(__dirname, '..'));
  if (real.startsWith(repo + require('node:path').sep)) throw new Error('APP_UPDATE_KEY_LOCATION_INVALID');
  const key = crypto.createPrivateKey(fs.readFileSync(real));
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 2048) throw new Error('APP_UPDATE_SIGNATURE_INVALID');
  const metadataSignature = crypto.sign('RSA-SHA256', Buffer.from(canonicalPayload(metadata)), key).toString('base64');
  return { ...metadata, signatureAlgorithm: 'RSA-SHA256', metadataSignature };
}
module.exports = { canonicalPayload, signMetadata };
