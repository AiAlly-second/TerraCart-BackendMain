const express = require("express");
const {
  createPaymentIntent,
  listPayments,
  getPaymentById,
  getPaymentsForOrder,
  getLatestPaymentForOrder,
  cancelPayment,
  markPaymentPaid,
  verifyRazorpayPayment,
  syncPaidOrders,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
} = require("../controllers/paymentController");
const { protect, authorize, optionalProtect } = require("../middleware/authMiddleware");
const { requirePaymentOrderAccess } = require('../middleware/paymentOrderAccess');

const router = express.Router();

router.post("/create", optionalProtect, requirePaymentOrderAccess, createPaymentIntent);
router.get("/order/:orderId/latest", optionalProtect, requirePaymentOrderAccess, getLatestPaymentForOrder);
router.post("/:id/cancel", optionalProtect, requirePaymentOrderAccess, cancelPayment);
router.post("/:id/verify-razorpay", optionalProtect, requirePaymentOrderAccess, verifyRazorpayPayment);

router.use(protect, authorize(["admin", "franchise_admin", "super_admin", "manager"]));

router.get("/", listPayments);
router.get("/order/:orderId/all", getPaymentsForOrder);
router.post("/sync-paid", syncPaidOrders);
router.get("/meta/constants", (_req, res) => {
  res.json({
    methods: PAYMENT_METHODS,
    statuses: PAYMENT_STATUSES,
  });
});

router.get("/:id", getPaymentById);

router.post("/:id/mark-paid", markPaymentPaid);

module.exports = router;
