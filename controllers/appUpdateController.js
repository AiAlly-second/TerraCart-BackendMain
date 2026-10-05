const fs = require('node:fs');
const path = require('node:path');
const semver = require('semver');
const { readMetadata, resolveApk } = require('../utils/appUpdateMetadata');

function createAppUpdateController({ configPath = path.join(__dirname, '..', 'app-update.json'),
  apkDirectory = path.join(__dirname, '..', 'apk'), env = process.env } = {}) {
  function payload(req) {
    const metadata = readMetadata(configPath);
    const file = resolveApk(apkDirectory, metadata);
    const size = fs.statSync(file).size;
    if (metadata.fileSizeBytes != null && metadata.fileSizeBytes !== size) throw new Error('APP_UPDATE_APK_INVALID');
    const configured = env.API_PUBLIC_BASE_URL || env.APP_API_BASE_URL || env.API_BASE_URL;
    const base = (configured || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
    const origin = new URL(base);
    if (origin.username || origin.password || (env.NODE_ENV === 'production' && origin.protocol !== 'https:')) throw new Error('APP_UPDATE_PUBLIC_URL_INVALID');
    return { ...metadata, fileSizeBytes: size,
      apkUrl: metadata.apkUrl || `${base}/api/app/apk/${encodeURIComponent(metadata.latestVersion)}` };
  }
  async function getAppVersion(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    try { return res.json({ success: true, data: payload(req) }); }
    catch (_) { return res.status(500).json({ success: false, message: 'App update configuration is unavailable', code: 'APP_UPDATE_CONFIG_INVALID' }); }
  }
  async function downloadApkByVersion(req, res) {
    try {
      const version = String(req.params.version || '');
      if (!semver.valid(version) || version.includes('+')) return res.status(400).json({ success: false, message: 'Invalid version format' });
      const metadata = readMetadata(configPath);
      if (version !== metadata.latestVersion) return res.status(404).json({ success: false, message: 'APK version unavailable' });
      const file = resolveApk(apkDirectory, metadata);
      const size = fs.statSync(file).size;
      if (metadata.fileSizeBytes != null && size !== metadata.fileSizeBytes) throw new Error('APP_UPDATE_APK_INVALID');
      res.setHeader('Content-Type', 'application/vnd.android.package-archive');
      res.setHeader('Content-Disposition', `attachment; filename="${metadata.apkFileName}"`);
      res.setHeader('Content-Length', size);
      res.setHeader('Cache-Control', 'no-store'); // Same-version newer builds must not serve stale bytes.
      return res.sendFile(file, error => {
        if (error && !res.headersSent) res.status(error.statusCode || 500).end();
      });
    } catch (_) { return res.status(500).json({ success: false, message: 'APK unavailable', code: 'APP_UPDATE_APK_INVALID' }); }
  }
  return { getAppVersion, downloadApkByVersion };
}
module.exports = { ...createAppUpdateController(), createAppUpdateController };
