const express = require("express");
const {
  createOrder,
  addKot,
  finalizeOrder,
  getOrders,
  getOrderById,
  updateOrderStatus,
  cancelOrderByCustomer,
  deleteOrder,
  returnItems,
  convertToTakeaway,
  addItemsToOrder
} = require("../controllers/orderController");
const { protect, authorize } = require("../middleware/authMiddleware");

const router = express.Router();

/* ---------- main flow (public - customer-facing) ---------- */
router.post("/", createOrder);             // first Confirm - public for customers
router.post("/:id/kot", addKot);           // Order More → Confirm - public for customers
router.post("/:id/finalize", protect, authorize(["admin"]), finalizeOrder);
router.patch("/:id/customer-status", cancelOrderByCustomer);  // Customer cancel/return - public with sessionToken verification

/* ---------- optional helpers (admin + mobile roles) ---------- */
// IMPORTANT: Specific route (/) must come before parameterized route (/:id)
// Mobile app access: waiter, cook, captain, manager can view orders
router.get("/", protect, authorize(["admin", "franchise_admin", "super_admin", "waiter", "cook", "captain", "manager"]), getOrders);
router.get("/:id", getOrderById);  // Public for customers to view their order
router.patch("/:id/status", protect, authorize(["admin", "franchise_admin", "super_admin"]), updateOrderStatus);
router.post("/:id/add-items", protect, authorize(["admin", "franchise_admin", "super_admin"]), addItemsToOrder);
router.patch("/:id/return-items", protect, authorize(["admin", "franchise_admin", "super_admin"]), returnItems);
router.patch("/:id/convert-to-takeaway", protect, authorize(["admin", "franchise_admin", "super_admin"]), convertToTakeaway);
router.delete("/:id", protect, authorize(["admin", "franchise_admin", "super_admin"]), deleteOrder);

module.exports = router;
