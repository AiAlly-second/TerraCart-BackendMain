const parseBool = (value, fallback = false) => {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
};

const parseNumber = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const STABILITY_FLAGS = Object.freeze({
  ENABLE_NO_RELOAD_RECOVERY: parseBool(
    process.env.ENABLE_NO_RELOAD_RECOVERY,
    true,
  ),
  ENABLE_SOCKET_ROOM_JOIN_DEDUPE: parseBool(
    process.env.ENABLE_SOCKET_ROOM_JOIN_DEDUPE,
    true,
  ),
  ENABLE_EVENT_ACK_GUARD: parseBool(process.env.ENABLE_EVENT_ACK_GUARD, true),
  ENABLE_EVENT_ORIGIN_METADATA: parseBool(
    process.env.ENABLE_EVENT_ORIGIN_METADATA,
    true,
  ),
  ENABLE_SOCKET_DEDUPE: parseBool(process.env.ENABLE_SOCKET_DEDUPE, true),
  ENABLE_REQUEST_DEDUPE: parseBool(process.env.ENABLE_REQUEST_DEDUPE, true),
  ENABLE_POLLING_MUTEX: parseBool(process.env.ENABLE_POLLING_MUTEX, true),
  ENABLE_SINGLETON_SOCKET_ADMIN: parseBool(
    process.env.ENABLE_SINGLETON_SOCKET_ADMIN,
    true,
  ),
  ENABLE_SINGLETON_SOCKET_CUSTOMER: parseBool(
    process.env.ENABLE_SINGLETON_SOCKET_CUSTOMER,
    true,
  ),
  ENABLE_SINGLETON_SOCKET_FLUTTER: parseBool(
    process.env.ENABLE_SINGLETON_SOCKET_FLUTTER,
    true,
  ),
  ENABLE_SOCKET_BACKOFF_JITTER: parseBool(
    process.env.ENABLE_SOCKET_BACKOFF_JITTER,
    true,
  ),
  ENABLE_CANONICAL_EVENTS: parseBool(process.env.ENABLE_CANONICAL_EVENTS, true),
  ENABLE_LEGACY_EVENT_COMPAT: parseBool(
    process.env.ENABLE_LEGACY_EVENT_COMPAT,
    true,
  ),
  ENABLE_ROOM_ONLY_EMITS: parseBool(process.env.ENABLE_ROOM_ONLY_EMITS, false),
  ENABLE_SINGLE_PRINT_LEADER: parseBool(
    process.env.ENABLE_SINGLE_PRINT_LEADER,
    false,
  ),
  ENABLE_PRINT_LEASE_HEARTBEAT: parseBool(
    process.env.ENABLE_PRINT_LEASE_HEARTBEAT,
    false,
  ),
  ENABLE_PRINT_FAILSAFE_POLLING: parseBool(
    process.env.ENABLE_PRINT_FAILSAFE_POLLING,
    true,
  ),
  ENABLE_SOCKET_BURST_PROTECTION: parseBool(
    process.env.ENABLE_SOCKET_BURST_PROTECTION,
    false,
  ),
  ENABLE_VISIBILITY_POLLING_PAUSE: parseBool(
    process.env.ENABLE_VISIBILITY_POLLING_PAUSE,
    true,
  ),
  ENABLE_INDEXEDSTACK_TAB_PAUSE: parseBool(
    process.env.ENABLE_INDEXEDSTACK_TAB_PAUSE,
    true,
  ),
  ENABLE_STABILITY_OBSERVABILITY: parseBool(
    process.env.ENABLE_STABILITY_OBSERVABILITY,
    true,
  ),
});

const STABILITY_THRESHOLDS = Object.freeze({
  MAX_ROOM_JOINS_PER_MINUTE: parseNumber(
    process.env.MAX_ROOM_JOINS_PER_MINUTE,
    120,
  ),
  MAX_RECONNECTS_PER_MINUTE: parseNumber(
    process.env.MAX_RECONNECTS_PER_MINUTE,
    60,
  ),
  MAX_EVENT_BURST_PER_SECOND: parseNumber(
    process.env.MAX_EVENT_BURST_PER_SECOND,
    25,
  ),
  MAX_API_CALLS_PER_MINUTE_PER_KEY: parseNumber(
    process.env.MAX_API_CALLS_PER_MINUTE_PER_KEY,
    120,
  ),
});

module.exports = {
  STABILITY_FLAGS,
  STABILITY_THRESHOLDS,
  parseBool,
};
