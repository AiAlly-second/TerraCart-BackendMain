const PrinterConfig = require("../models/printerConfigModel");

const DEFAULT_BUSINESS_NAME = "TERRA CART";

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
    const defaultPayload = {
      printerIp: "",
      printerPort: 9100,
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
      printerIp: config.printerIp,
      printerPort: config.printerPort ?? 9100,
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
 *   printerIp: string,
 *   printerPort?: number,
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
      businessName,
      kotHeaderText,
      billHeaderText,
      centerAlign,
      printAuthority: bodyPrintAuthority,
    } = req.body;
    if (!printerIp || typeof printerIp !== "string" || printerIp.trim() === "") {
      return res.status(400).json({ message: "printerIp is required" });
    }

    const cartId = resolveCartId(req.user);
    if (!cartId) {
      return res.status(403).json({
        message: "No cart/kiosk assigned to your account",
      });
    }

    const port = printerPort != null ? Number(printerPort) : 9100;
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      return res.status(400).json({ message: "printerPort must be between 1 and 65535" });
    }

    const authority =
      bodyPrintAuthority === "APP" || bodyPrintAuthority === "AGENT"
        ? bodyPrintAuthority
        : undefined;
    const update = {
      printerIp: printerIp.trim(),
      printerPort: port,
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
    return res.json({
      printerIp: config.printerIp,
      printerPort: config.printerPort ?? 9100,
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
