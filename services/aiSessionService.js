const crypto = require("crypto");

const getSecret = () =>
  String(
    process.env.AI_SESSION_SECRET || process.env.JWT_SECRET || ""
  ).trim();

const getTtlMs = () => {
  const n = Number.parseInt(process.env.AI_SESSION_TTL_MS || "86400000", 10);
  return Number.isFinite(n) && n > 0 ? n : 86400000;
};

/**
 * @param {string} cartId
 * @returns {string} token
 */
function signCartSessionToken(cartId) {
  const secret = getSecret();
  if (!secret) {
    throw new Error("AI_SESSION_SECRET or JWT_SECRET required for AI session tokens");
  }
  const cid = String(cartId || "").trim();
  const exp = Date.now() + getTtlMs();
  const payloadObj = { cartId: cid, exp };
  const payload = Buffer.from(JSON.stringify(payloadObj), "utf8").toString(
    "base64url"
  );
  const sig = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
  return `${payload}.${sig}`;
}

/**
 * @param {string} token
 * @returns {{ ok: boolean, cartId?: string, reason?: string }}
 */
function verifyCartSessionToken(token) {
  const secret = getSecret();
  if (!secret) return { ok: false, reason: "no_secret" };
  const raw = String(token || "").trim();
  if (!raw.includes(".")) return { ok: false, reason: "malformed" };
  const dot = raw.lastIndexOf(".");
  const payload = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad_sig" };
  }
  let obj;
  try {
    const json = Buffer.from(payload, "base64url").toString("utf8");
    obj = JSON.parse(json);
  } catch (_e) {
    return { ok: false, reason: "bad_payload" };
  }
  const cartId = String(obj.cartId || "").trim();
  const exp = Number(obj.exp);
  if (!cartId) return { ok: false, reason: "no_cart" };
  if (!Number.isFinite(exp) || Date.now() > exp) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, cartId };
}

module.exports = {
  signCartSessionToken,
  verifyCartSessionToken,
  getSecret,
  getTtlMs,
};
