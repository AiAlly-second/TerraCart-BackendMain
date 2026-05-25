/**
 * Lazy singleton Redis client for app-level caching / counters (not Socket.IO pub/sub).
 * Uses REDIS_URL when set; otherwise getRedisAppClient() returns null.
 */
const { createClient } = require("redis");

let client = null;
let connecting = null;

const getRedisUrl = () => {
  const url = String(process.env.REDIS_URL || "").trim();
  return url || null;
};

/**
 * @returns {Promise<import('redis').RedisClientType | null>}
 */
async function getRedisAppClient() {
  const url = getRedisUrl();
  if (!url) return null;

  if (client?.isOpen) return client;

  if (connecting) return connecting;

  connecting = (async () => {
    try {
      const c = createClient({ url });
      c.on("error", (err) => {
        try {
          process.stdout.write(
            `[REDIS_APP] Client error: ${err?.message || err}\n`
          );
        } catch (_e) {
          /* ignore */
        }
      });
      await c.connect();
      client = c;
      return client;
    } catch (err) {
      try {
        process.stdout.write(
          `[REDIS_APP] Connect failed: ${err?.message || err}\n`
        );
      } catch (_e) {
        /* ignore */
      }
      client = null;
      return null;
    } finally {
      connecting = null;
    }
  })();

  return connecting;
}

async function quitRedisAppClient() {
  if (!client?.isOpen) return;
  try {
    await client.quit();
  } catch (_e) {
    /* ignore */
  }
  client = null;
}

module.exports = {
  getRedisAppClient,
  quitRedisAppClient,
  getRedisUrl,
};
