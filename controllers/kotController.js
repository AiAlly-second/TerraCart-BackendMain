const Order = require("../models/orderModel");
const { asyncHandler } = require("../utils/asyncHandler");

/**
 * @desc    Get all active KOTs
 * @route   GET /api/kot
 * @access  Private (Cook, Manager)
 */
exports.getAllKOTs = asyncHandler(async (req, res) => {
  const {
    status,
    orderId,
    page = 1,
    limit = 20,
    sort = "-createdAt",
  } = req.query;

  // Build query for orders with KOTs
  const orderQuery = {
    kotLines: { $exists: true, $ne: [] },
    status: { $nin: ["Paid", "Cancelled", "Finalized"] },
  };

  // Data isolation
  if (req.user.cafeId) {
    orderQuery.cartId = req.user.cafeId;
  } else if (req.user.franchiseId) {
    orderQuery.franchiseId = req.user.franchiseId;
  }

  if (orderId) {
    orderQuery._id = orderId;
  }

  // Pagination
  const pageNum = parseInt(page);
  const limitNum = parseInt(limit);
  const skip = (pageNum - 1) * limitNum;

  // Get orders with KOTs
  const orders = await Order.find(orderQuery)
    .populate("table", "number name status")
    .sort(sort)
    .skip(skip)
    .limit(limitNum)
    .lean();

  // Transform to KOT format
  const kots = [];
  orders.forEach((order) => {
    order.kotLines.forEach((kotLine, index) => {
      kots.push({
        id: `${order._id}-${index}`,
        orderId: order._id,
        tableNumber: order.tableNumber,
        table: order.table,
        serviceType: order.serviceType,
        items: kotLine.items,
        subtotal: kotLine.subtotal,
        gst: kotLine.gst,
        totalAmount: kotLine.totalAmount,
        createdAt: kotLine.createdAt || order.createdAt,
        orderStatus: order.status,
      });
    });
  });

  const total = await Order.countDocuments(orderQuery);

  res.status(200).json({
    success: true,
    data: kots,
    pagination: {
      page: pageNum,
      limit: limitNum,
      total,
      pages: Math.ceil(total / limitNum),
    },
  });
});

/**
 * @desc    Get pending KOTs
 * @route   GET /api/kot/pending
 * @access  Private (Cook, Manager)
 */
exports.getPendingKOTs = asyncHandler(async (req, res) => {
  const orderQuery = {
    kotLines: { $exists: true, $ne: [] },
    status: { $in: ["Pending", "Confirmed", "Preparing"] },
  };

  // Data isolation
  if (req.user.cafeId) {
    orderQuery.cartId = req.user.cafeId;
  } else if (req.user.franchiseId) {
    orderQuery.franchiseId = req.user.franchiseId;
  }

  const orders = await Order.find(orderQuery)
    .populate("table", "number name status")
    .sort("createdAt")
    .limit(50)
    .lean();

  // Transform to KOT format
  const kots = [];
  orders.forEach((order) => {
    order.kotLines.forEach((kotLine, index) => {
      kots.push({
        id: `${order._id}-${index}`,
        orderId: order._id,
        tableNumber: order.tableNumber,
        table: order.table,
        serviceType: order.serviceType,
        items: kotLine.items,
        subtotal: kotLine.subtotal,
        gst: kotLine.gst,
        totalAmount: kotLine.totalAmount,
        createdAt: kotLine.createdAt || order.createdAt,
        orderStatus: order.status,
      });
    });
  });

  res.status(200).json({
    success: true,
    data: kots,
  });
});

/**
 * @desc    Get KOT by ID
 * @route   GET /api/kot/:id
 * @access  Private (Cook, Manager)
 */
exports.getKOTById = asyncHandler(async (req, res) => {
  // KOT ID format: orderId-kotIndex (e.g., "ORD-20251203017-0")
  // Split from the right to handle orderIds with dashes
  const lastDashIndex = req.params.id.lastIndexOf("-");
  const orderId = req.params.id.substring(0, lastDashIndex);
  const kotIndex = parseInt(req.params.id.substring(lastDashIndex + 1));

  const orderQuery = { _id: orderId };

  // Data isolation
  if (req.user.cafeId) {
    orderQuery.cartId = req.user.cafeId;
  } else if (req.user.franchiseId) {
    orderQuery.franchiseId = req.user.franchiseId;
  }

  const order = await Order.findOne(orderQuery)
    .populate("table", "number name status")
    .lean();

  if (!order || !order.kotLines || !order.kotLines[kotIndex]) {
    return res.status(404).json({
      success: false,
      message: "KOT not found",
    });
  }

  const kotLine = order.kotLines[kotIndex];

  const kot = {
    id: req.params.id,
    orderId: order._id,
    tableNumber: order.tableNumber,
    table: order.table,
    serviceType: order.serviceType,
    items: kotLine.items,
    subtotal: kotLine.subtotal,
    gst: kotLine.gst,
    totalAmount: kotLine.totalAmount,
    createdAt: kotLine.createdAt || order.createdAt,
    orderStatus: order.status,
  };

  res.status(200).json({
    success: true,
    data: kot,
  });
});

/**
 * @desc    Update KOT status (via order status)
 * @route   PATCH /api/kot/:id/status
 * @access  Private (Cook, Manager)
 */
exports.updateKOTStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;

  // Allowed transitions from KOT screen:
  // - 'Confirmed'  -> cook has accepted the KOT
  // - 'Preparing'  -> cook is working on the order
  // - 'Ready'      -> order is completed from kitchen side
  if (!status || !["Confirmed", "Preparing", "Ready"].includes(status)) {
    return res.status(400).json({
      success: false,
      message: "Status must be 'Confirmed', 'Preparing' or 'Ready'",
    });
  }

  // KOT ID format: orderId-kotIndex (e.g., "ORD-20251203017-0")
  // Split from the right to handle orderIds with dashes
  const lastDashIndex = req.params.id.lastIndexOf("-");
  const orderId = req.params.id.substring(0, lastDashIndex);

  const orderQuery = { _id: orderId };

  // Data isolation
  if (req.user.cafeId) {
    orderQuery.cartId = req.user.cafeId;
  } else if (req.user.franchiseId) {
    orderQuery.franchiseId = req.user.franchiseId;
  }

  const order = await Order.findOne(orderQuery);

  if (!order) {
    return res.status(404).json({
      success: false,
      message: "Order not found",
    });
  }

  // Update order status
  order.status = status;
  await order.save();

  await order.populate("table", "number name status");

  // Emit Socket.IO event
  if (req.app && req.app.get("io")) {
    req.app.get("io").emit("kot:status:updated", {
      kotId: req.params.id,
      orderId: order._id,
      status: status,
      order: order,
    });
  }

  res.status(200).json({
    success: true,
    message: "KOT status updated successfully",
    data: {
      kotId: req.params.id,
      orderId: order._id,
      status: order.status,
      order: order,
    },
  });
});

/**
 * @desc    Get KOT statistics
 * @route   GET /api/kot/stats
 * @access  Private (Cook, Manager)
 */
exports.getKOTStats = asyncHandler(async (req, res) => {
  const orderQuery = {
    kotLines: { $exists: true, $ne: [] },
  };

  // Data isolation
  if (req.user.cafeId) {
    orderQuery.cartId = req.user.cafeId;
  } else if (req.user.franchiseId) {
    orderQuery.franchiseId = req.user.franchiseId;
  }

  const [
    totalOrders,
    pendingOrders,
    preparingOrders,
    readyOrders,
  ] = await Promise.all([
    Order.countDocuments(orderQuery),
    Order.countDocuments({ ...orderQuery, status: "Pending" }),
    Order.countDocuments({ ...orderQuery, status: "Preparing" }),
    Order.countDocuments({ ...orderQuery, status: "Ready" }),
  ]);

  // Count total KOTs
  const ordersWithKOTs = await Order.find(orderQuery).lean();
  let totalKOTs = 0;
  ordersWithKOTs.forEach((order) => {
    totalKOTs += order.kotLines ? order.kotLines.length : 0;
  });

  res.status(200).json({
    success: true,
    data: {
      totalKOTs,
      totalOrders,
      pendingOrders,
      preparingOrders,
      readyOrders,
    },
  });
});

