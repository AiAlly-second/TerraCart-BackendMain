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
    if (!config) {
      return res.json({
        printerIp: "",
        printerPort: 9100,
        businessName: DEFAULT_BUSINESS_NAME,
        kotHeaderText: "",
        billHeaderText: "",
        centerAlign: true,
      });
    }

    return res.json({
      printerIp: config.printerIp,
      printerPort: config.printerPort ?? 9100,
      businessName: config.businessName || DEFAULT_BUSINESS_NAME,
      kotHeaderText: config.kotHeaderText || "",
      billHeaderText: config.billHeaderText || "",
      centerAlign: config.centerAlign !== false,
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

    const config = await PrinterConfig.findOneAndUpdate(
      { cartId },
      {
        printerIp: printerIp.trim(),
        printerPort: port,
        businessName: normalizeText(businessName, DEFAULT_BUSINESS_NAME),
        kotHeaderText: normalizeText(kotHeaderText),
        billHeaderText: normalizeText(billHeaderText),
        centerAlign: normalizeBool(centerAlign, true),
        updatedAt: new Date(),
      },
      { new: true, upsert: true }
    ).lean();

    return res.json({
      printerIp: config.printerIp,
      printerPort: config.printerPort ?? 9100,
      businessName: config.businessName || DEFAULT_BUSINESS_NAME,
      kotHeaderText: config.kotHeaderText || "",
      billHeaderText: config.billHeaderText || "",
      centerAlign: config.centerAlign !== false,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = {
  getPrinterConfig,
  savePrinterConfig,
};
