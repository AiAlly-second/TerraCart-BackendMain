const express = require("express");
const router = express.Router();
const {
  getAllRequests,
  getPendingRequests,
  getRequestById,
  createRequest,
  acknowledgeRequest,
  resolveRequest,
  updateRequest,
  deleteRequest,
  getRequestStats,
} = require("../controllers/customerRequestController");
const { protect, authorize } = require("../middleware/authMiddleware");
const { blockActionsIfCheckedOut } = require("../middleware/checkoutLockMiddleware");

// Public endpoint for customers to create requests (no auth required)
router.post("/", createRequest);

// Protected routes
router.use(protect);

// Get all customer requests (filtered by cart/kiosk)
router.get("/", authorize(["admin", "franchise_admin", "super_admin", "waiter", "cook", "captain", "manager"]), getAllRequests);

// Get pending requests
router.get("/pending", authorize(["admin", "franchise_admin", "super_admin", "waiter", "cook", "captain", "manager"]), getPendingRequests);

// Get request statistics
router.get("/stats", authorize(["admin", "franchise_admin", "super_admin", "manager"]), getRequestStats);

// Get request by ID
router.get("/:id", authorize(["admin", "franchise_admin", "super_admin", "waiter", "cook", "captain", "manager"]), getRequestById);

// Update request
router.put("/:id", authorize(["admin", "franchise_admin", "super_admin", "waiter", "cook", "captain", "manager"]), blockActionsIfCheckedOut, updateRequest);
router.patch("/:id", authorize(["admin", "franchise_admin", "super_admin", "waiter", "cook", "captain", "manager"]), blockActionsIfCheckedOut, updateRequest);

// Acknowledge request
router.post("/:id/acknowledge", authorize(["admin", "franchise_admin", "super_admin", "waiter", "cook", "captain", "manager"]), blockActionsIfCheckedOut, acknowledgeRequest);

// Resolve request
router.post("/:id/resolve", authorize(["admin", "franchise_admin", "super_admin", "waiter", "cook", "captain", "manager"]), blockActionsIfCheckedOut, resolveRequest);

// Delete request
router.delete("/:id", authorize(["admin", "franchise_admin", "super_admin", "manager"]), blockActionsIfCheckedOut, deleteRequest);

module.exports = router;

