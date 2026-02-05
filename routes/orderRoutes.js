const express = require("express");
const {
  createOrder,
  addKot,
  finalizeOrder,
  getOrders,
  getOrderById,
  updateOrderStatus,
  updatePrintStatus,
  acceptOrder,
  cancelOrderByCustomer,
  confirmPaymentByCustomer,
  deleteOrder,
  returnItems,
  convertToTakeaway,
  addItemsToOrder
} = require("../controllers/orderController");
const { protect, authorize, optionalProtect } = require("../middleware/authMiddleware");

const router = express.Router();

/* ---------- main flow (public - customer-facing) ---------- */
router.post("/", optionalProtect, createOrder);             // first Confirm - public for customers, but authenticate if token provided
router.post("/:id/kot", addKot);           // Order More → Confirm - public for customers
router.post("/:id/finalize", protect, authorize(["admin"]), finalizeOrder);
router.patch("/:id/customer-status", cancelOrderByCustomer);  // Customer cancel/return - public with sessionToken verification
router.patch("/:id/confirm-payment", confirmPaymentByCustomer);  // Customer confirm payment - public with sessionToken verification

/* ---------- optional helpers (admin only) ---------- */
router.get("/", protect, authorize(["admin", "franchise_admin", "super_admin", "waiter", "cook", "captain", "manager"]), getOrders);
router.get("/:id", getOrderById);  // Public for customers to view their order
router.patch("/:id/status", protect, authorize(["admin", "franchise_admin", "super_admin", "waiter", "cook", "captain", "manager"]), updateOrderStatus);
router.patch("/:id/accept", protect, authorize(["waiter", "captain", "manager"]), acceptOrder);
router.patch("/:id/print-status", protect, authorize(["admin", "manager", "waiter", "captain"]), updatePrintStatus);
router.post("/:id/add-items", protect, authorize(["admin", "franchise_admin", "super_admin"]), addItemsToOrder);
router.patch("/:id/return-items", protect, authorize(["admin", "franchise_admin", "super_admin"]), returnItems);
router.patch("/:id/convert-to-takeaway", protect, authorize(["admin", "franchise_admin", "super_admin"]), convertToTakeaway);
router.delete("/:id", protect, authorize(["admin", "franchise_admin", "super_admin"]), deleteOrder);

module.exports = router;
