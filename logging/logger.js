/**
 * Structured JSON logs + AsyncLocalStorage request context.
 * Uses process.stdout so logs remain visible when BACKEND_ENABLE_CONSOLE_LOGS=false.
 */
const { AsyncLocalStorage } = require("async_hooks");

const requestStore = new AsyncLocalStorage();

const isProd =
  String(process.env.NODE_ENV || "").toLowerCase() === "production";

function writeJson(level, event, fields = {}) {
  const ctx = requestStore.getStore() || {};
  const payload = {
    level,
    event,
    ts: new Date().toISOString(),
    correlationId: ctx.correlationId,
    path: ctx.path,
    method: ctx.method,
    ...fields,
  };
  try {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } catch (_e) {
    /* ignore */
  }
}

function requestContextMiddleware(req, res, next) {
  requestStore.run(
    {
      correlationId: req.correlationId,
      path: String(req.originalUrl || req.url || "").split("?")[0],
      method: req.method,
    },
    () => next(),
  );
}

function logAi(event, fields = {}) {
  writeJson("info", event, { scope: "ai", ...fields });
}

function logVoiceCache(fields = {}) {
  writeJson("info", "voice_parse_cache", { scope: "voice_cache", ...fields });
}

function logWarn(event, fields = {}) {
  writeJson("warn", event, fields);
}

function logError(event, fields = {}) {
  writeJson("error", event, fields);
}

function logRedisRate(fields = {}) {
  writeJson("info", "redis_rate_limit", { scope: "rate_limit", ...fields });
}

module.exports = {
  requestStore,
  requestContextMiddleware,
  logAi,
  logVoiceCache,
  logWarn,
  logError,
  logRedisRate,
  isProd,
};
