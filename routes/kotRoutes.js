const express = require("express");
const router = express.Router();
const { protect, authorize } = require("../middleware/authMiddleware");
const Order = require("../models/orderModel");
const Employee = require("../models/employeeModel");

// Helper to get cafeId based on user role
// Uses req.user.cafeId (populated by middleware) for mobile users to avoid Employee lookup
const getCafeId = async (user) => {
  if (user.role === "admin") {
    return user._id;
  } else if (["waiter", "cook", "captain", "manager"].includes(user.role)) {
    // First try req.user.cafeId (populated by middleware)
    if (user.cafeId) {
      return user.cafeId;
    }
    // Fallback: Employee lookup (should not be needed if middleware works correctly)
    const employee = await Employee.findOne({ 
      $or: [
        { userId: user._id },
        { email: user.email?.toLowerCase() }
      ]
    }).lean();
    return employee?.cafeId;
  } else if (user.role === "employee") {
    // Legacy employee role
    if (user.cafeId) {
      return user.cafeId;
    }
    const employee = await Employee.findOne({ 
      $or: [
        { userId: user._id },
        { email: user.email?.toLowerCase() }
      ]
    }).lean();
    return employee?.cafeId;
  }
  return null;
};

router.use(protect);

// Get all KOTs (KOTs are stored as kotLines in orders)
router.get("/", authorize(["admin", "franchise_admin", "super_admin", "waiter", "cook", "captain", "manager"]), async (req, res) => {
  try {
    const cafeId = await getCafeId(req.user);
    if (!cafeId) {
      return res.status(403).json({ message: "No cafe associated with this user" });
    }

    const orders = await Order.find({
      cartId: cafeId,
      kotLines: { $exists: true, $ne: [] },
    })
      .sort({ createdAt: -1 })
      .lean();

    // Extract KOTs from orders (includes both TAKEAWAY and DINE_IN orders)
    const kots = [];
    orders.forEach((order) => {
      if (order.kotLines && order.kotLines.length > 0) {
        order.kotLines.forEach((kot, index) => {
          kots.push({
            _id: `${order._id}-kot-${index}`,
            orderId: order._id,
            orderNumber: order.orderNumber,
            tableNumber: order.tableNumber,
            serviceType: order.serviceType || 'DINE_IN', // Include serviceType for filtering
            status: order.status,
            orderStatus: order.status, // Alias for compatibility
            items: kot.items,
            subtotal: kot.subtotal,
            gst: kot.gst,
            totalAmount: kot.totalAmount,
            createdAt: kot.createdAt || order.createdAt,
          });
        });
      }
    });

    return res.json({ success: true, data: kots });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// Get pending KOTs
router.get("/pending", authorize(["admin", "franchise_admin", "super_admin", "waiter", "cook", "captain", "manager"]), async (req, res) => {
  try {
    const cafeId = await getCafeId(req.user);
    if (!cafeId) {
      return res.status(403).json({ message: "No cafe associated with this user" });
    }

    const orders = await Order.find({
      cartId: cafeId,
      status: { $in: ["Pending", "Confirmed", "Preparing"] },
      kotLines: { $exists: true, $ne: [] },
    })
      .sort({ createdAt: -1 })
      .lean();

    const kots = [];
    orders.forEach((order) => {
      if (order.kotLines && order.kotLines.length > 0) {
        order.kotLines.forEach((kot, index) => {
          kots.push({
            _id: `${order._id}-kot-${index}`,
            orderId: order._id,
            orderNumber: order.orderNumber,
            tableNumber: order.tableNumber,
            serviceType: order.serviceType || 'DINE_IN', // Include serviceType for filtering
            status: order.status,
            orderStatus: order.status, // Alias for compatibility
            items: kot.items,
            subtotal: kot.subtotal,
            gst: kot.gst,
            totalAmount: kot.totalAmount,
            createdAt: kot.createdAt || order.createdAt,
          });
        });
      }
    });

    return res.json({ success: true, data: kots });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// Get KOT statistics
router.get("/stats", authorize(["admin", "franchise_admin", "super_admin", "manager"]), async (req, res) => {
  try {
    const cafeId = await getCafeId(req.user);
    if (!cafeId) {
      return res.status(403).json({ message: "No cafe associated with this user" });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const orders = await Order.find({
      cartId: cafeId,
      createdAt: { $gte: today, $lt: tomorrow },
      kotLines: { $exists: true, $ne: [] },
    }).lean();

    let totalKOTs = 0;
    let pendingKOTs = 0;
    orders.forEach((order) => {
      if (order.kotLines) {
        totalKOTs += order.kotLines.length;
        if (["Pending", "Confirmed", "Preparing"].includes(order.status)) {
          pendingKOTs += order.kotLines.length;
        }
      }
    });

    return res.json({
      total: totalKOTs,
      pending: pendingKOTs,
      completed: totalKOTs - pendingKOTs,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// Get KOT by ID (format: orderId-kot-index)
router.get("/:id", authorize(["admin", "franchise_admin", "super_admin", "waiter", "cook", "captain", "manager"]), async (req, res) => {
  try {
    // Parse KOT ID format: orderId-kot-index
    const parts = req.params.id.split("-kot-");
    if (parts.length !== 2) {
      return res.status(400).json({ message: "Invalid KOT ID format" });
    }

    const orderId = parts[0];
    const kotIndex = parseInt(parts[1]);

    const order = await Order.findById(orderId).lean();
    if (!order) {
      return res.status(404).json({ message: "KOT not found" });
    }

    if (!order.kotLines || !order.kotLines[kotIndex]) {
      return res.status(404).json({ message: "KOT not found" });
    }

    const kot = order.kotLines[kotIndex];
    return res.json({
      _id: req.params.id,
      orderId: order._id,
      orderNumber: order.orderNumber,
      tableNumber: order.tableNumber,
      status: order.status,
      items: kot.items,
      subtotal: kot.subtotal,
      gst: kot.gst,
      totalAmount: kot.totalAmount,
      createdAt: kot.createdAt,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// Update KOT status (updates the order status)
// Accepts both orderId and orderId-kot-index formats
router.patch("/:id/status", authorize(["admin", "franchise_admin", "super_admin", "waiter", "cook", "captain", "manager"]), async (req, res) => {
  try {
    const { status } = req.body;
    if (!status) {
      return res.status(400).json({ message: "Status is required" });
    }

    // Parse KOT ID - can be either orderId or orderId-kot-index
    let orderId = req.params.id;
    const parts = req.params.id.split("-kot-");
    if (parts.length === 2) {
      orderId = parts[0]; // Extract orderId from orderId-kot-index format
    }

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    // Check access
    const cafeId = await getCafeId(req.user);
    if (!cafeId || !order.cartId || order.cartId.toString() !== cafeId.toString()) {
      return res.status(403).json({ message: "Access denied. Order does not belong to your cart/kiosk." });
    }

    // Use orderController's updateOrderStatus for proper validation and socket events
    // This ensures status transitions are validated and socket events are emitted
    const { updateOrderStatus } = require("../controllers/orderController");
    
    // Temporarily store original id and update req.params.id
    const originalId = req.params.id;
    req.params.id = orderId;
    req.body.status = status;
    
    try {
      // Call updateOrderStatus which handles validation, transitions, and socket events
      return await updateOrderStatus(req, res);
    } finally {
      // Restore original params
      req.params.id = originalId;
    }
  } catch (err) {
    console.error('[KOT] Status update error:', err);
    return res.status(500).json({ message: err.message || "Failed to update KOT status" });
  }
});

module.exports = router;

