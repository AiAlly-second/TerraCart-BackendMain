const mongoose = require("mongoose");
const Order = require("../models/orderModel");
const Counter = require("../models/countermodel");
const { Table } = require("../models/tableModel");
const { Payment } = require("../models/paymentModel");

// Money helpers
const toPaise = (n) => Math.round(Number(n) * 100);
const toRupees = (p) => Number((p / 100).toFixed(2));

// Build KOT
function buildKot(items) {
  const lines = items.map((it) => ({
    name: it.name,
    quantity: Number(it.quantity),
    price: toPaise(it.price),
    returned: Boolean(it.returned),
  }));

  const subtotalP = lines.reduce((s, it) => s + it.price * it.quantity, 0);
  const gstP = Math.round(subtotalP * 0.05); // 5% GST
  const totalP = subtotalP + gstP;

  return {
    items: lines,
    subtotal: toRupees(subtotalP),
    gst: toRupees(gstP),
    totalAmount: toRupees(totalP),
  };
}

function getOrderBillAmount(order) {
  if (!order?.kotLines?.length) return 0;
  const latestKot = order.kotLines[order.kotLines.length - 1];
  const amount =
    Number(latestKot?.totalAmount ?? latestKot?.subtotal ?? 0) || 0;
  return amount > 0 ? amount : 0;
}

async function ensurePaymentRecord(order, options = {}) {
  if (!order?._id) return null;
  const amount = getOrderBillAmount(order);
  if (amount <= 0) {
    return { payment: null, created: false };
  }

  let payment = await Payment.findOne({ orderId: order._id });
  let created = false;
  if (!payment) {
    payment = await Payment.create({
      orderId: order._id,
      amount,
      method: options.method || "CASH",
      status: options.status || "PAID",
      description:
        options.description || "Payment settled by admin",
      paidAt: options.status === "PAID" ? new Date() : undefined,
    });
    created = true;
  } else {
    let mutate = false;
    if (payment.amount !== amount) {
      payment.amount = amount;
      mutate = true;
    }
    if (options.status === "PAID" && payment.status !== "PAID") {
      payment.status = "PAID";
      payment.paidAt = new Date();
      mutate = true;
    }
    if (options.method && payment.method !== options.method) {
      payment.method = options.method;
      mutate = true;
    }
    if (options.description && payment.description !== options.description) {
      payment.description = options.description;
      mutate = true;
    }
    if (mutate) {
      await payment.save();
    }
  }

  return { payment, created };
}

function formatPaymentPayload(payment) {
  const plain = payment?.toObject ? payment.toObject() : payment;
  if (!plain) return null;
  return {
    id: plain._id || plain.id,
    orderId: plain.orderId,
    amount: plain.amount,
    method: plain.method,
    status: plain.status,
    description: plain.description,
    upiPayload: plain.upiPayload,
    paymentUrl: plain.paymentUrl,
    providerReference: plain.providerReference,
    metadata: plain.metadata,
    createdAt: plain.createdAt,
    updatedAt: plain.updatedAt,
    paidAt: plain.paidAt,
    cancelledAt: plain.cancelledAt,
    cancellationReason: plain.cancellationReason,
  };
}

// Order status transitions (Finalized removed - Served goes directly to Paid)
const transitions = {
  Pending: new Set(["Confirmed", "Cancelled"]),
  Confirmed: new Set(["Preparing", "Cancelled"]),
  Preparing: new Set(["Ready", "Cancelled"]),
  Ready: new Set(["Served", "Cancelled"]),
  Served: new Set(["Paid", "Cancelled"]), // Removed Finalized - goes directly to Paid
  Finalized: new Set(["Paid", "Cancelled"]), // Keep for existing orders that are already Finalized
  Paid: new Set(["Returned"]),
  Cancelled: new Set([]),
  Returned: new Set([]),
};

// ---------------- CREATE ORDER ----------------
async function releaseTableForOrder(order, io) {
  try {
    if (!order?.table) return;
    const tableId = order.table._id || order.table;
    const table = await Table.findById(tableId);
    if (!table) return;
    table.status = "AVAILABLE";
    table.currentOrder = null;
    table.set("sessionToken", undefined);
    await table.save();
    
    // Notify next person in waitlist when table becomes available
    if (io) {
      const { notifyNextWaitlist } = require("./waitlistController");
      await notifyNextWaitlist(tableId, io);
    }
  } catch (err) {
    console.error("Failed to release table", err);
  }
}

const createOrder = async (req, res) => {
  console.log('[ORDER] createOrder called - no auth required');
  try {
    const { items, serviceType = "DINE_IN", tableId, sessionToken } = req.body;
    let { tableNumber } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "No items supplied" });
    }

    const isTableService = serviceType === "DINE_IN" || serviceType === "TAKEAWAY";
    if (!isTableService) {
      return res.status(400).json({ message: "Invalid service type" });
    }

    let tableDoc = null;
    const isTakeaway = serviceType === "TAKEAWAY";

    // For TAKEAWAY orders, skip all table-related logic
    if (!isTakeaway) {
      // DINE_IN orders require table and session token
      if (!sessionToken) {
        return res.status(400).json({
          message: "Session token is required for dine-in orders",
        });
      }

      if (!tableId && !tableNumber) {
        return res.status(400).json({ message: "Table selection is required for dine-in orders" });
      }

      if (tableId) {
        tableDoc = await Table.findById(tableId);
      } else if (tableNumber) {
        const numeric = Number(tableNumber);
        if (!Number.isNaN(numeric)) {
          tableDoc = await Table.findOne({ number: numeric });
        }
      }

      if (!tableDoc) {
        return res.status(404).json({ message: "Table record not found" });
      }

      if (tableDoc.sessionToken && tableDoc.sessionToken !== sessionToken) {
        return res.status(403).json({ message: "This table is currently assigned to another guest." });
      }

      tableNumber = tableNumber || String(tableDoc.number ?? tableDoc.tableNumber);
      if (!tableNumber) {
        tableNumber = String(tableDoc.number || "");
      }

      if (!tableDoc.sessionToken) {
        tableDoc.sessionToken = sessionToken;
      }
    } else {
      // For TAKEAWAY orders, set tableNumber to "TAKEAWAY" and skip table assignment
      tableNumber = "TAKEAWAY";
    }

    const kot = buildKot(items);

    // Generate custom order ID
    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10).replace(/-/g, ""); // YYYYMMDD

    // Find today's counter
    let counter = await Counter.findOneAndUpdate(
      { date: dateStr },
      { $inc: { seq: 1 } },
      { new: true, upsert: true }
    );

    const seqStr = String(counter.seq).padStart(3, "0");
    const orderId = `ORD-${dateStr}${seqStr}`;

    // Set cafeId: priority 1) from authenticated cafe admin, 2) from table's cafeId (for dine-in only)
    let cafeId = null;
    if (req.user && req.user.role === "admin" && req.user._id) {
      cafeId = req.user._id;
    } else if (!isTakeaway && tableDoc && tableDoc.cafeId) {
      cafeId = tableDoc.cafeId;
    }
    
    // Set franchiseId: priority 1) from authenticated cafe admin's franchise, 2) from table's franchiseId
    let franchiseId = null;
    if (req.user && req.user.role === "admin" && req.user.franchiseId) {
      franchiseId = req.user.franchiseId;
    } else if (!isTakeaway && tableDoc && tableDoc.franchiseId) {
      franchiseId = tableDoc.franchiseId;
    } else if (cafeId) {
      // If we have cafeId but no franchiseId, get it from the cafe admin user
      const cafeAdmin = await require("../models/userModel").findById(cafeId);
      if (cafeAdmin && cafeAdmin.franchiseId) {
        franchiseId = cafeAdmin.franchiseId;
      }
    }
    
    const order = await Order.create({
      _id: orderId,
      tableNumber: String(tableNumber),
      table: isTakeaway ? null : (tableDoc?._id || null), // No table for takeaway
      serviceType,
      sessionToken: isTakeaway ? undefined : sessionToken, // No session token needed for takeaway
      kotLines: [kot],
      status: "Confirmed",
      cafeId: cafeId,
      franchiseId: franchiseId,
    });

    // Only update table status for dine-in orders
    if (!isTakeaway && tableDoc) {
      tableDoc.status = "OCCUPIED";
      tableDoc.currentOrder = order._id;
      tableDoc.lastAssignedAt = new Date();
      await tableDoc.save();
    }

    // Emit socket event
    const io = req.app.get("io");
    io.emit("newOrder", order);

    return res.status(201).json(order);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ---------------- ADD KOT ----------------
const addKot = async (req, res) => {
  console.log('[ORDER] addKot called - no auth required');
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "No items supplied" });
    }

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: "Order not found" });
    if (order.status !== "Confirmed") {
      return res.status(400).json({ message: "Order is not open for KOTs" });
    }

    // Ensure cafeId and franchiseId are set from table if missing (for orders created before fix)
    if ((!order.cafeId || !order.franchiseId) && order.table) {
      const tableDoc = await Table.findById(order.table);
      if (tableDoc) {
        let needsSave = false;
        if (!order.cafeId && tableDoc.cafeId) {
          order.cafeId = tableDoc.cafeId;
          needsSave = true;
        }
        if (!order.franchiseId && tableDoc.franchiseId) {
          order.franchiseId = tableDoc.franchiseId;
          needsSave = true;
        }
        // If we still don't have franchiseId but have cafeId, get it from cafe admin
        if (!order.franchiseId && order.cafeId) {
          const User = require("../models/userModel");
          const cafeAdmin = await User.findById(order.cafeId);
          if (cafeAdmin && cafeAdmin.franchiseId) {
            order.franchiseId = cafeAdmin.franchiseId;
            needsSave = true;
          }
        }
        if (needsSave) {
          await order.save();
        }
      }
    }

    order.kotLines.push(buildKot(items));
    await order.save();

    const io = req.app.get("io");
    io.emit("orderUpdated", order);

    return res.json(order);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ---------------- FINALIZE ORDER ----------------
const finalizeOrder = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) {
      console.log('Order not found:', req.params.id);
      return res.status(404).json({ message: "Order not found" });
    }
    
    console.log('Attempting to finalize order:', {
      orderId: order._id,
      currentStatus: order.status,
      allowedTransitions: Array.from(transitions[order.status] || []),
    });
    
    if (!transitions[order.status]?.has("Finalized")) {
      console.log('Invalid transition:', {
        from: order.status,
        to: 'Finalized',
        allowedTransitions: Array.from(transitions[order.status] || []),
      });
      return res.status(400).json({ 
        message: `Cannot finalize from ${order.status}. Order must be in 'Served' state.`,
        currentStatus: order.status,
        allowedTransitions: Array.from(transitions[order.status] || []),
      });
    }

    order.status = "Finalized";
    await order.save();

    const io = req.app.get("io");
    io.emit("orderUpdated", order);

    return res.json(order);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ---------------- GET ORDERS ----------------
const getOrders = async (req, res) => {
  try {
    const query = {};
    
    // Filter orders based on admin role:
    // - Cafe admin: only orders from their cafe (cafeId matches their _id)
    // - Franchise admin: only orders from cafes under their franchise (franchiseId matches their _id)
    // - Super admin: all orders (no filter - they see everything)
    if (req.user && req.user.role === "admin" && req.user._id) {
      // Cafe admin - only see orders from their cafe
      query.cafeId = req.user._id;
    } else if (req.user && req.user.role === "franchise_admin" && req.user._id) {
      // Franchise admin - only see orders from cafes under their franchise
      query.franchiseId = req.user._id;
    }
    // For super_admin, no filter (see all orders)
    
    const orders = await Order.find(query)
      .sort({ createdAt: -1 })
      .populate("table")
      .lean();
    return res.json(orders);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ---------------- GET ORDER BY ID ----------------
const getOrderById = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id).populate("table").lean();
    if (!order) return res.status(404).json({ message: "Order not found" });
    
    // Check access permissions based on admin role:
    // - Cafe admin: can only access orders from their cafe
    // - Franchise admin: can only access orders from cafes under their franchise
    // - Super admin: can access all orders
    // - Public (no auth): can access orders (for frontend customers)
    if (req.user && req.user.role === "admin" && req.user._id) {
      // Cafe admin - check if order belongs to their cafe
      if (!order.cafeId || order.cafeId.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: "Order does not belong to your cafe" });
      }
    } else if (req.user && req.user.role === "franchise_admin" && req.user._id) {
      // Franchise admin - check if order belongs to their franchise
      if (!order.franchiseId || order.franchiseId.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: "Order does not belong to your franchise" });
      }
    }
    // For super_admin, no restriction (they can see all orders)
    
    return res.json(order);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ---------------- UPDATE ORDER STATUS ----------------
const updateOrderStatus = async (req, res) => {
  try {
    const { status } = req.body;
    if (!status) return res.status(400).json({ message: "Status required" });

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: "Order not found" });

    // Check access permissions based on admin role:
    // - Cafe admin: can only update orders from their cafe
    // - Franchise admin: can only update orders from cafes under their franchise
    // - Super admin: can update all orders
    if (req.user && req.user.role === "admin" && req.user._id) {
      // Cafe admin - check if order belongs to their cafe
      if (!order.cafeId || order.cafeId.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: "Order does not belong to your cafe" });
      }
    } else if (req.user && req.user.role === "franchise_admin" && req.user._id) {
      // Franchise admin - check if order belongs to their franchise
      if (!order.franchiseId || order.franchiseId.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: "Order does not belong to your franchise" });
      }
    }
    // For super_admin, no restriction (they can update all orders)

    // Debug logging
    console.log('Status update attempt:', {
      orderId: order._id,
      currentStatus: order.status,
      requestedStatus: status,
      allowedTransitions: Array.from(transitions[order.status] || []),
      hasTransition: transitions[order.status]?.has(status)
    });

    if (!transitions[order.status]?.has(status)) {
      console.error('Invalid transition:', {
        from: order.status,
        to: status,
        allowed: Array.from(transitions[order.status] || [])
      });
      return res.status(400).json({ 
        message: `Invalid transition ${order.status} → ${status}`,
        currentStatus: order.status,
        requestedStatus: status,
        allowedTransitions: Array.from(transitions[order.status] || [])
      });
    }

    const io = req.app.get("io");

    order.status = status;
    if (status === "Paid") {
      order.paidAt = new Date();
    } else if (status === "Returned") {
      order.returnedAt = new Date();
      order.paidAt = null;
      if (Array.isArray(order.kotLines)) {
        order.kotLines.forEach((kot, index) => {
          const kotLine = order.kotLines[index];
          const items = Array.isArray(kotLine.items) ? kotLine.items : [];
          kotLine.items = items.map((item) => {
            const plainItem = item?.toObject ? item.toObject() : item;
            return {
              ...plainItem,
              returned: true,
            };
          });
          kotLine.subtotal = 0;
          kotLine.gst = 0;
          kotLine.totalAmount = 0;
        });
      }
      order.markModified("kotLines");
    }

    await order.save();

    if (status === "Paid") {
      const { payment, created } = await ensurePaymentRecord(order, {
        status: "PAID",
        method: "CASH",
        description: "Payment recorded via admin panel",
      });
      if (payment && io) {
        const payload = formatPaymentPayload(payment);
        if (payload) {
          io.emit(created ? "paymentCreated" : "paymentUpdated", payload);
        }
      }
    }

    if (status === "Returned") {
      const payments = await Payment.find({ orderId: order._id });
      for (const payment of payments) {
        payment.status = "CANCELLED";
        payment.cancelledAt = new Date();
        payment.cancellationReason = "Order returned";
        await payment.save();
        if (io) {
          const payload = formatPaymentPayload(payment);
          if (payload) {
            io.emit("paymentUpdated", payload);
          }
        }
      }
    }

    if (["Paid", "Cancelled", "Returned"].includes(status)) {
      await releaseTableForOrder(order, io);
    }

    io.emit("orderUpdated", order);

    console.log('Status updated successfully:', order._id, '→', status);
    return res.json(order);
  } catch (err) {
    console.error('Status update error:', err);
    return res.status(500).json({ message: err.message });
  }
};

// ---------------- CUSTOMER CANCEL/RETURN ORDER ----------------
const cancelOrderByCustomer = async (req, res) => {
  try {
    const { status, sessionToken } = req.body;
    const orderId = req.params.id;
    
    if (!status) return res.status(400).json({ message: "Status required" });
    if (status !== "Cancelled" && status !== "Returned") {
      return res.status(400).json({ message: "Only Cancelled or Returned status allowed for customers" });
    }

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ message: "Order not found" });

    // Verify sessionToken for dine-in orders
    if (order.serviceType === "DINE_IN") {
      if (!sessionToken) {
        return res.status(401).json({ message: "Not authorized, no token" });
      }
      
      // Check sessionToken matches order's sessionToken or table's sessionToken
      let tokenMatches = false;
      if (order.sessionToken === sessionToken) {
        tokenMatches = true;
      } else if (order.table) {
        const table = await Table.findById(order.table);
        if (table && table.sessionToken === sessionToken) {
          tokenMatches = true;
        }
      }
      
      if (!tokenMatches) {
        return res.status(403).json({ message: "Not authorized, invalid token" });
      }
    }
    // For takeaway orders, allow cancellation without sessionToken verification

    // Check if status transition is allowed
    const allowedStatuses = status === "Cancelled" 
      ? ["Pending", "Confirmed", "Preparing", "Ready", "Served", "Finalized", "Completed"]
      : ["Paid"];
    
    if (!allowedStatuses.includes(order.status)) {
      return res.status(400).json({ 
        message: `Cannot ${status.toLowerCase()} order with status ${order.status}`,
        currentStatus: order.status,
        allowedStatuses
      });
    }

    const io = req.app.get("io");

    order.status = status;
    if (status === "Returned") {
      order.returnedAt = new Date();
      order.paidAt = null;
      if (Array.isArray(order.kotLines)) {
        order.kotLines.forEach((kot, index) => {
          const kotLine = order.kotLines[index];
          const items = Array.isArray(kotLine.items) ? kotLine.items : [];
          kotLine.items = items.map((item) => {
            const plainItem = item?.toObject ? item.toObject() : item;
            return {
              ...plainItem,
              returned: true,
            };
          });
          kotLine.subtotal = 0;
          kotLine.gst = 0;
          kotLine.totalAmount = 0;
        });
      }
      order.markModified("kotLines");

      // Cancel associated payments
      const payments = await Payment.find({ orderId: order._id });
      for (const payment of payments) {
        payment.status = "CANCELLED";
        payment.cancelledAt = new Date();
        payment.cancellationReason = "Order returned";
        await payment.save();
        if (io) {
          const payload = formatPaymentPayload(payment);
          if (payload) {
            io.emit("paymentUpdated", payload);
          }
        }
      }
    }

    await order.save();

    // Release table if order is cancelled or returned
    if (["Cancelled", "Returned"].includes(status)) {
      await releaseTableForOrder(order, io);
    }

    io.emit("orderUpdated", order);

    return res.json(order);
  } catch (err) {
    console.error('Customer cancel/return error:', err);
    return res.status(500).json({ message: err.message });
  }
};

// ---------------- DELETE ORDER ----------------
const deleteOrder = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: "Order not found" });

    // Prevent deletion of paid orders to maintain revenue data integrity
    // Revenue calculations depend on paid orders in the database
    if (order.status === "Paid") {
      return res.status(400).json({ 
        message: "Cannot delete paid orders. Paid orders are required for revenue tracking and financial records.",
        orderId: order._id,
        status: order.status
      });
    }

    // Delete the order
    await Order.findByIdAndDelete(req.params.id);

    const io = req.app.get("io");
    await releaseTableForOrder(order, io);
    io.emit("orderDeleted", { id: req.params.id });

    return res.json({ message: "Order deleted" });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = {
  createOrder,
  addKot,
  finalizeOrder,
  getOrders,
  getOrderById,
  updateOrderStatus,
  cancelOrderByCustomer,
  deleteOrder,
  releaseTableForOrder,
};
