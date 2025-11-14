const RevenueHistory = require("../models/revenueHistoryModel");
const Order = require("../models/orderModel");
const { Payment } = require("../models/paymentModel");
const User = require("../models/userModel");

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
      status: "Paid",
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
    const cafeMap = new Map();

    for (const order of orders) {
      const franchiseId = order.franchiseId?.toString() || order.franchiseId;
      const cafeId = order.cafeId?.toString() || order.cafeId;

      if (franchiseId && activeFranchiseIds.has(franchiseId)) {
        if (!franchiseMap.has(franchiseId)) {
          franchiseMap.set(franchiseId, {
            franchiseId,
            revenue: 0,
            cafeIds: new Set(),
          });
        }
        const franchise = franchiseMap.get(franchiseId);
        const orderTotal = order.kotLines.reduce((sum, kot) => sum + Number(kot.totalAmount || 0), 0);
        franchise.revenue += orderTotal;
        if (cafeId) {
          franchise.cafeIds.add(cafeId);
        }
      }

      if (cafeId) {
        const orderFranchiseId = order.franchiseId?.toString() || order.franchiseId;
        if (orderFranchiseId && activeFranchiseIds.has(orderFranchiseId)) {
          if (!cafeMap.has(cafeId)) {
            cafeMap.set(cafeId, {
              cafeId,
              franchiseId: orderFranchiseId,
              revenue: 0,
              orderCount: 0,
            });
          }
          const cafe = cafeMap.get(cafeId);
          const orderTotal = order.kotLines.reduce((sum, kot) => sum + Number(kot.totalAmount || 0), 0);
          cafe.revenue += orderTotal;
          cafe.orderCount += 1;
        }
      }
    }

    // Get franchise and cafe names (only active ones)
    const franchiseIds = Array.from(franchiseMap.keys());
    const cafeIds = Array.from(cafeMap.keys());
    const franchises = await User.find({ 
      _id: { $in: franchiseIds },
      role: "franchise_admin"
    }).select("name").lean();
    const cafes = await User.find({ 
      _id: { $in: cafeIds },
      role: "admin"
    }).select("name franchiseId").lean();

    const franchiseMapNames = new Map();
    franchises.forEach((f) => {
      franchiseMapNames.set(f._id.toString(), f.name);
    });

    const cafeMapNames = new Map();
    cafes.forEach((c) => {
      cafeMapNames.set(c._id.toString(), {
        name: c.name,
        franchiseId: c.franchiseId?.toString(),
      });
    });

    // Build franchise revenue array
    const franchiseRevenue = Array.from(franchiseMap.entries()).map(([id, data]) => ({
      franchiseId: id,
      franchiseName: franchiseMapNames.get(id) || "Unknown",
      revenue: data.revenue,
      cafeCount: data.cafeIds.size,
    }));

    // Build cafe revenue array
    const cafeRevenue = Array.from(cafeMap.entries()).map(([id, data]) => ({
      cafeId: id,
      cafeName: cafeMapNames.get(id)?.name || "Unknown",
      franchiseId: data.franchiseId,
      franchiseName: franchiseMapNames.get(data.franchiseId) || "Unknown",
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
        cafeRevenue,
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
      status: "Paid",
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
    const cafeMap = new Map();

    for (const order of orders) {
      const franchiseId = order.franchiseId?.toString() || order.franchiseId;
      const cafeId = order.cafeId?.toString() || order.cafeId;

      if (franchiseId && activeFranchiseIds.has(franchiseId)) {
        if (!franchiseMap.has(franchiseId)) {
          franchiseMap.set(franchiseId, {
            franchiseId,
            revenue: 0,
            cafeIds: new Set(),
          });
        }
        const franchise = franchiseMap.get(franchiseId);
        const orderTotal = order.kotLines.reduce((sum, kot) => sum + Number(kot.totalAmount || 0), 0);
        franchise.revenue += orderTotal;
        if (cafeId) {
          franchise.cafeIds.add(cafeId);
        }
      }

      if (cafeId) {
        const orderFranchiseId = order.franchiseId?.toString() || order.franchiseId;
        if (orderFranchiseId && activeFranchiseIds.has(orderFranchiseId)) {
          if (!cafeMap.has(cafeId)) {
            cafeMap.set(cafeId, {
              cafeId,
              franchiseId: orderFranchiseId,
              revenue: 0,
              orderCount: 0,
            });
          }
          const cafe = cafeMap.get(cafeId);
          const orderTotal = order.kotLines.reduce((sum, kot) => sum + Number(kot.totalAmount || 0), 0);
          cafe.revenue += orderTotal;
          cafe.orderCount += 1;
        }
      }
    }

    // Get franchise and cafe names (only active ones)
    const franchiseIds = Array.from(franchiseMap.keys());
    const cafeIds = Array.from(cafeMap.keys());
    const franchises = await User.find({ 
      _id: { $in: franchiseIds },
      role: "franchise_admin"
    }).select("name").lean();
    const cafes = await User.find({ 
      _id: { $in: cafeIds },
      role: "admin"
    }).select("name franchiseId").lean();

    const franchiseMapNames = new Map();
    franchises.forEach((f) => {
      franchiseMapNames.set(f._id.toString(), f.name);
    });

    const cafeMapNames = new Map();
    cafes.forEach((c) => {
      cafeMapNames.set(c._id.toString(), {
        name: c.name,
        franchiseId: c.franchiseId?.toString(),
      });
    });

    // Build franchise revenue array
    const franchiseRevenue = Array.from(franchiseMap.entries()).map(([id, data]) => ({
      franchiseId: id,
      franchiseName: franchiseMapNames.get(id) || "Unknown",
      revenue: data.revenue,
      cafeCount: data.cafeIds.size,
    }));

    // Build cafe revenue array
    const cafeRevenue = Array.from(cafeMap.entries()).map(([id, data]) => ({
      cafeId: id,
      cafeName: cafeMapNames.get(id)?.name || "Unknown",
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
        cafeRevenue,
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
    // First, get all ACTIVE franchises (franchise_admin users that exist AND are active)
    const activeFranchises = await User.find({ 
      role: "franchise_admin",
      isActive: true  // Only active franchises
    }).select("_id name").lean();
    
    const activeFranchiseIds = new Set(
      activeFranchises.map(f => f._id.toString())
    );
    
    // Create a map for franchise names
    const franchiseNameMap = new Map();
    activeFranchises.forEach((f) => {
      franchiseNameMap.set(f._id.toString(), f.name);
    });

    // Get all paid orders (including from deleted franchises - they're preserved)
    const allOrders = await Order.find({ status: "Paid" }).lean();
    
    // Filter orders to only include those from ACTIVE franchises
    const activeOrders = allOrders.filter(order => {
      const franchiseId = order.franchiseId?.toString() || order.franchiseId;
      return franchiseId && activeFranchiseIds.has(franchiseId);
    });

    // Calculate total revenue ONLY from active franchises
    const totalRevenue = calculateOrderRevenue(activeOrders);

    // Get franchise breakdown (only active franchises)
    const franchiseMap = new Map();
    const cafeMap = new Map();

    for (const order of activeOrders) {
      const franchiseId = order.franchiseId?.toString() || order.franchiseId;
      const cafeId = order.cafeId?.toString() || order.cafeId;

      // Only process orders from active franchises
      if (franchiseId && activeFranchiseIds.has(franchiseId)) {
        if (!franchiseMap.has(franchiseId)) {
          franchiseMap.set(franchiseId, {
            franchiseId,
            revenue: 0,
            cafeIds: new Set(),
          });
        }
        const franchise = franchiseMap.get(franchiseId);
        const orderTotal = order.kotLines.reduce((sum, kot) => sum + Number(kot.totalAmount || 0), 0);
        franchise.revenue += orderTotal;
        if (cafeId) {
          franchise.cafeIds.add(cafeId);
        }
      }

      // Only process cafes from active franchises
      if (cafeId) {
        const orderFranchiseId = order.franchiseId?.toString() || order.franchiseId;
        if (orderFranchiseId && activeFranchiseIds.has(orderFranchiseId)) {
          if (!cafeMap.has(cafeId)) {
            cafeMap.set(cafeId, {
              cafeId,
              franchiseId: orderFranchiseId,
              revenue: 0,
              orderCount: 0,
            });
          }
          const cafe = cafeMap.get(cafeId);
          const orderTotal = order.kotLines.reduce((sum, kot) => sum + Number(kot.totalAmount || 0), 0);
          cafe.revenue += orderTotal;
          cafe.orderCount += 1;
        }
      }
    }

    // Get cafe names (only for active cafes under active franchises)
    const cafeIds = Array.from(cafeMap.keys());
    const cafes = await User.find({ 
      _id: { $in: cafeIds },
      role: "admin"
    }).select("name franchiseId").lean();

    const cafeMapNames = new Map();
    cafes.forEach((c) => {
      cafeMapNames.set(c._id.toString(), {
        name: c.name,
        franchiseId: c.franchiseId?.toString(),
      });
    });

    // Build franchise revenue array (only active franchises)
    const franchiseRevenue = Array.from(franchiseMap.entries()).map(([id, data]) => ({
      franchiseId: id,
      franchiseName: franchiseNameMap.get(id) || "Unknown",
      revenue: data.revenue,
      cafeCount: data.cafeIds.size,
    }));

    // Build cafe revenue array (only active cafes)
    const cafeRevenue = Array.from(cafeMap.entries()).map(([id, data]) => ({
      cafeId: id,
      cafeName: cafeMapNames.get(id)?.name || "Unknown",
      franchiseId: data.franchiseId,
      franchiseName: franchiseNameMap.get(data.franchiseId) || "Unknown",
      revenue: data.revenue,
      orderCount: data.orderCount,
    }));

    // Count orders from deleted franchises (for information, not included in revenue)
    const deletedFranchiseOrders = allOrders.filter(order => {
      const franchiseId = order.franchiseId?.toString() || order.franchiseId;
      return franchiseId && !activeFranchiseIds.has(franchiseId);
    });
    const deletedFranchiseRevenue = calculateOrderRevenue(deletedFranchiseOrders);

    res.json({
      success: true,
      data: {
        totalRevenue, // Only from active franchises
        franchiseRevenue, // Only active franchises
        cafeRevenue, // Only active cafes
        totalOrders: activeOrders.length, // Only from active franchises
        calculatedAt: new Date(),
        // Additional info about preserved data from deleted franchises
        preservedData: {
          deletedFranchiseOrdersCount: deletedFranchiseOrders.length,
          deletedFranchiseRevenue: deletedFranchiseRevenue,
          note: "Paid orders from deleted franchises are preserved in database but excluded from active revenue calculations"
        }
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
    
    if (req.user.role !== "franchise_admin") {
      return res.status(403).json({
        success: false,
        message: "Only franchise admins can access this endpoint",
      });
    }

    // Get all paid orders for this franchise from database
    // These orders are permanently stored in MongoDB and persist after logout
    const orders = await Order.find({
      status: "Paid",
      franchiseId: franchiseId,
    }).lean();

    const totalRevenue = calculateOrderRevenue(orders);

    // Get cafe breakdown for this franchise
    const cafeMap = new Map();

    for (const order of orders) {
      const cafeId = order.cafeId?.toString() || order.cafeId;

      if (cafeId) {
        if (!cafeMap.has(cafeId)) {
          cafeMap.set(cafeId, {
            cafeId,
            revenue: 0,
            orderCount: 0,
          });
        }
        const cafe = cafeMap.get(cafeId);
        const orderTotal = order.kotLines.reduce((sum, kot) => sum + Number(kot.totalAmount || 0), 0);
        cafe.revenue += orderTotal;
        cafe.orderCount += 1;
      }
    }

    // Get cafe names
    const cafeIds = Array.from(cafeMap.keys());
    const cafes = await User.find({ _id: { $in: cafeIds } }).select("name").lean();

    const cafeMapNames = new Map();
    cafes.forEach((c) => {
      cafeMapNames.set(c._id.toString(), c.name);
    });

    const cafeRevenue = Array.from(cafeMap.entries()).map(([id, data]) => ({
      cafeId: id,
      cafeName: cafeMapNames.get(id) || "Unknown",
      revenue: data.revenue,
      orderCount: data.orderCount,
    }));

    // Get revenue by date range (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    thirtyDaysAgo.setHours(0, 0, 0, 0);

    // Get recent orders - use paidAt if available, otherwise use updatedAt as fallback
    const recentOrders = orders.filter(order => {
      const paidDate = order.paidAt ? new Date(order.paidAt) : (order.updatedAt ? new Date(order.updatedAt) : null);
      return paidDate && paidDate >= thirtyDaysAgo;
    });

    const recentRevenue = calculateOrderRevenue(recentOrders);

    // Get daily breakdown for last 30 days
    const dailyBreakdown = [];
    for (let i = 29; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      date.setHours(0, 0, 0, 0);
      
      const endDate = new Date(date);
      endDate.setHours(23, 59, 59, 999);

      const dayOrders = recentOrders.filter(order => {
        // Use paidAt if available, otherwise fallback to updatedAt
        const paidDate = order.paidAt ? new Date(order.paidAt) : (order.updatedAt ? new Date(order.updatedAt) : null);
        return paidDate && paidDate >= date && paidDate <= endDate;
      });

      const dayRevenue = calculateOrderRevenue(dayOrders);
      dailyBreakdown.push({
        date: date.toISOString().split('T')[0],
        revenue: dayRevenue,
        orderCount: dayOrders.length,
      });
    }

    res.json({
      success: true,
      data: {
        franchiseId,
        franchiseName: req.user.name,
        totalRevenue,
        recentRevenue, // Last 30 days
        cafeRevenue,
        dailyBreakdown,
        totalOrders: orders.length,
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

