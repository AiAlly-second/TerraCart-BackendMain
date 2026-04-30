const crypto = require("crypto");

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
]);

const REPLAYABLE_HEADERS = new Set([
  "content-type",
  "content-encoding",
  "cache-control",
  "etag",
  "last-modified",
  "vary",
]);

const DEFAULT_HEAVY_ENDPOINT_PREFIXES = [
  "/api/orders",
  "/api/inventory",
  "/api/analytics",
  "/api/dashboard",
  "/api/revenue",
  "/api/costing",
  "/api/costing-v2",
  "/api/print-queue",
];

const HEALTH_PATH_REGEX = /^\/(?:api\/)?health(?:\/|$)/i;

const nowMs = () => Date.now();

const toSafeInt = (rawValue, fallback) => {
  const parsed = Number.parseInt(rawValue, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return fallback;
  return parsed;
};

const writeLogLine = (line) => {
  try {
    process.stdout.write(`${line}\n`);
  } catch (_error) {
    // Ignore log write failures.
  }
};

const hashString = (input) =>
  crypto.createHash("sha1").update(String(input || "")).digest("hex");

const isHealthPath = (pathValue) => HEALTH_PATH_REGEX.test(String(pathValue || ""));

const getRequestIp = (req) => {
  const forwardedFor = req.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor.split(",")[0].trim();
  }
  return (
    req.ip ||
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    "unknown"
  );
};

const sortObjectKeys = (value, depth = 0) => {
  if (depth > 8) return "[MAX_DEPTH]";
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((entry) => sortObjectKeys(entry, depth + 1));
  }
  if (typeof value === "object") {
    const output = {};
    for (const key of Object.keys(value).sort()) {
      output[key] = sortObjectKeys(value[key], depth + 1);
    }
    return output;
  }
  if (typeof value === "string" && value.length > 2048) {
    return `${value.slice(0, 2048)}...`;
  }
  return value;
};

const cloneBody = (body) => {
  if (Buffer.isBuffer(body)) return Buffer.from(body);
  if (body && typeof body === "object") {
    try {
      return JSON.parse(JSON.stringify(body));
    } catch (_error) {
      return body;
    }
  }
  return body;
};

const pickReplayHeaders = (headers) => {
  const replay = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const normalized = String(name || "").toLowerCase();
    if (!normalized || HOP_BY_HOP_HEADERS.has(normalized)) continue;
    if (!REPLAYABLE_HEADERS.has(normalized)) continue;
    replay[name] = value;
  }
  return replay;
};

const replayResponse = (res, payload) => {
  if (!payload || res.headersSent || res.writableEnded) return;

  for (const [headerName, headerValue] of Object.entries(payload.headers || {})) {
    if (headerValue === undefined) continue;
    res.setHeader(headerName, headerValue);
  }

  res.status(payload.statusCode || 200);

  if (payload.bodyType === "json") {
    res.json(payload.body);
    return;
  }

  if (payload.body !== undefined) {
    res.send(payload.body);
    return;
  }

  res.end();
};

const createCacheKey = (req, includeBody = false) => {
  const authSource = [
    req.headers.authorization || "",
    req.headers["x-api-key"] || "",
    req.headers["x-session-token"] || "",
    req.headers["x-order-session-token"] || "",
    req.headers["x-anonymous-session-id"] || "",
  ].join("|");

  const bodyHash = includeBody
    ? hashString(JSON.stringify(sortObjectKeys(req.body || {})))
    : "";

  return [
    getRequestIp(req),
    req.method,
    req.originalUrl || req.url || req.path || "",
    hashString(authSource),
    bodyHash,
  ].join("|");
};

const pruneOldestEntries = (map, maxSize) => {
  if (!(map instanceof Map) || map.size <= maxSize) return;
  const entries = Array.from(map.entries()).sort(
    (left, right) => (left[1]?.createdAt || 0) - (right[1]?.createdAt || 0)
  );
  const toRemove = map.size - maxSize;
  for (let index = 0; index < toRemove; index += 1) {
    map.delete(entries[index][0]);
  }
};

const createSlowApiLogger = (options = {}) => {
  const thresholdMs = toSafeInt(options.thresholdMs || process.env.SLOW_API_THRESHOLD_MS, 300);

  return (req, res, next) => {
    const started = process.hrtime.bigint();

    res.on("finish", () => {
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      if (elapsedMs <= thresholdMs) return;
      writeLogLine(
        `SLOW API: [${req.method}] [${req.originalUrl || req.url}] - ${Math.round(
          elapsedMs
        )}ms`
      );
    });

    next();
  };
};

const createRequestTimeoutGuard = (options = {}) => {
  const timeoutMs = toSafeInt(options.timeoutMs || process.env.REQUEST_TIMEOUT_GUARD_MS, 10000);
  const shouldSkip = options.skip || (() => false);

  return (req, res, next) => {
    if (shouldSkip(req) || isHealthPath(req.path)) return next();

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (res.headersSent || res.writableEnded) return;
      res.setHeader("Retry-After", Math.ceil(timeoutMs / 1000));
      res.status(503).json({
        success: false,
        message: "Request timeout. Please retry.",
      });
    }, timeoutMs);

    if (typeof timer.unref === "function") timer.unref();

    const clear = () => clearTimeout(timer);
    res.on("finish", clear);
    res.on("close", clear);

    // Best-effort guard to reduce duplicate send attempts after timeout.
    const wrapSender = (sender) =>
      function wrappedSender(...args) {
        if (timedOut && (res.headersSent || res.writableEnded)) return res;
        return sender.apply(this, args);
      };

    res.json = wrapSender(res.json.bind(res));
    res.send = wrapSender(res.send.bind(res));
    res.end = wrapSender(res.end.bind(res));

    next();
  };
};

const createWarmupGuard = (options = {}) => {
  const warmupMs = toSafeInt(options.warmupMs || process.env.WARMUP_DURATION_MS, 8000);
  const heavyPrefixes = Array.isArray(options.heavyPrefixes) && options.heavyPrefixes.length
    ? options.heavyPrefixes
    : DEFAULT_HEAVY_ENDPOINT_PREFIXES;
  const startedAt = nowMs();
  const warmupUntil = startedAt + warmupMs;

  writeLogLine(
    `[STARTUP] Warmup enabled for ${warmupMs}ms (until ${new Date(warmupUntil).toISOString()})`
  );

  const isHeavyPath = (pathValue) => {
    const normalized = String(pathValue || "");
    return heavyPrefixes.some((prefix) => normalized.startsWith(prefix));
  };

  const middleware = (req, res, next) => {
    if (isHealthPath(req.path) || req.method === "OPTIONS") return next();
    const now = nowMs();
    if (now >= warmupUntil) return next();
    if (!isHeavyPath(req.path)) return next();

    const retryAfterSeconds = Math.max(1, Math.ceil((warmupUntil - now) / 1000));
    res.setHeader("Retry-After", retryAfterSeconds);
    return res.status(503).json({
      success: false,
      message: "Server warming up. Please retry shortly.",
    });
  };

  middleware.getState = () => ({
    startedAt,
    warmupUntil,
    warmupMs,
    remainingMs: Math.max(0, warmupUntil - nowMs()),
  });

  return middleware;
};

const createRequestDeduplicationMiddleware = (options = {}) => {
  const inflight = new Map();
  const pendingTtlMs = toSafeInt(options.pendingTtlMs || process.env.REQUEST_DEDUP_TTL_MS, 20000);
  const maxEntries = toSafeInt(options.maxEntries || process.env.REQUEST_DEDUP_MAX_ENTRIES, 1500);
  const shouldSkip = options.skip || (() => false);

  const cleanup = () => {
    const now = nowMs();
    for (const [key, entry] of inflight.entries()) {
      if (!entry || now - entry.createdAt > pendingTtlMs) {
        inflight.delete(key);
      }
    }
  };

  const cleanupTimer = setInterval(cleanup, 30000);
  if (typeof cleanupTimer.unref === "function") cleanupTimer.unref();

  return (req, res, next) => {
    if (isHealthPath(req.path) || shouldSkip(req)) return next();
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();

    const dedupeKey = createCacheKey(req, req.method !== "GET");
    const existing = inflight.get(dedupeKey);

    if (existing) {
      existing.promise
        .then((payload) => replayResponse(res, payload))
        .catch(() => next());
      return;
    }

    let resolveEntry;
    let rejectEntry;
    const promise = new Promise((resolve, reject) => {
      resolveEntry = resolve;
      rejectEntry = reject;
    });

    const entry = {
      createdAt: nowMs(),
      promise,
      resolve: resolveEntry,
      reject: rejectEntry,
    };

    inflight.set(dedupeKey, entry);
    pruneOldestEntries(inflight, maxEntries);

    let capturedBody;
    let bodyType;
    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);
    const originalEnd = res.end.bind(res);

    res.json = (body) => {
      bodyType = "json";
      capturedBody = cloneBody(body);
      return originalJson(body);
    };

    res.send = (body) => {
      if (!bodyType) bodyType = Buffer.isBuffer(body) ? "buffer" : "send";
      capturedBody = cloneBody(body);
      return originalSend(body);
    };

    res.end = function dedupeAwareEnd(chunk, encoding, callback) {
      if (!bodyType && chunk !== undefined && chunk !== null) {
        bodyType = Buffer.isBuffer(chunk) ? "buffer" : "send";
        capturedBody = cloneBody(chunk);
      }
      return originalEnd(chunk, encoding, callback);
    };

    let settled = false;
    const clearEntry = () => {
      if (settled) return;
      settled = true;
      inflight.delete(dedupeKey);
    };

    res.on("finish", () => {
      const payload = {
        statusCode: res.statusCode,
        headers: pickReplayHeaders(res.getHeaders()),
        bodyType: bodyType || null,
        body: capturedBody,
      };
      entry.resolve(payload);
      clearEntry();
    });

    res.on("close", () => {
      if (settled || res.writableEnded) return;
      entry.reject(new Error("Request closed before completion"));
      clearEntry();
    });

    next();
  };
};

const createGetResponseCache = (options = {}) => {
  const cache = new Map();
  const ttlMs = toSafeInt(options.ttlMs || process.env.GET_CACHE_TTL_MS, 10000);
  const maxEntries = toSafeInt(options.maxEntries || process.env.GET_CACHE_MAX_ENTRIES, 600);
  const matcher = options.matcher || ((req) => req.path.startsWith("/api/menu/public"));

  const cleanup = () => {
    const now = nowMs();
    for (const [key, entry] of cache.entries()) {
      if (!entry || now >= entry.expiresAt) {
        cache.delete(key);
      }
    }
  };

  const cleanupTimer = setInterval(cleanup, 30000);
  if (typeof cleanupTimer.unref === "function") cleanupTimer.unref();

  return (req, res, next) => {
    if (req.method !== "GET") return next();
    if (isHealthPath(req.path)) return next();
    if (!matcher(req)) return next();

    const cacheKey = createCacheKey(req, false);
    const now = nowMs();
    const cached = cache.get(cacheKey);

    if (cached && now < cached.expiresAt) {
      replayResponse(res, cached);
      return;
    }

    let capturedBody;
    let bodyType;
    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);
    const originalEnd = res.end.bind(res);

    res.json = (body) => {
      bodyType = "json";
      capturedBody = cloneBody(body);
      return originalJson(body);
    };

    res.send = (body) => {
      if (!bodyType) bodyType = Buffer.isBuffer(body) ? "buffer" : "send";
      capturedBody = cloneBody(body);
      return originalSend(body);
    };

    res.end = function cacheAwareEnd(chunk, encoding, callback) {
      if (!bodyType && chunk !== undefined && chunk !== null) {
        bodyType = Buffer.isBuffer(chunk) ? "buffer" : "send";
        capturedBody = cloneBody(chunk);
      }
      return originalEnd(chunk, encoding, callback);
    };

    res.on("finish", () => {
      if (res.statusCode < 200 || res.statusCode >= 300) return;
      const cachedPayload = {
        createdAt: nowMs(),
        expiresAt: nowMs() + ttlMs,
        statusCode: res.statusCode,
        headers: pickReplayHeaders(res.getHeaders()),
        bodyType: bodyType || null,
        body: capturedBody,
      };
      cache.set(cacheKey, cachedPayload);
      pruneOldestEntries(cache, maxEntries);
    });

    next();
  };
};

const createShutdownGuard = (isShuttingDown) => {
  return (req, res, next) => {
    const shuttingDown = typeof isShuttingDown === "function" ? isShuttingDown() : false;
    if (!shuttingDown || isHealthPath(req.path)) return next();
    res.setHeader("Connection", "close");
    res.setHeader("Retry-After", "3");
    return res.status(503).json({
      success: false,
      message: "Server restart in progress. Please retry shortly.",
    });
  };
};

module.exports = {
  createSlowApiLogger,
  createRequestTimeoutGuard,
  createWarmupGuard,
  createRequestDeduplicationMiddleware,
  createGetResponseCache,
  createShutdownGuard,
  isHealthPath,
  getRequestIp,
  writeLogLine,
};
