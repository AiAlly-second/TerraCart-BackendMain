/**
 * Request correlation IDs for observability (x-request-id).
 * Safe when BACKEND_ENABLE_CONSOLE_LOGS=false — headers still set for clients/proxies.
 */
const crypto = require("crypto");

const HEADER_IN = "x-request-id";
const HEADER_OUT = "x-request-id";

const requestCorrelationMiddleware = (req, res, next) => {
  const incoming = req.headers[HEADER_IN];
  const id =
    typeof incoming === "string" && incoming.trim().length > 0
      ? incoming.trim().slice(0, 128)
      : crypto.randomUUID();

  req.correlationId = id;
  res.setHeader(HEADER_OUT, id);
  next();
};

module.exports = {
  requestCorrelationMiddleware,
  HEADER_IN,
  HEADER_OUT,
};
