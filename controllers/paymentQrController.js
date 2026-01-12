const PaymentQR = require("../models/paymentQrModel");
const { getStorageCallback, getFileUrl } = require("../config/uploadConfig");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const fileFilter = (req, file, cb) => {
  // Accept only image files
  if (file.mimetype.startsWith("image/")) {
    cb(null, true);
  } else {
    cb(new Error("Only image files are allowed"), false);
  }
};

const upload = multer({
  storage: getStorageCallback("payment-qr"),
  fileFilter: fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
});

// Middleware for single file upload
exports.uploadQR = upload.single("qrImage");

/**
 * Upload or update payment QR code
 */
exports.uploadPaymentQR = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "QR code image is required" });
    }

    const { upiId, gatewayName } = req.body;
    const userId = req.user?._id;
    const cafeId = req.user?.franchiseId || req.user?._id;

    // Construct image URL
    // Use helper to get URL (handles S3 vs Local)
    const qrImageUrl = getFileUrl(req, req.file, "payment-qr");

    // Deactivate existing active QR codes for this cafe/user
    await PaymentQR.updateMany(
      {
        $or: [{ userId }, { cafeId }],
        isActive: true,
      },
      { isActive: false }
    );

    // Create new QR code entry
    const paymentQR = await PaymentQR.create({
      userId,
      cafeId,
      qrImageUrl,
      upiId,
      gatewayName,
      isActive: true,
    });

    return res.status(201).json({
      message: "QR code uploaded successfully",
      qrCode: {
        id: paymentQR._id,
        qrImageUrl: paymentQR.qrImageUrl,
        upiId: paymentQR.upiId,
        gatewayName: paymentQR.gatewayName,
        isActive: paymentQR.isActive,
        createdAt: paymentQR.createdAt,
      },
    });
  } catch (err) {
    console.error("Error uploading QR code:", err);
    // Delete uploaded file if database save fails
    if (req.file) {
      fs.unlinkSync(req.file.path);
    }
    return res.status(500).json({ message: err.message || "Failed to upload QR code" });
  }
};

/**
 * Get active payment QR code
 */
exports.getActivePaymentQR = async (req, res) => {
  try {
    const userId = req.user?._id;
    const cafeId = req.user?.franchiseId || req.user?._id;

    // Try to find cafe-specific QR first, then user-specific, then global
    let qrCode = await PaymentQR.findOne({
      $or: [{ cafeId }, { userId }],
      isActive: true,
    }).sort({ createdAt: -1 });

    // If no specific QR found, get any active global QR
    if (!qrCode) {
      qrCode = await PaymentQR.findOne({ isActive: true }).sort({ createdAt: -1 });
    }

    if (!qrCode) {
      return res.status(404).json({ message: "No active QR code found" });
    }

    return res.json({
      id: qrCode._id,
      qrImageUrl: qrCode.qrImageUrl,
      upiId: qrCode.upiId,
      gatewayName: qrCode.gatewayName,
      isActive: qrCode.isActive,
      createdAt: qrCode.createdAt,
    });
  } catch (err) {
    console.error("Error fetching QR code:", err);
    return res.status(500).json({ message: err.message || "Failed to fetch QR code" });
  }
};

/**
 * Get active payment QR code (public - no auth required)
 */
exports.getActivePaymentQRPublic = async (req, res) => {
  try {
    // Get any active QR code (most recent)
    const qrCode = await PaymentQR.findOne({ isActive: true }).sort({ createdAt: -1 });

    if (!qrCode) {
      // Return 200 with null instead of 404 - no active QR code is a valid state
      return res.json(null);
    }

    return res.json({
      id: qrCode._id,
      qrImageUrl: qrCode.qrImageUrl,
      upiId: qrCode.upiId,
      gatewayName: qrCode.gatewayName,
    });
  } catch (err) {
    console.error("Error fetching QR code:", err);
    return res.status(500).json({ message: err.message || "Failed to fetch QR code" });
  }
};

/**
 * List all QR codes (admin only)
 */
exports.listPaymentQRs = async (req, res) => {
  try {
    const userId = req.user?._id;
    const cafeId = req.user?.franchiseId || req.user?._id;

    const qrCodes = await PaymentQR.find({
      $or: [{ userId }, { cafeId }],
    })
      .sort({ createdAt: -1 })
      .lean();

    return res.json(
      qrCodes.map((qr) => ({
        id: qr._id,
        qrImageUrl: qr.qrImageUrl,
        upiId: qr.upiId,
        gatewayName: qr.gatewayName,
        isActive: qr.isActive,
        createdAt: qr.createdAt,
      }))
    );
  } catch (err) {
    console.error("Error listing QR codes:", err);
    return res.status(500).json({ message: err.message || "Failed to list QR codes" });
  }
};

/**
 * Delete QR code
 */
exports.deletePaymentQR = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?._id;
    const cafeId = req.user?.franchiseId || req.user?._id;

    const qrCode = await PaymentQR.findOne({
      _id: id,
      $or: [{ userId }, { cafeId }],
    });

    if (!qrCode) {
      return res.status(404).json({ message: "QR code not found" });
    }

    // Delete file from filesystem
    const filePath = path.join(__dirname, "../", qrCode.qrImageUrl);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    // Delete from database
    await PaymentQR.findByIdAndDelete(id);

    return res.json({ message: "QR code deleted successfully" });
  } catch (err) {
    console.error("Error deleting QR code:", err);
    return res.status(500).json({ message: err.message || "Failed to delete QR code" });
  }
};

