/**
 * Feature-flagged Redis counters for AI billable routes (daily buckets).
 * Keys: ai_usage:{route}:{yyyy-mm-dd}:{dimension}
 */
const { getRedisAppClient } = require("./redisAppClient");

const enabled = () =>
  String(process.env.AI_USAGE_TRACKING_ENABLED || "true").toLowerCase() ===
  "true";

const todayKeyPart = () => {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
};

const sanitizeDim = (value) => {
  const s = String(value || "unknown")
    .replace(/[^a-zA-Z0-9:_-]/g, "_")
    .slice(0, 120);
  return s || "unknown";
};

/**
 * @param {object} opts
 * @param {string} opts.routeKey - e.g. voice_tap_to_order, voice_transcribe, translate_menu
 * @param {string} [opts.cartId]
 * @param {string} [opts.ip]
 */
async function recordAiRequest(opts = {}) {
  if (!enabled()) return;

  const routeKey = sanitizeDim(opts.routeKey || "ai");
  const day = todayKeyPart();
  const redis = await getRedisAppClient();
  if (!redis) return;

  const dims = [
    ["global", `ai_usage:${routeKey}:${day}:global`],
    [
      `ip:${sanitizeDim(opts.ip)}`,
      `ai_usage:${routeKey}:${day}:ip:${sanitizeDim(opts.ip)}`,
    ],
  ];
  if (opts.cartId) {
    dims.push([
      `cart:${sanitizeDim(opts.cartId)}`,
      `ai_usage:${routeKey}:${day}:cart:${sanitizeDim(opts.cartId)}`,
    ]);
  }

  const ttlSec =
    Number.parseInt(process.env.AI_USAGE_KEY_TTL_SEC || "172800", 10) || 172800;

  try {
    for (const [, key] of dims) {
      await redis.incr(key);
      await redis.expire(key, ttlSec);
    }
  } catch (_e) {
    /* non-fatal */
  }
}

module.exports = {
  recordAiRequest,
  enabled,
  todayKeyPart,
};
