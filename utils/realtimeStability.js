const crypto = require("crypto");
const {
  STABILITY_FLAGS,
  STABILITY_THRESHOLDS,
} = require("../config/stabilityFlags");

const defaultLegacyEventAliases = {
  "order.updated": ["order:status:updated", "order_status_updated", "orderUpdated", "order:upsert"],
  "order.created": ["order:created", "newOrder"],
  "payment.updated": ["paymentUpdated"],
  "payment.created": ["paymentCreated"],
  "table.updated": ["table:status:updated"],
  "kot.updated": ["kot:status:updated"],
  "attendance.updated": ["attendance:updated"],
  "customer_request.updated": [
    "request:created",
    "request:updated",
    "request:acknowledged",
    "request:resolved",
    "request:deleted",
    "assistance_request_created",
  ],
};

const eventBurstWindows = new Map();
const duplicateEnvelopeWindow = new Map();
const DEDUPE_WINDOW_MS = 1500;

const stableStringify = (value) => {
  try {
    if (value == null) return "null";
    if (typeof value !== "object") return JSON.stringify(value);

    if (Array.isArray(value)) {
      return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
    }

    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  } catch (_error) {
    return "unserializable";
  }
};

const getPayloadHash = (payload) =>
  crypto.createHash("sha1").update(stableStringify(payload)).digest("hex");

const trimBurstWindow = (timestamps, now) => {
  const cutoff = now - 1000;
  while (timestamps.length > 0 && timestamps[0] < cutoff) {
    timestamps.shift();
  }
};

const markEventBurst = (key) => {
  if (!STABILITY_FLAGS.ENABLE_STABILITY_OBSERVABILITY) return false;

  const now = Date.now();
  if (!eventBurstWindows.has(key)) {
    eventBurstWindows.set(key, []);
  }
  const timestamps = eventBurstWindows.get(key);
  timestamps.push(now);
  trimBurstWindow(timestamps, now);

  const threshold = STABILITY_THRESHOLDS.MAX_EVENT_BURST_PER_SECOND;
  const exceeded = timestamps.length > threshold;
  if (exceeded) {
    console.warn("[RealtimeStability] Event burst detected", {
      key,
      perSecond: timestamps.length,
      threshold,
    });
  }
  return exceeded;
};

const buildEventEnvelope = (
  event,
  payload,
  {
    source = "backend",
    correlationId = null,
    version = "v2",
    legacyEvent = null,
  } = {},
) => {
  const baseCorrelationId =
    correlationId ||
    `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;

  if (!STABILITY_FLAGS.ENABLE_EVENT_ORIGIN_METADATA) {
    return payload;
  }

  const metadata = {
    event,
    version,
    source,
    correlationId: baseCorrelationId,
    emittedAt: new Date().toISOString(),
    ...(legacyEvent ? { legacyEvent } : {}),
  };

  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return {
      ...payload,
      __meta: metadata,
    };
  }

  return {
    value: payload,
    __meta: metadata,
  };
};

const shouldDropDuplicateEnvelope = (event, room, payload) => {
  if (!STABILITY_FLAGS.ENABLE_EVENT_ACK_GUARD) return false;

  const hash = getPayloadHash(payload);
  const now = Date.now();
  const dedupeKey = `${event}|${room}|${hash}`;
  const previousTs = duplicateEnvelopeWindow.get(dedupeKey) || 0;

  if (now - previousTs <= DEDUPE_WINDOW_MS) {
    if (STABILITY_FLAGS.ENABLE_STABILITY_OBSERVABILITY) {
      console.warn("[RealtimeStability] Duplicate event dropped", {
        event,
        room,
      });
    }
    return true;
  }

  duplicateEnvelopeWindow.set(dedupeKey, now);
  return false;
};

const resolveRoomTargets = ({ room, roomFallback = null }) => {
  const primaryRoom = String(room || "").trim();
  const secondaryRoom = String(roomFallback || "").trim();

  if (!primaryRoom && !secondaryRoom) {
    return [];
  }

  if (STABILITY_FLAGS.ENABLE_ROOM_ONLY_EMITS) {
    return primaryRoom ? [primaryRoom] : [];
  }

  const targets = [];
  if (primaryRoom) targets.push(primaryRoom);
  if (secondaryRoom && secondaryRoom !== primaryRoom) targets.push(secondaryRoom);
  return targets;
};

const emitEventWithCompatibility = ({
  io,
  event,
  payload,
  room,
  roomFallback = null,
  source = "backend",
  correlationId = null,
  version = "v2",
  legacyEvents = null,
}) => {
  if (!io || !event) return;

  const resolvedLegacyEvents = Array.isArray(legacyEvents)
    ? legacyEvents.filter(Boolean)
    : defaultLegacyEventAliases[event] || [];

  const targets = resolveRoomTargets({ room, roomFallback });
  const uniqueTargets = Array.from(new Set(targets));
  if (uniqueTargets.length === 0) return;

  for (const targetRoom of uniqueTargets) {
    const burstKey = `${targetRoom}|${event}`;
    const burstExceeded = markEventBurst(burstKey);
    if (
      burstExceeded &&
      STABILITY_FLAGS.ENABLE_SOCKET_BURST_PROTECTION
    ) {
      continue;
    }

    if (shouldDropDuplicateEnvelope(event, targetRoom, payload)) {
      continue;
    }

    const envelope = buildEventEnvelope(event, payload, {
      source,
      correlationId,
      version,
    });
    io.to(targetRoom).emit(event, envelope);

    if (!STABILITY_FLAGS.ENABLE_LEGACY_EVENT_COMPAT) continue;

    for (const legacyEvent of resolvedLegacyEvents) {
      const legacyEnvelope = buildEventEnvelope(event, payload, {
        source,
        correlationId,
        version,
        legacyEvent,
      });
      io.to(targetRoom).emit(legacyEvent, legacyEnvelope);
    }
  }
};

module.exports = {
  emitEventWithCompatibility,
  buildEventEnvelope,
  defaultLegacyEventAliases,
};
