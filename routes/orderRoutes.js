const express = require("express");
const {
  createOrder,
  getNextTakeawayToken,
  addKot,
  finalizeOrder,
  getOrders,
  getOrderById,
  getKotPrintTemplate,
  updateOrderStatus,
  updatePrintStatus,
  claimPrintJob,
  completePrintJob,
  acceptOrder,
  cancelOrderByCustomer,
  confirmPaymentByCustomer,
  deleteOrder,
  returnItems,
  convertToTakeaway,
  addItemsToOrder,
  updateOrderAddons,
} = require("../controllers/orderController");
const {
  protect,
  authorize,
  optionalProtect,
} = require("../middleware/authMiddleware");
const {
  validateOrderType,
} = require("../middleware/orderValidationMiddleware");

const router = express.Router();

/* ---------- main flow (public - customer-facing) ---------- */
router.post("/", optionalProtect, validateOrderType, createOrder); // first Confirm - public for customers, but authenticate if token provided
router.get("/takeaway-token/next", optionalProtect, getNextTakeawayToken);
router.post("/:id/kot", optionalProtect, addKot); // Order More → Confirm - public for customers
router.post("/:id/finalize", protect, authorize(["admin"]), finalizeOrder);
router.patch("/:id/customer-status", optionalProtect, cancelOrderByCustomer); // Customer cancel/return - public with sessionToken verification
router.patch("/:id/confirm-payment", optionalProtect, confirmPaymentByCustomer); // Customer confirm payment - public with sessionToken verification

/* ---------- optional helpers (admin only) ---------- */
router.get(
  "/",
  protect,
  authorize([
    "admin",
    "franchise_admin",
    "super_admin",
    "waiter",
    "cook",
    "captain",
    "manager",
  ]),
  getOrders,
);
router.get(
  "/:id/kot-print",
  protect,
  authorize(["admin", "manager", "waiter", "captain"]),
  getKotPrintTemplate,
);
router.get("/:id", optionalProtect, getOrderById); // Public for customers to view their order
router.patch(
  "/:id/status",
  protect,
  authorize([
    "admin",
    "franchise_admin",
    "super_admin",
    "waiter",
    "cook",
    "captain",
    "manager",
  ]),
  updateOrderStatus,
);
router.patch(
  "/:id/accept",
  protect,
  authorize(["waiter", "cook", "captain", "manager", "admin"]),
  acceptOrder,
);
router.patch(
  "/:id/print-status",
  protect,
  authorize(["admin", "manager", "waiter", "captain"]),
  updatePrintStatus,
);
router.patch(
  "/:id/print-claim",
  protect,
  authorize(["admin", "manager", "waiter", "captain"]),
  claimPrintJob,
);
router.patch(
  "/:id/print-complete",
  protect,
  authorize(["admin", "manager", "waiter", "captain"]),
  completePrintJob,
);
router.post(
  "/:id/add-items",
  protect,
  authorize(["admin", "franchise_admin", "super_admin"]),
  addItemsToOrder,
);
router.patch(
  "/:id/addons",
  protect,
  authorize(["admin", "franchise_admin", "super_admin"]),
  updateOrderAddons,
);
router.patch(
  "/:id/return-items",
  protect,
  authorize(["admin", "franchise_admin", "super_admin"]),
  returnItems,
);
router.patch(
  "/:id/convert-to-takeaway",
  protect,
  authorize(["admin", "franchise_admin", "super_admin"]),
  convertToTakeaway,
);
router.delete(
  "/:id",
  protect,
  authorize(["admin", "franchise_admin", "super_admin"]),
  deleteOrder,
);

module.exports = router;

