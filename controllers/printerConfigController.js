const PrinterConfig = require("../models/printerConfigModel");

const DEFAULT_BUSINESS_NAME = "TERRA CART";
const DEFAULT_PRINTER_PORT = 9100;

const resolveCartId = (user = {}) => {
  if (user.cartId) return user.cartId;
  if (user.cafeId) return user.cafeId;
  // Cart admin accounts use their own _id as cart id.
  if (user.role === "admin" && user._id) return user._id;
  return null;
};

const normalizeText = (value, fallback = "") => {
  if (typeof value !== "string") return fallback;
  return value.trim();
};

const normalizeBool = (value, fallback = true) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true") return true;
    if (v === "false") return false;
  }
  return fallback;
};

const normalizeIp = (value) => {
  if (typeof value !== "string") return "";
  return value.trim();
};

const isValidPort = (value) =>
  Number.isFinite(value) && value >= 1 && value <= 65535;

const parsePort = (value, fallback = DEFAULT_PRINTER_PORT) => {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  return parsed;
};

const resolvePrinterEndpoints = (config = {}) => {
  const legacyIp = normalizeIp(config.printerIp);
  const legacyPort = isValidPort(Number(config.printerPort))
    ? Number(config.printerPort)
    : DEFAULT_PRINTER_PORT;

  const kotPrinterIp = normalizeIp(config.kotPrinterIp) || legacyIp;
  const kotPrinterPort = isValidPort(Number(config.kotPrinterPort))
    ? Number(config.kotPrinterPort)
    : legacyPort;

  const billPrinterIp =
    normalizeIp(config.billPrinterIp) || legacyIp || kotPrinterIp;
  const billPrinterPort = isValidPort(Number(config.billPrinterPort))
    ? Number(config.billPrinterPort)
    : legacyPort;

  return {
    printerIp: legacyIp || kotPrinterIp || billPrinterIp || "",
    printerPort: legacyPort,
    kotPrinterIp: kotPrinterIp || "",
    kotPrinterPort,
    billPrinterIp: billPrinterIp || "",
    billPrinterPort,
  };
};

/**
 * GET /printer-config
 * Get printer config for current user's cart (staff/admin).
 * cartId comes from employee record or cart-admin account.
 */
const getPrinterConfig = async (req, res) => {
  try {
    const cartId = resolveCartId(req.user);
    if (!cartId) {
      return res.status(403).json({
        message: "No cart/kiosk assigned to your account",
      });
    }

    const config = await PrinterConfig.findOne({ cartId }).lean();
    const envAuthority = (process.env.PRINT_AUTHORITY || "").trim().toUpperCase();
    const endpoints = resolvePrinterEndpoints(config || {});
    const defaultPayload = {
      printerIp: "",
      printerPort: DEFAULT_PRINTER_PORT,
      kotPrinterIp: "",
      kotPrinterPort: DEFAULT_PRINTER_PORT,
      billPrinterIp: "",
      billPrinterPort: DEFAULT_PRINTER_PORT,
      businessName: DEFAULT_BUSINESS_NAME,
      kotHeaderText: "",
      billHeaderText: "",
      centerAlign: true,
      printAuthority: envAuthority === "AGENT" ? "AGENT" : "APP",
    };
    if (!config) {
      return res.json(defaultPayload);
    }

    const printAuthority =
      envAuthority === "APP" || envAuthority === "AGENT"
        ? envAuthority
        : (config.printAuthority || "APP");
    return res.json({
      printerIp: endpoints.printerIp,
      printerPort: endpoints.printerPort,
      kotPrinterIp: endpoints.kotPrinterIp,
      kotPrinterPort: endpoints.kotPrinterPort,
      billPrinterIp: endpoints.billPrinterIp,
      billPrinterPort: endpoints.billPrinterPort,
      businessName: config.businessName || DEFAULT_BUSINESS_NAME,
      kotHeaderText: config.kotHeaderText || "",
      billHeaderText: config.billHeaderText || "",
      centerAlign: config.centerAlign !== false,
      printAuthority,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

/**
 * PUT /printer-config
 * Set printer config for current user's cart (manager/admin).
 * Body: {
 *   printerIp?: string, // legacy fallback for both printers
 *   printerPort?: number,
 *   kotPrinterIp?: string,
 *   kotPrinterPort?: number,
 *   billPrinterIp?: string,
 *   billPrinterPort?: number,
 *   businessName?: string,
 *   kotHeaderText?: string,
 *   billHeaderText?: string,
 *   centerAlign?: boolean
 * }
 */
const savePrinterConfig = async (req, res) => {
  try {
    const {
      printerIp,
      printerPort,
      kotPrinterIp,
      kotPrinterPort,
      billPrinterIp,
      billPrinterPort,
      businessName,
      kotHeaderText,
      billHeaderText,
      centerAlign,
      printAuthority: bodyPrintAuthority,
    } = req.body;

    const rawLegacyIp = normalizeIp(printerIp);
    const rawKotIp = normalizeIp(kotPrinterIp);
    const rawBillIp = normalizeIp(billPrinterIp);
    if (!rawLegacyIp && !rawKotIp && !rawBillIp) {
      return res.status(400).json({
        message:
          "At least one printer IP is required (printerIp or kotPrinterIp or billPrinterIp)",
      });
    }

    const cartId = resolveCartId(req.user);
    if (!cartId) {
      return res.status(403).json({
        message: "No cart/kiosk assigned to your account",
      });
    }

    const resolvedLegacyIp = rawLegacyIp || rawKotIp || rawBillIp;
    const resolvedKotIp = rawKotIp || rawLegacyIp;
    const resolvedBillIp = rawBillIp || rawLegacyIp || rawKotIp;

    const port = parsePort(printerPort, DEFAULT_PRINTER_PORT);
    if (!isValidPort(port)) {
      return res.status(400).json({ message: "printerPort must be between 1 and 65535" });
    }
    const resolvedKotPort = parsePort(kotPrinterPort, port);
    if (!isValidPort(resolvedKotPort)) {
      return res
        .status(400)
        .json({ message: "kotPrinterPort must be between 1 and 65535" });
    }
    const resolvedBillPort = parsePort(billPrinterPort, port);
    if (!isValidPort(resolvedBillPort)) {
      return res
        .status(400)
        .json({ message: "billPrinterPort must be between 1 and 65535" });
    }

    const authority =
      bodyPrintAuthority === "APP" || bodyPrintAuthority === "AGENT"
        ? bodyPrintAuthority
        : undefined;
    const update = {
      printerIp: resolvedLegacyIp,
      printerPort: port,
      kotPrinterIp: resolvedKotIp,
      kotPrinterPort: resolvedKotPort,
      billPrinterIp: resolvedBillIp,
      billPrinterPort: resolvedBillPort,
      businessName: normalizeText(businessName, DEFAULT_BUSINESS_NAME),
      kotHeaderText: normalizeText(kotHeaderText),
      billHeaderText: normalizeText(billHeaderText),
      centerAlign: normalizeBool(centerAlign, true),
      updatedAt: new Date(),
    };
    if (authority) update.printAuthority = authority;

    const config = await PrinterConfig.findOneAndUpdate(
      { cartId },
      update,
      { new: true, upsert: true }
    ).lean();

    const envAuthority = (process.env.PRINT_AUTHORITY || "").trim().toUpperCase();
    const printAuthority =
      envAuthority === "APP" || envAuthority === "AGENT"
        ? envAuthority
        : (config.printAuthority || "APP");
    const endpoints = resolvePrinterEndpoints(config || {});
    return res.json({
      printerIp: endpoints.printerIp,
      printerPort: endpoints.printerPort,
      kotPrinterIp: endpoints.kotPrinterIp,
      kotPrinterPort: endpoints.kotPrinterPort,
      billPrinterIp: endpoints.billPrinterIp,
      billPrinterPort: endpoints.billPrinterPort,
      businessName: config.businessName || DEFAULT_BUSINESS_NAME,
      kotHeaderText: config.kotHeaderText || "",
      billHeaderText: config.billHeaderText || "",
      centerAlign: config.centerAlign !== false,
      printAuthority,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = {
  getPrinterConfig,
  savePrinterConfig,
};
