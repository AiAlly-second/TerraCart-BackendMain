const mongoose = require("mongoose");
const Order = require("../models/orderModel");
const PrintJob = require("../models/printJobModel");
const PrinterConfig = require("../models/printerConfigModel");
const Counter = require("../models/countermodel");
const { Table } = require("../models/tableModel");
const { Payment } = require("../models/paymentModel");
const Customer = require("../models/customerModel");
const Employee = require("../models/employeeModel");
const { triggerKotPrintJob } = require("./networkPrinterController");

const Cart = require("../models/cartModel");
const {
  consumeIngredientsForOrder,
} = require("../services/costing-v2/orderConsumptionService");

// Simple in-memory cache for franchise and cafe data to prevent repeated DB queries
const invoiceDataCache = {
  franchise: new Map(),
  cafe: new Map(),
};

// Cache TTL: 5 minutes (300000 ms)
const CACHE_TTL = 5 * 60 * 1000;

const getCachedFranchise = (franchiseId) => {
  const cached = invoiceDataCache.franchise.get(franchiseId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }
  return null;
};

const setCachedFranchise = (franchiseId, data) => {
  invoiceDataCache.franchise.set(franchiseId, {
    data,
    timestamp: Date.now(),
  });
};

const getCachedCafe = (cartId) => {
  const cached = invoiceDataCache.cafe.get(cartId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }
  return null;
};

const setCachedCafe = (cartId, data) => {
  invoiceDataCache.cafe.set(cartId, {
    data,
    timestamp: Date.now(),
  });
};

// Money helpers
const toPaise = (n) => Math.round(Number(n) * 100);
const toRupees = (p) => Number((p / 100).toFixed(2));

const FINAL_ORDER_STATUSES = ["Paid", "Cancelled", "Finalized", "Returned", "Exit"];
const ACTIVE_TAKEAWAY_TOKEN_STATUSES = [
  "Pending",
  "Confirmed",
  "Preparing",
  "Ready",
  "Served",
  "Finalized",
  "Accept",
  "Accepted",
  "Being Prepared",
  "BeingPrepared",
];
const sanitizeAddonName = (value) => {
  const normalized = String(value || "")
    .replace(/^\(\s*\+\s*\)\s*/u, "")
    .trim();
  return normalized || "Add-on";
};

const normalizeSelectedAddons = (addons) => {
  if (!Array.isArray(addons)) return [];

  const addonMap = new Map();

  addons.forEach((addon) => {
    if (!addon || typeof addon !== "object") return;

    const name = sanitizeAddonName(addon.name);
    const priceValue = Number(addon.price);
    const price =
      Number.isFinite(priceValue) && priceValue >= 0 ? priceValue : 0;
    const qtyValue = Number(addon.quantity);
    const quantity =
      Number.isFinite(qtyValue) && qtyValue > 0 ? Math.floor(qtyValue) : 1;

    const normalized = {
      name,
      price,
      quantity,
    };

    const rawAddonId = addon.addonId || addon._id || addon.id;
    const addonIdString =
      rawAddonId && typeof rawAddonId.toString === "function"
        ? rawAddonId.toString()
        : rawAddonId;

    if (addonIdString && mongoose.Types.ObjectId.isValid(addonIdString)) {
      normalized.addonId =
        typeof rawAddonId === "string"
          ? new mongoose.Types.ObjectId(addonIdString)
          : rawAddonId;
    }

    const dedupeKey = normalized.addonId
      ? `id:${normalized.addonId.toString()}`
      : `name:${name.toLowerCase()}:${price}`;

    if (!addonMap.has(dedupeKey)) {
      addonMap.set(dedupeKey, normalized);
      return;
    }

    const existing = addonMap.get(dedupeKey);
    existing.quantity += quantity;
  });

  return Array.from(addonMap.values()).filter(
    (addon) => addon && addon.quantity > 0,
  );
};

const mapAcceptedByToAssignedStaff = (acceptedBy, fallbackRole = null) => {
  if (!acceptedBy || !acceptedBy.employeeId) {
    return null;
  }

  const resolvedRole = acceptedBy.employeeRole || fallbackRole || null;
  const employeeId =
    typeof acceptedBy.employeeId?.toString === "function"
      ? acceptedBy.employeeId.toString()
      : acceptedBy.employeeId;

  return {
    id: employeeId || null,
    name: acceptedBy.employeeName || null,
    role: resolvedRole ? String(resolvedRole).toUpperCase() : null,
    disability: acceptedBy.disability?.type || null,
    photoUrl: null, // No photo field is currently stored in employee/user schema
    acceptedAt: acceptedBy.acceptedAt || null,
  };
};

const resolveAssignmentDisplayType = (role) =>
  String(role || "").toUpperCase() === "ADMIN" ? "TEAM" : "INDIVIDUAL";

const normalizeObjectId = (value) => {
  if (!value) return null;
  if (value instanceof mongoose.Types.ObjectId) return value;
  const asString =
    typeof value === "string"
      ? value.trim()
      : typeof value?.toString === "function"
        ? value.toString()
        : "";
  if (!asString || !mongoose.Types.ObjectId.isValid(asString)) return null;
  return new mongoose.Types.ObjectId(asString);
};

const normalizeDocType = (value) => {
  const normalized = String(value || "")
    .trim()
    .toUpperCase();
  if (normalized === "KOT" || normalized === "BILL") return normalized;
  return null;
};

const normalizePrinterId = (value) => {
  const normalized = String(value || "").trim();
  return normalized || "default";
};

const toNonNegativeInt = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    const intValue = Math.floor(value);
    return intValue >= 0 ? intValue : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      const intValue = Math.floor(parsed);
      return intValue >= 0 ? intValue : null;
    }
  }
  return null;
};

const resolvePrintAccessError = (user, order) => {
  if (!user || !order) return "Not authorized";

  if (user.role === "admin" && user._id) {
    if (!order.cartId || order.cartId.toString() !== user._id.toString()) {
      return "Order does not belong to your cafe";
    }
    return null;
  }

  if (["manager", "waiter", "captain"].includes(user.role)) {
    if (!user.cafeId && !user.cartId) {
      return "No cart/kiosk assigned to your account";
    }
    const userCartId = (user.cartId || user.cafeId).toString();
    if (!order.cartId || order.cartId.toString() !== userCartId) {
      return "Order does not belong to your cart/kiosk";
    }
    return null;
  }

  return "Not authorized for this action";
};

const MOBILE_ORDER_ROLES = new Set([
  "waiter",
  "cook",
  "captain",
  "manager",
  "employee",
]);

const resolveMobileCartId = async (user) => {
  if (!user) return null;

  if (user.cartId || user.cafeId) {
    return user.cartId || user.cafeId;
  }

  let employee = null;
  if (user.employeeId) {
    employee = await Employee.findById(user.employeeId).select("cartId cafeId").lean();
  }

  if (!employee && user._id) {
    employee = await Employee.findOne({ userId: user._id })
      .select("cartId cafeId")
      .lean();
  }

  if (!employee && user.email) {
    employee = await Employee.findOne({
      email: String(user.email).toLowerCase(),
    })
      .select("cartId cafeId")
      .lean();
  }

  return employee?.cartId || employee?.cafeId || null;
};

const buildAutoPrintKey = ({
  order,
  docType,
  printerId,
  kotIndex,
  kotNumber,
  orderVersion,
}) => {
  const safeDocType = normalizeDocType(docType) || "KOT";
  const safePrinterId = normalizePrinterId(printerId);
  const orderId = String(order?._id || "").trim();
  const fallbackOrderVersion =
    order?.updatedAt instanceof Date
      ? order.updatedAt.toISOString()
      : order?.updatedAt
        ? String(order.updatedAt)
        : "";

  let versionToken = String(orderVersion || "").trim();
  if (safeDocType === "KOT") {
    const normalizedKotNumber = toNonNegativeInt(kotNumber);
    const normalizedKotIndex = toNonNegativeInt(kotIndex);
    if (normalizedKotNumber != null && normalizedKotNumber > 0) {
      versionToken = `K${normalizedKotNumber}`;
    } else if (normalizedKotIndex != null) {
      versionToken = `I${normalizedKotIndex}`;
    } else {
      const latestIndex = Array.isArray(order?.kotLines)
        ? Math.max(0, order.kotLines.length - 1)
        : 0;
      versionToken = `I${latestIndex}`;
    }
  } else if (!versionToken) {
    versionToken = fallbackOrderVersion || "current";
  }

  return `${orderId}:${safeDocType}:${safePrinterId}:${versionToken}`;
};

const getActiveTakeawayTokenQuery = (cartId) => ({
  cartId,
  serviceType: "TAKEAWAY",
  orderType: { $ne: "DELIVERY" },
  status: { $in: ACTIVE_TAKEAWAY_TOKEN_STATUSES },
  takeawayToken: { $ne: null },
});

const findExistingTakeawayTokenForSession = async ({ cartId, sessionToken }) => {
  if (!cartId || !sessionToken) return null;
  const existingOrder = await Order.findOne({
    ...getActiveTakeawayTokenQuery(cartId),
    sessionToken,
  })
    .select("_id takeawayToken")
    .lean();
  if (
    !existingOrder ||
    !Number.isInteger(existingOrder.takeawayToken) ||
    existingOrder.takeawayToken <= 0
  ) {
    return null;
  }
  return {
    token: existingOrder.takeawayToken,
    orderId: existingOrder._id,
  };
};

const resolveTakeawayTokenAllocation = async ({ cartId, preferredToken = null }) => {
  if (!cartId) return { token: null, source: "unavailable" };

  const existingTokens = await Order.find(getActiveTakeawayTokenQuery(cartId))
    .select("takeawayToken")
    .lean();

  const usedTokens = new Set(
    existingTokens
      .map((order) => order.takeawayToken)
      .filter((value) => Number.isInteger(value) && value > 0),
  );

  const preferredNumber = Number(preferredToken);
  if (
    Number.isInteger(preferredNumber) &&
    preferredNumber > 0 &&
    !usedTokens.has(preferredNumber)
  ) {
    return { token: preferredNumber, source: "preferred" };
  }

  let nextToken = 1;
  while (usedTokens.has(nextToken)) {
    nextToken += 1;
  }

  return { token: nextToken, source: "next" };
};

const buildNewOrderAvailablePayload = (order) => {
  const latestKot =
    Array.isArray(order?.kotLines) && order.kotLines.length > 0
      ? order.kotLines[order.kotLines.length - 1]
      : null;
  const acceptedByEmployeeId =
    order?.acceptedBy?.employeeId &&
    typeof order.acceptedBy.employeeId?.toString === "function"
      ? order.acceptedBy.employeeId.toString()
      : order?.acceptedBy?.employeeId || null;

  return {
    orderId:
      typeof order?._id?.toString === "function" ? order._id.toString() : order?._id,
    orderType: order?.orderType || order?.serviceType || null,
    serviceType: order?.serviceType || null,
    tableNo: order?.tableNumber || null,
    takeaway: order?.serviceType === "TAKEAWAY",
    isAssigned: !!acceptedByEmployeeId,
    acceptedByEmployeeId: acceptedByEmployeeId || null,
    createdAt: order?.createdAt || new Date(),
    orderSummary: (latestKot?.items || []).map((item) => ({
      name: item?.name || "Item",
      quantity: Number(item?.quantity) || 0,
    })),
  };
};

const ACCEPTABLE_ORDER_STATUSES = ["Pending", "Confirmed", "Preparing", "Ready", "Served"];
const ACCEPTABLE_SERVICE_TYPES = ["DINE_IN", "TAKEAWAY", "PICKUP", "DELIVERY"];
const AUTO_ASSIGN_CREATOR_ROLES = new Set([
  "waiter",
  "captain",
  "manager",
  "admin",
]);

const buildCreatorAcceptedBy = async ({ req, cartId }) => {
  if (!req?.user) return null;

  const creatorRole = String(req.user.role || "").toLowerCase();
  if (!AUTO_ASSIGN_CREATOR_ROLES.has(creatorRole)) {
    return null;
  }

  const isAdminCreator = creatorRole === "admin";
  if (isAdminCreator) {
    return {
      employeeId: req.user._id,
      employeeName: req.user?.name || "Admin",
      employeeRole: req.user?.role || "admin",
      disability: {
        hasDisability: false,
        type: null,
      },
      acceptedAt: new Date(),
    };
  }

  const normalizedCartId =
    cartId && typeof cartId.toString === "function" ? cartId.toString() : cartId;

  let employee = null;
  if (req.user.employeeId) {
    employee = await Employee.findById(req.user.employeeId).lean();
  }

  if (!employee) {
    const employeeQuery = {
      userId: req.user._id,
      isActive: true,
    };
    if (normalizedCartId) {
      employeeQuery.cartId = normalizedCartId;
    }
    employee = await Employee.findOne(employeeQuery).lean();
  }

  if (!employee && req.user.email) {
    const employeeQueryByEmail = {
      email: String(req.user.email).toLowerCase(),
      isActive: true,
    };
    if (normalizedCartId) {
      employeeQueryByEmail.cartId = normalizedCartId;
    }
    employee = await Employee.findOne(employeeQueryByEmail).lean();
  }

  const fallbackEmployeeId = req.user.employeeId || req.user._id;
  const resolvedEmployeeId = employee?._id || fallbackEmployeeId;

  return {
    employeeId: resolvedEmployeeId,
    employeeName: employee?.name || req.user?.name || "Staff",
    employeeRole: employee?.employeeRole || req.user?.role || null,
    disability: {
      hasDisability: employee?.disability?.hasDisability ?? false,
      type: employee?.disability?.type || null,
    },
    acceptedAt: new Date(),
  };
};

// Build KOT
function buildKot(items) {
  // Validate items before processing
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("Items array is required and must not be empty");
  }

  const lines = items.map((it, index) => {
    // Validate each item
    if (!it || typeof it !== "object") {
      throw new Error(`Item at index ${index} is invalid: must be an object`);
    }
    if (!it.name || typeof it.name !== "string" || it.name.trim() === "") {
      throw new Error(`Item at index ${index} is missing or has invalid name`);
    }
    const quantity = Number(it.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error(
        `Item at index ${index} (${it.name}) has invalid quantity: ${it.quantity}`,
      );
    }
    let price = Number(it.price);
    if (!Number.isFinite(price) || price < 0) {
      throw new Error(
        `Item at index ${index} (${it.name}) has invalid price: ${it.price}`,
      );
    }

    // Add extras prices to item price
    const itemExtras = [];
    if (Array.isArray(it.extras) && it.extras.length > 0) {
      it.extras.forEach((extra, extraIndex) => {
        if (!extra || typeof extra !== "object") return;
        if (!extra.name || typeof extra.name !== "string") return;

        const extraPrice = Number(extra.price);
        if (Number.isFinite(extraPrice) && extraPrice >= 0) {
          price += extraPrice; // Add extra price to item price
          itemExtras.push({
            name: String(extra.name).trim(),
            price: extraPrice,
          });
        }
      });
    }

    const itemData = {
      name: String(it.name).trim(),
      quantity: quantity,
      price: toPaise(price),
      returned: Boolean(it.returned),
    };

    // Pass-through menuItemId/costingMenuItemId for Finances consumption matching
    if (it.menuItemId && mongoose.Types.ObjectId.isValid(it.menuItemId)) {
      itemData.menuItemId = typeof it.menuItemId === "string" ? new mongoose.Types.ObjectId(it.menuItemId) : it.menuItemId;
    }
    if (it.costingMenuItemId && mongoose.Types.ObjectId.isValid(it.costingMenuItemId)) {
      itemData.costingMenuItemId = typeof it.costingMenuItemId === "string" ? new mongoose.Types.ObjectId(it.costingMenuItemId) : it.costingMenuItemId;
    }

    // Include extras in order if any were added
    if (itemExtras.length > 0) {
      itemData.extras = itemExtras;
    }

    const rawSpecialInstructions =
      typeof it.specialInstructions === "string"
        ? it.specialInstructions
        : typeof it.note === "string"
          ? it.note
          : "";
    const normalizedSpecialInstructions = rawSpecialInstructions.trim();
    if (normalizedSpecialInstructions) {
      itemData.specialInstructions = normalizedSpecialInstructions;
      itemData.note = normalizedSpecialInstructions;
    }

    return itemData;
  });

  const subtotalP = lines.reduce((s, it) => s + it.price * it.quantity, 0);
  const gstP = 0; // No GST applied
  const totalP = subtotalP; // Total equals subtotal

  return {
    items: lines,
    subtotal: toRupees(subtotalP),
    gst: 0,
    totalAmount: toRupees(subtotalP),
  };
}

function getNextKotNumber(orderLike) {
  const kotLines = Array.isArray(orderLike?.kotLines) ? orderLike.kotLines : [];
  let maxKotNumber = 0;
  for (let i = 0; i < kotLines.length; i++) {
    const line = kotLines[i];
    const fromField = Number(line?.kotNumber);
    const candidate = Number.isFinite(fromField) && fromField > 0 ? fromField : i + 1;
    if (candidate > maxKotNumber) maxKotNumber = candidate;
  }
  return maxKotNumber + 1;
}

function normalizeOrderSpecialInstructions(payload = {}) {
  const candidates = [
    payload?.specialInstructions,
    payload?.specialInstruction,
    payload?.orderNote,
    payload?.note,
    payload?.notes,
  ];
  for (const value of candidates) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return "";
}

const KOT_TEMPLATE_VERSION = "kotTemplateV2Compact";

function escapePrintHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeKotText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeKotMultilineNote(value) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

function isTakeawayLikeForKot(order = {}) {
  const serviceType = String(order.serviceType || "")
    .trim()
    .toUpperCase();
  const orderType = String(order.orderType || "")
    .trim()
    .toUpperCase();

  // Service type is the primary source of truth. Ignore stale orderType for dine-in.
  if (serviceType === "DINE_IN") return false;

  if (
    serviceType === "TAKEAWAY" ||
    serviceType === "PICKUP" ||
    serviceType === "DELIVERY"
  ) {
    return true;
  }

  // Backward compatibility when serviceType is missing.
  if (!serviceType) {
    return (
      orderType === "PICKUP" ||
      orderType === "DELIVERY" ||
      orderType === "TAKEAWAY"
    );
  }

  return false;
}

function resolveKotTypeLabel(order = {}) {
  const serviceType = String(order.serviceType || "")
    .trim()
    .toUpperCase();
  const orderType = String(order.orderType || "")
    .trim()
    .toUpperCase();

  if (
    serviceType === "DELIVERY" ||
    (serviceType === "TAKEAWAY" && orderType === "DELIVERY")
  ) {
    return "DELIVERY";
  }

  if (
    serviceType === "PICKUP" ||
    (serviceType === "TAKEAWAY" && orderType === "PICKUP")
  ) {
    return "TAKEAWAY";
  }

  if (serviceType === "TAKEAWAY") return "TAKEAWAY";
  return isTakeawayLikeForKot(order) ? "TAKEAWAY" : "DINE-IN";
}

function resolveKotOrderNote(order = {}, kot = {}) {
  const candidates = [
    order.specialInstructions,
    order.specialInstruction,
    order.orderNote,
    order.note,
    order.notes,
    kot.specialInstructions,
    kot.note,
  ];
  for (const value of candidates) {
    const text = normalizeKotMultilineNote(value);
    if (text.trim()) return text;
  }
  return "";
}

function resolveKotNumber(kot = {}, kotIndex = 0) {
  const explicitNumber = Number(kot?.kotNumber);
  if (Number.isFinite(explicitNumber) && explicitNumber > 0) {
    return Math.floor(explicitNumber);
  }
  return kotIndex + 1;
}

function wrapKotText(text, maxChars = 32) {
  const normalized = sanitizeKotText(text);
  if (!normalized) return [];
  if (normalized.length <= maxChars) return [normalized];

  const words = normalized.split(" ");
  const lines = [];
  let current = "";
  for (const word of words) {
    if (!current) {
      current = word;
      continue;
    }
    if ((`${current} ${word}`).length <= maxChars) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function wrapKotMultilineNote(text, maxChars = 32) {
  const normalized = normalizeKotMultilineNote(text);
  if (!normalized.trim()) return [];
  return normalized.split("\n");
}

function formatRow(left, right, width = 32) {
  const safeWidth = Number.isFinite(width) && width > 0 ? Math.floor(width) : 32;
  const leftText = sanitizeKotText(left);
  const rightText = sanitizeKotText(right);
  if (!rightText) {
    return leftText.length <= safeWidth ? leftText : leftText.slice(0, safeWidth);
  }

  const availableLeft = safeWidth - rightText.length - 1;
  if (availableLeft <= 0) {
    return rightText.length <= safeWidth
      ? rightText
      : rightText.slice(rightText.length - safeWidth);
  }

  let safeLeft = leftText;
  if (safeLeft.length > availableLeft) {
    safeLeft =
      availableLeft > 2
        ? `${safeLeft.slice(0, availableLeft - 2)}..`
        : safeLeft.slice(0, availableLeft);
  }

  const gap = safeWidth - safeLeft.length - rightText.length;
  const spacing = " ".repeat(gap > 0 ? gap : 1);
  return `${safeLeft}${spacing}${rightText}`;
}

function collectItemModifiers(item = {}) {
  const buckets = [
    item.extras,
    item.addOns,
    item.addons,
    item.modifiers,
    item.variants,
  ];
  const names = [];

  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) continue;
    for (const entry of bucket) {
      if (!entry) continue;
      if (typeof entry === "string") {
        const text = sanitizeKotText(entry);
        if (text) names.push(text);
        continue;
      }
      const name = sanitizeKotText(entry.name || entry.label || entry.value);
      if (name) names.push(name);
    }
  }

  return [...new Set(names)];
}

function getOrderRefForKot(order = {}) {
  const orderId = String(order._id || "").trim();
  if (!orderId) return "";
  return orderId.length > 8
    ? orderId.slice(orderId.length - 8).toUpperCase()
    : orderId.toUpperCase();
}

function buildLine(text, options = {}) {
  const sanitized =
    options.raw === true ? String(text ?? "") : sanitizeKotText(text);
  return {
    text: sanitized,
    align: options.align || "left",
    bold: options.bold === true,
    separator: options.separator === true,
    indent: Number.isFinite(options.indent) ? options.indent : 0,
  };
}

function renderKotHtmlFromLines({ lines, paperWidth }) {
  const bodyWidth = paperWidth === "80mm" ? "80mm" : "58mm";
  const maxWidth = paperWidth === "80mm" ? "300px" : "220px";
  const separatorFallback = "-".repeat(paperWidth === "80mm" ? 42 : 32);

  const htmlLines = lines
    .map((line) => {
      if (!line || typeof line !== "object") return "";
      const alignClass =
        line.align === "center"
          ? "center"
          : line.align === "right"
            ? "right"
            : "left";
      if (line.separator) {
        const sepText = escapePrintHtml(line.text || separatorFallback);
        return `<div class="line ${alignClass}">${sepText}</div>`;
      }
      const text = escapePrintHtml(line.text || "");
      if (!text) return '<div class="line">&nbsp;</div>';
      const boldClass = line.bold ? " bold" : "";
      const indent = Number.isFinite(line.indent) ? Math.max(0, line.indent) : 0;
      const style = indent > 0 ? ` style="padding-left:${indent * 8}px"` : "";
      return `<div class="line ${alignClass}${boldClass}"${style}>${text}</div>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>KOT Print</title>
    <style>
      @media print {
        @page { size: ${bodyWidth} auto; margin: 0; }
        body { margin: 0; padding: 0; }
      }
      body {
        width: ${bodyWidth};
        max-width: ${maxWidth};
        margin: 0 auto;
        padding: 1.5mm;
        font-family: "Courier New", monospace;
        font-size: 10px;
        line-height: 1.2;
        color: #000;
      }
      .line { white-space: pre-wrap; word-break: break-word; }
      .left { text-align: left; }
      .center { text-align: center; }
      .right { text-align: right; }
      .bold { font-weight: 700; }
    </style>
  </head>
  <body>${htmlLines}</body>
</html>`;
}

async function resolveOutletNameForKot(order = {}) {
  const fallback = "TERRA CART";
  if (!order?.cartId) return fallback;

  const cartId =
    typeof order.cartId?.toString === "function"
      ? order.cartId.toString()
      : String(order.cartId || "").trim();

  if (!cartId) return fallback;

  const cachedCafe = getCachedCafe(cartId);
  if (cachedCafe?.cartName) {
    return sanitizeKotText(cachedCafe.cartName) || fallback;
  }

  try {
    const User = require("../models/userModel");
    const cart = await User.findById(cartId).select("cartName name").lean();
    if (!cart) return fallback;

    const cartName = sanitizeKotText(cart.cartName || cart.name || fallback);
    const mergedCache = {
      ...(cachedCafe || {}),
      cartName,
    };
    setCachedCafe(cartId, mergedCache);
    return cartName || fallback;
  } catch (_) {
    return fallback;
  }
}

async function resolveKotPrinterConfig(order = {}) {
  const fallback = {
    businessName: "",
    kotHeaderText: "",
    centerAlign: true,
  };
  if (!order?.cartId) return fallback;

  const cartId =
    typeof order.cartId?.toString === "function"
      ? order.cartId.toString()
      : String(order.cartId || "").trim();
  if (!cartId) return fallback;

  try {
    const config = await PrinterConfig.findOne({ cartId })
      .select("businessName kotHeaderText centerAlign")
      .lean();
    if (!config) return fallback;
    return {
      businessName: sanitizeKotText(config.businessName || ""),
      kotHeaderText:
        typeof config.kotHeaderText === "string" ? config.kotHeaderText.trim() : "",
      centerAlign: config.centerAlign !== false,
    };
  } catch (_) {
    return fallback;
  }
}

async function buildKotPrintTemplate({
  order,
  kot,
  kotIndex,
  paperWidth,
}) {
  const safePaperWidth = paperWidth === "80mm" ? "80mm" : "58mm";
  const maxChars = safePaperWidth === "80mm" ? 42 : 32;
  const separator = "-".repeat(maxChars);
  const printerConfig = await resolveKotPrinterConfig(order);
  const resolvedOutletName = await resolveOutletNameForKot(order);
  const outletName = printerConfig.businessName || resolvedOutletName;
  const customHeaderLines = String(printerConfig.kotHeaderText || "")
    .split(/\r?\n/g)
    .map((line) => sanitizeKotText(line))
    .filter(Boolean);
  const centerAlign = printerConfig.centerAlign !== false;
  const lineAlign = centerAlign ? "center" : "left";
  const serviceLabel = resolveKotTypeLabel(order);
  const orderRef = getOrderRefForKot(order);
  const kotNumber = resolveKotNumber(kot, kotIndex);
  const timestampCandidate = kot?.createdAt || order?.createdAt || order?.updatedAt;
  const parsedTimestamp = timestampCandidate
    ? new Date(timestampCandidate)
    : null;
  const printDate =
    parsedTimestamp instanceof Date && !Number.isNaN(parsedTimestamp.getTime())
      ? parsedTimestamp
      : new Date();
  const datePart = printDate.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    timeZone: "Asia/Kolkata",
  });
  const timePart = printDate
    .toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  })
    .toUpperCase();
  const dateLabel = `${datePart}, ${timePart}`;
  const isTakeawayLike = isTakeawayLikeForKot(order);
  const tableLabel = sanitizeKotText(order.tableNumber || order?.table?.number || "");
  const hasTable = !isTakeawayLike && tableLabel;
  const orderNote = resolveKotOrderNote(order, kot);
  const tokenLabel =
    isTakeawayLike && order?.takeawayToken
      ? sanitizeKotText(order.takeawayToken)
      : "";
  const noteLines = orderNote
    ? [
        buildLine(separator, { separator: true }),
        buildLine("Note:", { align: lineAlign, bold: true }),
        ...wrapKotMultilineNote(orderNote, maxChars).map((lineText) =>
          buildLine(lineText, { align: lineAlign, raw: true }),
        ),
        buildLine(separator, { separator: true }),
      ]
    : [buildLine(separator, { separator: true })];

  const kotTitle = `KOT #${String(kotNumber).padStart(2, "0")} ${serviceLabel}`;

  const lines = [
    buildLine(outletName, { align: lineAlign, bold: true }),
    ...customHeaderLines.map((lineText) =>
      buildLine(lineText, { align: lineAlign, bold: true }),
    ),
    buildLine(kotTitle, { align: lineAlign, bold: true }),
    buildLine(dateLabel, { align: lineAlign }),
    buildLine(separator, { separator: true }),
    ...(hasTable ? [buildLine(`Table: ${tableLabel}`, { align: lineAlign })] : []),
    ...(tokenLabel &&
    isTakeawayLike &&
    serviceLabel !== "DELIVERY"
      ? [buildLine(`Token: ${tokenLabel}`, { align: lineAlign })]
      : []),
    ...(orderRef ? [buildLine(`Ref: ${orderRef}`, { align: lineAlign })] : []),
    ...noteLines,
  ];

  const items = Array.isArray(kot?.items) ? kot.items : [];
  const printableItems = items.filter((item) => item && item.returned !== true);
  const selectedAddons = Array.isArray(order?.selectedAddons)
    ? order.selectedAddons.filter((addon) => addon && Number(addon.quantity || 1) > 0)
    : [];

  if (!printableItems.length && !selectedAddons.length) {
    lines.push(buildLine("No items"));
  } else {
    const itemAlign = "left";
    const indentedRowWidth = Math.max(8, maxChars - 2);
    for (const item of printableItems) {
      const qty = Math.max(1, Number(item.quantity) || 1);
      const itemName = sanitizeKotText(item.name || "Item");
      lines.push(
        buildLine(formatRow(itemName, `${qty}x`, maxChars), {
          bold: true,
          align: itemAlign,
        }),
      );

      const modifiers = collectItemModifiers(item);
      for (const modifier of modifiers) {
        const wrapped = wrapKotText(`+ ${modifier}`, indentedRowWidth);
        wrapped.forEach((lineText) => {
          lines.push(
            buildLine(lineText, {
              align: itemAlign,
              indent: 1,
            }),
          );
        });
      }

      const itemNote = sanitizeKotText(item.specialInstructions || item.note || "");
      if (itemNote) {
        const wrapped = wrapKotText(`Note: ${itemNote}`, indentedRowWidth);
        wrapped.forEach((lineText) => {
          lines.push(
            buildLine(lineText, {
              align: itemAlign,
              indent: 1,
            }),
          );
        });
      }
    }

    for (const addon of selectedAddons) {
      const addonQty = Math.max(1, Number(addon.quantity) || 1);
      const addonName = sanitizeKotText(addon.name || "Add-on");
      lines.push(
        buildLine(formatRow(`+ ${addonName}`, `${addonQty}x`, indentedRowWidth), {
          align: itemAlign,
          indent: 1,
        }),
      );
    }
  }

  const totalQty = printableItems.reduce(
    (sum, item) => sum + (Number(item?.quantity) || 0),
    0,
  );
  lines.push(buildLine(separator, { separator: true }));
  lines.push(
    buildLine(`Items: ${printableItems.length}  Qty: ${totalQty}`, {
      bold: true,
      align: lineAlign,
    }),
  );

  const html = renderKotHtmlFromLines({
    lines,
    paperWidth: safePaperWidth,
  });

  return {
    templateVersion: KOT_TEMPLATE_VERSION,
    paperWidth: safePaperWidth,
    kotIndex,
    kotNumber,
    lines,
    html,
    orderMeta: {
      orderId: String(order?._id || ""),
      orderRef,
      serviceType: serviceLabel,
      tableNumber: hasTable ? tableLabel : null,
      takeawayToken:
        isTakeawayLike && order?.takeawayToken
          ? sanitizeKotText(order.takeawayToken)
          : null,
      itemCount: printableItems.length,
      totalQty,
    },
  };
}

function getOrderBillAmount(order) {
  const kotAmount = Array.isArray(order?.kotLines)
    ? toRupees(
      order.kotLines.reduce((kotSum, kot) => {
        const items = Array.isArray(kot?.items) ? kot.items : [];
        return (
          kotSum +
          items.reduce((itemSum, item) => {
            if (!item || item.returned) return itemSum;
            const priceInPaise = Number(item.price);
            if (!Number.isFinite(priceInPaise) || priceInPaise < 0) {
              return itemSum;
            }
            const qtyValue = Number(item.quantity);
            const quantity =
              Number.isFinite(qtyValue) && qtyValue > 0
                ? Math.floor(qtyValue)
                : 0;
            return itemSum + priceInPaise * quantity;
          }, 0)
        );
      }, 0),
    )
    : 0;
  const addonsAmount = Array.isArray(order?.selectedAddons)
    ? order.selectedAddons.reduce((sum, addon) => {
      if (!addon) return sum;
      const price = Number(addon.price);
      if (!Number.isFinite(price) || price < 0) return sum;
      const qtyValue = Number(addon.quantity);
      const quantity =
        Number.isFinite(qtyValue) && qtyValue > 0 ? Math.floor(qtyValue) : 1;
      return sum + price * quantity;
    }, 0)
    : 0;

  const amount = kotAmount + addonsAmount;
  return amount > 0 ? Number(amount.toFixed(2)) : 0;
}

async function ensurePaymentRecord(order, options = {}) {
  if (!order?._id) return null;
  const amount = getOrderBillAmount(order);
  if (amount <= 0) {
    return { payment: null, created: false };
  }

  let payment = await Payment.findOne({ orderId: order._id });
  let created = false;
  if (!payment) {
    payment = await Payment.create({
      orderId: order._id,
      amount,
      method: options.method || "CASH",
      status: options.status || "PAID",
      description: options.description || "Payment settled by admin",
      paidAt: options.status === "PAID" ? new Date() : undefined,
    });
    created = true;
  } else {
    let mutate = false;
    if (payment.amount !== amount) {
      payment.amount = amount;
      mutate = true;
    }
    if (options.status === "PAID" && payment.status !== "PAID") {
      payment.status = "PAID";
      payment.paidAt = new Date();
      mutate = true;
    }
    if (options.method && payment.method !== options.method) {
      payment.method = options.method;
      mutate = true;
    }
    if (options.description && payment.description !== options.description) {
      payment.description = options.description;
      mutate = true;
    }
    if (mutate) {
      await payment.save();
    }
  }

  return { payment, created };
}

function formatPaymentPayload(payment) {
  const plain = payment?.toObject ? payment.toObject() : payment;
  if (!plain) return null;
  return {
    id: plain._id || plain.id,
    orderId: plain.orderId,
    amount: plain.amount,
    method: plain.method,
    status: plain.status,
    description: plain.description,
    upiPayload: plain.upiPayload,
    paymentUrl: plain.paymentUrl,
    providerReference: plain.providerReference,
    metadata: plain.metadata,
    createdAt: plain.createdAt,
    updatedAt: plain.updatedAt,
    paidAt: plain.paidAt,
    cancelledAt: plain.cancelledAt,
    cancellationReason: plain.cancellationReason,
  };
}

const printerIpRegex = /^(\d{1,3}\.){3}\d{1,3}$/;

const buildEscPosPayloadFromKotLines = ({ lines = [], centerAlign = true }) => {
  const safeLines = Array.isArray(lines) ? lines : [];
  if (!safeLines.length) return "";

  const alignByte = centerAlign ? "\x01" : "\x00";
  let payload = "\x1B@"; // Initialize printer
  payload += `\x1Ba${alignByte}`; // Text alignment

  safeLines.forEach((line) => {
    payload += `${String(line ?? "")}\n`;
  });

  payload += "\n\n\n\x1DV\x00"; // Feed + cut
  return payload;
};

const resolveSenderRoleForPrint = (req) => {
  const roleFromUser = String(req?.user?.role || "").trim().toLowerCase();
  if (roleFromUser) return roleFromUser;

  const roleFromBody = String(req?.body?.senderRole || "").trim().toLowerCase();
  if (roleFromBody) return roleFromBody;

  return "public";
};

const resolveEmployeeIdForPrintLog = async (req, senderRole) => {
  if (!req?.user) return null;

  if (req.user.employeeId) {
    return req.user.employeeId?.toString?.() || String(req.user.employeeId);
  }

  if (!["waiter", "cook", "captain", "manager", "employee"].includes(senderRole)) {
    return null;
  }

  const employee =
    (await Employee.findOne({ userId: req.user._id }).select("_id").lean()) ||
    (req.user?.email
      ? await Employee.findOne({ email: String(req.user.email).toLowerCase() })
          .select("_id")
          .lean()
      : null);

  return employee?._id?.toString?.() || null;
};

const triggerKotPrintAfterSave = async ({ req, order, kotIndex }) => {
  if (!order || !Array.isArray(order.kotLines)) return null;
  if (kotIndex < 0 || kotIndex >= order.kotLines.length) return null;

  const orderId = String(order._id || "").trim();
  const kot = order.kotLines[kotIndex];
  const kotNumber = Number(kot?.kotNumber);
  const kotId = `${orderId}:KOT:${Number.isFinite(kotNumber) && kotNumber > 0 ? kotNumber : kotIndex + 1}`;
  const senderRole = resolveSenderRoleForPrint(req);
  const employeeId = await resolveEmployeeIdForPrintLog(req, senderRole);
  const orderCartId = order.cartId || order.cafeId || null;

  if (!orderCartId) {
    console.warn(
      `[KOT_PRINT_TRIGGER] ${JSON.stringify({
        kotId,
        senderRole,
        employeeId,
        printTriggered: false,
        reason: "missing_cart_id",
      })}`
    );
    return null;
  }

  const printerConfig = await PrinterConfig.findOne({ cartId: orderCartId })
    .select("printerIp printerPort centerAlign")
    .lean();

  const printerIp = String(printerConfig?.printerIp || "").trim();
  const printerPort = Number(printerConfig?.printerPort || 9100);

  if (!printerIp || !printerIpRegex.test(printerIp) || !Number.isFinite(printerPort)) {
    console.warn(
      `[KOT_PRINT_TRIGGER] ${JSON.stringify({
        kotId,
        senderRole,
        employeeId,
        printTriggered: false,
        reason: "invalid_printer_config",
        printerIp,
      })}`
    );
    return null;
  }

  const template = await buildKotPrintTemplate({
    order,
    kot,
    kotIndex,
    paperWidth: "58mm",
  });

  const payload = buildEscPosPayloadFromKotLines({
    lines: template?.lines || [],
    centerAlign: printerConfig?.centerAlign !== false,
  });

  if (!payload) {
    console.warn(
      `[KOT_PRINT_TRIGGER] ${JSON.stringify({
        kotId,
        senderRole,
        employeeId,
        printTriggered: false,
        reason: "empty_kot_template",
      })}`
    );
    return null;
  }

  const printResult = await triggerKotPrintJob({
    orderId,
    kotIndex,
    printerIP: printerIp,
    printerPort,
    data: payload,
  });

  console.log(
    `[KOT_PRINT_TRIGGER] ${JSON.stringify({
      kotId,
      senderRole,
      employeeId,
      printTriggered: true,
      skipped: !!printResult?.skipped,
      queued: !!printResult?.queued,
      success: !!printResult?.success,
    })}`
  );

  // Emit to cart room only (printer service listeners), never employee-specific socket.
  const io = req?.app?.get("io");
  const emitToCafe = req?.app?.get("emitToCafe");
  if (io && emitToCafe && orderCartId) {
    emitToCafe(io, orderCartId.toString(), "printer:kot:triggered", {
      orderId,
      kotIndex,
      kotId,
      senderRole,
      employeeId,
      printTriggered: true,
      queued: !!printResult?.queued,
      skipped: !!printResult?.skipped,
      success: !!printResult?.success,
    });
  }

  return printResult;
};

// Order status transitions
// UNIFIED flow for both DINE_IN and TAKEAWAY:
// Pending → Confirmed → Preparing → Ready → Completed → Paid
// Legacy statuses (Served, Finalized, Accepted, Being Prepared) still supported for backward compatibility
const transitions = {
  // Unified flow statuses
  Pending: new Set(["Confirmed", "Cancelled", "Accepted"]), // Accepted for legacy takeaway accept flow
  Confirmed: new Set(["Preparing", "Cancelled"]),
  Preparing: new Set(["Ready", "Cancelled"]),
  Ready: new Set(["Completed", "Served", "Cancelled"]), // Served for legacy dine-in
  Completed: new Set(["Paid", "Cancelled"]),
  Paid: new Set(["Returned"]),
  Cancelled: new Set([]),
  Returned: new Set([]),
  // Legacy DINE_IN statuses (backward compatibility)
  Served: new Set(["Paid", "Completed", "Cancelled"]), // Allow transition to Completed or Paid
  Finalized: new Set(["Paid", "Cancelled"]),
  // Legacy TAKEAWAY statuses (backward compatibility)
  Accept: new Set(["Preparing", "Being Prepared", "BeingPrepared", "Cancelled"]),
  Accepted: new Set(["Preparing", "Being Prepared", "BeingPrepared", "Cancelled"]),
  "Being Prepared": new Set(["Ready", "Completed", "Cancelled"]),
  BeingPrepared: new Set(["Ready", "Completed", "Cancelled"]),
  Exit: new Set([]), // Final status for legacy takeaway
};

const resetInventoryDeductionFlag = async (orderId) => {
  if (!orderId) return;
  try {
    await Order.findByIdAndUpdate(orderId, {
      inventoryDeducted: false,
      inventoryDeductedAt: null,
    });
  } catch (err) {
    console.error(
      `[COSTING] Failed to reset inventoryDeducted for order ${orderId}:`,
      err.message,
    );
  }
};

const shouldResetInventoryDeduction = (result) => {
  if (!result) return true;
  if (result.success || result.alreadyProcessed) return false;
  const consumedCount = Array.isArray(result.summary?.ingredientsConsumed)
    ? result.summary.ingredientsConsumed.length
    : 0;
  const processedCount = Number(result.summary?.itemsProcessed || 0);
  return consumedCount === 0 && processedCount === 0;
};

// ---------------- CREATE ORDER ----------------
async function releaseTableForOrder(order, io, emitToCafe = null) {
  try {
    if (!order?.table) return;
    const tableId = order.table._id || order.table;
    const table = await Table.findById(tableId);
    if (!table) return;

    // Only release table for dine-in orders
    if (order.serviceType !== "DINE_IN") return;

    const oldStatus = table.status;

    // Store original status to detect if it actually changed
    const originalStatus = table.status;

    // Mark table as AVAILABLE when order is paid/cancelled/returned/finalized
    // This ensures table shows as available in cart admin and to other customers
    table.status = "AVAILABLE";
    table.currentOrder = null;
    table.set("sessionToken", undefined);
    table.lastAssignedAt = null;
    await table.save();

    // Emit socket event for table status update to notify cart admin and customers
    if (io && table.cartId && emitToCafe) {
      emitToCafe(io, table.cartId.toString(), "table:status:updated", {
        id: table._id,
        number: table.number,
        status: table.status,
        currentOrder: null,
      });
    }

    // Also emit globally so customers can receive real-time updates
    if (io) {
      io.emit("table:status:updated", {
        id: table._id,
        number: table.number,
        status: table.status,
        currentOrder: null,
      });
    }

    // Notify next person in waitlist when table becomes available
    // CRITICAL: Only notify if status actually changed to AVAILABLE (wasn't already AVAILABLE)
    // This prevents loops when releaseTableForOrder is called multiple times
    if (io && originalStatus !== "AVAILABLE") {
      // Check if there's already a NOTIFIED entry before calling notifyNextWaitlist
      // This prevents loops and duplicate notifications
      const Waitlist = require("../models/waitlistModel");
      const existingNotified = await Waitlist.findOne({
        table: table._id,
        status: "NOTIFIED",
      });

      // Only notify if there's no existing NOTIFIED entry
      if (!existingNotified) {
        const { notifyNextWaitlist } = require("./waitlistController");
        await notifyNextWaitlist(tableId, io);
      } else {
        console.log(
          `[TABLE] Table ${table.number} released but already has NOTIFIED waitlist entry - skipping notification`,
        );
      }
    }

    console.log(
      `[TABLE] Released table ${table.number} (${table._id}) - Status: ${oldStatus} → AVAILABLE (Order ${order._id} status: ${order.status})`,
    );
  } catch (err) {
    console.error("Failed to release table", err);
  }
}

const getNextTakeawayToken = async (req, res) => {
  try {
    const cartId = normalizeObjectId(req.query?.cartId);
    const sessionToken = String(req.query?.sessionToken || "").trim();

    if (!cartId) {
      return res.status(400).json({ message: "Valid cartId is required" });
    }

    const existingForSession = sessionToken
      ? await findExistingTakeawayTokenForSession({
        cartId,
        sessionToken,
      })
      : null;

    if (existingForSession) {
      return res.json({
        token: existingForSession.token,
        cartId: cartId.toString(),
        existingOrderId: existingForSession.orderId,
        reused: true,
      });
    }

    const allocation = await resolveTakeawayTokenAllocation({ cartId });
    if (!allocation.token) {
      return res.status(500).json({ message: "Failed to allocate takeaway token" });
    }

    return res.json({
      token: allocation.token,
      cartId: cartId.toString(),
      existingOrderId: null,
      reused: false,
    });
  } catch (err) {
    console.error("[ORDER] Failed to get next takeaway token:", err);
    return res.status(500).json({ message: err.message });
  }
};

const createOrder = async (req, res) => {
  console.log("[ORDER] createOrder called", {
    hasUser: !!req.user,
    userRole: req.user?.role,
    userId: req.user?._id?.toString(),
  });
  try {
    console.log("[ORDER] Request body:", {
      serviceType: req.body.serviceType,
      orderType: req.body.orderType,
      hasItems: !!req.body.items && req.body.items.length > 0,
      itemsCount: req.body.items?.length || 0,
      hasCartId: !!req.body.cartId,
      cartId: req.body.cartId,
    });
    const {
      items,
      serviceType = "DINE_IN",
      orderType, // PICKUP or DELIVERY (for TAKEAWAY service type)
      tableId,
      sessionToken,
      customerName,
      customerMobile,
      customerEmail,
      cartId: requestCartId, // Accept cartId from request body (for takeaway/pickup/delivery orders)
      customerLocation, // { latitude, longitude, address }
      selectedAddons, // Add-ons selected by customer
      takeawayToken: requestedTakeawayToken, // Optional pre-assigned takeaway token from customer app
      idempotencyKey,
    } = req.body;
    const specialInstructions = normalizeOrderSpecialInstructions(req.body);
    let { tableNumber } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "No items supplied" });
    }

    const requestIdempotencyKey = String(
      idempotencyKey || req.headers["x-idempotency-key"] || "",
    ).trim();
    if (requestIdempotencyKey) {
      const existingByKey = await Order.findOne({
        idempotencyKey: requestIdempotencyKey,
      });
      if (existingByKey) {
        console.log(
          `[ORDER] createOrder idempotent replay detected for key ${requestIdempotencyKey}. Returning existing order ${existingByKey._id}.`,
        );
        return res.json(existingByKey);
      }
    }

    const normalizedServiceType = String(serviceType || "DINE_IN")
      .trim()
      .toUpperCase();
    const normalizedOrderType =
      typeof orderType === "string" ? orderType.trim().toUpperCase() : undefined;

    // Validate service type - now supports DINE_IN, TAKEAWAY, PICKUP, DELIVERY
    const validServiceTypes = ["DINE_IN", "TAKEAWAY", "PICKUP", "DELIVERY"];
    if (!validServiceTypes.includes(normalizedServiceType)) {
      return res.status(400).json({ message: "Invalid service type" });
    }

    // Preserve subtype even when clients omit orderType but send serviceType=PICKUP/DELIVERY.
    // Ignore stale orderType for explicit dine-in requests.
    const effectiveOrderType =
      normalizedServiceType === "DINE_IN"
        ? undefined
        : normalizedOrderType ||
          (normalizedServiceType === "PICKUP" ||
          normalizedServiceType === "DELIVERY"
            ? normalizedServiceType
            : undefined);

    // For PICKUP/DELIVERY, validate orderType
    if (
      (normalizedServiceType === "PICKUP" ||
        normalizedServiceType === "DELIVERY") &&
      !effectiveOrderType
    ) {
      return res.status(400).json({
        message:
          "orderType (PICKUP or DELIVERY) is required for this service type",
      });
    }

    let tableDoc = null;
    const isTakeaway =
      normalizedServiceType === "TAKEAWAY" ||
      normalizedServiceType === "PICKUP" ||
      normalizedServiceType === "DELIVERY";
    const isPickup =
      normalizedServiceType === "PICKUP" || effectiveOrderType === "PICKUP";
    const isDelivery =
      normalizedServiceType === "DELIVERY" || effectiveOrderType === "DELIVERY";

    // For TAKEAWAY orders, skip all table-related logic
    if (!isTakeaway) {
      // DINE_IN orders require table and session token
      if (!sessionToken) {
        console.log(
          "[ORDER] createOrder - Missing sessionToken for DINE_IN order",
          {
            serviceType: normalizedServiceType,
            tableId,
            tableNumber,
            hasItems: items && items.length > 0,
          },
        );
        return res.status(400).json({
          message:
            "Session token is required for dine-in orders. Please scan the table QR code again.",
        });
      }

      if (!tableId && !tableNumber) {
        return res
          .status(400)
          .json({ message: "Table selection is required for dine-in orders" });
      }

      if (tableId) {
        tableDoc = await Table.findById(tableId);
      } else if (tableNumber) {
        const numeric = Number(tableNumber);
        if (!Number.isNaN(numeric)) {
          tableDoc = await Table.findOne({ number: numeric });
        }
      }

      if (!tableDoc) {
        return res.status(404).json({ message: "Table record not found" });
      }

      // CRITICAL: Check if user has an active order for this table
      // If they do, allow order creation even if sessionToken doesn't match
      // This prevents "table assigned to another guest" error when user has active order
      let hasActiveOrderForTable = false;
      let existingOrderForTable = null;

      // Check 1: Check table's currentOrder
      if (tableDoc.currentOrder) {
        try {
          const orderId = tableDoc.currentOrder.toString();
          existingOrderForTable = await Order.findById(orderId);
          if (
            existingOrderForTable &&
            existingOrderForTable.sessionToken === sessionToken
          ) {
            // User has an active order with matching sessionToken - allow order creation
            hasActiveOrderForTable = true;
            console.log(
              `[ORDER] User has active order ${existingOrderForTable._id} for table ${tableDoc.number} - allowing order creation`,
            );
          }
        } catch (err) {
          console.warn("[ORDER] Failed to check table's currentOrder:", err);
        }
      }

      // Check 2: If not found, search for any active order for this table with matching sessionToken
      if (!hasActiveOrderForTable && sessionToken) {
        try {
          const activeStatuses = [
            "Pending",
            "Confirmed",
            "Preparing",
            "Ready",
            "Served",
            "Finalized",
          ];
          existingOrderForTable = await Order.findOne({
            table: tableDoc._id,
            sessionToken: sessionToken,
            status: { $in: activeStatuses },
            serviceType: "DINE_IN",
          });

          if (existingOrderForTable) {
            hasActiveOrderForTable = true;
            console.log(
              `[ORDER] Found active order ${existingOrderForTable._id} for table ${tableDoc.number} with matching sessionToken - allowing order creation`,
            );
          }
        } catch (err) {
          console.warn("[ORDER] Failed to search for active order:", err);
        }
      }

      // CRITICAL: Very lenient check - only reject if ALL of these are true:
      // 1. Table has a sessionToken
      // 2. It doesn't match the request sessionToken
      // 3. User doesn't have an active order for this table
      // 4. Table is actually OCCUPIED (not just has a sessionToken)
      // 5. Table has a currentOrder that belongs to someone else (not our order)
      // This allows users to create orders even if sessionToken is slightly out of sync
      const tableHasOtherOrder =
        tableDoc.currentOrder &&
        (!existingOrderForTable ||
          existingOrderForTable._id.toString() !==
          tableDoc.currentOrder.toString());

      const shouldReject =
        tableDoc.sessionToken &&
        tableDoc.sessionToken !== sessionToken &&
        !hasActiveOrderForTable &&
        tableDoc.status === "OCCUPIED" &&
        tableHasOtherOrder;

      if (shouldReject) {
        console.log(
          `[ORDER] Rejecting order - table ${tableDoc.number} is occupied by another guest:`,
          {
            tableSessionToken: tableDoc.sessionToken,
            requestSessionToken: sessionToken,
            hasActiveOrder: hasActiveOrderForTable,
            currentOrder: tableDoc.currentOrder,
            tableStatus: tableDoc.status,
            tableHasOtherOrder,
          },
        );
        return res.status(403).json({
          message: "This table is currently assigned to another guest.",
        });
      }

      // If table status is not OCCUPIED but has sessionToken mismatch, update it
      // This handles cases where table status is AVAILABLE/RESERVED but has stale sessionToken
      if (
        tableDoc.sessionToken &&
        tableDoc.sessionToken !== sessionToken &&
        !hasActiveOrderForTable &&
        tableDoc.status !== "OCCUPIED"
      ) {
        console.log(
          `[ORDER] Table ${tableDoc.number} has sessionToken mismatch but status is ${tableDoc.status} - updating sessionToken to: ${sessionToken}`,
        );
        tableDoc.sessionToken = sessionToken;
      }

      // If table has no sessionToken, set it (user is claiming the table)
      if (!tableDoc.sessionToken && sessionToken) {
        console.log(
          `[ORDER] Table ${tableDoc.number} has no sessionToken - setting it to: ${sessionToken}`,
        );
        tableDoc.sessionToken = sessionToken;
      }

      // If user has active order but sessionToken doesn't match table's sessionToken,
      // update table's sessionToken to match the order's sessionToken
      if (hasActiveOrderForTable && tableDoc.sessionToken !== sessionToken) {
        console.log(
          `[ORDER] Updating table ${tableDoc.number} sessionToken to match active order: ${sessionToken}`,
        );
        tableDoc.sessionToken = sessionToken;
      }

      // If table has no sessionToken but user has active order, set it
      if (hasActiveOrderForTable && !tableDoc.sessionToken && sessionToken) {
        console.log(
          `[ORDER] Setting table ${tableDoc.number} sessionToken from active order: ${sessionToken}`,
        );
        tableDoc.sessionToken = sessionToken;
      }

      tableNumber =
        tableNumber || String(tableDoc.number ?? tableDoc.tableNumber);
      if (!tableNumber) {
        tableNumber = String(tableDoc.number || "");
      }

      if (!tableDoc.sessionToken) {
        tableDoc.sessionToken = sessionToken;
      }
    } else {
      // For TAKEAWAY orders, set tableNumber to "TAKEAWAY" and skip table assignment
      tableNumber = "TAKEAWAY";
    }

    // Build KOT with error handling
    let kot;
    try {
      kot = buildKot(items);
      kot.kotNumber = 1;
      console.log("[ORDER] KOT built successfully:", {
        itemsCount: kot.items.length,
        subtotal: kot.subtotal,
        gst: kot.gst,
        totalAmount: kot.totalAmount,
      });
    } catch (kotError) {
      console.error("[ORDER] Failed to build KOT:", kotError);
      return res.status(400).json({
        message: `Invalid order items: ${kotError.message}`,
        error: kotError.message,
      });
    }

    // Generate custom order ID
    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10).replace(/-/g, ""); // YYYYMMDD

    // Find today's counter
    let counter = await Counter.findOneAndUpdate(
      { date: dateStr },
      { $inc: { seq: 1 } },
      { new: true, upsert: true },
    );

    const seqStr = String(counter.seq).padStart(3, "0");
    const orderId = `ORD-${dateStr}${seqStr}`;

    // Set cartId: priority 1) from authenticated cafe admin, 2) from request body (for takeaway from customer frontend), 3) from table's cartId (for dine-in only), 4) from first active cafe (for takeaway fallback)
    let cartId = null;
    let deliveryInfo = null; // Store delivery info for delivery orders
    let pickupCartData = null; // Store cart data for pickup location
    let cartAdmin = null; // Store cart admin user (for pickup/delivery orders)
    if (req.user && req.user.role === "admin" && req.user._id) {
      cartId = req.user._id;
      console.log(
        "[ORDER] Using cartId from authenticated user:",
        cartId.toString(),
      );
    } else if (isTakeaway && requestCartId && !isPickup && !isDelivery) {
      // For regular takeaway orders (not pickup/delivery), accept either:
      // 1) cart admin user id (legacy), or
      // 2) Cart document id (used by some frontend flows).
      const User = require("../models/userModel");
      const Cart = require("../models/cartModel");

      let cartAdminId = null;

      // Try requestCartId directly as cart admin user id
      cartAdmin = await User.findById(requestCartId)
        .select("_id franchiseId role isActive isApproved")
        .lean();
      if (
        cartAdmin &&
        cartAdmin.role === "admin" &&
        cartAdmin.isActive &&
        cartAdmin.isApproved
      ) {
        cartAdminId = cartAdmin._id;
      } else {
        // Try requestCartId as Cart document id
        const cartDoc = await Cart.findById(requestCartId)
          .select("_id cartAdminId isActive")
          .lean();
        if (cartDoc && cartDoc.isActive && cartDoc.cartAdminId) {
          const resolvedAdmin = await User.findById(cartDoc.cartAdminId)
            .select("_id franchiseId role isActive isApproved")
            .lean();
          if (
            resolvedAdmin &&
            resolvedAdmin.role === "admin" &&
            resolvedAdmin.isActive &&
            resolvedAdmin.isApproved
          ) {
            cartAdmin = resolvedAdmin;
            cartAdminId = resolvedAdmin._id;
          }
        }
      }

      if (cartAdminId) {
        cartId = cartAdminId;
        console.log(
          "[ORDER] Using resolved cart admin id for takeaway:",
          cartId.toString(),
        );
      } else {
        console.warn(
          `[ORDER] WARNING: Invalid cartId in request (${requestCartId}). Could not resolve active/approved cart admin. Falling back to first active cafe.`,
        );
        // Fall through to fallback logic below
      }
    } else if (!isTakeaway && tableDoc) {
      if (tableDoc.cartId) {
        cartId = tableDoc.cartId;
        console.log("[ORDER] Using cartId from table:", cartId.toString());
      } else if (tableDoc.franchiseId) {
        // Fallback: table has no cartId but has franchiseId - use first cart under franchise
        const User = require("../models/userModel");
        const firstCafe = await User.findOne({
          role: "admin",
          franchiseId: tableDoc.franchiseId,
          isActive: true,
          isApproved: true,
        })
          .select("_id")
          .lean();
        if (firstCafe) {
          cartId = firstCafe._id;
          console.log(
            "[ORDER] Using cartId from first cafe in table's franchise (table had no cartId):",
            cartId.toString(),
          );
        }
      }
    }

    // For PICKUP/DELIVERY orders, validate cart configuration and delivery eligibility
    if (isPickup || isDelivery) {
      if (!requestCartId) {
        return res.status(400).json({
          message: "cartId is required for pickup/delivery orders",
        });
      }

      const Cart = require("../models/cartModel");
      const User = require("../models/userModel");
      const { isWithinDeliveryRange } = require("../utils/distanceCalculator");

      let cart = null;
      let cartAdminId = null;
      // Note: cartAdmin is already declared at function level (line 547)

      try {
        // Check if requestCartId is a Cart document ID or cartAdminId (user ID)
        cart = await Cart.findById(requestCartId).lean();

        if (cart && cart.cartAdminId) {
          // It's a Cart document ID - get the cartAdminId
          // Convert ObjectId to string if needed
          cartAdminId = cart.cartAdminId.toString
            ? cart.cartAdminId.toString()
            : cart.cartAdminId;
          console.log("[ORDER] Found Cart document, using cartAdminId:", {
            cartId: requestCartId,
            cartAdminId: cartAdminId,
          });
        } else {
          // Assume it's a cartAdminId (user ID) - backward compatibility
          cartAdminId = requestCartId.toString
            ? requestCartId.toString()
            : requestCartId;
          console.log(
            "[ORDER] Using requestCartId as cartAdminId (backward compatibility):",
            cartAdminId,
          );
        }

        if (!cartAdminId) {
          return res.status(400).json({
            message: "Unable to determine cart admin ID",
          });
        }

        // Get cart admin user
        cartAdmin = await User.findById(cartAdminId)
          .select("_id franchiseId role isActive isApproved")
          .lean();

        if (!cartAdmin || cartAdmin.role !== "admin" || !cartAdmin.isActive) {
          return res.status(400).json({
            message: "Invalid or inactive cart",
          });
        }

        // If we didn't find cart by ID, find it by cartAdminId
        if (!cart) {
          cart = await Cart.findOne({
            cartAdminId: cartAdminId,
            isActive: true,
          }).lean();
        }

        if (!cart || !cart.isActive) {
          return res.status(400).json({
            message: "Cart not found or inactive",
          });
        }
      } catch (cartError) {
        console.error(
          "[ORDER] Error processing cart for pickup/delivery:",
          cartError,
        );
        return res.status(400).json({
          message: `Failed to process cart: ${cartError.message}`,
        });
      }

      // Validate pickup/delivery configuration
      if (isPickup && !cart.pickupEnabled) {
        return res.status(400).json({
          message: "Pickup is not enabled for this cart",
        });
      }

      if (isDelivery) {
        if (!cart.deliveryEnabled) {
          return res.status(400).json({
            message: "Delivery is not enabled for this cart",
          });
        }

        // Validate customer location for delivery
        if (
          !customerLocation ||
          !customerLocation.latitude ||
          !customerLocation.longitude
        ) {
          return res.status(400).json({
            message:
              "Customer location (latitude and longitude) is required for delivery orders",
          });
        }

        // Validate cart has coordinates
        if (
          !cart.coordinates ||
          !cart.coordinates.latitude ||
          !cart.coordinates.longitude
        ) {
          return res.status(400).json({
            message:
              "Cart location not configured. Please configure cart coordinates.",
          });
        }

        // Check if customer is within delivery radius
        const rangeCheck = isWithinDeliveryRange(
          customerLocation.latitude,
          customerLocation.longitude,
          cart.coordinates.latitude,
          cart.coordinates.longitude,
          cart.deliveryRadius || 5,
        );

        if (!rangeCheck.isWithinRange) {
          return res.status(400).json({
            message: `Delivery not available. You are ${rangeCheck.distance.toFixed(
              2,
            )} km away, but maximum delivery radius is ${cart.deliveryRadius || 5
              } km.`,
            distance: rangeCheck.distance,
            maxRadius: cart.deliveryRadius || 5,
          });
        }

        // Store delivery info (will be added to orderData after it's created)
        // Store in variables to use later
        deliveryInfo = {
          distance: rangeCheck.distance,
          deliveryCharge: cart.deliveryCharge || 0,
          estimatedTime: Math.ceil(rangeCheck.distance * 2), // Rough estimate: 2 min per km
        };
      }

      // Set cartId to cartAdminId (user ID), not Cart document ID
      cartId = cartAdminId;
      console.log("[ORDER] Set cartId for pickup/delivery order:", {
        requestCartId: requestCartId,
        cartAdminId: cartAdminId,
        finalCartId: cartId,
      });

      // Store cart data for later use (pickup location)
      pickupCartData = cart;
    }

    // Fallback: For takeaway orders without cartId, get the first active cafe admin
    if (isTakeaway && !cartId && !isPickup && !isDelivery) {
      const User = require("../models/userModel");
      const firstCafe = await User.findOne({
        role: "admin",
        isActive: true,
        isApproved: true,
      })
        .select("_id franchiseId")
        .lean();
      if (firstCafe) {
        cartId = firstCafe._id;
        console.log(
          "[ORDER] Using cartId from first active cafe for takeaway (fallback):",
          cartId.toString(),
        );
      } else {
        console.warn(
          "[ORDER] WARNING: No active cafe admin found for takeaway order. Order will be created without cartId.",
        );
        // Allow order to be created without cartId - it will be visible to super admin only
      }
    }

    // Set franchiseId: priority 1) from authenticated cafe admin's franchise, 2) from table's franchiseId, 3) from cart admin's franchise (for pickup/delivery), 4) from cafe's franchise
    let franchiseId = null;
    if (req.user && req.user.role === "admin" && req.user.franchiseId) {
      franchiseId = req.user.franchiseId;
    } else if (!isTakeaway && tableDoc && tableDoc.franchiseId) {
      franchiseId = tableDoc.franchiseId;
    } else if ((isPickup || isDelivery) && cartAdmin && cartAdmin.franchiseId) {
      // For pickup/delivery orders, use franchiseId from cartAdmin (already fetched)
      franchiseId = cartAdmin.franchiseId;
    } else if (cartId) {
      // If we have cartId but no franchiseId, get it from the cafe admin user
      const User = require("../models/userModel");
      const cafeAdmin = await User.findById(cartId)
        .select("franchiseId")
        .lean();
      if (cafeAdmin && cafeAdmin.franchiseId) {
        franchiseId = cafeAdmin.franchiseId;
      }
    }

    const shouldStartPendingForPayment = isPickup || isDelivery;

    const orderData = {
      _id: orderId,
      tableNumber: String(tableNumber),
      table: isTakeaway ? null : tableDoc?._id || null, // No table for takeaway/pickup/delivery
      serviceType: isPickup || isDelivery ? "TAKEAWAY" : normalizedServiceType, // Store as TAKEAWAY for backward compatibility
      orderType: isPickup ? "PICKUP" : isDelivery ? "DELIVERY" : undefined,
      // For takeaway/pickup/delivery orders, store session token to isolate each customer session
      // For dine-in orders, use the table session token
      sessionToken: isTakeaway ? sessionToken || undefined : sessionToken,
      selectedAddons: normalizeSelectedAddons(selectedAddons),
      kotLines: [kot],
      // UNIFIED STATUS FLOW:
      // - PICKUP/DELIVERY: Start as 'Pending' (awaiting payment confirmation)
      // - DINE_IN and regular TAKEAWAY: Start as 'Confirmed'
      status: shouldStartPendingForPayment ? "Pending" : "Confirmed",
      // Payment tracking: All orders start as UNPAID
      paymentStatus: "UNPAID",
      paymentMode: null,
      // Inventory tracking: Not yet deducted (will be deducted when status changes to Preparing)
      inventoryDeducted: false,
    };

    if (requestIdempotencyKey) {
      orderData.idempotencyKey = requestIdempotencyKey;
    }

    // Only set cartId and franchiseId if they exist (they're optional in the schema)
    // Convert to ObjectId if needed (Mongoose will handle this automatically, but we ensure it's valid)
    if (cartId) {
      if (mongoose.Types.ObjectId.isValid(cartId)) {
        orderData.cartId =
          typeof cartId === "string"
            ? new mongoose.Types.ObjectId(cartId)
            : cartId;
      } else {
        console.warn("[ORDER] Invalid cartId format:", cartId);
        // Still set it - Mongoose might handle it
        orderData.cartId = cartId;
      }
    }
    if (franchiseId) {
      if (mongoose.Types.ObjectId.isValid(franchiseId)) {
        orderData.franchiseId =
          typeof franchiseId === "string"
            ? new mongoose.Types.ObjectId(franchiseId)
            : franchiseId;
      } else {
        console.warn("[ORDER] Invalid franchiseId format:", franchiseId);
        // Still set it - Mongoose might handle it
        orderData.franchiseId = franchiseId;
      }
    }

    // Store special instructions for all order types
    if (specialInstructions) {
      orderData.specialInstructions = specialInstructions;
    }

    // Add customer information for takeaway/pickup/delivery orders
    if (isTakeaway || isPickup || isDelivery) {
      // Customer fields are required for pickup/delivery
      if (isPickup || isDelivery) {
        if (!customerName || !customerName.trim()) {
          return res.status(400).json({ message: "Customer name is required" });
        }
        if (!customerMobile || !customerMobile.trim()) {
          return res
            .status(400)
            .json({ message: "Customer mobile number is required" });
        }
      }

      // Set customer information
      if (customerName && customerName.trim()) {
        orderData.customerName = customerName.trim();
      }
      if (customerMobile && customerMobile.trim()) {
        orderData.customerMobile = customerMobile.trim();
      }
      if (customerEmail && customerEmail.trim()) {
        orderData.customerEmail = customerEmail.trim();
      }

      // Store customer location for pickup/delivery
      if (customerLocation) {
        orderData.customerLocation = {
          latitude: customerLocation.latitude,
          longitude: customerLocation.longitude,
          address:
            customerLocation.address || customerLocation.fullAddress || "",
        };
      }

      // Store delivery info for delivery orders
      if (isDelivery && deliveryInfo) {
        orderData.deliveryInfo = deliveryInfo;
      }

      // Store pickup location (cart address) for pickup/delivery orders
      if ((isPickup || isDelivery) && pickupCartData) {
        if (pickupCartData.address || pickupCartData.coordinates) {
          orderData.pickupLocation = {
            address:
              pickupCartData.address?.fullAddress ||
              pickupCartData.location ||
              "Address not set",
            coordinates: pickupCartData.coordinates || null,
          };
        }
      }

      // Generate simple takeaway token (1, 2, 3, etc.) per cart.
      // Do not assign takeaway token for DELIVERY orders.
      // REUSABLE: when orders are Paid/Cancelled/Returned, their tokens become free again.
      if (cartId && !isDelivery) {
        const tokenScopeCartId = normalizeObjectId(cartId);
        if (!tokenScopeCartId) {
          console.warn(
            `[ORDER] Skipping takeaway token allocation due to invalid cartId: ${cartId}`,
          );
        } else {
          const allocation = await resolveTakeawayTokenAllocation({
            cartId: tokenScopeCartId,
            preferredToken: requestedTakeawayToken,
          });
          if (Number.isInteger(allocation.token) && allocation.token > 0) {
            orderData.takeawayToken = allocation.token;
            console.log(
              `[ORDER] Assigned takeaway token ${orderData.takeawayToken} for cart ${tokenScopeCartId.toString()} (source: ${allocation.source})`,
            );
          }
        }
      }
    }

    // Auto-assign orders created from authenticated staff/admin sessions.
    // Customer/public orders remain unassigned and continue through accept flow.
    const creatorAssignment = await buildCreatorAcceptedBy({
      req,
      cartId: orderData.cartId || cartId || null,
    });
    if (creatorAssignment) {
      orderData.acceptedBy = creatorAssignment;
      if (orderData.serviceType !== "DINE_IN" && orderData.status === "Pending") {
        orderData.status = "Confirmed";
      }
    }

    // Order data prepared

    // Log order data before creation for debugging
    console.log("[ORDER] Creating order with data:", {
      orderId: orderData._id,
      serviceType: orderData.serviceType,
      orderType: orderData.orderType,
      cartId: orderData.cartId ? orderData.cartId.toString() : null,
      franchiseId: orderData.franchiseId
        ? orderData.franchiseId.toString()
        : null,
      hasKotLines: !!orderData.kotLines && orderData.kotLines.length > 0,
      kotLinesCount: orderData.kotLines?.length || 0,
      customerName: orderData.customerName || null,
      customerMobile: orderData.customerMobile || null,
    });

    let order;
    try {
      order = await Order.create(orderData);
      console.log("[ORDER] Order created successfully:", order._id);
    } catch (createError) {
      if (
        createError?.code === 11000 &&
        requestIdempotencyKey &&
        (createError?.keyPattern?.idempotencyKey ||
          createError?.keyValue?.idempotencyKey)
      ) {
        const existingByKey = await Order.findOne({
          idempotencyKey: requestIdempotencyKey,
        });
        if (existingByKey) {
          console.log(
            `[ORDER] createOrder duplicate key handled for ${requestIdempotencyKey}. Returning existing order ${existingByKey._id}.`,
          );
          return res.json(existingByKey);
        }
      }
      console.error("[ORDER] Failed to create order:", createError);
      console.error("[ORDER] Error name:", createError.name);
      console.error("[ORDER] Error message:", createError.message);
      console.error("[ORDER] Error stack:", createError.stack);
      if (createError.errors) {
        console.error(
          "[ORDER] Validation errors:",
          JSON.stringify(createError.errors, null, 2),
        );
      }
      console.error(
        "[ORDER] Order data that failed:",
        JSON.stringify(orderData, null, 2),
      );
      return res.status(400).json({
        message: `Failed to create order: ${createError.message}`,
        error: createError.message,
        details: createError.errors || "Unknown error",
      });
    }

    // Order created successfully
    // NOTE: Inventory consumption is NOT done here.
    // Inventory is ONLY deducted when order status changes to "Preparing" or "Being Prepared"
    // This ensures:
    // 1. Real-time inventory deduction only when kitchen actually starts
    // 2. No premature deductions for orders that might be cancelled
    // 3. Accurate food cost tracking in Finance panel
    console.log(`[ORDER] Order ${order._id} created. Inventory will be deducted when status changes to Preparing.`);

    // Centralized KOT print trigger: DB save is complete, now trigger print.
    // Printing is intentionally decoupled from employee check-in/checkout state.
    try {
      if (Array.isArray(order.kotLines) && order.kotLines.length > 0) {
        await triggerKotPrintAfterSave({
          req,
          order,
          kotIndex: order.kotLines.length - 1,
        });
      }
    } catch (printTriggerError) {
      console.error(
        `[ORDER] KOT print trigger failed for order ${order._id}:`,
        printTriggerError.message
      );
    }

    // Only update table status for dine-in orders
    if (!isTakeaway && tableDoc) {
      // Mark table as OCCUPIED when order is created
      // This ensures table shows as occupied in cart admin and to other customers
      tableDoc.status = "OCCUPIED";
      tableDoc.currentOrder = order._id;
      tableDoc.lastAssignedAt = new Date();
      await tableDoc.save();

      // Emit socket event to notify cart admin and other customers
      const io = req.app?.get("io");
      const emitToCafe = req.app?.get("emitToCafe");
      if (io && tableDoc.cartId && emitToCafe) {
        emitToCafe(io, tableDoc.cartId.toString(), "table:status:updated", {
          id: tableDoc._id,
          number: tableDoc.number,
          status: tableDoc.status,
          currentOrder: order._id,
        });
      }

      console.log(
        `[TABLE] Table ${tableDoc.number} marked as OCCUPIED for order ${order._id}`,
      );
    }

    // Create or update customer record for takeaway orders (non-blocking)
    if (
      isTakeaway &&
      (customerName || customerMobile || customerEmail) &&
      cartId
    ) {
      console.log("[ORDER] Starting customer creation process:", {
        orderId,
        isTakeaway,
        hasCustomerName: !!customerName,
        hasCustomerMobile: !!customerMobile,
        hasCustomerEmail: !!customerEmail,
        cartId: cartId ? cartId.toString() : "null",
        franchiseId: franchiseId ? franchiseId.toString() : "null",
      });

      // Run asynchronously so it doesn't block order creation
      (async () => {
        try {
          // Helper function to normalize phone number
          const normalizePhone = (phone) => {
            if (!phone) return null;
            // Remove all non-digit characters
            return phone.replace(/\D/g, "");
          };

          const normalizedPhone = customerMobile
            ? normalizePhone(customerMobile)
            : null;
          const normalizedEmail = customerEmail
            ? customerEmail.trim().toLowerCase()
            : null;

          console.log("[ORDER] Customer data normalized:", {
            normalizedPhone,
            normalizedEmail,
            customerName: customerName?.trim(),
          });

          // Phone or email is required to create customer
          if (!normalizedPhone && !normalizedEmail) {
            console.log(
              "[ORDER] Skipping customer creation - no phone or email provided",
            );
            return;
          }

          // Build search query - match by phone (primary) or email (secondary)
          let query = {};

          if (normalizedPhone && normalizedEmail) {
            // Both phone and email provided - search by either
            query = {
              $or: [{ phone: normalizedPhone }, { email: normalizedEmail }],
            };
          } else if (normalizedPhone) {
            // Only phone provided
            query = { phone: normalizedPhone };
          } else if (normalizedEmail) {
            // Only email provided
            query = { email: normalizedEmail };
          }

          // Filter by cartId to ensure customer belongs to the right cart
          // Customer model uses cartId (changed from cafeId)
          if (cartId) {
            const mongoose = require("mongoose");
            const cartIdValue = cartId._id || cartId;
            // Ensure cartId is ObjectId for proper matching
            const cartIdObj = mongoose.Types.ObjectId.isValid(cartIdValue)
              ? typeof cartIdValue === "string"
                ? new mongoose.Types.ObjectId(cartIdValue)
                : cartIdValue
              : cartIdValue;

            console.log("[ORDER] Setting cartId for customer query:", {
              cartId: cartId.toString(),
              cartIdValue: cartIdValue.toString(),
              cartIdObj: cartIdObj.toString(),
              cartIdType: typeof cartIdObj,
            });

            if (query.$or) {
              // If we have $or, wrap it in $and with cartId filter
              query = {
                $and: [{ $or: query.$or }, { cartId: cartIdObj }],
              };
            } else {
              query.cartId = cartIdObj;
            }
          }

          console.log(
            "[ORDER] Customer search query:",
            JSON.stringify(query, null, 2),
          );

          // Try to find existing customer
          let customer = await Customer.findOne(query);
          const orderTotal = kot.totalAmount || 0;

          console.log("[ORDER] Customer lookup result:", {
            found: !!customer,
            customerId: customer?._id?.toString(),
            customerName: customer?.name,
            customerCartId: customer?.cartId?.toString(),
          });

          if (customer) {
            // Update existing customer
            let updated = false;

            // Update name if provided and different
            if (
              customerName &&
              customerName.trim() &&
              customer.name !== customerName.trim()
            ) {
              customer.name = customerName.trim();
              updated = true;
            }

            // Update email if provided and different
            if (
              normalizedEmail &&
              (!customer.email || customer.email !== normalizedEmail)
            ) {
              customer.email = normalizedEmail;
              updated = true;
            }

            // Update phone if provided and different (and not a placeholder)
            if (
              normalizedPhone &&
              customer.phone &&
              !customer.phone.startsWith("email-") &&
              customer.phone !== normalizedPhone
            ) {
              customer.phone = normalizedPhone;
              updated = true;
            }

            // If customer has placeholder phone but now has real phone, update it
            if (
              normalizedPhone &&
              customer.phone &&
              customer.phone.startsWith("email-")
            ) {
              customer.phone = normalizedPhone;
              updated = true;
            }

            // If customer has no phone but now has one, update it
            if (normalizedPhone && !customer.phone) {
              customer.phone = normalizedPhone;
              updated = true;
            }

            // Increment visit count
            customer.incrementVisit();
            customer.totalSpent = (customer.totalSpent || 0) + orderTotal;
            customer.lastOrderId = order._id;
            updated = true;

            if (updated) {
              await customer.save();
            }

            console.log(
              `✅ [ORDER] Updated customer record: ${customer.name} (${customer.phone || customer.email
              }) - Visit #${customer.visitCount} for order ${orderId}`,
            );
          } else {
            // Create new customer record
            // Phone is required in schema, so use a placeholder if only email provided
            const phoneForNewCustomer =
              normalizedPhone || `email-${Date.now()}`;

            // Ensure cartId is converted to ObjectId
            const cartIdValue = cartId._id || cartId;
            const franchiseIdValue = franchiseId
              ? franchiseId._id || franchiseId
              : null;

            // Convert to ObjectId if they're strings (mongoose is already imported at top)
            const cartIdObj = mongoose.Types.ObjectId.isValid(cartIdValue)
              ? typeof cartIdValue === "string"
                ? new mongoose.Types.ObjectId(cartIdValue)
                : cartIdValue
              : cartIdValue;
            const franchiseIdObj =
              franchiseIdValue &&
                mongoose.Types.ObjectId.isValid(franchiseIdValue)
                ? typeof franchiseIdValue === "string"
                  ? new mongoose.Types.ObjectId(franchiseIdValue)
                  : franchiseIdValue
                : franchiseIdValue;

            console.log("[ORDER] ObjectId conversion:", {
              originalCartId: cartId.toString(),
              cartIdValue: cartIdValue.toString(),
              cartIdObj: cartIdObj.toString(),
              franchiseIdObj: franchiseIdObj?.toString() || "null",
            });

            const newCustomerData = {
              name: customerName ? customerName.trim() : "Guest",
              email: normalizedEmail || null,
              phone: phoneForNewCustomer,
              cartId: cartIdObj, // Customer model uses cartId (changed from cafeId)
              franchiseId: franchiseIdObj,
              visitCount: 1,
              firstVisitAt: new Date(),
              lastVisitAt: new Date(),
              totalSpent: orderTotal,
              lastOrderId: order._id,
              ratings: [],
              averageRating: 0,
            };

            console.log("[ORDER] Creating new customer with data:", {
              name: newCustomerData.name,
              phone: newCustomerData.phone,
              email: newCustomerData.email,
              cartId: newCustomerData.cartId?.toString(),
              franchiseId: newCustomerData.franchiseId?.toString(),
              cartIdType: typeof newCustomerData.cartId,
            });

            try {
              customer = await Customer.create(newCustomerData);
              console.log(
                `✅ [ORDER] Created new customer record: ${customer.name} (${customer.phone || customer.email
                }) for order ${orderId}`,
              );
              console.log("[ORDER] Created customer details:", {
                customerId: customer._id.toString(),
                cartId: customer.cartId?.toString(),
                franchiseId: customer.franchiseId?.toString(),
                phone: customer.phone,
                email: customer.email,
              });

              // Verify customer was created correctly
              const verifyCustomer = await Customer.findById(
                customer._id,
              ).lean();
              if (verifyCustomer) {
                console.log(
                  "[ORDER] Customer verification - Customer exists in database:",
                  {
                    id: verifyCustomer._id.toString(),
                    cartId: verifyCustomer.cartId?.toString(),
                    name: verifyCustomer.name,
                    phone: verifyCustomer.phone,
                    email: verifyCustomer.email,
                  },
                );

                // Test query that customer management panel would use
                const testQuery = { cartId: cartIdObj };
                const testCustomers = await Customer.find(testQuery)
                  .limit(1)
                  .lean();
                console.log(
                  "[ORDER] Test query for customer management panel:",
                  {
                    query: { cartId: cartIdObj.toString() },
                    foundCustomers: testCustomers.length,
                    sampleCustomer: testCustomers[0]
                      ? {
                        id: testCustomers[0]._id.toString(),
                        name: testCustomers[0].name,
                        cartId: testCustomers[0].cartId?.toString(),
                      }
                      : null,
                  },
                );
              } else {
                console.error(
                  "[ORDER] Customer verification FAILED - Customer not found after creation!",
                );
              }
            } catch (createError) {
              console.error("[ORDER] Error creating customer:", createError);
              console.error("[ORDER] Customer creation error details:", {
                message: createError.message,
                name: createError.name,
                code: createError.code,
                errors: createError.errors,
              });
              throw createError; // Re-throw to be caught by outer catch
            }
          }
        } catch (customerError) {
          // Log error but don't fail the order creation
          console.error(
            "[ORDER] Failed to create/update customer record:",
            customerError,
          );
          console.error("[ORDER] Customer error stack:", customerError.stack);
          console.error("[ORDER] Customer error details:", {
            message: customerError.message,
            name: customerError.name,
            code: customerError.code,
          });
        }
      })();
    } else {
      console.log("[ORDER] Skipping customer creation - conditions not met:", {
        isTakeaway,
        hasCustomerInfo: !!(customerName || customerMobile || customerEmail),
        hasCartId: !!cartId,
      });
    }

    // Emit socket event to cafe room (only for admin panel, not customer frontend)
    // PICKUP/DELIVERY: do NOT notify admin until payment is complete (order will appear when status becomes Paid)
    const isPickupOrDeliveryOrder =
      order.orderType === "PICKUP" ||
      order.orderType === "DELIVERY" ||
      order.serviceType === "PICKUP" ||
      order.serviceType === "DELIVERY";
    const isTakeawayAwaitingPayment =
      isPickupOrDeliveryOrder && order.status === "Pending";
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    if (order.cartId && io && emitToCafe && !isTakeawayAwaitingPayment) {
      // Only emit to admin panel - customer frontend uses polling
      emitToCafe(io, order.cartId.toString(), "order:created", order);
      emitToCafe(io, order.cartId.toString(), "newOrder", order); // Legacy support
      emitToCafe(io, order.cartId.toString(), "kot:created", order); // KOT created

      // Explicit new-order availability event for waiter/captain/manager claim flow.
      const isUnassigned = !order.acceptedBy || !order.acceptedBy.employeeId;
      const isActiveStatus = !FINAL_ORDER_STATUSES.includes(order.status);
      if (isUnassigned && isActiveStatus) {
        emitToCafe(
          io,
          order.cartId.toString(),
          "NEW_ORDER_AVAILABLE",
          buildNewOrderAvailablePayload(order),
        );
      }
    }
    // KOT printing is handled by print-claim/template clients.
    // Keep order creation side-effect free to avoid duplicate legacy prints.
    return res.status(201).json(order);
  } catch (err) {
    console.error("[ORDER] createOrder - Unhandled error:", err);
    console.error("[ORDER] Error stack:", err.stack);
    console.error("[ORDER] Error details:", {
      message: err.message,
      name: err.name,
      code: err.code,
    });
    return res.status(500).json({
      message: err.message || "Internal server error",
      error: process.env.NODE_ENV === "development" ? err.stack : undefined,
    });
  }
};

// ---------------- ADD KOT ----------------
const addKot = async (req, res) => {
  console.log("[ORDER] addKot called - no auth required");
  console.log("[ORDER] addKot - Order ID:", req.params.id);
  console.log(
    "[ORDER] addKot - Request body:",
    JSON.stringify(req.body, null, 2),
  );
  try {
    const { items, selectedAddons = [] } = req.body;
    const requestKotIdempotencyKey = String(
      req.body?.idempotencyKey || req.headers["x-idempotency-key"] || "",
    ).trim();
    const specialInstructions = normalizeOrderSpecialInstructions(req.body);

    // Enhanced validation with detailed error messages
    if (!items) {
      console.error("[ORDER] addKot - Missing items field in request body");
      return res
        .status(400)
        .json({ message: "No items field supplied in request body" });
    }
    if (!Array.isArray(items)) {
      console.error(
        "[ORDER] addKot - Items is not an array:",
        typeof items,
        items,
      );
      return res
        .status(400)
        .json({ message: `Items must be an array, received: ${typeof items}` });
    }
    if (items.length === 0) {
      console.error("[ORDER] addKot - Items array is empty");
      return res.status(400).json({
        message:
          "Items array is empty. Please add at least one item to the order.",
      });
    }

    const order = await Order.findById(req.params.id);
    if (!order) {
      console.error("[ORDER] addKot - Order not found:", req.params.id);
      return res.status(404).json({ message: "Order not found" });
    }

    if (
      requestKotIdempotencyKey &&
      Array.isArray(order.kotRequestKeys) &&
      order.kotRequestKeys.includes(requestKotIdempotencyKey)
    ) {
      console.log(
        `[ORDER] addKot idempotent replay detected for key ${requestKotIdempotencyKey}. Returning existing order ${order._id}.`,
      );
      return res.json(order);
    }

    // Define statuses that allow adding KOTs
    // For takeaway orders, allow more statuses (customers can add items even if preparing)
    // For dine-in orders, also allow more statuses for flexibility
    const allowedStatusesForKot = [
      "Pending",
      "Confirmed",
      "Preparing",
      "Ready",
    ];

    // Never allow adding KOTs to these final statuses
    const blockedStatuses = [
      "Cancelled",
      "Returned",
      "Paid",
      "Served",
      "Finalized",
    ];

    if (blockedStatuses.includes(order.status)) {
      console.error(
        "[ORDER] addKot - Order is in a final status that blocks KOTs:",
        order.status,
      );
      return res.status(400).json({
        message: `Cannot add items to order with status: ${order.status
          }. Order is already ${order.status.toLowerCase()}.`,
        currentStatus: order.status,
      });
    }

    if (!allowedStatusesForKot.includes(order.status)) {
      console.error(
        "[ORDER] addKot - Order status does not allow adding KOTs:",
        order.status,
      );
      return res.status(400).json({
        message: `Order is not open for adding items. Current status: ${order.status}. Please contact staff if you need to modify your order.`,
        currentStatus: order.status,
        allowedStatuses: allowedStatusesForKot,
      });
    }

    // Ensure cartId and franchiseId are set if missing (for orders created before fix)
    let needsSave = false;

    // For dine-in orders, get cartId/franchiseId from table
    if ((!order.cartId || !order.franchiseId) && order.table) {
      const tableDoc = await Table.findById(order.table);
      if (tableDoc) {
        if (!order.cartId && tableDoc.cartId) {
          order.cartId = tableDoc.cartId;
          needsSave = true;
        } else if (!order.cartId && tableDoc.franchiseId) {
          // Fallback: table has no cartId but has franchiseId - use first cart under franchise
          const User = require("../models/userModel");
          const firstCafe = await User.findOne({
            role: "admin",
            franchiseId: tableDoc.franchiseId,
            isActive: true,
            isApproved: true,
          })
            .select("_id franchiseId")
            .lean();
          if (firstCafe) {
            order.cartId = firstCafe._id;
            needsSave = true;
            if (!order.franchiseId && firstCafe.franchiseId) {
              order.franchiseId = firstCafe.franchiseId;
              needsSave = true;
            }
          }
        }
        if (!order.franchiseId && tableDoc.franchiseId) {
          order.franchiseId = tableDoc.franchiseId;
          needsSave = true;
        }
      }
    }

    // For takeaway orders without cartId/franchiseId, assign from first active cafe
    if (
      order.serviceType === "TAKEAWAY" &&
      (!order.cartId || !order.franchiseId)
    ) {
      const User = require("../models/userModel");
      if (!order.cartId) {
        const firstCafe = await User.findOne({
          role: "admin",
          isActive: true,
          isApproved: true,
        })
          .select("_id franchiseId")
          .lean();
        if (firstCafe) {
          order.cartId = firstCafe._id;
          needsSave = true;
          // Also set franchiseId if we have it
          if (!order.franchiseId && firstCafe.franchiseId) {
            order.franchiseId = firstCafe.franchiseId;
          }
        }
      } else if (!order.franchiseId && order.cartId) {
        // If we have cartId but no franchiseId, get it from cafe admin
        const cafeAdmin = await User.findById(order.cartId)
          .select("franchiseId")
          .lean();
        if (cafeAdmin && cafeAdmin.franchiseId) {
          order.franchiseId = cafeAdmin.franchiseId;
          needsSave = true;
        }
      }
    }

    // If we still don't have franchiseId but have cartId, get it from cafe admin
    if (!order.franchiseId && order.cartId) {
      const User = require("../models/userModel");
      const cafeAdmin = await User.findById(order.cartId)
        .select("franchiseId")
        .lean();
      if (cafeAdmin && cafeAdmin.franchiseId) {
        order.franchiseId = cafeAdmin.franchiseId;
        needsSave = true;
      }
    }

    if (needsSave) {
      console.log("[ORDER] addKot - Updating order with cartId/franchiseId:", {
        orderId: order._id,
        cartId: order.cartId ? order.cartId.toString() : "none",
        franchiseId: order.franchiseId ? order.franchiseId.toString() : "none",
      });
      await order.save();
    }

    // Build KOT with error handling
    let newKot;
    try {
      newKot = buildKot(items);
      newKot.kotNumber = getNextKotNumber(order);
      console.log("[ORDER] addKot - KOT built successfully:", {
        itemsCount: newKot.items.length,
        subtotal: newKot.subtotal,
        gst: newKot.gst,
        totalAmount: newKot.totalAmount,
      });
    } catch (kotError) {
      console.error("[ORDER] addKot - Failed to build KOT:", kotError);
      return res.status(400).json({
        message: `Invalid order items: ${kotError.message}`,
        error: kotError.message,
      });
    }

    order.kotLines.push(newKot);
    const normalizedIncomingAddons = normalizeSelectedAddons(selectedAddons);
    if (normalizedIncomingAddons.length > 0) {
      const mergedAddons = normalizeSelectedAddons([
        ...(Array.isArray(order.selectedAddons) ? order.selectedAddons : []),
        ...normalizedIncomingAddons,
      ]);
      order.selectedAddons = mergedAddons;
      order.markModified("selectedAddons");
    }
    if (requestKotIdempotencyKey) {
      const requestKeys = Array.isArray(order.kotRequestKeys)
        ? [...order.kotRequestKeys]
        : [];
      if (!requestKeys.includes(requestKotIdempotencyKey)) {
        requestKeys.push(requestKotIdempotencyKey);
      }
      order.kotRequestKeys = requestKeys;
    }

    // Allow customer to attach/update special instructions when adding KOT
    if (specialInstructions) {
      order.specialInstructions = specialInstructions;
    }

    try {
      await order.save();
      console.log("[ORDER] addKot - Order updated successfully:", order._id);
    } catch (saveError) {
      console.error("[ORDER] addKot - Failed to save order:", saveError);
      return res.status(400).json({
        message: `Failed to save order: ${saveError.message}`,
        error: saveError.message,
      });
    }

    // Centralized KOT print trigger after KOT record is persisted.
    // Decoupled from attendance/session state.
    try {
      await triggerKotPrintAfterSave({
        req,
        order,
        kotIndex: order.kotLines.length - 1,
      });
    } catch (printTriggerError) {
      console.error(
        `[ORDER] addKot - KOT print trigger failed for order ${order._id}:`,
        printTriggerError.message
      );
    }

    // Update customer record for takeaway orders (non-blocking)
    if (
      order.serviceType === "TAKEAWAY" &&
      (order.customerName || order.customerMobile || order.customerEmail) &&
      order.cartId
    ) {
      // Run asynchronously so it doesn't block order update
      (async () => {
        try {
          // Helper function to normalize phone number
          const normalizePhone = (phone) => {
            if (!phone) return null;
            // Remove all non-digit characters
            return phone.replace(/\D/g, "");
          };

          const normalizedPhone = order.customerMobile
            ? normalizePhone(order.customerMobile)
            : null;
          const normalizedEmail = order.customerEmail
            ? order.customerEmail.trim().toLowerCase()
            : null;

          // Phone or email is required to find customer
          if (!normalizedPhone && !normalizedEmail) {
            console.log(
              "[ORDER] addKot - Skipping customer update - no phone or email",
            );
            return;
          }

          // Build search query - match by phone (primary) or email (secondary)
          let query = {};

          if (normalizedPhone && normalizedEmail) {
            // Both phone and email provided - search by either
            query = {
              $or: [{ phone: normalizedPhone }, { email: normalizedEmail }],
            };
          } else if (normalizedPhone) {
            // Only phone provided
            query = { phone: normalizedPhone };
          } else if (normalizedEmail) {
            // Only email provided
            query = { email: normalizedEmail };
          }

          // Filter by cartId to ensure customer belongs to the right cart
          // Customer model uses cartId (changed from cafeId)
          if (order.cartId) {
            const cartIdValue = order.cartId._id || order.cartId;
            if (query.$or) {
              // If we have $or, wrap it in $and with cartId filter
              query = {
                $and: [{ $or: query.$or }, { cartId: cartIdValue }],
              };
            } else {
              query.cartId = cartIdValue;
            }
          }

          const customer = await Customer.findOne(query);
          const newKotTotal = newKot.totalAmount || 0;

          if (customer) {
            // Update existing customer's total spent
            customer.totalSpent = (customer.totalSpent || 0) + newKotTotal;
            customer.lastOrderId = order._id;
            customer.lastVisitAt = new Date();
            await customer.save();
            console.log(
              `✅ [ORDER] addKot - Updated customer record: ${customer.name} (${customer.phone || customer.email
              }) for order ${order._id}`,
            );
          } else {
            console.log(
              `[ORDER] addKot - Customer not found for order ${order._id
              } (phone: ${normalizedPhone || "N/A"}, email: ${normalizedEmail || "N/A"
              })`,
            );
          }
        } catch (customerError) {
          // Log error but don't fail the order update
          console.error(
            "[ORDER] addKot - Failed to update customer record:",
            customerError,
          );
        }
      })();
    }

    // Emit socket event to cafe room
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    if (order.cartId) {
      emitToCafe(io, order.cartId.toString(), "order:status:updated", order);
      emitToCafe(io, order.cartId.toString(), "orderUpdated", order); // Legacy support
      emitToCafe(io, order.cartId.toString(), "kot:status:updated", order); // KOT updated
      if (order.acceptedBy && order.acceptedBy.employeeId) {
        const assignmentDisplayType = resolveAssignmentDisplayType(
          order.acceptedBy?.employeeRole || null,
        );
        emitToCafe(
          io,
          order.cartId.toString(),
          "ORDER_ACCEPTED",
          {
            orderId: order._id,
            status: order.status,
            assignedStaff: mapAcceptedByToAssignedStaff(order.acceptedBy),
            assignmentDisplayType,
            order,
          },
        );
      }
    }

    return res.json(order);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ---------------- FINALIZE ORDER ----------------
const finalizeOrder = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) {
      console.log("Order not found:", req.params.id);
      return res.status(404).json({ message: "Order not found" });
    }

    console.log("Attempting to finalize order:", {
      orderId: order._id,
      currentStatus: order.status,
      allowedTransitions: Array.from(transitions[order.status] || []),
    });

    if (!transitions[order.status]?.has("Finalized")) {
      console.log("Invalid transition:", {
        from: order.status,
        to: "Finalized",
        allowedTransitions: Array.from(transitions[order.status] || []),
      });
      return res.status(400).json({
        message: `Cannot finalize from ${order.status}. Order must be in 'Served' state.`,
        currentStatus: order.status,
        allowedTransitions: Array.from(transitions[order.status] || []),
      });
    }

    order.status = "Finalized";
    order.inventoryDeducted = true;
    order.inventoryDeductedAt = new Date();
    await order.save();

    // Await consumption to surface failures (MenuItemV2 not found, no recipe) for diagnostics
    const userId = req.user
      ? req.user._id
      : order.cartId && (order.cartId._id || order.cartId);
    if (userId) {
      console.log(
        `[COSTING] Finalized order ${order._id} - Triggering consumption (User: ${userId})`,
      );
      try {
        const result = await consumeIngredientsForOrder(order, userId);
        if (result.success) {
          console.log(
            `[COSTING] Finalized order ${order._id} consumption success`,
          );
        } else {
          console.warn(
            `[COSTING] Finalized order ${order._id} consumption failed: ${result.message}`,
          );
          if (result.summary?.errors?.length) {
            console.warn(
              `[COSTING] Consumption errors:`,
              result.summary.errors,
            );
          }
          if (shouldResetInventoryDeduction(result)) {
            await resetInventoryDeductionFlag(order._id);
          }
        }
      } catch (err) {
        console.error(
          `[COSTING] Finalized order ${order._id} consumption error:`,
          err,
        );
        await resetInventoryDeductionFlag(order._id);
      }
    } else {
      console.warn(
        `[COSTING] Skipping consumption for finalized order ${order._id}: no req.user and no order.cartId`,
      );
      await resetInventoryDeductionFlag(order._id);
    }

    // Release table when order is finalized
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    await releaseTableForOrder(order, io, emitToCafe);

    // Emit socket event to cafe room (only for admin panel, not customer frontend)
    if (order.cartId && io && emitToCafe) {
      // Only emit to admin panel - customer frontend uses polling to avoid loops
      emitToCafe(io, order.cartId.toString(), "order:status:updated", order);
      emitToCafe(io, order.cartId.toString(), "orderUpdated", order); // Legacy support
      emitToCafe(io, order.cartId.toString(), "kot:status:updated", order); // KOT updated
    }

    return res.json(order);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ---------------- GET ORDERS ----------------
// IMPORTANT: This function returns ALL orders permanently - no date filtering or time limits
// Orders are stored permanently in the database and will never be automatically deleted
// CRITICAL: Each cart admin must only see their own orders (filtered by cartId)
const getOrders = async (req, res) => {
  try {
    const query = {};

    // Filter orders based on user role:
    // - Cart admin (admin): ONLY see orders from their cart (cartId matches their _id) - CRITICAL FOR DATA ISOLATION
    // - Franchise admin: only orders from cafes under their franchise (franchiseId matches their _id)
    // - Mobile users (waiter, cook, captain, manager): ONLY see orders from their assigned cart/kiosk
    // - Super admin: all orders (no filter - they see everything)
    if (req.user && req.user.role === "admin" && req.user._id) {
      // CRITICAL: Cart admin - ONLY see orders from their own cart
      // This ensures complete data isolation between carts
      query.cartId = req.user._id;
      console.log(
        `[GET_ORDERS] Cart admin ${req.user._id} - filtering by cartId: ${req.user._id}`,
      );
    } else if (
      req.user &&
      req.user.role === "franchise_admin" &&
      req.user._id
    ) {
      // Franchise admin - only see orders from cafes under their franchise
      query.franchiseId = req.user._id;
      console.log(
        `[GET_ORDERS] Franchise admin ${req.user._id} - filtering by franchiseId: ${req.user._id}`,
      );
    } else if (req.user && MOBILE_ORDER_ROLES.has(req.user.role)) {
      // Mobile users - ONLY see orders from their assigned cart/kiosk
      // Prefer cartId, fallback to cafeId for backward compatibility.
      const mobileCartId = await resolveMobileCartId(req.user);
      if (mobileCartId) {
        query.cartId = mobileCartId;
        console.log(
          `[GET_ORDERS] Mobile user ${req.user._id} (${req.user.role}) - filtering by cartId: ${mobileCartId}`,
        );
      } else {
        // If no cart binding found, return empty set instead of leaking cross-cart data.
        console.warn(
          `[GET_ORDERS] Mobile user ${req.user._id} has no cartId/cafeId - returning empty array`,
        );
        return res.json([]);
      }
    }
    // For super_admin, no query-level restriction (see all orders)

    // PICKUP/DELIVERY: hide unpaid Pending orders from cart admin until payment is done.
    // Regular TAKEAWAY should follow dine-in visibility.
    query.$and = query.$and || [];
    query.$and.push({
      $or: [
        { status: { $ne: "Pending" } },
        {
          orderType: { $nin: ["PICKUP", "DELIVERY"] },
          serviceType: { $nin: ["PICKUP", "DELIVERY"] },
        },
      ],
    });

    // Fetch ALL orders - no date filtering, no limits, permanent storage
    // Add limit to prevent infinite queries (max 10000 orders at once)
    // Use select to limit fields and improve performance
    const orders = await Order.find(query)
      .sort({ createdAt: -1 }) // Sort by newest first (uses index)
      .limit(10000) // Safety limit to prevent infinite queries
      .populate("table", "number name status") // Only populate needed fields
      .select("-__v") // Exclude version field
      .lean();

    // Optimize franchiseId population: Batch fetch instead of N+1 queries
    const User = require("../models/userModel");
    const ordersNeedingFranchiseId = orders.filter(
      (order) => !order.franchiseId && order.cartId,
    );

    if (ordersNeedingFranchiseId.length > 0) {
      // Batch fetch all cafes at once
      const cartIds = [
        ...new Set(
          ordersNeedingFranchiseId.map((o) =>
            o.cartId.toString ? o.cartId.toString() : o.cartId,
          ),
        ),
      ];

      const cafes = await User.find({ _id: { $in: cartIds } })
        .select("_id franchiseId")
        .lean();

      const cafeMap = new Map(
        cafes.map((c) => [c._id.toString(), c.franchiseId]),
      );

      // Update orders in memory and batch update in background
      const updatePromises = [];
      for (const order of ordersNeedingFranchiseId) {
        const cartId = order.cartId.toString
          ? order.cartId.toString()
          : order.cartId;
        const franchiseId = cafeMap.get(cartId);
        if (franchiseId) {
          order.franchiseId = franchiseId;
          // Batch update in background (non-blocking)
          updatePromises.push(
            Order.findByIdAndUpdate(order._id, { franchiseId }).catch((err) => {
              console.warn(
                `[GET_ORDERS] Failed to update order ${order._id} franchiseId:`,
                err.message,
              );
            }),
          );
        }
      }

      // Execute updates in background (don't await)
      if (updatePromises.length > 0) {
        Promise.all(updatePromises).catch((err) => {
          console.warn("[GET_ORDERS] Background update error:", err.message);
        });
      }
    }

    for (const order of orders) {
      order.assignedStaff = mapAcceptedByToAssignedStaff(
        order.acceptedBy,
        order.acceptedBy?.employeeRole || null,
      );
    }

    return res.json(orders);
  } catch (err) {
    console.error("[GET_ORDERS] Error:", err);
    return res.status(500).json({ message: err.message });
  }
};

// ---------------- GET ORDER BY ID ----------------
const getOrderById = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id).populate("table").lean();
    if (!order) return res.status(404).json({ message: "Order not found" });

    // Ensure franchiseId is set if missing (for old orders)
    if (!order.franchiseId && order.cartId) {
      const User = require("../models/userModel");
      const cafe = await User.findById(order.cartId)
        .select("franchiseId")
        .lean();
      if (cafe && cafe.franchiseId) {
        // Update order with franchiseId (non-blocking)
        Order.findByIdAndUpdate(req.params.id, {
          franchiseId: cafe.franchiseId,
        }).catch(() => {
          // Failed to update order franchiseId - non-blocking
        });
        order.franchiseId = cafe.franchiseId;
      }
    }

    // Check access permissions based on user role:
    // - Cafe admin: can only access orders from their cafe
    // - Franchise admin: can only access orders from cafes under their franchise
    // - Mobile users (waiter, cook, captain, manager): can only access orders from their assigned cart/kiosk
    // - Super admin: can access all orders
    // - Public (no auth): can access orders (for frontend customers)
    if (req.user && req.user.role === "admin" && req.user._id) {
      // Cafe admin - check if order belongs to their cafe
      if (
        !order.cartId ||
        order.cartId.toString() !== req.user._id.toString()
      ) {
        return res
          .status(403)
          .json({ message: "Order does not belong to your cafe" });
      }
    } else if (
      req.user &&
      req.user.role === "franchise_admin" &&
      req.user._id
    ) {
      // Franchise admin - check if order belongs to their franchise
      if (
        !order.franchiseId ||
        order.franchiseId.toString() !== req.user._id.toString()
      ) {
        return res
          .status(403)
          .json({ message: "Order does not belong to your franchise" });
      }
    } else if (req.user && MOBILE_ORDER_ROLES.has(req.user.role)) {
      // Mobile users - check if order belongs to their assigned cart/kiosk
      const mobileCartId = await resolveMobileCartId(req.user);
      if (!mobileCartId) {
        return res
          .status(403)
          .json({ message: "No cart/kiosk assigned to your account" });
      }
      if (
        !order.cartId ||
        order.cartId.toString() !== mobileCartId.toString()
      ) {
        return res
          .status(403)
          .json({ message: "Order does not belong to your cart/kiosk" });
      }
    }
    // For super_admin, no restriction (they can see all orders)

    // Populate franchise GST number if franchiseId exists and not already populated
    if (order.franchiseId && !order.franchise) {
      const User = require("../models/userModel");
      const franchiseId = order.franchiseId.toString
        ? order.franchiseId.toString()
        : order.franchiseId;

      // Check cache first
      const cachedFranchise = getCachedFranchise(franchiseId);
      if (cachedFranchise) {
        order.franchise = cachedFranchise;
        // Silently use cache - no need to log every time
      } else {
        console.log(`[INVOICE] Fetching franchise data for ID: ${franchiseId}`);
        const franchise = await User.findById(franchiseId)
          .select("gstNumber name address")
          .lean();
        if (franchise) {
          order.franchise = {
            gstNumber: franchise.gstNumber,
            name: franchise.name,
            address: franchise.address,
          };
          setCachedFranchise(franchiseId, order.franchise);
          console.log(`[INVOICE] Franchise data loaded:`, {
            name: franchise.name,
            gstNumber: franchise.gstNumber,
            hasAddress: !!franchise.address,
          });
        } else {
          console.warn(`[INVOICE] Franchise not found for ID: ${franchiseId}`);
        }
      }
    } else if (order.franchiseId && order.franchise) {
      // Data already populated, skip fetching
      // No need to log - this is expected
    } else {
      console.warn(`[INVOICE] Order ${order._id} has no franchiseId`);
    }

    // Populate cafe/cart address for invoice (cartId is cart admin User _id)
    if (order.cartId && !order.cafe) {
      const User = require("../models/userModel");
      const cartId = order.cartId.toString
        ? order.cartId.toString()
        : order.cartId;

      // Check cache first
      const cachedCafe = getCachedCafe(cartId);
      if (cachedCafe) {
        order.cafe = cachedCafe;
        console.log(`[INVOICE] Using cached cart data for ID: ${cartId}`);
      } else {
        console.log(`[INVOICE] Fetching cart data for ID: ${cartId}`);
        const cafe = await User.findById(cartId)
          .select(
            "address cartName location name phone managerHelplineNumber emergencyContacts"
          )
          .lean();

        let address = (cafe && (cafe.address || cafe.location)) || null;
        let cafeName = (cafe && (cafe.cartName || cafe.name)) || null;

        // Prefer Cart document address (from cart registration/settings)
        const cartDoc = await Cart.findOne({ cartAdminId: order.cartId })
          .select("address location")
          .lean();
        if (cartDoc) {
          const cartAddress =
            (cartDoc.address && (cartDoc.address.fullAddress || [cartDoc.address.street, cartDoc.address.city, cartDoc.address.state, cartDoc.address.zipCode].filter(Boolean).join(", "))) ||
            cartDoc.location ||
            null;
          if (cartAddress) address = cartAddress;
        }

        if (cafe || address || cafeName) {
          order.cafe = {
            address: address || undefined,
            cartName: cafeName,
            cafeName: cafeName,
            name: cafeName,
          };
          setCachedCafe(cartId, order.cafe);
          console.log(`[INVOICE] Cart data loaded:`, {
            cartName: order.cafe.cartName,
            address: order.cafe.address,
          });
        } else {
          console.warn(`[INVOICE] Cart not found for ID: ${cartId}`);
        }
      }
    } else if (order.cartId && order.cafe) {
      // Data already populated (e.g. from cache), skip fetching
    } else {
      console.warn(`[INVOICE] Order ${order._id} has no cartId`);
    }

    order.assignedStaff = mapAcceptedByToAssignedStaff(
      order.acceptedBy,
      order.acceptedBy?.employeeRole || null,
    );
    return res.json(order);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ---------------- ADD ITEMS TO ORDER (ADMIN) ----------------
const addItemsToOrder = async (req, res) => {
  try {
    const { items } = req.body;
    const specialInstructions = normalizeOrderSpecialInstructions(req.body);
    const orderId = req.params.id;

    // Validate items
    if (!items) {
      return res
        .status(400)
        .json({ message: "No items field supplied in request body" });
    }
    if (!Array.isArray(items)) {
      return res
        .status(400)
        .json({ message: `Items must be an array, received: ${typeof items}` });
    }
    if (items.length === 0) {
      return res.status(400).json({
        message: "Items array is empty. Please add at least one item.",
      });
    }

    // Find the order
    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    // Check access permissions
    if (req.user && req.user.role === "admin" && req.user._id) {
      // Cafe admin:
      // - For DINE_IN orders, enforce strict cart ownership
      // - For TAKEAWAY orders, allow modification even if cartId is missing/mismatched
      if (order.serviceType !== "TAKEAWAY") {
        if (
          !order.cartId ||
          order.cartId.toString() !== req.user._id.toString()
        ) {
          return res
            .status(403)
            .json({ message: "Order does not belong to your cafe" });
        }
      }
    } else if (
      req.user &&
      req.user.role === "franchise_admin" &&
      req.user._id
    ) {
      if (
        !order.franchiseId ||
        order.franchiseId.toString() !== req.user._id.toString()
      ) {
        return res
          .status(403)
          .json({ message: "Order does not belong to your franchise" });
      }
    } else if (
      req.user &&
      ["waiter", "cook", "captain", "manager"].includes(req.user.role)
    ) {
      // Mobile users - can only add items to orders from their assigned cart/kiosk
      if (!req.user.cafeId) {
        return res
          .status(403)
          .json({ message: "No cart/kiosk assigned to your account" });
      }
      if (
        !order.cartId ||
        order.cartId.toString() !== req.user.cafeId.toString()
      ) {
        return res
          .status(403)
          .json({ message: "Order does not belong to your cart/kiosk" });
      }
    }

    // Check if order can be modified - only allow adding items until payment is done
    // Block adding items to Paid, Cancelled, or Returned orders
    if (["Paid", "Cancelled", "Returned"].includes(order.status)) {
      return res.status(400).json({
        message: `Cannot add items to order with status: ${order.status}. Items can only be added to unpaid orders.`,
        currentStatus: order.status,
      });
    }

    // Build new KOT with the items
    let newKot;
    try {
      newKot = buildKot(items);
      newKot.kotNumber = getNextKotNumber(order);
      console.log("[ORDER] addItemsToOrder - KOT built successfully:", {
        itemsCount: newKot.items.length,
        subtotal: newKot.subtotal,
        gst: newKot.gst,
        totalAmount: newKot.totalAmount,
      });
    } catch (kotError) {
      console.error("[ORDER] addItemsToOrder - Failed to build KOT:", kotError);
      return res.status(400).json({
        message: `Invalid order items: ${kotError.message}`,
        error: kotError.message,
      });
    }

    // Add the new KOT to the order
    order.kotLines.push(newKot);

    if (specialInstructions) {
      order.specialInstructions = specialInstructions;
    }

    try {
      await order.save();
      console.log(
        "[ORDER] addItemsToOrder - Order updated successfully:",
        order._id,
      );
    } catch (saveError) {
      console.error(
        "[ORDER] addItemsToOrder - Failed to save order:",
        saveError,
      );
      return res.status(400).json({
        message: `Failed to save order: ${saveError.message}`,
        error: saveError.message,
      });
    }

    // Centralized KOT print trigger after KOT line is persisted.
    try {
      await triggerKotPrintAfterSave({
        req,
        order,
        kotIndex: order.kotLines.length - 1,
      });
    } catch (printTriggerError) {
      console.error(
        `[ORDER] addItemsToOrder - KOT print trigger failed for order ${order._id}:`,
        printTriggerError.message
      );
    }

    // Emit socket event for real-time update
    // Emit socket event to cafe room
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    if (order.cartId) {
      emitToCafe(io, order.cartId.toString(), "order:status:updated", order);
      emitToCafe(io, order.cartId.toString(), "orderUpdated", order); // Legacy support
      emitToCafe(io, order.cartId.toString(), "kot:status:updated", order); // KOT updated
    }

    return res.json(order);
  } catch (err) {
    console.error("[ORDER] addItemsToOrder - Error:", err);
    return res.status(500).json({ message: err.message });
  }
};

// ---------------- UPDATE ORDER ADD-ONS (ADMIN) ----------------
const updateOrderAddons = async (req, res) => {
  try {
    const { selectedAddons } = req.body;
    const orderId = req.params.id;

    if (!Array.isArray(selectedAddons)) {
      return res.status(400).json({
        message: "selectedAddons must be an array",
      });
    }

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    // Check access permissions (aligned with addItemsToOrder)
    if (req.user && req.user.role === "admin" && req.user._id) {
      // Cafe admin:
      // - For DINE_IN orders, enforce strict cart ownership
      // - For TAKEAWAY orders, allow modification even if cartId is missing/mismatched
      if (order.serviceType !== "TAKEAWAY") {
        if (
          !order.cartId ||
          order.cartId.toString() !== req.user._id.toString()
        ) {
          return res
            .status(403)
            .json({ message: "Order does not belong to your cafe" });
        }
      }
    } else if (
      req.user &&
      req.user.role === "franchise_admin" &&
      req.user._id
    ) {
      if (
        !order.franchiseId ||
        order.franchiseId.toString() !== req.user._id.toString()
      ) {
        return res
          .status(403)
          .json({ message: "Order does not belong to your franchise" });
      }
    } else if (
      req.user &&
      ["waiter", "cook", "captain", "manager"].includes(req.user.role)
    ) {
      if (!req.user.cafeId) {
        return res
          .status(403)
          .json({ message: "No cart/kiosk assigned to your account" });
      }
      if (
        !order.cartId ||
        order.cartId.toString() !== req.user.cafeId.toString()
      ) {
        return res
          .status(403)
          .json({ message: "Order does not belong to your cart/kiosk" });
      }
    }

    // Same modification rules as add-items endpoint
    if (["Paid", "Cancelled", "Returned"].includes(order.status)) {
      return res.status(400).json({
        message: `Cannot update add-ons for order with status: ${order.status}. Add-ons can only be updated on unpaid active orders.`,
        currentStatus: order.status,
      });
    }

    order.selectedAddons = normalizeSelectedAddons(selectedAddons);
    order.markModified("selectedAddons");
    await order.save();

    // Emit socket event to cafe room
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    if (order.cartId && emitToCafe) {
      emitToCafe(io, order.cartId.toString(), "order:status:updated", order);
      emitToCafe(io, order.cartId.toString(), "orderUpdated", order);
    }

    return res.json(order);
  } catch (err) {
    console.error("[ORDER] updateOrderAddons - Error:", err);
    return res.status(500).json({ message: err.message });
  }
};

// ---------------- ACCEPT ORDER (first-come-first-serve) ----------------
const acceptOrder = async (req, res) => {
  try {
    const orderId = req.params.id;

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ message: "Order not found" });

    // Allow acceptance for dine-in and takeaway flows.
    if (!ACCEPTABLE_SERVICE_TYPES.includes(order.serviceType)) {
      return res.status(400).json({
        message:
          "Order acceptance is not supported for this order type",
      });
    }

    // Accept only while order is still active and not already accepted.
    if (!ACCEPTABLE_ORDER_STATUSES.includes(order.status)) {
      return res.status(400).json({
        message: `Order cannot be accepted (current status: ${order.status})`,
      });
    }
    if (order.acceptedBy && order.acceptedBy.employeeId) {
      return res.status(409).json({
        message: `Order already accepted by ${order.acceptedBy.employeeName || "another staff member"}`,
      });
    }

    const isAdminAccepter = String(req.user?.role || "").toLowerCase() === "admin";

    // Check cart access for waiter/captain/manager/admin
    const userCartId = (
      isAdminAccepter
        ? req.user._id
        : req.user.cartId || req.user.cafeId
    )?.toString();
    if (!userCartId) {
      return res
        .status(403)
        .json({ message: "No cart/kiosk assigned to your account" });
    }
    if (!order.cartId || order.cartId.toString() !== userCartId) {
      return res
        .status(403)
        .json({ message: "Order does not belong to your cart/kiosk" });
    }

    // Lookup employee by userId for staff roles.
    // Admin accept path uses admin user identity directly.
    let employee = null;
    if (!isAdminAccepter) {
      employee = await Employee.findOne({
        userId: req.user._id,
        cartId: order.cartId,
        isActive: true,
      });
      if (!employee) {
        return res.status(403).json({
          message: "Employee record not found for your account",
        });
      }
    }

    const accepterId = isAdminAccepter ? req.user._id : employee._id;
    const accepterName = isAdminAccepter
      ? req.user?.name || "Admin"
      : employee.name || "Staff";
    const accepterRole = isAdminAccepter
      ? req.user?.role || "admin"
      : employee.employeeRole || req.user?.role || null;

    // Intentionally allow multiple active accepted orders per accepter.
    // First-come-first-serve lock per order remains unchanged below.

    const acceptedBy = {
      employeeId: accepterId,
      employeeName: accepterName,
      employeeRole: accepterRole,
      disability: {
        hasDisability: isAdminAccepter
          ? false
          : employee.disability?.hasDisability ?? false,
        type: isAdminAccepter ? null : employee.disability?.type || null,
      },
      acceptedAt: new Date(),
    };

    const assignmentDisplayType = resolveAssignmentDisplayType(accepterRole);

    // Atomic update: first to accept wins.
    // For takeaway flows we normalize Pending -> Confirmed when accepted.
    const setFields = { acceptedBy };
    if (order.serviceType !== "DINE_IN") {
      setFields.status = "Confirmed";
    }
    const updatedOrder = await Order.findOneAndUpdate(
      {
        _id: orderId,
        status: { $in: ACCEPTABLE_ORDER_STATUSES },
        $or: [
          { acceptedBy: { $exists: false } },
          { acceptedBy: null },
          { "acceptedBy.employeeId": { $exists: false } },
        ],
      },
      {
        $set: {
          ...setFields,
        },
      },
      { new: true },
    );

    if (!updatedOrder) {
      return res.status(409).json({
        message: "Order was already accepted by another staff member",
      });
    }

    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    let assignedStaff = null;
    if (io && updatedOrder.cartId && emitToCafe) {
      assignedStaff = mapAcceptedByToAssignedStaff(
        updatedOrder.acceptedBy,
        accepterRole,
      );

      emitToCafe(
        io,
        updatedOrder.cartId.toString(),
        "order:status:updated",
        updatedOrder,
      );
      emitToCafe(
        io,
        updatedOrder.cartId.toString(),
        "orderUpdated",
        updatedOrder,
      );
      emitToCafe(
        io,
        updatedOrder.cartId.toString(),
        "ORDER_ACCEPTED",
        {
          orderId: updatedOrder._id,
          status: updatedOrder.status,
          assignedStaff,
          assignmentDisplayType,
          order: updatedOrder,
        },
      );
    }

    const responseOrder =
      typeof updatedOrder.toObject === "function"
        ? updatedOrder.toObject()
        : updatedOrder;
    responseOrder.assignedStaff = assignedStaff;
    responseOrder.assignmentDisplayType = assignmentDisplayType;
    return res.json(responseOrder);
  } catch (err) {
    console.error("[ORDER] acceptOrder error:", err);
    return res.status(500).json({ message: err.message });
  }
};

// ---------------- UPDATE ORDER STATUS ----------------
const updateOrderStatus = async (req, res) => {
  try {
    const { status, reason } = req.body;
    if (!status) return res.status(400).json({ message: "Status required" });

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: "Order not found" });

    // Check access permissions based on admin role:
    // - Cafe admin: for DINE_IN, enforce cart ownership; for TAKEAWAY, allow flexible control
    // - Franchise admin: can only update orders from cafes under their franchise
    // - Super admin: can update all orders
    if (req.user && req.user.role === "admin" && req.user._id) {
      // Cafe admin - only enforce cartId check for dine-in orders
      if (order.serviceType !== "TAKEAWAY") {
        if (
          !order.cartId ||
          order.cartId.toString() !== req.user._id.toString()
        ) {
          return res
            .status(403)
            .json({ message: "Order does not belong to your cafe" });
        }
      }
    } else if (
      req.user &&
      req.user.role === "franchise_admin" &&
      req.user._id
    ) {
      // Franchise admin - check if order belongs to their franchise
      if (
        !order.franchiseId ||
        order.franchiseId.toString() !== req.user._id.toString()
      ) {
        return res
          .status(403)
          .json({ message: "Order does not belong to your franchise" });
      }
    } else if (
      req.user &&
      ["waiter", "cook", "captain", "manager"].includes(req.user.role)
    ) {
      const userCartId = (req.user.cartId || req.user.cafeId)?.toString();
      if (!userCartId) {
        return res
          .status(403)
          .json({ message: "No cart/kiosk assigned to your account" });
      }
      if (!order.cartId || order.cartId.toString() !== userCartId) {
        return res
          .status(403)
          .json({ message: "Order does not belong to your cart/kiosk" });
      }
    }
    // For super_admin, no restriction (they can update all orders)

    // ADMIN FLEXIBLE STATUS CHANGES: Allow admins to change status to any valid status
    // This gives admins full control over order status regardless of normal flow
    // Include both DINE_IN and TAKEAWAY statuses
    const validStatuses = [
      "Pending",
      "Confirmed",
      "Preparing",
      "Ready",
      "Served",
      "Finalized",
      "Paid",
      "Cancelled",
      "Returned",
      // TAKEAWAY statuses
      "Accept",
      "Accepted",
      "Being Prepared",
      "BeingPrepared",
      "Completed",
      "Exit",
    ];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        message: `Invalid status: ${status}`,
        validStatuses,
      });
    }

    // For non-admin users, validate status transitions based on service type
    if (
      req.user &&
      !["admin", "franchise_admin", "super_admin"].includes(req.user.role)
    ) {
      const currentStatus = order.status;
      const allowedTransitions = transitions[currentStatus] || new Set();

      // Normalize status names for comparison (handle "Being Prepared" vs "BeingPrepared")
      const normalizedStatus =
        status === "Being Prepared" ? "BeingPrepared" : status;
      const normalizedCurrent =
        currentStatus === "Being Prepared" ? "BeingPrepared" : currentStatus;

      // Check if transition is allowed
      if (
        !allowedTransitions.has(status) &&
        !allowedTransitions.has(normalizedStatus)
      ) {
        // Special handling: Allow "Accept" -> "Being Prepared" for takeaway orders starting from Pending
        if (
          order.serviceType === "TAKEAWAY" &&
          (currentStatus === "Pending" ||
            currentStatus === "Accept" ||
            currentStatus === "Accepted") &&
          (status === "Being Prepared" || status === "BeingPrepared")
        ) {
          // Allow this transition
        } else {
          return res.status(400).json({
            message: `Invalid status transition from ${currentStatus} to ${status}`,
            currentStatus,
            requestedStatus: status,
            allowedTransitions: Array.from(allowedTransitions),
          });
        }
      }
    }

    // PICKUP/DELIVERY: block order from proceeding until payment is complete.
    const isPickupOrDeliveryOrder =
      order.orderType === "PICKUP" ||
      order.orderType === "DELIVERY" ||
      order.serviceType === "PICKUP" ||
      order.serviceType === "DELIVERY";
    const isProceedingStatus = [
      "Confirmed",
      "Preparing",
      "Being Prepared",
      "BeingPrepared",
      "Ready",
      "Completed",
      "Served",
    ].includes(status);
    if (isPickupOrDeliveryOrder && isProceedingStatus) {
      const alreadyPaid =
        order.status === "Paid" || order.paymentStatus === "PAID";
      let paymentComplete = alreadyPaid;
      if (!paymentComplete) {
        const paidPayment = await Payment.findOne({
          orderId: order._id,
          status: "PAID",
        })
          .limit(1)
          .lean();
        paymentComplete = !!paidPayment;
      }
      if (!paymentComplete) {
        return res.status(400).json({
          message:
            "Payment must be marked complete before this order can proceed. Please confirm payment (online or cash) in the Payments panel first.",
          code: "PAYMENT_REQUIRED",
        });
      }
    }

    // Log the status change (admin has full control)
    console.log("Status update (admin flexible):", {
      orderId: order._id,
      serviceType: order.serviceType,
      currentStatus: order.status,
      requestedStatus: status,
      isAdmin: !!req.user,
    });

    const io = req.app.get("io");

    // Prepare update object for faster atomic update
    const updateData = { status };
    if (reason) {
      updateData.cancellationReason = reason;
    }

    // Handle status-specific updates
    if (status === "Paid") {
      updateData.paidAt = new Date();
      updateData.paymentStatus = "PAID";
    } else if (status === "Returned") {
      updateData.returnedAt = new Date();
      updateData.paidAt = null;
      updateData.paymentStatus = "REFUNDED";
      if (Array.isArray(order.kotLines)) {
        order.kotLines.forEach((kot, index) => {
          const kotLine = order.kotLines[index];
          const items = Array.isArray(kotLine.items) ? kotLine.items : [];
          kotLine.items = items.map((item) => {
            const plainItem = item?.toObject ? item.toObject() : item;
            return {
              ...plainItem,
              returned: true,
            };
          });
          kotLine.subtotal = 0;
          kotLine.gst = 0;
          kotLine.totalAmount = 0;
        });
        updateData.kotLines = order.kotLines;
      }
    }

    // CRITICAL: Inventory deduction ONLY happens when status changes to "Preparing" or "Being Prepared"
    // AND only if inventory hasn't already been deducted (inventoryDeducted flag)
    const isPreparingStatus = ["Preparing", "Being Prepared", "BeingPrepared"].includes(status);
    const needsInventoryDeduction = isPreparingStatus && !order.inventoryDeducted;

    // Fallback: If order reaches Completed, Paid, Ready, Served, or Exit without consumption, trigger now
    // Served: cart admin may mark dine-in as "Served" without going through Preparing/Ready (e.g. one-click serve)
    const isCompletionStatus = ["Completed", "Paid", "Ready", "Served", "Exit"].includes(status);
    const needsFallbackConsumption = isCompletionStatus && !order.inventoryDeducted;

    if (needsInventoryDeduction) {
      // Set the flag BEFORE consumption to prevent race conditions
      updateData.inventoryDeducted = true;
      updateData.inventoryDeductedAt = new Date();
    } else if (needsFallbackConsumption) {
      // Set flag so we consume once and avoid duplicate runs
      updateData.inventoryDeducted = true;
      updateData.inventoryDeductedAt = new Date();
    }

    // Use findByIdAndUpdate for faster atomic update (instead of find + save)
    const updatedOrder = await Order.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: false }, // Skip validators for speed
    )
      .populate("table", "number name status")
      .lean();

    if (!updatedOrder) {
      return res.status(404).json({ message: "Order not found" });
    }

    // Update local order object for socket emission
    Object.assign(order, updatedOrder);

    // INVENTORY CONSUMPTION - ONLY when changing to PREPARING status
    // This ensures:
    // 1. Real-time inventory deduction when kitchen starts
    // 2. No double deduction (flag is set above)
    // 3. Finance panel accuracy
    if (needsInventoryDeduction) {
      const userId = req.user
        ? req.user._id
        : updatedOrder.cartId &&
        (updatedOrder.cartId._id || updatedOrder.cartId);

      if (!userId) {
        console.warn(
          `[COSTING] Skipping consumption for order ${updatedOrder._id}: no req.user and no order.cartId`,
        );
      } else {
        console.log(
          `[COSTING] 🔥 Status changed to ${status} for order ${order._id} - Triggering REAL-TIME inventory deduction (User: ${userId})`,
        );

        // Run ingredient consumption in background (non-blocking)
        consumeIngredientsForOrder(updatedOrder, userId)
          .then(async (consumptionResult) => {
            if (consumptionResult.success) {
              console.log(
                `[COSTING] ✅ Successfully consumed ingredients for order ${order._id} (status: ${status})`,
              );
            } else {
              // It's normal to have "already processed" or "no items" - log as info, not error/warn
              const isBenign =
                consumptionResult.alreadyProcessed ||
                consumptionResult.message?.includes("No new items");
              if (isBenign) {
                console.log(
                  `[COSTING] ℹ️ Consumption skipped for ${order._id}: ${consumptionResult.message}`,
                );
              } else {
                console.warn(
                  `[COSTING] ❌ Failed to consume ingredients for order ${order._id}:`,
                );
                if (consumptionResult.summary?.errors) {
                  consumptionResult.summary.errors.forEach((e) => {
                    console.warn(` - ${e.item}: ${e.error}`);
                  });
                } else {
                  console.warn(
                    consumptionResult.error ||
                    consumptionResult.message ||
                    "Unknown error",
                  );
                }
                if (shouldResetInventoryDeduction(consumptionResult)) {
                  await resetInventoryDeductionFlag(updatedOrder._id);
                }
              }
            }
          })
          .catch(async (consumptionError) => {
            console.error(
              `[COSTING] ❌ Error consuming ingredients for order ${order._id}:`,
              consumptionError,
            );
            await resetInventoryDeductionFlag(updatedOrder._id);
          });
      }
      if (!userId) {
        await resetInventoryDeductionFlag(updatedOrder._id);
      }
    } else if (isPreparingStatus && order.inventoryDeducted) {
      console.log(
        `[COSTING] ℹ️ Order ${order._id} already had inventory deducted - skipping duplicate consumption`,
      );
    } else if (needsFallbackConsumption) {
      const userId = req.user
        ? req.user._id
        : updatedOrder.cartId &&
        (updatedOrder.cartId._id || updatedOrder.cartId);

      if (!userId) {
        console.warn(
          `[COSTING] Skipping fallback consumption for order ${updatedOrder._id}: no req.user and no order.cartId`,
        );
      } else {
        console.log(
          `[COSTING] 🔥 Fallback: Order ${updatedOrder._id} reached ${status} without consumption - triggering now`,
        );

        consumeIngredientsForOrder(updatedOrder, userId)
          .then(async (consumptionResult) => {
            if (consumptionResult.success) {
              console.log(
                `[COSTING] ✅ Fallback consumption success for order ${order._id}`,
              );
            } else {
              const isBenign =
                consumptionResult.alreadyProcessed ||
                consumptionResult.message?.includes("No new items");
              if (isBenign) {
                console.log(
                  `[COSTING] ℹ️ Fallback consumption skipped for ${order._id}: ${consumptionResult.message}`,
                );
              } else {
                console.warn(
                  `[COSTING] ❌ Fallback consumption failed for order ${order._id}:`,
                );
                if (consumptionResult.summary?.errors) {
                  consumptionResult.summary.errors.forEach((e) => {
                    console.warn(` - ${e.item}: ${e.error}`);
                  });
                } else {
                  console.warn(
                    consumptionResult.error ||
                    consumptionResult.message ||
                    "Unknown error",
                  );
                }
                if (shouldResetInventoryDeduction(consumptionResult)) {
                  await resetInventoryDeductionFlag(updatedOrder._id);
                }
              }
            }
          })
          .catch(async (consumptionError) => {
            console.error(
              `[COSTING] ❌ Fallback consumption error for order ${order._id}:`,
              consumptionError,
            );
            await resetInventoryDeductionFlag(updatedOrder._id);
          });
      }
      if (!userId) {
        await resetInventoryDeductionFlag(updatedOrder._id);
      }
    }

    // Handle payment updates in background (non-blocking)
    const emitToCafe = req.app.get("emitToCafe");

    // Emit socket event immediately for fast UI update
    if (order.cartId && io && emitToCafe) {
      // Emit immediately with updated order data
      emitToCafe(
        io,
        order.cartId.toString(),
        "order:status:updated",
        updatedOrder,
      );
      emitToCafe(io, order.cartId.toString(), "orderUpdated", updatedOrder); // Legacy support
    }

    // Handle payment and table release in background (non-blocking)
    Promise.all([
      // Payment handling
      (async () => {
        if (status === "Paid") {
          try {
            const { payment, created } = await ensurePaymentRecord(
              updatedOrder,
              {
                status: "PAID",
                method: "CASH",
                description: "Payment recorded via admin panel",
              },
            );
            if (payment && io) {
              const payload = formatPaymentPayload(payment);
              if (payload) {
                io.emit(created ? "paymentCreated" : "paymentUpdated", payload);
              }
            }
          } catch (err) {
            console.error("[UPDATE_STATUS] Payment error:", err);
          }
        }

        if (status === "Returned") {
          try {
            const payments = await Payment.find({ orderId: order._id });
            const updatePromises = payments.map((payment) => {
              payment.status = "CANCELLED";
              payment.cancelledAt = new Date();
              payment.cancellationReason = "Order returned";
              return payment.save().then(() => {
                if (io) {
                  const payload = formatPaymentPayload(payment);
                  if (payload) {
                    io.emit("paymentUpdated", payload);
                  }
                }
              });
            });
            await Promise.all(updatePromises);
          } catch (err) {
            console.error("[UPDATE_STATUS] Payment cancellation error:", err);
          }
        }
      })(),
      // Table release
      (async () => {
        if (["Paid", "Cancelled", "Returned", "Finalized"].includes(status)) {
          try {
            await releaseTableForOrder(updatedOrder, io, emitToCafe);
          } catch (err) {
            console.error("[UPDATE_STATUS] Table release error:", err);
          }
        }
      })(),
    ]).catch((err) => {
      console.error("[UPDATE_STATUS] Background task error:", err);
    });

    // Return immediately - don't wait for background tasks
    return res.json(updatedOrder);
  } catch (err) {
    console.error("Status update error:", err);
    return res.status(500).json({ message: err.message });
  }
};

// ---------------- CUSTOMER CANCEL/RETURN ORDER ----------------
const cancelOrderByCustomer = async (req, res) => {
  try {
    const { status, sessionToken, reason } = req.body;
    const orderId = req.params.id;

    if (!status) return res.status(400).json({ message: "Status required" });
    if (status !== "Cancelled" && status !== "Returned") {
      return res.status(400).json({
        message: "Only Cancelled or Returned status allowed for customers",
      });
    }

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ message: "Order not found" });

    // Verify sessionToken for dine-in orders
    if (order.serviceType === "DINE_IN") {
      if (!sessionToken) {
        return res.status(401).json({ message: "Not authorized, no token" });
      }

      // Check sessionToken matches order's sessionToken or table's sessionToken
      let tokenMatches = false;
      if (order.sessionToken === sessionToken) {
        tokenMatches = true;
      } else if (order.table) {
        const table = await Table.findById(order.table);
        if (table && table.sessionToken === sessionToken) {
          tokenMatches = true;
        }
      }

      if (!tokenMatches) {
        return res
          .status(403)
          .json({ message: "Not authorized, invalid token" });
      }
    } else if (order.serviceType === "TAKEAWAY") {
      // Verify sessionToken for takeaway orders when possible.
      // For Pending takeaway orders (customer backed out from payment): always allow cancel
      // so the order is removed from cart admin view without requiring sessionToken match.
      const isPendingTakeaway =
        order.status === "Pending" && order.serviceType === "TAKEAWAY";
      if (isPendingTakeaway) {
        // Allow cancel without sessionToken so "back without payment" always succeeds
        console.log(
          `[ORDER] Takeaway Pending order ${orderId} - allowing cancellation (customer left payment)`,
        );
      } else if (order.sessionToken) {
        if (!sessionToken) {
          return res.status(401).json({ message: "Not authorized, no token" });
        }
        if (order.sessionToken !== sessionToken) {
          return res
            .status(403)
            .json({ message: "Not authorized, invalid token" });
        }
      } else {
        console.log(
          `[ORDER] Takeaway order ${orderId} has no sessionToken - allowing cancellation`,
        );
      }
    }

    // Check if status transition is allowed
    const allowedStatuses =
      status === "Cancelled"
        ? [
          "Pending",
          "Confirmed",
          "Preparing",
          "Ready",
          "Served",
          "Finalized",
          "Completed",
        ]
        : ["Paid"];

    if (!allowedStatuses.includes(order.status)) {
      return res.status(400).json({
        message: `Cannot ${status.toLowerCase()} order with status ${order.status
          }`,
        currentStatus: order.status,
        allowedStatuses,
      });
    }

    const io = req.app.get("io");

    order.status = status;
    if (reason) {
      order.cancellationReason = reason;
    }

    if (status === "Returned") {
      order.returnedAt = new Date();
      order.paidAt = null;
      if (Array.isArray(order.kotLines)) {
        order.kotLines.forEach((kot, index) => {
          const kotLine = order.kotLines[index];
          const items = Array.isArray(kotLine.items) ? kotLine.items : [];
          kotLine.items = items.map((item) => {
            const plainItem = item?.toObject ? item.toObject() : item;
            return {
              ...plainItem,
              returned: true,
            };
          });
          kotLine.subtotal = 0;
          kotLine.gst = 0;
          kotLine.totalAmount = 0;
        });
      }
      order.markModified("kotLines");

      // Cancel associated payments
      const payments = await Payment.find({ orderId: order._id });
      for (const payment of payments) {
        payment.status = "CANCELLED";
        payment.cancelledAt = new Date();
        payment.cancellationReason = "Order returned";
        await payment.save();
        if (io) {
          const payload = formatPaymentPayload(payment);
          if (payload) {
            io.emit("paymentUpdated", payload);
          }
        }
      }
    }

    await order.save();

    // Release table if order is cancelled or returned
    const emitToCafe = req.app.get("emitToCafe");
    if (["Cancelled", "Returned"].includes(status)) {
      await releaseTableForOrder(order, io, emitToCafe);
    }

    // Emit socket event to cafe room (only for admin panel, not customer frontend)
    if (order.cartId && io && emitToCafe) {
      // Only emit to admin panel - customer frontend uses polling to avoid loops
      emitToCafe(io, order.cartId.toString(), "order:status:updated", order);
      emitToCafe(io, order.cartId.toString(), "orderUpdated", order); // Legacy support
    }

    return res.json(order);
  } catch (err) {
    console.error("Customer cancel/return error:", err);
    return res.status(500).json({ message: err.message });
  }
};

// ---------------- CUSTOMER CONFIRM PAYMENT ----------------
const confirmPaymentByCustomer = async (req, res) => {
  try {
    const { sessionToken, paymentMethod } = req.body;
    const orderId = req.params.id;

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ message: "Order not found" });

    // Verify sessionToken for dine-in orders
    if (order.serviceType === "DINE_IN") {
      if (!sessionToken) {
        return res.status(401).json({ message: "Not authorized, no token" });
      }

      // Check sessionToken matches order's sessionToken or table's sessionToken
      let tokenMatches = false;
      if (order.sessionToken === sessionToken) {
        tokenMatches = true;
      } else if (order.table) {
        const table = await Table.findById(order.table);
        if (table && table.sessionToken === sessionToken) {
          tokenMatches = true;
        }
      }

      if (!tokenMatches) {
        return res
          .status(403)
          .json({ message: "Not authorized, invalid token" });
      }
    }

    // Check if order can be confirmed as paid (must be Finalized or Completed)
    const allowedStatuses = ["Finalized", "Completed"];

    if (!allowedStatuses.includes(order.status)) {
      return res.status(400).json({
        message: `Cannot confirm payment for order with status ${order.status}. Order must be Finalized or Completed.`,
        currentStatus: order.status,
        allowedStatuses,
      });
    }

    // Check if already paid
    if (order.status === "Paid") {
      return res
        .status(400)
        .json({ message: "Order is already marked as paid" });
    }

    const io = req.app.get("io");

    // Update order status to Paid and set payment fields
    order.status = "Paid";
    order.paidAt = new Date();
    order.paymentStatus = "PAID";
    order.paymentMode = paymentMethod || "CASH";

    // Fallback: trigger inventory consumption if order reached Paid without going through Preparing/Completed
    const needsFallbackConsumption = !order.inventoryDeducted;
    if (needsFallbackConsumption) {
      order.inventoryDeducted = true;
      order.inventoryDeductedAt = new Date();
    }
    await order.save();

    // Run consumption when customer confirms payment (no req.user in this flow)
    if (needsFallbackConsumption) {
      const userId =
        req.user && req.user._id
          ? req.user._id
          : order.cartId && (order.cartId._id || order.cartId);
      if (userId) {
        console.log(
          `[COSTING] Fallback: Order ${order._id} paid via customer confirm - triggering consumption`,
        );
        consumeIngredientsForOrder(order, userId)
          .then(async (consumptionResult) => {
            if (consumptionResult.success) {
              console.log(
                `[COSTING] Fallback consumption success for order ${order._id}`,
              );
            } else {
              const isBenign =
                consumptionResult.alreadyProcessed ||
                consumptionResult.message?.includes("No new items");
              if (!isBenign && consumptionResult.summary?.errors) {
                consumptionResult.summary.errors.forEach((e) =>
                  console.warn(`[COSTING] ${e.item}: ${e.error}`),
                );
              }
              if (!isBenign && shouldResetInventoryDeduction(consumptionResult)) {
                await resetInventoryDeductionFlag(order._id);
              }
            }
          })
          .catch(async (err) => {
            console.error(
              `[COSTING] Fallback consumption error for order ${order._id}:`,
              err,
            );
            await resetInventoryDeductionFlag(order._id);
          });
      } else {
        console.warn(
          `[COSTING] Skipping fallback consumption for order ${order._id}: no userId (req.user or order.cartId)`,
        );
        await resetInventoryDeductionFlag(order._id);
      }
    }

    // Create or update payment record
    const { payment, created } = await ensurePaymentRecord(order, {
      status: "PAID",
      method: paymentMethod || "CASH",
      description: "Payment confirmed by customer",
    });

    if (payment && io) {
      const payload = formatPaymentPayload(payment);
      if (payload) {
        io.emit(created ? "paymentCreated" : "paymentUpdated", payload);
      }
    }

    // Emit socket event to cafe room (so cart admin sees the order when payment is confirmed)
    const emitToCafe = req.app.get("emitToCafe");

    // Release table
    await releaseTableForOrder(order, io, emitToCafe);
    if (order.cartId && emitToCafe) {
      emitToCafe(io, order.cartId.toString(), "order:created", order);
      emitToCafe(io, order.cartId.toString(), "newOrder", order);
      emitToCafe(io, order.cartId.toString(), "order:status:updated", order);
      emitToCafe(io, order.cartId.toString(), "orderUpdated", order);
    }

    console.log("Payment confirmed by customer:", order._id);
    return res.json(order);
  } catch (err) {
    console.error("Customer confirm payment error:", err);
    return res.status(500).json({ message: err.message });
  }
};

// ---------------- DELETE ORDER ----------------
// DISABLED: Orders are stored permanently and should never be deleted
// This function is kept for emergency use only but is disabled by default
const deleteOrder = async (req, res) => {
  // Orders are stored permanently - deletion is disabled
  return res.status(403).json({
    message:
      "Order deletion is disabled. Orders are stored permanently with no time limit.",
  });

  /* DISABLED CODE - Keep for reference only
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: "Order not found" });

    // Check access permissions
    if (req.user && req.user.role === "admin" && req.user._id) {
      if (!order.cartId || order.cartId.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: "Order does not belong to your cafe" });
      }
    } else if (req.user && req.user.role === "franchise_admin" && req.user._id) {
      if (!order.franchiseId || order.franchiseId.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: "Order does not belong to your franchise" });
      }
    }

    const isPaidOrder = order.status === "Paid";
    const orderAmount = getOrderBillAmount(order);

    // For paid orders, we need to handle revenue adjustment
    if (isPaidOrder) {
      // Find and update/cancel the payment record
      const payment = await Payment.findOne({ orderId: order._id });
      if (payment) {
        // Mark payment as cancelled with reason
        payment.status = "CANCELLED";
        payment.cancelledAt = new Date();
        payment.cancellationReason = "Order deleted by admin";
        await payment.save();

        // Emit payment update event
        const io = req.app.get("io");
        if (io) {
          const payload = formatPaymentPayload(payment);
          if (payload) {
            io.emit("paymentUpdated", payload);
          }
        }
      }

      // Note: Revenue calculations are dynamic and based on current paid orders
      // When a paid order is deleted, it will automatically be excluded from future revenue calculations
      // No need to manually adjust revenue history - it's calculated on-demand from existing paid orders
    }

    // Release table if it's a dine-in order
    const io = req.app.get("io");
    await releaseTableForOrder(order, io);

    // Emit socket event before deletion
    const emitToCafe = req.app.get("emitToCafe");
    if (order.cartId) {
      emitToCafe(io, order.cartId.toString(), "order:deleted", { id: req.params.id });
      emitToCafe(io, order.cartId.toString(), "orderDeleted", { id: req.params.id }); // Legacy support
    }
    
    // Delete the order
    await Order.findByIdAndDelete(req.params.id);

    return res.json({ 
      message: isPaidOrder 
        ? `Order deleted successfully. Revenue calculations will automatically exclude this order.`
        : "Order deleted successfully",
      wasPaid: isPaidOrder,
      orderAmount: isPaidOrder ? orderAmount : 0
    });
  } catch (err) {
    console.error('Delete order error:', err);
    return res.status(500).json({ message: err.message });
  }
  */
};

// ---------------- PARTIAL RETURN ITEMS ----------------
const returnItems = async (req, res) => {
  try {
    const { itemIds } = req.body; // Array of item identifiers: [{ kotIndex, itemIndex }]

    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      return res
        .status(400)
        .json({ message: "Please select at least one item to return" });
    }

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: "Order not found" });

    // Check access permissions
    if (req.user && req.user.role === "admin" && req.user._id) {
      if (
        !order.cartId ||
        order.cartId.toString() !== req.user._id.toString()
      ) {
        return res
          .status(403)
          .json({ message: "Order does not belong to your cafe" });
      }
    } else if (
      req.user &&
      req.user.role === "franchise_admin" &&
      req.user._id
    ) {
      if (
        !order.franchiseId ||
        order.franchiseId.toString() !== req.user._id.toString()
      ) {
        return res
          .status(403)
          .json({ message: "Order does not belong to your franchise" });
      }
    }

    // Check if order can be modified (admin can remove items from any status except Cancelled/Returned)
    if (["Cancelled", "Returned"].includes(order.status)) {
      return res.status(400).json({
        message: `Cannot remove items from order with status ${order.status
          }. Order is already ${order.status.toLowerCase()}.`,
      });
    }

    // Mark selected items as returned
    let totalReturnedAmount = 0;
    const kotLines = Array.isArray(order.kotLines) ? order.kotLines : [];

    itemIds.forEach(({ kotIndex, itemIndex }) => {
      if (
        kotLines[kotIndex] &&
        kotLines[kotIndex].items &&
        kotLines[kotIndex].items[itemIndex]
      ) {
        const item = kotLines[kotIndex].items[itemIndex];
        if (!item.returned) {
          item.returned = true;
          // Calculate returned amount
          const itemPrice = toRupees(item.price || 0);
          totalReturnedAmount += itemPrice * (item.quantity || 1);
        }
      }
    });

    // Recalculate KOT totals
    kotLines.forEach((kot, kotIdx) => {
      const items = Array.isArray(kot.items) ? kot.items : [];
      let subtotalP = 0;

      items.forEach((item) => {
        if (!item.returned) {
          subtotalP += (item.price || 0) * (item.quantity || 1);
        }
      });

      const gstP = 0; // No GST applied
      const totalP = subtotalP; // Total equals subtotal

      kot.subtotal = toRupees(subtotalP);
      kot.gst = 0;
      kot.totalAmount = toRupees(subtotalP);
    });

    order.kotLines = kotLines;
    order.markModified("kotLines");

    // If all items are returned, mark order as Returned
    const allItemsReturned = kotLines.every((kot) => {
      const items = Array.isArray(kot.items) ? kot.items : [];
      return items.length > 0 && items.every((item) => item.returned);
    });

    if (allItemsReturned) {
      order.status = "Returned";
      order.returnedAt = new Date();

      // Cancel associated payments
      const payments = await Payment.find({ orderId: order._id });
      for (const payment of payments) {
        payment.status = "CANCELLED";
        payment.cancelledAt = new Date();
        payment.cancellationReason = "Order returned";
        await payment.save();
      }
    }

    await order.save();

    // Emit socket event to cafe room (only for admin panel, not customer frontend)
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");

    // Release table if order is fully returned
    if (order.status === "Returned") {
      await releaseTableForOrder(order, io, emitToCafe);
    }
    if (io && order.cartId && emitToCafe) {
      // Only emit to admin panel - customer frontend uses polling to avoid loops
      emitToCafe(io, order.cartId.toString(), "order:status:updated", order);
      emitToCafe(io, order.cartId.toString(), "orderUpdated", order); // Legacy support
    }

    res.json({
      message: `${itemIds.length} item(s) returned successfully`,
      order,
      returnedAmount: totalReturnedAmount,
      allItemsReturned,
    });
  } catch (err) {
    console.error("Return items error:", err);
    return res.status(500).json({ message: err.message });
  }
};

// ---------------- CONVERT DINE-IN TO TAKEAWAY ----------------
const convertToTakeaway = async (req, res) => {
  try {
    const { itemIds } = req.body; // Optional: array of item identifiers for paid orders
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: "Order not found" });

    // Check access permissions
    if (req.user && req.user.role === "admin" && req.user._id) {
      if (
        !order.cartId ||
        order.cartId.toString() !== req.user._id.toString()
      ) {
        return res
          .status(403)
          .json({ message: "Order does not belong to your cafe" });
      }
    } else if (
      req.user &&
      req.user.role === "franchise_admin" &&
      req.user._id
    ) {
      if (
        !order.franchiseId ||
        order.franchiseId.toString() !== req.user._id.toString()
      ) {
        return res
          .status(403)
          .json({ message: "Order does not belong to your franchise" });
      }
    }

    // Only allow conversion for dine-in orders
    if (order.serviceType !== "DINE_IN") {
      return res.status(400).json({
        message: `Cannot convert order. Current service type is ${order.serviceType}. Only DINE_IN orders can be converted.`,
      });
    }

    // Check if order can be converted (not cancelled or returned)
    if (["Cancelled", "Returned"].includes(order.status)) {
      return res.status(400).json({
        message: `Cannot convert order with status ${order.status}`,
      });
    }

    // For orders with item selection (both paid and unpaid), mark items as takeaway in the same order
    if (Array.isArray(itemIds) && itemIds.length > 0) {
      // Get selected items from the order
      const kotLines = Array.isArray(order.kotLines) ? order.kotLines : [];
      const selectedItems = [];

      itemIds.forEach(({ kotIndex, itemIndex }) => {
        if (
          kotLines[kotIndex] &&
          kotLines[kotIndex].items &&
          kotLines[kotIndex].items[itemIndex]
        ) {
          const item = kotLines[kotIndex].items[itemIndex];
          if (!item.returned && !item.convertedToTakeaway) {
            // Convert price from paise to rupees (buildKot expects rupees and will convert back to paise)
            const priceInRupees = toRupees(item.price || 0);
            selectedItems.push({
              name: item.name,
              quantity: item.quantity,
              price: priceInRupees, // Pass price in rupees, buildKot will convert to paise
            });
          }
        }
      });

      if (selectedItems.length === 0) {
        return res
          .status(400)
          .json({ message: "No valid items selected for takeaway conversion" });
      }

      // Mark selected items as converted to takeaway in the original order
      // Keep them in the same order, just mark them as takeaway
      itemIds.forEach(({ kotIndex, itemIndex }) => {
        if (
          kotLines[kotIndex] &&
          kotLines[kotIndex].items &&
          kotLines[kotIndex].items[itemIndex]
        ) {
          const item = kotLines[kotIndex].items[itemIndex];
          if (!item.returned) {
            // Mark item as takeaway but keep it in calculations
            item.convertedToTakeaway = true;
          }
        }
      });

      // Recalculate KOT totals for original order (include takeaway items, exclude only returned items)
      kotLines.forEach((kot, kotIdx) => {
        const items = Array.isArray(kot.items) ? kot.items : [];
        let subtotalP = 0;

        items.forEach((item) => {
          // Include takeaway items in calculations, only exclude returned items
          if (!item.returned) {
            subtotalP += (item.price || 0) * (item.quantity || 1);
          }
        });

        const gstP = 0; // No GST applied
        const totalP = subtotalP; // Total equals subtotal

        kot.subtotal = toRupees(subtotalP);
        kot.gst = 0;
        kot.totalAmount = toRupees(subtotalP);
      });

      order.kotLines = kotLines;
      order.markModified("kotLines");

      // Update payment record for original order if it exists (for paid orders)
      if (order.status === "Paid") {
        const originalOrderAmount = getOrderBillAmount(order);
        const originalPayment = await Payment.findOne({ orderId: order._id });
        if (originalPayment) {
          originalPayment.amount = originalOrderAmount;
          await originalPayment.save();

          const io = req.app.get("io");
          if (io) {
            const payload = formatPaymentPayload(originalPayment);
            if (payload) {
              io.emit("paymentUpdated", payload);
            }
          }
        }
      }

      // Save the updated original order
      await order.save();

      // Emit socket events to cafe room
      const io = req.app.get("io");
      const emitToCafe = req.app.get("emitToCafe");
      if (io && order.cartId && emitToCafe) {
        // Only emit to admin panel - customer frontend uses polling to avoid loops
        emitToCafe(io, order.cartId.toString(), "order:status:updated", order);
        emitToCafe(io, order.cartId.toString(), "orderUpdated", order); // Legacy support
      }

      return res.json({
        message: `${selectedItems.length} item(s) marked as takeaway successfully. Items remain in the same dine-in order.`,
        order: order,
      });
    }

    // If no itemIds provided, return error (we don't convert entire order anymore)
    return res.status(400).json({
      message:
        "Please specify which items to mark as takeaway. Use itemIds array in request body.",
    });
  } catch (err) {
    console.error("Convert to takeaway error:", err);
    return res.status(500).json({ message: err.message });
  }
};

// ---------------- UPDATE PRINT STATUS ----------------
const updatePrintStatus = async (req, res) => {
  try {
    const { kotPrinted, billPrinted, lastPrintedKotIndex } = req.body;
    if (
      kotPrinted === undefined &&
      billPrinted === undefined &&
      lastPrintedKotIndex === undefined
    ) {
      return res.status(400).json({
        message:
          "At least one of kotPrinted, billPrinted, or lastPrintedKotIndex is required",
      });
    }

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: "Order not found" });

    // Access control: admin, manager, waiter, captain
    if (req.user && req.user.role === "admin" && req.user._id) {
      if (
        !order.cartId ||
        order.cartId.toString() !== req.user._id.toString()
      ) {
        return res
          .status(403)
          .json({ message: "Order does not belong to your cafe" });
      }
    } else if (
      req.user &&
      ["manager", "waiter", "captain"].includes(req.user.role)
    ) {
      if (!req.user.cafeId && !req.user.cartId) {
        return res
          .status(403)
          .json({ message: "No cart/kiosk assigned to your account" });
      }
      const userCartId = (req.user.cartId || req.user.cafeId).toString();
      if (!order.cartId || order.cartId.toString() !== userCartId) {
        return res
          .status(403)
          .json({ message: "Order does not belong to your cart/kiosk" });
      }
    }

    const update = {};
    if (kotPrinted === true) update["printStatus.kotPrinted"] = true;
    if (billPrinted === true) update["printStatus.billPrinted"] = true;
    if (typeof lastPrintedKotIndex === "number" && lastPrintedKotIndex >= 0) {
      update["printStatus.lastPrintedKotIndex"] = lastPrintedKotIndex;
    }

    if (Object.keys(update).length === 0) {
      return res.json(order);
    }

    // Atomic guards:
    // - billPrinted should only flip once
    // - kotPrinted should only flip once when no index progression is provided
    // - lastPrintedKotIndex can only move forward (prevents duplicate same-KOT updates)
    const filter = { _id: req.params.id };
    if (billPrinted === true) filter["printStatus.billPrinted"] = { $ne: true };
    const hasLastPrintedKotIndex =
      typeof lastPrintedKotIndex === "number" && lastPrintedKotIndex >= 0;
    if (kotPrinted === true && !hasLastPrintedKotIndex) {
      filter["printStatus.kotPrinted"] = { $ne: true };
    }
    if (hasLastPrintedKotIndex) {
      filter.$or = [
        { "printStatus.lastPrintedKotIndex": { $lt: lastPrintedKotIndex } },
        { "printStatus.lastPrintedKotIndex": { $exists: false } },
      ];
    }

    const updated = await Order.findOneAndUpdate(
      filter,
      { $set: update },
      { new: true },
    )
      .populate("table")
      .lean();

    return res.json(updated ?? order);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ---------------- GET KOT PRINT TEMPLATE (BACKEND SINGLE SOURCE) ----------------
const getKotPrintTemplate = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
      .populate("table", "number name")
      .lean();
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    const accessError = resolvePrintAccessError(req.user, order);
    if (accessError) {
      return res.status(403).json({ message: accessError });
    }

    const kotLines = Array.isArray(order.kotLines) ? order.kotLines : [];
    if (!kotLines.length) {
      return res.status(400).json({ message: "Order has no KOT lines" });
    }

    const requestedKotIndex = toNonNegativeInt(req.query?.kotIndex);
    const kotIndex =
      requestedKotIndex != null ? requestedKotIndex : kotLines.length - 1;
    if (kotIndex < 0 || kotIndex >= kotLines.length) {
      return res.status(400).json({ message: "Invalid kotIndex" });
    }

    const paperWidthRaw = String(
      req.query?.paperWidth || req.query?.paper || "58mm",
    )
      .trim()
      .toLowerCase();
    const paperWidth = paperWidthRaw.includes("80") ? "80mm" : "58mm";

    const kot = kotLines[kotIndex] || {};
    const template = await buildKotPrintTemplate({
      order,
      kot,
      kotIndex,
      paperWidth,
    });

    const printerId = normalizePrinterId(req.query?.printerId || "kitchen-primary");
    const printKey = buildAutoPrintKey({
      order,
      docType: "KOT",
      printerId,
      kotIndex,
      kotNumber: template.kotNumber,
      orderVersion:
        order?.updatedAt instanceof Date
          ? order.updatedAt.toISOString()
          : String(order?.updatedAt || ""),
    });

    return res.json({
      success: true,
      data: {
        ...template,
        orderId: String(order._id),
        printKey,
      },
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ---------------- CLAIM AUTO-PRINT JOB (IDEMPOTENT) ----------------
const claimPrintJob = async (req, res) => {
  try {
    const {
      docType,
      printerId,
      kotIndex,
      kotNumber,
      orderVersion,
      printKey,
      metadata,
    } = req.body || {};

    const normalizedDocType = normalizeDocType(docType);
    if (!normalizedDocType) {
      return res.status(400).json({ message: "docType must be KOT or BILL" });
    }

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: "Order not found" });

    const accessError = resolvePrintAccessError(req.user, order);
    if (accessError) {
      return res.status(403).json({ message: accessError });
    }

    const normalizedPrinterId = normalizePrinterId(printerId);
    const resolvedPrintKey =
      String(printKey || "").trim() ||
      buildAutoPrintKey({
        order,
        docType: normalizedDocType,
        printerId: normalizedPrinterId,
        kotIndex,
        kotNumber,
        orderVersion,
      });

    const safeMetadata = metadata && typeof metadata === "object" ? metadata : null;

    try {
      const job = await PrintJob.create({
        printKey: resolvedPrintKey,
        orderId: order._id,
        cartId: order.cartId || null,
        docType: normalizedDocType,
        printerId: normalizedPrinterId,
        orderVersion: String(orderVersion || "").trim(),
        status: "PENDING",
        metadata: safeMetadata,
      });

      return res.json({
        claimed: true,
        printKey: resolvedPrintKey,
        jobId: job._id,
      });
    } catch (createError) {
      if (
        createError?.code === 11000 &&
        (createError?.keyPattern?.printKey || createError?.keyValue?.printKey)
      ) {
        return res.json({
          claimed: false,
          printKey: resolvedPrintKey,
          reason: "already-claimed",
        });
      }
      throw createError;
    }
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ---------------- COMPLETE AUTO-PRINT JOB ----------------
const completePrintJob = async (req, res) => {
  try {
    const { printKey, docType, success = true, errorMessage } = req.body || {};
    const resolvedPrintKey = String(printKey || "").trim();
    if (!resolvedPrintKey) {
      return res.status(400).json({ message: "printKey is required" });
    }

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: "Order not found" });

    const accessError = resolvePrintAccessError(req.user, order);
    if (accessError) {
      return res.status(403).json({ message: accessError });
    }

    const normalizedDocType = normalizeDocType(docType);
    const filter = {
      orderId: order._id,
      printKey: resolvedPrintKey,
      ...(normalizedDocType ? { docType: normalizedDocType } : {}),
    };

    const status = success ? "SUCCESS" : "FAILED";
    const update = {
      status,
      completedAt: new Date(),
      errorMessage: success ? "" : String(errorMessage || "").trim(),
    };

    const job = await PrintJob.findOneAndUpdate(filter, { $set: update }, { new: true });
    if (!job) {
      return res.status(404).json({ message: "Print job not found" });
    }

    return res.json({
      success: true,
      printKey: job.printKey,
      status: job.status,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = {
  createOrder,
  getNextTakeawayToken,
  addKot,
  addItemsToOrder,
  updateOrderAddons,
  finalizeOrder,
  getOrders,
  getOrderById,
  getKotPrintTemplate,
  updateOrderStatus,
  acceptOrder,
  cancelOrderByCustomer,
  confirmPaymentByCustomer,
  deleteOrder,
  releaseTableForOrder,
  returnItems,
  convertToTakeaway,
  updatePrintStatus,
  claimPrintJob,
  completePrintJob,
};
