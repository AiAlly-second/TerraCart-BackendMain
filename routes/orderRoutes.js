const express = require("express");
const {
  createOrder,
  addKot,
  finalizeOrder,
  getOrders,
  getOrderById,
  updateOrderStatus,
  cancelOrderByCustomer,
  deleteOrder
} = require("../controllers/orderController");
const { protect, authorize } = require("../middleware/authMiddleware");

const router = express.Router();

/* ---------- main flow (public - customer-facing) ---------- */
router.post("/", createOrder);             // first Confirm - public for customers
router.post("/:id/kot", addKot);           // Order More → Confirm - public for customers
router.post("/:id/finalize", protect, authorize(["admin"]), finalizeOrder);
router.patch("/:id/customer-status", cancelOrderByCustomer);  // Customer cancel/return - public with sessionToken verification

/* ---------- optional helpers (admin only) ---------- */
router.get("/", protect, authorize(["admin", "franchise_admin", "super_admin"]), getOrders);
router.get("/:id", getOrderById);  // Public for customers to view their order
router.patch("/:id/status", protect, authorize(["admin", "franchise_admin", "super_admin"]), updateOrderStatus);
router.delete("/:id", protect, authorize(["admin", "franchise_admin", "super_admin"]), deleteOrder);

module.exports = router;
