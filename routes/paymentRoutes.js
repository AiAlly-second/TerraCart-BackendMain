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
const { protect, authorize } = require("../middleware/authMiddleware");

const router = express.Router();

router.post("/create", createPaymentIntent);
router.get("/order/:orderId/latest", getLatestPaymentForOrder);
router.post("/:id/cancel", cancelPayment);
router.post("/:id/verify-razorpay", verifyRazorpayPayment);

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
