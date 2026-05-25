const crypto = require("crypto");

/**
 * Optional short-lived private HTTP cache for public menu/add-on reads.
 * Enabled only when MENU_HTTP_CACHE_ENABLED=true (see env).
 */
function sendJsonWithOptionalPrivateCache(req, res, body, status = 200) {
  if (process.env.MENU_HTTP_CACHE_ENABLED !== "true") {
    return res.status(status).json(body);
  }
  const payload = JSON.stringify(body);
  const etag = `"sha1-${crypto.createHash("sha1").update(payload).digest("hex")}"`;
  const inm = req.headers["if-none-match"];
  res.set("Cache-Control", "private, max-age=30");
  res.set("ETag", etag);
  if (inm === etag) {
    return res.status(304).end();
  }
  return res.status(status).json(body);
}

module.exports = { sendJsonWithOptionalPrivateCache };
