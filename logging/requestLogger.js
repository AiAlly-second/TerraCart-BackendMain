/**
 * Structured HTTP-ish helpers (optional extension point).
 */
const { logWarn, logError } = require("./logger");

function logRetry(tag, fields = {}) {
  logWarn(`http_retry:${tag}`, fields);
}

module.exports = { logRetry, logWarn, logError };
