const fs = require("fs");
const path = require("path");

const APP_UPDATE_CONFIG_PATH = path.join(__dirname, "..", "app-update.json");
const APK_DIRECTORY = path.join(__dirname, "..", "apk");
const APK_FILE_PREFIX = "terracart_admin_v";
const APK_FILE_EXTENSION = ".apk";
const VERSION_TOKEN_PATTERN = /^[0-9A-Za-z._-]+$/;

const trimTrailingSlash = (value) => String(value || "").replace(/\/+$/, "");

const coalesceString = (...values) => {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const normalized = String(value).trim();
    if (normalized.length > 0) {
      return normalized;
    }
  }
  return "";
};

const hasOwn = (obj, key) =>
  Object.prototype.hasOwnProperty.call(obj || {}, key);

const parseBoolean = (value, fallback = false) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
  }
  return fallback;
};

const readUpdateConfig = () => {
  try {
    if (!fs.existsSync(APP_UPDATE_CONFIG_PATH)) return {};
    const raw = fs.readFileSync(APP_UPDATE_CONFIG_PATH, "utf8");
    if (!raw || raw.trim().length === 0) return {};
    // Support UTF-8 with BOM (common when file is edited by Windows PowerShell).
    const normalizedRaw = raw.replace(/^\uFEFF/, "");
    const parsed = JSON.parse(normalizedRaw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
    return {};
  } catch (_error) {
    return {};
  }
};

const resolvePublicApiBase = (req) => {
  const envBase = coalesceString(
    process.env.APP_API_BASE_URL,
    process.env.API_BASE_URL
  );
  if (envBase) return trimTrailingSlash(envBase);
  return trimTrailingSlash(`${req.protocol}://${req.get("host")}`);
};

const buildResolvedUpdatePayload = (req) => {
  const fileConfig = readUpdateConfig();

  const latestVersion = coalesceString(
    fileConfig.latestVersion,
    process.env.LATEST_APP_VERSION,
    "1.0.0"
  );
  const minimumSupportedVersion = coalesceString(
    fileConfig.minimumSupportedVersion,
    process.env.MIN_SUPPORTED_APP_VERSION,
    latestVersion
  );
  const releaseNotes = coalesceString(
    fileConfig.releaseNotes,
    process.env.APP_RELEASE_NOTES
  );
  const sha256 = coalesceString(fileConfig.sha256, process.env.APP_APK_SHA256);
  const configuredApkUrl = coalesceString(
    fileConfig.apkUrl,
    process.env.APP_APK_URL
  );
  const updateUrl = coalesceString(
    fileConfig.updateUrl,
    process.env.APP_UPDATE_URL
  );
  const forceUpdate = hasOwn(fileConfig, "forceUpdate")
    ? parseBoolean(fileConfig.forceUpdate, false)
    : parseBoolean(process.env.FORCE_APP_UPDATE, false);

  const defaultApkUrl = `${resolvePublicApiBase(req)}/api/app/apk/${encodeURIComponent(
    latestVersion
  )}`;
  const apkUrl = configuredApkUrl || defaultApkUrl;

  return {
    latestVersion,
    minimumSupportedVersion,
    apkUrl,
    releaseNotes,
    sha256,
    forceUpdate,
    updateUrl,
  };
};

exports.getAppVersion = async (req, res) => {
  try {
    const data = buildResolvedUpdatePayload(req);
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to resolve app version info",
      error: error.message,
    });
  }
};

exports.downloadApkByVersion = async (req, res) => {
  try {
    const version = String(req.params.version || "").trim();
    if (!VERSION_TOKEN_PATTERN.test(version)) {
      return res.status(400).json({
        success: false,
        message: "Invalid version format",
      });
    }

    const apkFileName = `${APK_FILE_PREFIX}${version}${APK_FILE_EXTENSION}`;
    const apkPath = path.join(APK_DIRECTORY, apkFileName);
    const resolvedApkPath = path.resolve(apkPath);
    const resolvedApkDir = path.resolve(APK_DIRECTORY);

    if (!resolvedApkPath.startsWith(resolvedApkDir)) {
      return res.status(403).json({
        success: false,
        message: "Access denied",
      });
    }

    if (!fs.existsSync(resolvedApkPath)) {
      return res.status(404).json({
        success: false,
        message: `APK not found for version ${version}`,
      });
    }

    res.setHeader("Content-Type", "application/vnd.android.package-archive");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${apkFileName}"`
    );
    res.setHeader("Cache-Control", "public, max-age=300");
    return res.sendFile(resolvedApkPath);
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to serve APK",
      error: error.message,
    });
  }
};
