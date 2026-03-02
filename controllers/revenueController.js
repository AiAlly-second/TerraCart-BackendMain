const mongoose = require("mongoose");
const RevenueHistory = require("../models/revenueHistoryModel");
const Order = require("../models/orderModel");
const { Payment } = require("../models/paymentModel");
const User = require("../models/userModel");
const {
  ORDER_STATUSES,
  PAYMENT_STATUSES,
} = require("../utils/orderContract");

const SETTLED_ORDER_QUERY = Object.freeze({
  status: ORDER_STATUSES.COMPLETED,
  paymentStatus: PAYMENT_STATUSES.PAID,
});

// Helper function to calculate revenue from orders
function calculateOrderRevenue(orders) {
  return orders.reduce((sum, order) => {
    if (!order.kotLines || !Array.isArray(order.kotLines) || order.kotLines.length === 0) {
      return sum;
    }
    const orderTotal = order.kotLines.reduce((kotSum, kot) => {
      return kotSum + Number(kot.totalAmount || 0);
    }, 0);
    return sum + orderTotal;
  }, 0);
}

function isValidDateValue(date) {
  return date instanceof Date && !Number.isNaN(date.getTime());
}

function parseDateFilter(value, endOfDay = false) {
  if (!value) return null;
  const parsed = new Date(value);
  if (!isValidDateValue(parsed)) return null;
  if (endOfDay) {
    parsed.setHours(23, 59, 59, 999);
  } else {
    parsed.setHours(0, 0, 0, 0);
  }
  return parsed;
}

function resolveOrderPaidDate(order) {
  const candidate = order?.paidAt || order?.updatedAt || null;
  if (!candidate) return null;
  const parsed = new Date(candidate);
  return isValidDateValue(parsed) ? parsed : null;
}

// Calculate and store daily revenue
// IMPORTANT: Only includes revenue from ACTIVE franchises
exports.calculateDailyRevenue = async (req, res) => {
  try {
    const { date } = req.query;
    let targetDate = date ? new Date(date) : new Date();
    
    // Set to start of day
    targetDate.setHours(0, 0, 0, 0);
    const endDate = new Date(targetDate);
    endDate.setHours(23, 59, 59, 999);

    // Get all ACTIVE franchises first (only isActive=true)
    const activeFranchises = await User.find({ 
      role: "franchise_admin",
      isActive: true
    }).select("_id name").lean();
    
    const activeFranchiseIds = new Set(
      activeFranchises.map(f => f._id.toString())
    );

    // Get all paid orders for the day (including from deleted franchises - preserved)
    const allOrders = await Order.find({
      ...SETTLED_ORDER_QUERY,
      paidAt: {
        $gte: targetDate,
        $lte: endDate,
      },
    }).lean();

    // Filter to only include orders from ACTIVE franchises
    const orders = allOrders.filter(order => {
      const franchiseId = order.franchiseId?.toString() || order.franchiseId;
      return franchiseId && activeFranchiseIds.has(franchiseId);
    });

    // Calculate total revenue (only from active franchises)
    const totalRevenue = calculateOrderRevenue(orders);

    // Get franchise breakdown (only active franchises)
    const franchiseMap = new Map();
    const cartMap = new Map();

    for (const order of orders) {
      const franchiseId = order.franchiseId?.toString() || order.franchiseId;
      const cartId = order.cartId?.toString() || order.cartId;

      if (franchiseId && activeFranchiseIds.has(franchiseId)) {
        if (!franchiseMap.has(franchiseId)) {
          franchiseMap.set(franchiseId, {
            franchiseId,
            revenue: 0,
            cartIds: new Set(),
          });
        }
        const franchise = franchiseMap.get(franchiseId);
        const orderTotal = order.kotLines.reduce((sum, kot) => sum + Number(kot.totalAmount || 0), 0);
        franchise.revenue += orderTotal;
        if (cartId) {
          franchise.cartIds.add(cartId);
        }
      }

      if (cartId) {
        const orderFranchiseId = order.franchiseId?.toString() || order.franchiseId;
        if (orderFranchiseId && activeFranchiseIds.has(orderFranchiseId)) {
          if (!cartMap.has(cartId)) {
            cartMap.set(cartId, {
              cartId,
              franchiseId: orderFranchiseId,
              revenue: 0,
              orderCount: 0,
            });
          }
          const cart = cartMap.get(cartId);
          const orderTotal = order.kotLines.reduce((sum, kot) => sum + Number(kot.totalAmount || 0), 0);
          cart.revenue += orderTotal;
          cart.orderCount += 1;
        }
      }
    }

    // Get franchise and cart names (only active ones)
    const franchiseIds = Array.from(franchiseMap.keys());
    const cartIds = Array.from(cartMap.keys());
    const franchises = await User.find({ 
      _id: { $in: franchiseIds },
      role: "franchise_admin"
    }).select("name").lean();
    const carts = await User.find({ 
      _id: { $in: cartIds },
      role: "admin"
    }).select("name franchiseId").lean();

    const franchiseMapNames = new Map();
    franchises.forEach((f) => {
      franchiseMapNames.set(f._id.toString(), f.name);
    });

    const cartMapNames = new Map();
    carts.forEach((c) => {
      cartMapNames.set(c._id.toString(), {
        name: c.name,
        franchiseId: c.franchiseId?.toString(),
      });
    });

    // Build franchise revenue array
    const franchiseRevenue = Array.from(franchiseMap.entries()).map(([id, data]) => ({
      franchiseId: id,
      franchiseName: franchiseMapNames.get(id) || "Unknown",
      revenue: data.revenue,
      cartCount: data.cartIds.size,
    }));

    // Build cafe revenue array
    const cartRevenue = Array.from(cartMap.entries()).map(([id, data]) => ({
      cartId: id,
      cartName: cartMapNames.get(id)?.name || "Unknown",
      franchiseId: data.franchiseId,
      franchiseName: franchiseMapNames.get(data.franchiseId?.toString()) || "Unknown",
      revenue: data.revenue,
      orderCount: data.orderCount,
    }));

    // Store or update daily revenue
    const dailyRevenue = await RevenueHistory.findOneAndUpdate(
      {
        date: targetDate,
        periodType: "daily",
      },
      {
        date: targetDate,
        periodType: "daily",
        totalRevenue,
        franchiseRevenue,
        cartRevenue,
        totalOrders: orders.length,
        totalPayments: orders.length,
        calculatedAt: new Date(),
      },
      {
        upsert: true,
        new: true,
      }
    );

    res.json({
      success: true,
      data: dailyRevenue,
      message: "Daily revenue calculated and stored",
    });
  } catch (error) {
    console.error("Error calculating daily revenue:", error);
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// Calculate and store monthly revenue
// IMPORTANT: Only includes revenue from ACTIVE franchises
exports.calculateMonthlyRevenue = async (req, res) => {
  try {
    const { year, month } = req.query;
    let targetDate = new Date();
    
    if (year && month) {
      targetDate = new Date(parseInt(year), parseInt(month) - 1, 1);
    } else {
      // Default to current month
      targetDate = new Date(targetDate.getFullYear(), targetDate.getMonth(), 1);
    }

    const startDate = new Date(targetDate);
    startDate.setHours(0, 0, 0, 0);
    
    const endDate = new Date(targetDate.getFullYear(), targetDate.getMonth() + 1, 0);
    endDate.setHours(23, 59, 59, 999);

    // Get all ACTIVE franchises first (only isActive=true)
    const activeFranchises = await User.find({ 
      role: "franchise_admin",
      isActive: true
    }).select("_id name").lean();
    
    const activeFranchiseIds = new Set(
      activeFranchises.map(f => f._id.toString())
    );

    // Get all paid orders for the month (including from deleted franchises - preserved)
    const allOrders = await Order.find({
      ...SETTLED_ORDER_QUERY,
      paidAt: {
        $gte: startDate,
        $lte: endDate,
      },
    }).lean();

    // Filter to only include orders from ACTIVE franchises
    const orders = allOrders.filter(order => {
      const franchiseId = order.franchiseId?.toString() || order.franchiseId;
      return franchiseId && activeFranchiseIds.has(franchiseId);
    });

    // Calculate total revenue (only from active franchises)
    const totalRevenue = calculateOrderRevenue(orders);

    // Get franchise breakdown (only active franchises)
    const franchiseMap = new Map();
    const cartMap = new Map();

    for (const order of orders) {
      const franchiseId = order.franchiseId?.toString() || order.franchiseId;
      const cartId = order.cartId?.toString() || order.cartId;

      if (franchiseId && activeFranchiseIds.has(franchiseId)) {
        if (!franchiseMap.has(franchiseId)) {
          franchiseMap.set(franchiseId, {
            franchiseId,
            revenue: 0,
            cartIds: new Set(),
          });
        }
        const franchise = franchiseMap.get(franchiseId);
        const orderTotal = order.kotLines.reduce((sum, kot) => sum + Number(kot.totalAmount || 0), 0);
        franchise.revenue += orderTotal;
        if (cartId) {
          franchise.cartIds.add(cartId);
        }
      }

      if (cartId) {
        const orderFranchiseId = order.franchiseId?.toString() || order.franchiseId;
        if (orderFranchiseId && activeFranchiseIds.has(orderFranchiseId)) {
          if (!cartMap.has(cartId)) {
            cartMap.set(cartId, {
              cartId,
              franchiseId: orderFranchiseId,
              revenue: 0,
              orderCount: 0,
            });
          }
          const cart = cartMap.get(cartId);
          const orderTotal = order.kotLines.reduce((sum, kot) => sum + Number(kot.totalAmount || 0), 0);
          cart.revenue += orderTotal;
          cart.orderCount += 1;
        }
      }
    }

    // Get franchise and cart names (only active ones)
    const franchiseIds = Array.from(franchiseMap.keys());
    const cartIds = Array.from(cartMap.keys());
    const franchises = await User.find({ 
      _id: { $in: franchiseIds },
      role: "franchise_admin"
    }).select("name").lean();
    const carts = await User.find({ 
      _id: { $in: cartIds },
      role: "admin"
    }).select("name franchiseId").lean();

    const franchiseMapNames = new Map();
    franchises.forEach((f) => {
      franchiseMapNames.set(f._id.toString(), f.name);
    });

    const cartMapNames = new Map();
    carts.forEach((c) => {
      cartMapNames.set(c._id.toString(), {
        name: c.name,
        franchiseId: c.franchiseId?.toString(),
      });
    });

    // Build franchise revenue array
    const franchiseRevenue = Array.from(franchiseMap.entries()).map(([id, data]) => ({
      franchiseId: id,
      franchiseName: franchiseMapNames.get(id) || "Unknown",
      revenue: data.revenue,
      cartCount: data.cartIds.size,
    }));

    // Build cafe revenue array
    const cartRevenue = Array.from(cartMap.entries()).map(([id, data]) => ({
      cartId: id,
      cartName: cartMapNames.get(id)?.name || "Unknown",
      franchiseId: data.franchiseId,
      franchiseName: franchiseMapNames.get(data.franchiseId) || "Unknown",
      revenue: data.revenue,
      orderCount: data.orderCount,
    }));

    // Store or update monthly revenue
    const monthlyRevenue = await RevenueHistory.findOneAndUpdate(
      {
        date: startDate,
        periodType: "monthly",
      },
      {
        date: startDate,
        periodType: "monthly",
        totalRevenue,
        franchiseRevenue,
        cartRevenue,
        totalOrders: orders.length,
        totalPayments: orders.length,
        calculatedAt: new Date(),
      },
      {
        upsert: true,
        new: true,
      }
    );

    res.json({
      success: true,
      data: monthlyRevenue,
      message: "Monthly revenue calculated and stored",
    });
  } catch (error) {
    console.error("Error calculating monthly revenue:", error);
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// Get revenue history
exports.getRevenueHistory = async (req, res) => {
  try {
    const { periodType, startDate, endDate, limit = 30 } = req.query;

    const query = {};
    
    if (periodType) {
      query.periodType = periodType;
    }

    if (startDate || endDate) {
      query.date = {};
      if (startDate) {
        query.date.$gte = new Date(startDate);
      }
      if (endDate) {
        query.date.$lte = new Date(endDate);
      }
    }

    const history = await RevenueHistory.find(query)
      .sort({ date: -1 })
      .limit(parseInt(limit))
      .lean();

    res.json({
      success: true,
      data: history,
      count: history.length,
    });
  } catch (error) {
    console.error("Error fetching revenue history:", error);
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// Get current revenue (real-time calculation)
// IMPORTANT: Only includes revenue from ACTIVE franchises (franchises that still exist in User collection)
// Paid orders from deleted franchises are preserved in database but excluded from revenue calculations
exports.getCurrentRevenue = async (req, res) => {
  try {
    // NOTE: current implementation uses in-memory aggregation over all paid orders.
    // For high scale, replace this with a MongoDB aggregation pipeline like below:
    //
    // const pipeline = [
    //   { $match: { status: "Paid" } },
    //   {
    //     $group: {
    //       _id: "$franchiseId",
    //       revenue: {
    //         $sum: {
    //           $sum: {
    //             $map: {
    //               input: "$kotLines",
    //               as: "kot",
    //               in: { $toDouble: { $ifNull: ["$$kot.totalAmount", 0] } }
    //             }
    //           }
    //         }
    //       },
    //       orderCount: { $sum: 1 },
    //       cartIds: { $addToSet: "$cartId" }
    //     }
    //   }
    // ];
    //
    // const franchiseAgg = await Order.aggregate(pipeline);
    //
    // For now, keep existing logic but this comment shows the target approach.

    // Existing implementation (works, but not optimal for millions of orders)
    const activeFranchises = await User.find({ 
      role: "franchise_admin",
      isActive: true
    }).select("_id name").lean();
    
    const activeFranchiseIds = new Set(activeFranchises.map(f => f._id.toString()));

    const franchiseNameMap = new Map();
    activeFranchises.forEach((f) => {
      franchiseNameMap.set(f._id.toString(), f.name);
    });

    const allOrders = await Order.find(SETTLED_ORDER_QUERY).lean();
    const activeOrders = allOrders.filter(order => {
      const franchiseId = order.franchiseId?.toString() || order.franchiseId;
      return franchiseId && activeFranchiseIds.has(franchiseId);
    });

    const totalRevenue = calculateOrderRevenue(activeOrders);

    const franchiseMap = new Map();
    const cartMap = new Map();

    for (const order of activeOrders) {
      const franchiseId = order.franchiseId?.toString() || order.franchiseId;
      const cartId = order.cartId?.toString() || order.cartId;

      if (franchiseId && activeFranchiseIds.has(franchiseId)) {
        if (!franchiseMap.has(franchiseId)) {
          franchiseMap.set(franchiseId, {
            franchiseId,
            revenue: 0,
            cartIds: new Set(),
          });
        }
        const franchise = franchiseMap.get(franchiseId);
        const orderTotal = order.kotLines.reduce(
          (sum, kot) => sum + Number(kot.totalAmount || 0),
          0
        );
        franchise.revenue += orderTotal;
        if (cartId) {
          franchise.cartIds.add(cartId);
        }
      }

      if (cartId) {
        const orderFranchiseId = order.franchiseId?.toString() || order.franchiseId;
        if (orderFranchiseId && activeFranchiseIds.has(orderFranchiseId)) {
          if (!cartMap.has(cartId)) {
            cartMap.set(cartId, {
              cartId,
              franchiseId: orderFranchiseId,
              revenue: 0,
              orderCount: 0,
            });
          }
          const cart = cartMap.get(cartId);
          const orderTotal = order.kotLines.reduce(
            (sum, kot) => sum + Number(kot.totalAmount || 0),
            0
          );
          cart.revenue += orderTotal;
          cart.orderCount += 1;
        }
      }
    }

    const cartIds = Array.from(cartMap.keys());
    const carts = await User.find({ 
      _id: { $in: cartIds },
      role: "admin"
    }).select("name franchiseId").lean();

    const cartMapNames = new Map();
    carts.forEach((c) => {
      cartMapNames.set(c._id.toString(), {
        name: c.name,
        franchiseId: c.franchiseId?.toString(),
      });
    });

    // Get ALL active carts for each franchise (not just those with orders)
    const allActiveCarts = await User.find({
      role: "admin",
      franchiseId: { $in: Array.from(activeFranchiseIds) },
      isActive: true
    }).select("_id name franchiseId").lean();

    // Count carts per franchise
    const franchiseCartCountMap = new Map();
    allActiveCarts.forEach((cart) => {
      const cartFranchiseId = cart.franchiseId?.toString();
      if (cartFranchiseId && activeFranchiseIds.has(cartFranchiseId)) {
        const currentCount = franchiseCartCountMap.get(cartFranchiseId) || 0;
        franchiseCartCountMap.set(cartFranchiseId, currentCount + 1);
      }
    });

    const franchiseRevenue = Array.from(franchiseMap.entries()).map(([id, data]) => ({
      franchiseId: id,
      franchiseName: franchiseNameMap.get(id) || "Unknown",
      revenue: data.revenue,
      cartCount: franchiseCartCountMap.get(id) || 0, // Use actual cart count, not just carts with orders
    }));

    // Include all active carts, even if they have no orders (with 0 revenue)
    const allCartMap = new Map();
    
    // Add carts with orders
    cartMap.forEach((data, cartId) => {
      allCartMap.set(cartId, {
        cartId,
        cartName: cartMapNames.get(cartId)?.name || "Unknown",
        franchiseId: data.franchiseId,
        franchiseName: franchiseNameMap.get(data.franchiseId) || "Unknown",
        revenue: data.revenue,
        orderCount: data.orderCount,
      });
    });
    
    // Add carts without orders (to show all carts under each franchise)
    allActiveCarts.forEach((cart) => {
      const cartId = cart._id.toString();
      const cartFranchiseId = cart.franchiseId?.toString();
      
      if (cartFranchiseId && activeFranchiseIds.has(cartFranchiseId) && !allCartMap.has(cartId)) {
        allCartMap.set(cartId, {
          cartId,
          cartName: cart.name || "Unknown",
          franchiseId: cartFranchiseId,
          franchiseName: franchiseNameMap.get(cartFranchiseId) || "Unknown",
          revenue: 0,
          orderCount: 0,
        });
      }
    });

    const cartRevenue = Array.from(allCartMap.values());

    const deletedFranchiseOrders = allOrders.filter(order => {
      const franchiseId = order.franchiseId?.toString() || order.franchiseId;
      return franchiseId && !activeFranchiseIds.has(franchiseId);
    });
    const deletedFranchiseRevenue = calculateOrderRevenue(deletedFranchiseOrders);

    res.json({
      success: true,
      data: {
        totalRevenue,
        franchiseRevenue,
        cartRevenue,
        totalOrders: activeOrders.length,
        calculatedAt: new Date(),
        preservedData: {
          deletedFranchiseOrdersCount: deletedFranchiseOrders.length,
          deletedFranchiseRevenue,
          note: "Paid orders from deleted franchises are preserved in database but excluded from active revenue calculations",
        },
      },
    });
  } catch (error) {
    console.error("Error getting current revenue:", error);
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// Get franchise admin's own revenue (filtered by their franchiseId)
// IMPORTANT: Revenue is calculated from database orders (MongoDB)
// Data persists permanently - logout does NOT delete orders or revenue data
// Only paid orders are included in revenue calculations
exports.getFranchiseRevenue = async (req, res) => {
  try {
    const franchiseId = req.user._id.toString();
    const startDateParam = req.query?.startDate;
    const endDateParam = req.query?.endDate;
    
    if (req.user.role !== "franchise_admin") {
      return res.status(403).json({
        success: false,
        message: "Only franchise admins can access this endpoint",
      });
    }

    // Get all paid orders for this franchise from database
    // These orders are permanently stored in MongoDB and persist after logout
    // Convert franchiseId string to ObjectId for proper query matching
    let franchiseObjectId;
    try {
      franchiseObjectId = new mongoose.Types.ObjectId(franchiseId);
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: "Invalid franchise ID format",
      });
    }

    const hasStartDateParam =
      typeof startDateParam === "string" && startDateParam.trim() !== "";
    const hasEndDateParam =
      typeof endDateParam === "string" && endDateParam.trim() !== "";

    if (hasStartDateParam !== hasEndDateParam) {
      return res.status(400).json({
        success: false,
        message: "Both startDate and endDate are required for date range filtering",
      });
    }

    const rangeStart = hasStartDateParam
      ? parseDateFilter(startDateParam, false)
      : null;
    const rangeEnd = hasEndDateParam ? parseDateFilter(endDateParam, true) : null;

    if ((hasStartDateParam && !rangeStart) || (hasEndDateParam && !rangeEnd)) {
      return res.status(400).json({
        success: false,
        message: "Invalid date format. Use YYYY-MM-DD",
      });
    }

    if (rangeStart && rangeEnd && rangeStart > rangeEnd) {
      return res.status(400).json({
        success: false,
        message: "startDate cannot be after endDate",
      });
    }
    const isDateRangeApplied = Boolean(rangeStart && rangeEnd);
    
    const orders = await Order.find({
      ...SETTLED_ORDER_QUERY,
      franchiseId: franchiseObjectId,
    }).lean();

    const filteredOrders = isDateRangeApplied
      ? orders.filter((order) => {
          const paidDate = resolveOrderPaidDate(order);
          return paidDate && paidDate >= rangeStart && paidDate <= rangeEnd;
        })
      : orders;

    const totalRevenue = calculateOrderRevenue(filteredOrders);

    // Get cart breakdown for this franchise
    const cartMap = new Map();

    for (const order of filteredOrders) {
      const cartId = order.cartId?.toString() || order.cartId;

      if (cartId) {
        if (!cartMap.has(cartId)) {
          cartMap.set(cartId, {
            cartId,
            revenue: 0,
            orderCount: 0,
          });
        }
        const cart = cartMap.get(cartId);
        const orderTotal = order.kotLines.reduce((sum, kot) => sum + Number(kot.totalAmount || 0), 0);
        cart.revenue += orderTotal;
        cart.orderCount += 1;
      }
    }

    // Get cart names
    const cartIds = Array.from(cartMap.keys());
    const carts = await User.find({ _id: { $in: cartIds } }).select("name").lean();

    const cartMapNames = new Map();
    carts.forEach((c) => {
      cartMapNames.set(c._id.toString(), c.name);
    });

    const cartRevenue = Array.from(cartMap.entries()).map(([id, data]) => ({
      cartId: id,
      cartName: cartMapNames.get(id) || "Unknown",
      revenue: data.revenue,
      orderCount: data.orderCount,
    }));

    const buildDateKey = (date) => {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");
      return `${year}-${month}-${day}`;
    };

    const getOrderTotal = (order) =>
      (order.kotLines || []).reduce(
        (sum, kot) => sum + Number(kot.totalAmount || 0),
        0,
      );

    let recentRevenue = 0;
    let dailyBreakdown = [];

    if (isDateRangeApplied) {
      recentRevenue = totalRevenue;

      const dayMap = new Map();
      filteredOrders.forEach((order) => {
        const paidDate = resolveOrderPaidDate(order);
        if (!paidDate) return;
        const dateKey = buildDateKey(paidDate);
        if (!dayMap.has(dateKey)) {
          dayMap.set(dateKey, { revenue: 0, orderCount: 0 });
        }
        const bucket = dayMap.get(dateKey);
        bucket.revenue += getOrderTotal(order);
        bucket.orderCount += 1;
      });

      for (
        let cursor = new Date(rangeStart);
        cursor <= rangeEnd;
        cursor.setDate(cursor.getDate() + 1)
      ) {
        const dateKey = buildDateKey(cursor);
        const bucket = dayMap.get(dateKey) || { revenue: 0, orderCount: 0 };
        dailyBreakdown.push({
          date: dateKey,
          revenue: bucket.revenue,
          orderCount: bucket.orderCount,
        });
      }
    } else {
      // Get revenue by date range (last 30 days)
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      thirtyDaysAgo.setHours(0, 0, 0, 0);

      // Get recent orders - use paidAt if available, otherwise use updatedAt as fallback
      const recentOrders = orders.filter((order) => {
        const paidDate = resolveOrderPaidDate(order);
        return paidDate && paidDate >= thirtyDaysAgo;
      });

      recentRevenue = calculateOrderRevenue(recentOrders);

      // Get daily breakdown for last 30 days
      dailyBreakdown = [];
      for (let i = 29; i >= 0; i--) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        date.setHours(0, 0, 0, 0);

        const endDate = new Date(date);
        endDate.setHours(23, 59, 59, 999);

        const dayOrders = recentOrders.filter((order) => {
          // Use paidAt if available, otherwise fallback to updatedAt
          const paidDate = resolveOrderPaidDate(order);
          return paidDate && paidDate >= date && paidDate <= endDate;
        });

        const dayRevenue = calculateOrderRevenue(dayOrders);
        dailyBreakdown.push({
          date: date.toISOString().split("T")[0],
          revenue: dayRevenue,
          orderCount: dayOrders.length,
        });
      }
    }

    res.json({
      success: true,
      data: {
        franchiseId,
        franchiseName: req.user.name,
        totalRevenue,
        recentRevenue, // Last 30 days
        cartRevenue,
        dailyBreakdown,
        totalOrders: filteredOrders.length,
        dateRange: {
          startDate: rangeStart ? buildDateKey(rangeStart) : null,
          endDate: rangeEnd ? buildDateKey(rangeEnd) : null,
          isApplied: isDateRangeApplied,
        },
        calculatedAt: new Date(),
      },
    });
  } catch (error) {
    console.error("Error getting franchise revenue:", error);
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// export fully detailed revenue data
exports.getDetailedRevenueExport = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const query = { ...SETTLED_ORDER_QUERY };

    if (startDate || endDate) {
      query.paidAt = {};
      if (startDate) query.paidAt.$gte = new Date(startDate);
      if (endDate) query.paidAt.$lte = new Date(endDate);
    }

    // 1. Fetch orders with populated references
    const orders = await Order.find(query)
      .populate("franchiseId", "name")
      .populate("cartId", "name")
      .sort({ paidAt: -1 })
      .lean();

    // 2. Prepare flat data structures for different sheets
    const ordersData = [];
    const itemsData = [];

    for (const order of orders) {
      // Order level calculations
      const subtotal = (order.kotLines || []).reduce((sum, kot) => sum + (kot.subtotal || 0), 0);
      const gst = (order.kotLines || []).reduce((sum, kot) => sum + (kot.gst || 0), 0);
      const totalAmount = (order.kotLines || []).reduce((sum, kot) => sum + (kot.totalAmount || 0), 0);

      // Add to Orders Data
      ordersData.push({
        OrderID: order._id,
        InvoiceNo: `INV-${new Date(order.createdAt).toISOString().slice(0, 10).replace(/-/g, "")}-${(order._id || "").toString().slice(-6).toUpperCase()}`,
        Date: order.paidAt ? new Date(order.paidAt).toLocaleDateString() : 'N/A',
        Time: order.paidAt ? new Date(order.paidAt).toLocaleTimeString() : 'N/A',
        Franchise: order.franchiseId?.name || "Unknown",
        Cart: order.cartId?.name || "Unknown",
        ServiceType: order.serviceType,
        OrderType: order.orderType || "N/A", // Delivery/Pickup
        CustomerName: order.customerName || "N/A",
        Mobile: order.customerMobile || "N/A",
        PaymentMethod: order.paymentMethod || "CASH",
        Subtotal: subtotal.toFixed(2),
        GST: gst.toFixed(2),
        TotalAmount: totalAmount.toFixed(2),
      });

      // Process Items for Items Data
      if (order.kotLines) {
        order.kotLines.forEach((kot) => {
          if (kot.items) {
            kot.items.forEach((item) => {
              itemsData.push({
                OrderID: order._id,
                ItemName: item.name,
                Quantity: item.quantity,
                UnitPrice: item.price ? (item.price / 100).toFixed(2) : "0.00",
                TotalPrice: item.price ? ((item.price * item.quantity) / 100).toFixed(2) : "0.00",
                Isreturned: item.returned ? "Yes" : "No",
                IsTakeaway: item.convertedToTakeaway ? "Yes" : "No",
                Franchise: order.franchiseId?.name || "Unknown",
                Cart: order.cartId?.name || "Unknown",
              });
            });
          }
        });
      }
    }

    res.json({
      success: true,
      data: {
        orders: ordersData,
        items: itemsData,
        generatedAt: new Date(),
        recordCount: orders.length
      },
    });

  } catch (error) {
    console.error("Error exporting detailed revenue:", error);
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};
