const express = require("express");
const router = express.Router();
const { protect, authorize } = require("../middleware/authMiddleware");
const {
  getAllCustomers,
  getCustomer,
  getCustomerStats,
  searchCustomers,
} = require("../controllers/customerController");

// All routes require authentication
router.use(protect);

// Get customer statistics
router.get("/stats", getCustomerStats);

// Search customers
router.get("/search", searchCustomers);

// Get all customers
router.get("/", getAllCustomers);

// Get single customer with full details
router.get("/:id", getCustomer);

module.exports = router;

