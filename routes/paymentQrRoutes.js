const express = require("express");
const {
  uploadPaymentQR,
  getActivePaymentQR,
  getActivePaymentQRPublic,
  listPaymentQRs,
  deletePaymentQR,
  uploadQR,
} = require("../controllers/paymentQrController");
const { protect, authorize } = require("../middleware/authMiddleware");

const router = express.Router();

// Test route to verify router is working
router.get("/test", (req, res) => {
  res.json({ message: "Payment QR routes are working!" });
});

// Public route - get active QR code (for customer payment page)
router.get("/active", getActivePaymentQRPublic);

// Protected routes - admin only
router.use(protect, authorize(["admin", "franchise_admin", "super_admin"]));

router.post("/upload", uploadQR, uploadPaymentQR);
router.get("/", getActivePaymentQR);
router.get("/list", listPaymentQRs);
router.delete("/:id", deletePaymentQR);

module.exports = router;

