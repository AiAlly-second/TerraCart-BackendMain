/**
 * Best-effort singleton Redis client for optional application caches/counters.
 * Callers must treat a null return value as a cache miss. Redis never blocks
 * ordinary request handling or core API startup.
 */
const { createClient } = require("redis");

let client = null;
let connectPromise = null;
let recoveryTimer = null;
let state = "DISABLED";

const asPositiveInt = (rawValue, fallback) => {
  const parsed = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const getRedisUrl = () => String(process.env.REDIS_URL || "").trim() || null;
const getConnectTimeoutMs = () => asPositiveInt(process.env.REDIS_CONNECT_TIMEOUT_MS, 1000);
const getRecoveryDelayMs = () => asPositiveInt(process.env.REDIS_RECOVERY_DELAY_MS, 15000);
const getMaxReconnectAttempts = () =>
  asPositiveInt(process.env.REDIS_MAX_RECONNECT_ATTEMPTS, 5);

const setState = (nextState, detail = "") => {
  if (state === nextState) return;
  state = nextState;
  try {
    process.stdout.write(`[REDIS] ${nextState}${detail ? `: ${detail}` : ""}\n`);
  } catch (_error) {
    // Logging must not affect request handling.
  }
};

const destroyClient = (candidate) => {
  try {
    candidate?.destroy?.();
  } catch (_error) {
    // The client may already be closed.
  }
};

const scheduleRecovery = () => {
  if (!getRedisUrl() || recoveryTimer || connectPromise || client?.isReady) return;
  recoveryTimer = setTimeout(() => {
    recoveryTimer = null;
    void ensureRedisAppClientConnection();
  }, getRecoveryDelayMs());
  if (typeof recoveryTimer.unref === "function") recoveryTimer.unref();
};

const buildClient = (url) => {
  const candidate = createClient({
    url,
    socket: {
      connectTimeout: getConnectTimeoutMs(),
      reconnectStrategy: (retries) => {
        if (retries >= getMaxReconnectAttempts()) {
          return new Error("Redis reconnect attempt budget exhausted");
        }
        return Math.min(500 * 2 ** retries, 5000);
      },
    },
  });

  candidate.on("connect", () => setState("CONNECTING"));
  candidate.on("ready", () => setState("READY"));
  candidate.on("reconnecting", () => setState("DEGRADED", "reconnecting"));
  candidate.on("error", () => setState("DEGRADED"));
  candidate.on("end", () => {
    if (client === candidate) client = null;
    setState("DEGRADED", "connection closed");
    scheduleRecovery();
  });
  return candidate;
};

/** Starts a background connection attempt; normal request paths never await it. */
function ensureRedisAppClientConnection() {
  const url = getRedisUrl();
  if (!url) {
    setState("DISABLED");
    return Promise.resolve(null);
  }
  if (client?.isReady) return Promise.resolve(client);
  if (connectPromise) return connectPromise;
  // A failed attempt has already scheduled one recovery probe. Request paths
  // must not turn that bounded probe into a reconnect storm.
  if (recoveryTimer) return Promise.resolve(null);

  const candidate = buildClient(url);
  client = candidate;
  setState("CONNECTING");
  connectPromise = candidate
    .connect()
    .then(() => (candidate.isReady ? candidate : null))
    .catch(() => {
      if (client === candidate) client = null;
      destroyClient(candidate);
      setState("DEGRADED");
      scheduleRecovery();
      return null;
    })
    .finally(() => {
      connectPromise = null;
      if (!candidate.isReady && client === null) scheduleRecovery();
    });
  return connectPromise;
}

/** Returns a ready client or null immediately, preserving database fallback. */
function getRedisAppClient() {
  if (!getRedisUrl()) {
    setState("DISABLED");
    return null;
  }
  if (client?.isReady) return client;
  void ensureRedisAppClientConnection();
  return null;
}

function getRedisAppStatus() {
  const configured = Boolean(getRedisUrl());
  return { configured, state: configured ? state : "DISABLED", ready: Boolean(client?.isReady) };
}

async function quitRedisAppClient() {
  if (recoveryTimer) clearTimeout(recoveryTimer);
  recoveryTimer = null;
  const candidate = client;
  client = null;
  if (candidate?.isOpen) {
    try {
      await candidate.quit();
    } catch (_error) {
      destroyClient(candidate);
    }
  } else {
    destroyClient(candidate);
  }
  setState(getRedisUrl() ? "DEGRADED" : "DISABLED");
}

module.exports = {
  ensureRedisAppClientConnection,
  getRedisAppClient,
  getRedisAppStatus,
  quitRedisAppClient,
  getRedisUrl,
};
