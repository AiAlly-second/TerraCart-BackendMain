const express = require("express");
const router = express.Router();
const {
  getAllRequests,
  getPendingRequests,
  getRequestById,
  createRequest,
  updateRequest,
  acknowledgeRequest,
  resolveRequest,
  deleteRequest,
} = require("../controllers/customerRequestController");
const { protect, authorize } = require("../middleware/authMiddleware");

// Create request can be public (from customer) or authenticated
router.post("/", createRequest);

// All other routes require authentication
router.use(protect);

// Get pending requests
router.get("/pending", getPendingRequests);

// Get all requests
router.get("/", getAllRequests);

// Get request by ID
router.get("/:id", getRequestById);

// Update request
router.patch("/:id", updateRequest);

// Acknowledge request
router.patch("/:id/acknowledge", acknowledgeRequest);

// Resolve request
router.patch("/:id/resolve", resolveRequest);

// Delete request (Manager only)
router.delete("/:id", authorize(["admin", "franchise_admin", "super_admin", "manager"]), deleteRequest);

module.exports = router;

