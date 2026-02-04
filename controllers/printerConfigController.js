const PrinterConfig = require("../models/printerConfigModel");

/**
 * GET /printer-config
 * Get printer config for current user's cart (manager only).
 * cartId comes from employee record (req.user.cartId or req.user.cafeId).
 */
const getPrinterConfig = async (req, res) => {
  try {
    const cartId = req.user.cartId || req.user.cafeId;
    if (!cartId) {
      return res.status(403).json({
        message: "No cart/kiosk assigned to your account",
      });
    }

    const config = await PrinterConfig.findOne({ cartId }).lean();
    if (!config) {
      return res.json({ printerIp: "", printerPort: 9100 });
    }

    return res.json({
      printerIp: config.printerIp,
      printerPort: config.printerPort ?? 9100,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

/**
 * PUT /printer-config
 * Set printer config for current user's cart (manager only).
 * Body: { printerIp: string, printerPort?: number }
 */
const savePrinterConfig = async (req, res) => {
  try {
    const { printerIp, printerPort } = req.body;
    if (!printerIp || typeof printerIp !== "string" || printerIp.trim() === "") {
      return res.status(400).json({ message: "printerIp is required" });
    }

    const cartId = req.user.cartId || req.user.cafeId;
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
        updatedAt: new Date(),
      },
      { new: true, upsert: true }
    ).lean();

    return res.json({
      printerIp: config.printerIp,
      printerPort: config.printerPort ?? 9100,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = {
  getPrinterConfig,
  savePrinterConfig,
};
