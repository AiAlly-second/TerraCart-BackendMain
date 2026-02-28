const PaymentQR = require("../models/paymentQrModel");
const Order = require("../models/orderModel");
const { getStorageCallback, getFileUrl } = require("../config/uploadConfig");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const http = require("http");
const https = require("https");
const mongoose = require("mongoose");
const { Jimp } = require("jimp");
const jsQR = require("jsqr");

const toObjectIdIfValid = (value) => {
  if (!value) return value;
  return mongoose.Types.ObjectId.isValid(value)
    ? new mongoose.Types.ObjectId(value)
    : value;
};

const parseUpiPayload = (payload) => {
  if (!payload || typeof payload !== "string") return null;
  const trimmed = payload.trim();
  if (!/^upi:\/\/pay\?/i.test(trimmed)) return null;

  const query = trimmed.split("?")[1] || "";
  if (!query) return null;

  const params = new URLSearchParams(query);
  const normalized = {};
  for (const [key, value] of params.entries()) {
    const lowered = String(key || "").toLowerCase();
    if (!lowered) continue;

    let decoded = value;
    try {
      decoded = decodeURIComponent(String(value || "").replace(/\+/g, "%20"));
    } catch (_err) {
      decoded = String(value || "");
    }
    normalized[lowered] = decoded.trim();
  }

  const upiId = normalized.pa || "";
  const payeeName = normalized.pn || "";

  if (!upiId) return null;

  return {
    upiId,
    payeeName,
    rawPayload: trimmed,
  };
};

const downloadBufferFromUrl = (url, depth = 0) =>
  new Promise((resolve) => {
    if (!url || !/^https?:\/\//i.test(url) || depth > 3) {
      resolve(null);
      return;
    }

    const transport = url.startsWith("https://") ? https : http;
    const request = transport.get(url, (response) => {
      const { statusCode = 0, headers = {} } = response;
      const redirectLocation = headers.location;
      if (
        statusCode >= 300 &&
        statusCode < 400 &&
        redirectLocation
      ) {
        response.resume();
        const redirectedUrl = new URL(redirectLocation, url).toString();
        resolve(downloadBufferFromUrl(redirectedUrl, depth + 1));
        return;
      }

      if (statusCode !== 200) {
        response.resume();
        resolve(null);
        return;
      }

      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve(Buffer.concat(chunks)));
    });

    request.on("error", () => resolve(null));
    request.setTimeout(10000, () => {
      request.destroy();
      resolve(null);
    });
  });

const resolveQrImagePath = (rawPath) => {
  if (!rawPath || typeof rawPath !== "string") return null;
  if (path.isAbsolute(rawPath)) return rawPath;
  return path.join(__dirname, "..", rawPath.replace(/^\/+/, ""));
};

const readUploadedQrBuffer = async (source) => {
  if (!source) return null;

  if (Buffer.isBuffer(source)) {
    return source;
  }

  if (typeof source === "string") {
    if (/^https?:\/\//i.test(source)) {
      return downloadBufferFromUrl(source);
    }
    const absolutePath = resolveQrImagePath(source);
    if (!absolutePath || !fs.existsSync(absolutePath)) return null;
    return fs.promises.readFile(absolutePath);
  }

  if (source.buffer && Buffer.isBuffer(source.buffer)) {
    return source.buffer;
  }

  if (source.path && fs.existsSync(source.path)) {
    return fs.promises.readFile(source.path);
  }

  if (source.location && /^https?:\/\//i.test(source.location)) {
    return downloadBufferFromUrl(source.location);
  }

  if (source.qrImageUrl) {
    return readUploadedQrBuffer(source.qrImageUrl);
  }

  return null;
};

const decodeUpiFromQrImage = async (file) => {
  try {
    const imageBuffer = await readUploadedQrBuffer(file);
    if (!imageBuffer) return null;

    const image = await Jimp.read(imageBuffer);
    const { data, width, height } = image.bitmap || {};
    if (!data || !width || !height) return null;

    const pixels = new Uint8ClampedArray(
      data.buffer,
      data.byteOffset,
      data.byteLength,
    );

    const decoded = jsQR(pixels, width, height, {
      inversionAttempts: "attemptBoth",
    });

    if (!decoded?.data) return null;

    return parseUpiPayload(decoded.data);
  } catch (error) {
    console.warn("[PAYMENT_QR] Failed to decode uploaded QR image:", error.message);
    return null;
  }
};

const persistDecodedQrIdentity = async (qrCode) => {
  if (!qrCode || (qrCode.upiId && qrCode.gatewayName) || !qrCode.qrImageUrl) {
    return qrCode;
  }

  const extractedUpi = await decodeUpiFromQrImage(qrCode.qrImageUrl);
  if (!extractedUpi) return qrCode;

  let changed = false;
  if (!qrCode.upiId && extractedUpi.upiId) {
    qrCode.upiId = extractedUpi.upiId;
    changed = true;
  }
  if (!qrCode.gatewayName && extractedUpi.payeeName) {
    qrCode.gatewayName = extractedUpi.payeeName;
    changed = true;
  }

  if (changed && typeof qrCode.save === "function") {
    try {
      await qrCode.save();
    } catch (saveError) {
      console.warn(
        "[PAYMENT_QR] Failed to persist decoded identity details:",
        saveError.message,
      );
    }
  }
  return qrCode;
};

const buildScopeOrFilter = (scopeId) => {
  if (!scopeId) return [];

  const variants = [];
  const normalizedScopeId = toObjectIdIfValid(scopeId);
  variants.push(normalizedScopeId);

  const scopeAsString = String(scopeId);
  if (!variants.some((v) => String(v) === scopeAsString)) {
    variants.push(scopeAsString);
  }

  const fields = ["userId", "cartId", "cafeId"];
  const filters = [];
  for (const field of fields) {
    for (const variant of variants) {
      filters.push({ [field]: variant });
    }
  }
  return filters;
};

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
    const providedUpiId = typeof upiId === "string" ? upiId.trim() : "";
    const providedGatewayName =
      typeof gatewayName === "string" ? gatewayName.trim() : "";
    const userId = req.user?._id ? toObjectIdIfValid(req.user._id) : null;
    const requestedCartId = req.body?.cartId || req.query?.cartId || null;
    const role = req.user?.role;
    // Cart admin uploads are always scoped to their own cart.
    // Non-admin roles can still pass cartId explicitly when needed.
    const rawScopeCartId =
      role === "admin" ? req.user?._id : requestedCartId || req.user?._id;
    const scopeCartId = toObjectIdIfValid(rawScopeCartId);

    // Construct image URL
    // Use helper to get URL (handles S3 vs Local)
    const qrImageUrl = getFileUrl(req, req.file, "payment-qr");

    // If admin did not enter UPI details manually, try extracting from QR image.
    const extractedUpi = await decodeUpiFromQrImage(req.file);
    const finalUpiId = providedUpiId || extractedUpi?.upiId || "";
    const finalGatewayName =
      providedGatewayName || extractedUpi?.payeeName || "";

    // Deactivate existing active QR codes for this scope/user
    const scopeOrFilter = buildScopeOrFilter(scopeCartId);
    const deactivateFilter = scopeOrFilter.length
      ? { isActive: true, $or: scopeOrFilter }
      : userId
        ? { isActive: true, userId }
        : { _id: null };
    await PaymentQR.updateMany(deactivateFilter, { isActive: false });

    // Create new QR code entry
    const paymentQR = await PaymentQR.create({
      userId,
      cartId: scopeCartId,
      qrImageUrl,
      upiId: finalUpiId || undefined,
      gatewayName: finalGatewayName || undefined,
      isActive: true,
    });

    return res.status(201).json({
      message: "QR code uploaded successfully",
      qrCode: {
        id: paymentQR._id,
        qrImageUrl: paymentQR.qrImageUrl,
        upiId: paymentQR.upiId,
        gatewayName: paymentQR.gatewayName,
        extractedFromQr: Boolean(extractedUpi),
        isActive: paymentQR.isActive,
        createdAt: paymentQR.createdAt,
      },
    });
  } catch (err) {
    console.error("Error uploading QR code:", err);
    // Delete uploaded file if database save fails
    if (req.file?.path && fs.existsSync(req.file.path)) {
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
    const scopeCartId = toObjectIdIfValid(req.query?.cartId || req.user?._id);

    const scopeOrFilter = buildScopeOrFilter(scopeCartId);
    if (!scopeOrFilter.length) {
      // No scoped cart is a valid state for this request context.
      // Keep response shape consistent with public endpoint.
      return res.json(null);
    }
    const query = { isActive: true, $or: scopeOrFilter };

    let qrCode = await PaymentQR.findOne(query).sort({ createdAt: -1 });

    if (!qrCode) {
      // No active QR is a valid state (before first upload / after deletion).
      return res.json(null);
    }
    qrCode = await persistDecodedQrIdentity(qrCode);

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
    let scopeCartId = req.query?.cartId || null;
    const orderId = req.query?.orderId || null;

    // If orderId is present, trust order.cartId as source of truth.
    if (orderId) {
      const order = await Order.findById(orderId).select("cartId cafeId").lean();
      if (order?.cartId || order?.cafeId) {
        scopeCartId = order.cartId || order.cafeId || null;
      }
    }

    const scopeOrFilter = buildScopeOrFilter(scopeCartId);
    if (!scopeOrFilter.length) {
      return res.json(null);
    }
    const scopedQuery = { isActive: true, $or: scopeOrFilter };

    let qrCode = await PaymentQR.findOne(scopedQuery).sort({ createdAt: -1 });

    if (!qrCode) {
      // Return 200 with null instead of 404 - no active QR code is a valid state
      return res.json(null);
    }
    qrCode = await persistDecodedQrIdentity(qrCode);

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
    const scopeCartId = toObjectIdIfValid(req.query?.cartId || req.user?._id);
    const scopeOrFilter = buildScopeOrFilter(scopeCartId);
    if (!scopeOrFilter.length) {
      return res.json([]);
    }

    const qrCodes = await PaymentQR.find({
      $or: scopeOrFilter,
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
    const scopeCartId = toObjectIdIfValid(req.query?.cartId || req.user?._id);
    const scopeOrFilter = buildScopeOrFilter(scopeCartId);
    if (!scopeOrFilter.length) {
      return res.status(404).json({ message: "QR code not found" });
    }

    const qrCode = await PaymentQR.findOne({
      _id: id,
      $or: scopeOrFilter,
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

