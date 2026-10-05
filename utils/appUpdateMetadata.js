const fs = require('node:fs');
const path = require('node:path');
const semver = require('semver');

const filenamePattern = /^[a-zA-Z0-9_-]+_v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:_b\d+)?\.apk$/;
function validateMetadata(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('APP_UPDATE_CONFIG_INVALID');
  const m = { ...input };
  for (const key of ['latestVersion', 'minimumSupportedVersion']) {
    if (typeof m[key] !== 'string' || !semver.valid(m[key]) || m[key].includes('+')) throw new Error('APP_UPDATE_CONFIG_INVALID');
  }
  if (semver.gt(m.minimumSupportedVersion, m.latestVersion)) throw new Error('APP_UPDATE_CONFIG_INVALID');
  if (m.latestBuildNumber != null && (!Number.isSafeInteger(m.latestBuildNumber) || m.latestBuildNumber <= 0)) throw new Error('APP_UPDATE_CONFIG_INVALID');
  if (typeof m.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(m.sha256)) throw new Error('APP_UPDATE_CONFIG_INVALID');
  m.sha256 = m.sha256.toLowerCase();
  if (m.forceUpdate != null && typeof m.forceUpdate !== 'boolean') throw new Error('APP_UPDATE_CONFIG_INVALID');
  m.forceUpdate = m.forceUpdate ?? false;
  m.apkFileName = m.apkFileName || `terracart_admin_v${m.latestVersion}.apk`;
  if (!filenamePattern.test(m.apkFileName) || path.basename(m.apkFileName) !== m.apkFileName) throw new Error('APP_UPDATE_CONFIG_INVALID');
  const escapedVersion = m.latestVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const mapped = m.apkFileName.match(new RegExp(`_v${escapedVersion}(?:_b(\\d+))?\\.apk$`));
  if (!mapped || (mapped[1] && m.latestBuildNumber != null && Number(mapped[1]) !== m.latestBuildNumber)) throw new Error('APP_UPDATE_CONFIG_INVALID');
  if (m.fileSizeBytes != null && (!Number.isSafeInteger(m.fileSizeBytes) || m.fileSizeBytes <= 0)) throw new Error('APP_UPDATE_CONFIG_INVALID');
  for (const key of ['apkUrl', 'updateUrl']) {
    m[key] = m[key] ?? '';
    if (typeof m[key] !== 'string') throw new Error('APP_UPDATE_CONFIG_INVALID');
    if (m[key]) {
      const url = new URL(m[key]);
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('APP_UPDATE_CONFIG_INVALID');
    }
  }
  if (typeof m.releaseNotes !== 'string') throw new Error('APP_UPDATE_CONFIG_INVALID');
  if (m.publishedAt != null && !Number.isFinite(Date.parse(m.publishedAt))) throw new Error('APP_UPDATE_CONFIG_INVALID');
  return m;
}
function readMetadata(file) {
  return validateMetadata(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')));
}
function resolveApk(directory, metadata) {
  const root = fs.realpathSync(directory);
  const file = path.resolve(root, metadata.apkFileName);
  if (path.dirname(file) !== root || fs.lstatSync(file).isSymbolicLink() ||
      fs.realpathSync(file) !== file || !fs.statSync(file).isFile()) throw new Error('APP_UPDATE_APK_INVALID');
  return file;
}
module.exports = { validateMetadata, readMetadata, resolveApk, filenamePattern };
