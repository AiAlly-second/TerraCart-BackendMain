/** Optional Redis: one client, one recovery timer, no offline command queue. */
const { createClient } = require('redis');
const positiveInt = (raw, fallback) => {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
};
function createRedisManager({ factory = createClient, env = process.env,
  random = Math.random, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  log = (line) => process.stdout.write(`${line}\n`) } = {}) {
  let client = null, commandClient = null, connecting = null, recoveryTimer = null;
  let stopped = false, failures = 0, attempts = 0, state = 'DISABLED';
  let readyAt = null;
  const url = () => String(env.REDIS_URL || '').trim() || null;
  const setState = (value) => {
    if (state === value) return;
    state = value;
    log(`[REDIS] ${value}`); // Never log hosts, credentials or error payloads.
  };
  const destroy = (candidate) => {
    try { candidate?.destroy(); } catch (_) { /* already disconnected */ }
  };
  const scheduleRecovery = () => {
    if (stopped || !url() || recoveryTimer || connecting || client?.isReady) return;
    const cap = positiveInt(env.REDIS_RECOVERY_MAX_DELAY_MS, 300000);
    const base = positiveInt(env.REDIS_RECOVERY_DELAY_MS, 15000);
    const delay = Math.min(cap, base * 2 ** Math.min(Math.max(0, failures - 1), 10));
    recoveryTimer = setTimer(() => {
      recoveryTimer = null;
      void ensureConnection();
    }, Math.min(cap, Math.round(delay * (1 + random() * 0.2))));
    recoveryTimer?.unref?.();
  };
  const failed = (candidate) => {
    if (client !== candidate || stopped) return;
    client = null;
    commandClient = null;
    // A briefly successful connection must not reset the outage backoff.
    if (readyAt !== null && now() - readyAt >= 60000) failures = 0;
    readyAt = null;
    failures++;
    destroy(candidate);
    setState('DEGRADED');
    scheduleRecovery();
  };
  function ensureConnection() {
    if (stopped) return Promise.resolve(null);
    if (!url()) { setState('DISABLED'); return Promise.resolve(null); }
    if (client?.isReady) return Promise.resolve(client);
    if (connecting) return connecting;
    if (recoveryTimer) return Promise.resolve(null);
    setState('CONNECTING');
    attempts++;
    let candidate;
    try {
      candidate = factory({ url: url(), disableOfflineQueue: true,
        commandsQueueMaxLength: 100,
        socket: { connectTimeout: positiveInt(env.REDIS_CONNECT_TIMEOUT_MS, 1000),
          reconnectStrategy: false } });
    } catch (_) {
      failures++;
      setState('DEGRADED');
      scheduleRecovery();
      return Promise.resolve(null);
    }
    client = candidate;
    candidate.on('error', () => failed(candidate));
    candidate.on('end', () => failed(candidate));
    let deadline;
    const timeout = new Promise((_, reject) => {
      deadline = setTimer(() => reject(new Error('REDIS_CONNECT_TIMEOUT')),
        positiveInt(env.REDIS_CONNECT_TIMEOUT_MS, 1000) + 250);
      deadline?.unref?.();
    });
    connecting = Promise.race([Promise.resolve().then(() => candidate.connect()), timeout])
      .then(() => {
        if (stopped || client !== candidate || !candidate.isReady) {
          destroy(candidate); return null;
        }
        readyAt = now();
        commandClient = candidate.withCommandOptions?.({
          timeout: positiveInt(env.REDIS_COMMAND_TIMEOUT_MS, 500),
        }) || candidate;
        setState('READY');
        return candidate;
      }).catch(() => { failed(candidate); return null; })
      .finally(() => {
        clearTimer(deadline);
        connecting = null;
        if (!client?.isReady) scheduleRecovery();
      });
    return connecting;
  }
  function getClient() {
    if (stopped || !url()) return null;
    if (client?.isReady) {
      if (readyAt !== null && now() - readyAt >= 60000) failures = 0;
      return commandClient || client;
    }
    void ensureConnection();
    return null;
  }
  async function quit() {
    stopped = true; // end/error/in-flight finally cannot restart recovery.
    clearTimer(recoveryTimer);
    recoveryTimer = null;
    const candidate = client;
    client = null;
    commandClient = null;
    // No offline writes to drain; destroy also aborts a pending connection.
    destroy(candidate);
    setState('STOPPED');
  }
  return { ensureConnection, getClient, quit,
    status: () => ({ configured: Boolean(url()), required: env.REDIS_REQUIRED === 'true',
      state: url() ? state : 'DISABLED',
      ready: Boolean(client?.isReady), attempts, consecutiveFailures: failures,
      recoveryScheduled: Boolean(recoveryTimer) }) };
}
const manager = createRedisManager();
module.exports = { createRedisManager,
  ensureRedisAppClientConnection: manager.ensureConnection,
  getRedisAppClient: manager.getClient, getRedisAppStatus: manager.status,
  quitRedisAppClient: manager.quit,
  getRedisUrl: () => String(process.env.REDIS_URL || '').trim() || null };
