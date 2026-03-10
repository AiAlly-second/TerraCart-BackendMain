const mongoose = require("mongoose");
const Order = require("../models/orderModel");
const { Table } = require("../models/tableModel");
const InventoryItem = require("../models/inventoryModel");
const EmployeeAttendance = require("../models/employeeAttendanceModel");
const Employee = require("../models/employeeModel");
const User = require("../models/userModel");
const Task = require("../models/taskModel");
const CustomerRequest = require("../models/customerRequestModel");
const {
  ORDER_STATUSES,
  PAYMENT_STATUSES,
} = require("../utils/orderContract");
const { getISTDateRange } = require("../utils/istDateTime");

const normalizeIdString = (value) => {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (typeof value === "object") {
    const nested = value._id || value.id || value.cartId || value.cafeId || null;
    if (nested && nested !== value) return normalizeIdString(nested);
  }
  if (typeof value?.toString === "function") return value.toString().trim();
  return "";
};

const idsMatch = (left, right) => {
  const leftId = normalizeIdString(left);
  const rightId = normalizeIdString(right);
  return Boolean(leftId) && Boolean(rightId) && leftId === rightId;
};

const buildIdVariants = (value) => {
  if (!value) return [];

  const variants = [value];
  const normalized = normalizeIdString(value);
  const objectIdVariant =
    normalized && mongoose.Types.ObjectId.isValid(normalized)
      ? new mongoose.Types.ObjectId(normalized)
      : null;

  if (
    objectIdVariant &&
    !variants.some((variant) => normalizeIdString(variant) === normalized)
  ) {
    variants.push(objectIdVariant);
  }

  if (
    normalized &&
    !variants.some((variant) => normalizeIdString(variant) === normalized)
  ) {
    variants.push(normalized);
  }

  return variants;
};

const buildIdCondition = (value) => {
  const variants = buildIdVariants(value);
  if (!variants.length) return null;
  return variants.length === 1 ? variants[0] : { $in: variants };
};

const buildCartScopeWithLegacyFallback = (cartId) => {
  const cartCondition = buildIdCondition(cartId);
  if (!cartCondition) return null;

  return {
    $or: [
      { cartId: cartCondition },
      {
        $and: [
          {
            $or: [{ cartId: { $exists: false } }, { cartId: null }],
          },
          { cafeId: cartCondition },
        ],
      },
    ],
  };
};

const buildPaidDayRangeClause = (startDate, endDate) => ({
  $or: [
    {
      paidAt: {
        $gte: startDate,
        $lt: endDate,
      },
    },
    {
      $and: [
        {
          $or: [{ paidAt: { $exists: false } }, { paidAt: null }],
        },
        {
          createdAt: {
            $gte: startDate,
            $lt: endDate,
          },
        },
      ],
    },
  ],
});

const toFiniteNumber = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
};

const toRupeesFromPaise = (value) => Number((toFiniteNumber(value) / 100).toFixed(2));

const calculateOrderRevenue = (order) => {
  const kotLines = Array.isArray(order?.kotLines) ? order.kotLines : [];
  const selectedAddons = Array.isArray(order?.selectedAddons)
    ? order.selectedAddons
    : [];

  let kotTotal = kotLines.reduce((sum, kotLine) => {
    return sum + toFiniteNumber(kotLine?.totalAmount);
  }, 0);

  // Fallback for legacy/incomplete KOT totals.
  if (kotTotal <= 0) {
    const kotTotalInPaise = kotLines.reduce((sum, kotLine) => {
      const items = Array.isArray(kotLine?.items) ? kotLine.items : [];
      return (
        sum +
        items.reduce((itemSum, item) => {
          if (!item || item.returned) return itemSum;
          const quantity = Math.max(0, Math.floor(toFiniteNumber(item?.quantity) || 0));
          const priceInPaise = toFiniteNumber(item?.price);
          return itemSum + quantity * priceInPaise;
        }, 0)
      );
    }, 0);
    kotTotal = toRupeesFromPaise(kotTotalInPaise);
  }

  const addonTotal = selectedAddons.reduce((sum, addon) => {
    const quantity = Math.max(0, Math.floor(toFiniteNumber(addon?.quantity) || 1));
    return sum + toFiniteNumber(addon?.price) * quantity;
  }, 0);

  const officeChargeRaw = toFiniteNumber(order?.officeDeliveryCharge);
  const officeDeliveryCharge = officeChargeRaw > 0 ? officeChargeRaw : 0;

  return kotTotal + addonTotal + officeDeliveryCharge;
};

const calculateRevenueFromOrders = (orders) =>
  orders.reduce((sum, order) => sum + calculateOrderRevenue(order), 0);

// Helper to get cartId based on user role (returns cartId, not cafeId)
const getCafeId = async (user) => {
  if (user.role === "admin") {
    return user._id; // Cart admin's _id is the cartId
  } else if (["waiter", "cook", "captain", "manager"].includes(user.role)) {
    // Mobile users - always prefer current Employee mapping to avoid stale
    // user.cafeId/cartId after reassignment.
    let employee = null;
    if (user.employeeId) {
      employee = await Employee.findById(user.employeeId).lean();
    }
    if (!employee && user._id) {
      employee = await Employee.findOne({ userId: user._id }).lean();
    }
    if (!employee && user.email) {
      employee = await Employee.findOne({
        email: String(user.email).toLowerCase(),
      }).lean();
    }

    if (employee) {
      // Prioritize cartId, fallback to cafeId
      const cartId = employee.cartId || employee.cafeId;
      if (cartId) {
        console.log("[DASHBOARD] getCafeId - Found employee by lookup:", {
          userId: user._id,
          email: user.email,
          employeeId: employee._id,
          cartId,
        });
        return cartId;
      }
    }

    if (user.cartId) {
      return user.cartId;
    }

    if (user.cafeId) {
      // Legacy fallback for older mobile user records.
      return user.cafeId;
    }

    console.log("[DASHBOARD] getCafeId - No employee found for mobile user:", {
      userId: user._id,
      email: user.email,
      role: user.role,
    });
    return null;
  } else if (user.role === "employee") {
    // Legacy employee role - look up Employee by userId first, then email.
    let employee = null;
    if (user.employeeId) {
      employee = await Employee.findById(user.employeeId).lean();
    }
    if (!employee && user._id) {
      employee = await Employee.findOne({ userId: user._id }).lean();
    }
    if (!employee && user.email) {
      employee = await Employee.findOne({
        email: String(user.email).toLowerCase(),
      }).lean();
    }
    return employee?.cartId || employee?.cafeId; // Prioritize cartId, fallback to cafeId
  }
  return null;
};

// Get dashboard statistics
exports.getDashboardStats = async (req, res) => {
  try {
    const resolvedCafeId = await getCafeId(req.user);
    if (!resolvedCafeId) {
      return res.status(403).json({ message: "Access denied. No cafe associated with this user." });
    }

    const requestedCartId = normalizeIdString(req.query?.cartId);
    if (requestedCartId && !idsMatch(requestedCartId, resolvedCafeId)) {
      return res
        .status(403)
        .json({ message: "Requested cartId does not match your current cart access." });
    }

    const cafeId = requestedCartId || resolvedCafeId;
    const cartCondition = buildIdCondition(cafeId);
    const orderScope = buildCartScopeWithLegacyFallback(cafeId);
    if (!cartCondition || !orderScope) {
      return res.status(403).json({ message: "Access denied. Invalid cart context." });
    }

    const { startUTC: today, endUTC: tomorrow } = getISTDateRange();

    /*
    const normalizedRole = String(req.user?.role || "").toLowerCase();
    const requireAcceptedKotAssignment =
      normalizedRole === "cook" || normalizedRole === "manager";

    const acceptedKotScope = requireAcceptedKotAssignment
      ? {
        $or: [
          { "acceptedBy.employeeId": { $exists: true, $ne: null } },
          { "acceptedBy.employeeName": { $exists: true, $nin: ["", null] } },
        ],
      }
      : null;
    */
    const requireAcceptedKotAssignment = false;
    const acceptedKotScope = null;

    const buildKotStatusQuery = (statusMatchers) => {
      const clauses = [
        orderScope,
        {
          status: { $in: statusMatchers },
        },
      ];
      if (acceptedKotScope) {
        clauses.push(acceptedKotScope);
      }
      return { $and: clauses };
    };

    const pendingKotStatuses = [ORDER_STATUSES.NEW];
    const preparingKotStatuses = [ORDER_STATUSES.PREPARING];
    const readyKotStatuses = [ORDER_STATUSES.READY];

    // Run all queries in parallel for faster response
    const [
      activeOrders,
      todayPaidOrders,
      pendingKOTs,
      preparingKOTs,
      readyKOTs,
      completedUnpaid,
      completedPaid,
      lowStockItems,
      todayAttendance,
      occupiedTables,
      totalTables,
      pendingTasks,
      pendingRequests,
    ] = await Promise.all([
      // Active orders: terminal-specific open kitchen flow (exclude completed/cancelled).
      Order.countDocuments({
        ...orderScope,
        status: {
          $in: [
            ORDER_STATUSES.NEW,
            ORDER_STATUSES.PREPARING,
            ORDER_STATUSES.READY,
          ],
        },
      }),

      // Today's paid orders for revenue (cart-scoped, paidAt-first date filter).
      Order.find({
        $and: [
          orderScope,
          { paymentStatus: PAYMENT_STATUSES.PAID },
          buildPaidDayRangeClause(today, tomorrow),
        ],
      })
        .select("kotLines selectedAddons officeDeliveryCharge")
        .lean(),

      // Pending KOTs (orders waiting for kitchen start).
      Order.countDocuments(buildKotStatusQuery(pendingKotStatuses)),

      // Preparing KOTs.
      Order.countDocuments(buildKotStatusQuery(preparingKotStatuses)),

      // Ready KOTs.
      Order.countDocuments(buildKotStatusQuery(readyKotStatuses)),

      // Completed but payment pending.
      Order.countDocuments({
        ...orderScope,
        status: ORDER_STATUSES.COMPLETED,
        paymentStatus: { $ne: PAYMENT_STATUSES.PAID },
      }),

      // Completed and paid (history bucket).
      Order.countDocuments({
        ...orderScope,
        status: ORDER_STATUSES.COMPLETED,
        paymentStatus: PAYMENT_STATUSES.PAID,
      }),

      // Low stock items (threshold can be configured)
      // InventoryItem model uses cartId. Fall back to cafeId only for legacy docs
      // that still do not have cartId.
      InventoryItem.countDocuments({
        $and: [
          buildCartScopeWithLegacyFallback(cafeId),
          {
            $or: [
              { quantity: { $lt: 10 } }, // Use 'quantity' field, not 'stockQuantity'
              { quantity: { $exists: false } },
            ]
          }
        ]
      }),

      // Today's attendance count
      // EmployeeAttendance uses cartId. Fall back to cafeId only for legacy docs
      // that still do not have cartId.
      EmployeeAttendance.countDocuments({
        ...buildCartScopeWithLegacyFallback(cafeId),
        date: { $gte: today, $lt: tomorrow },
        "checkIn.time": { $exists: true },
      }),

      // Occupied tables (Table model uses cartId)
      Table.countDocuments({
        cartId: cartCondition,
        isOccupied: true,
      }),

      // Total tables
      Table.countDocuments({
        cartId: cartCondition,
      }),

      // Pending tasks (not completed or cancelled)
      Task.countDocuments({
        cartId: cartCondition,
        status: { $nin: ["completed", "cancelled"] },
      }),

      // Pending customer requests
      CustomerRequest.countDocuments({
        ...buildCartScopeWithLegacyFallback(cafeId),
        status: "pending",
      }),
    ]);

    const todayRevenue = Number(calculateRevenueFromOrders(todayPaidOrders).toFixed(2));

    res.json({
      success: true,
      data: {
        activeOrders,
        todayRevenue,
        pendingTasks,
        pendingKOTs,
        preparingKOTs,
        readyKOTs,
        completedUnpaid,
        completedPaid,
        lowStockItems,
        todayAttendance,
        occupiedTables,
        totalTables,
        availableTables: totalTables - occupiedTables,
        pendingRequests,
      },
    });
  } catch (error) {
    console.error("[DASHBOARD] Error:", error);
    res.status(500).json({ message: "Failed to get dashboard stats", error: error.message });
  }
};

// Get recent activity
exports.getRecentActivity = async (req, res) => {
  try {
    const cafeId = await getCafeId(req.user);
    if (!cafeId) {
      return res.status(403).json({ message: "Access denied. No cafe associated with this user." });
    }

    const limit = parseInt(req.query.limit) || 20;
    const activities = [];

    // Recent orders
    const recentOrders = await Order.find({
      cartId: cafeId,
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    recentOrders.forEach((order) => {
      const isCompletedPaid =
        order.status === ORDER_STATUSES.COMPLETED &&
        order.paymentStatus === PAYMENT_STATUSES.PAID;
      activities.push({
        type: "order",
        action: isCompletedPaid ? "paid" : String(order.status || "").toLowerCase(),
        description: `Order #${order.orderNumber || order._id} ${order.status}`,
        amount: order.totalAmount,
        timestamp: order.createdAt,
        id: order._id,
      });
    });

    // Recent attendance check-ins
    // EmployeeAttendance model uses cartId, support cafeId for backward compatibility
    const recentAttendance = await EmployeeAttendance.find({
      $or: [
        { cartId: cafeId },
        { cafeId: cafeId } // Fallback for backward compatibility
      ],
      "checkIn.time": { $exists: true },
    })
      .populate("employeeId", "name employeeRole")
      .sort({ "checkIn.time": -1 })
      .limit(limit)
      .lean();

    recentAttendance.forEach((attendance) => {
      if (attendance.employeeId) {
        activities.push({
          type: "attendance",
          action: "checked_in",
          description: `${attendance.employeeId.name} checked in`,
          timestamp: attendance.checkIn.time,
          id: attendance._id,
        });
      }
    });

    // Sort all activities by timestamp
    activities.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    // Return top N activities
    const topActivities = activities.slice(0, limit);

    res.json({
      success: true,
      data: topActivities,
    });
  } catch (error) {
    console.error("[DASHBOARD] Error:", error);
    res.status(500).json({ message: "Failed to get recent activity", error: error.message });
  }
};

// Get performance metrics
exports.getPerformanceMetrics = async (req, res) => {
  try {
    const cafeId = await getCafeId(req.user);
    if (!cafeId) {
      return res.status(403).json({ message: "Access denied. No cafe associated with this user." });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);
    const monthAgo = new Date(today);
    monthAgo.setMonth(monthAgo.getMonth() - 1);

    // Weekly revenue
    const weeklyOrders = await Order.find({
      cartId: cafeId,
      createdAt: { $gte: weekAgo },
      status: ORDER_STATUSES.COMPLETED,
      paymentStatus: PAYMENT_STATUSES.PAID,
    }).lean();

    const weeklyRevenue = weeklyOrders.reduce((sum, order) => sum + (order.totalAmount || 0), 0);

    // Monthly revenue
    const monthlyOrders = await Order.find({
      cartId: cafeId,
      createdAt: { $gte: monthAgo },
      status: ORDER_STATUSES.COMPLETED,
      paymentStatus: PAYMENT_STATUSES.PAID,
    }).lean();

    const monthlyRevenue = monthlyOrders.reduce((sum, order) => sum + (order.totalAmount || 0), 0);

    // Average order value
    const avgOrderValue = weeklyOrders.length > 0
      ? weeklyRevenue / weeklyOrders.length
      : 0;

    // Orders per day (last 7 days)
    const ordersPerDay = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const nextDate = new Date(date);
      nextDate.setDate(nextDate.getDate() + 1);

      const dayOrders = await Order.countDocuments({
        cartId: cafeId,
        createdAt: { $gte: date, $lt: nextDate },
        status: ORDER_STATUSES.COMPLETED,
        paymentStatus: PAYMENT_STATUSES.PAID,
      });

      ordersPerDay.push({
        date: date.toISOString().split("T")[0],
        count: dayOrders,
      });
    }

    res.json({
      success: true,
      data: {
        weeklyRevenue,
        monthlyRevenue,
        avgOrderValue,
        ordersPerDay,
        totalOrders: weeklyOrders.length,
      },
    });
  } catch (error) {
    console.error("[DASHBOARD] Error:", error);
    res.status(500).json({ message: "Failed to get performance metrics", error: error.message });
  }
};

