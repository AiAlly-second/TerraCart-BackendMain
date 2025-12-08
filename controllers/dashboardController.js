const Order = require("../models/orderModel");
const { Table } = require("../models/tableModel");
const InventoryItem = require("../models/inventoryModel");
const EmployeeAttendance = require("../models/employeeAttendanceModel");
const Employee = require("../models/employeeModel");
const User = require("../models/userModel");

// Helper to get cafeId based on user role
const getCafeId = async (user) => {
  if (user.role === "admin") {
    return user._id;
  } else if (["waiter", "cook", "captain", "manager"].includes(user.role)) {
    // Mobile users - these are direct User records
    // Look up Employee record by email (since Employee doesn't have userId)
    const employee = await Employee.findOne({ email: user.email?.toLowerCase() }).lean();
    if (employee && employee.cafeId) {
      console.log('[DASHBOARD] getCafeId - Found employee by email:', {
        userId: user._id,
        email: user.email,
        employeeId: employee._id,
        cafeId: employee.cafeId
      });
      return employee.cafeId;
    }
    console.log('[DASHBOARD] getCafeId - No employee found for mobile user:', {
      userId: user._id,
      email: user.email,
      role: user.role
    });
    return null;
  } else if (user.role === "employee") {
    // Legacy employee role - look up Employee by email
    const employee = await Employee.findOne({ email: user.email?.toLowerCase() }).lean();
    return employee?.cafeId;
  }
  return null;
};

// Get dashboard statistics
exports.getDashboardStats = async (req, res) => {
  try {
    const cafeId = await getCafeId(req.user);
    if (!cafeId) {
      return res.status(403).json({ message: "Access denied. No cafe associated with this user." });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // Active orders (today, excluding all completed/inactive statuses)
    // Inactive statuses: Paid, Returned, Finalized, Cancelled, Exit (for takeaway)
    const activeOrders = await Order.countDocuments({
      cartId: cafeId,
      createdAt: { $gte: today },
      status: { 
        $nin: [
          "Finalized", 
          "Cancelled", 
          "Paid", 
          "Returned", 
          "Exit" // Takeaway final status
        ] 
      },
    });

    // Today's revenue - from orders that are Paid, Finalized, or Exit (includes both DINE_IN and TAKEAWAY)
    // Calculate revenue from kotLines totalAmount (sum of all kotLines in each order)
    const todayOrders = await Order.find({
      cartId: cafeId,
      createdAt: { $gte: today, $lt: tomorrow },
      status: { $in: ["Paid", "Finalized", "Exit"] },
    }).lean();

    const todayRevenue = todayOrders.reduce((sum, order) => {
      // For revenue calculation, sum all kotLines totalAmount
      // Each KOT represents items that were ordered and paid for
      if (!order.kotLines || order.kotLines.length === 0) {
        return sum;
      }
      const orderTotal = order.kotLines.reduce(
        (lineSum, kotLine) => lineSum + (Number(kotLine.totalAmount) || 0),
        0
      );
      return sum + orderTotal;
    }, 0);

    // Pending tasks (if you have a tasks model, otherwise return 0)
    const pendingTasks = 0; // TODO: Implement when tasks model is available

    // Pending KOTs (orders with status pending/preparing)
    const pendingKOTs = await Order.countDocuments({
      cartId: cafeId,
      status: { $in: ["Pending", "Confirmed", "Preparing", "Ready"] },
    });

    // Low stock items (threshold can be configured)
    const lowStockItems = await InventoryItem.countDocuments({
      cafeId: cafeId,
      $or: [
        { stockQuantity: { $lt: 10 } },
        { stockQuantity: { $exists: false } },
      ],
    });

    // Today's attendance count
    const todayAttendance = await EmployeeAttendance.countDocuments({
      cafeId: cafeId,
      date: { $gte: today, $lt: tomorrow },
      "checkIn.time": { $exists: true },
    });

    // Occupied tables (Table model uses cartId)
    const occupiedTables = await Table.countDocuments({
      cartId: cafeId,
      isOccupied: true,
    });

    // Total tables
    const totalTables = await Table.countDocuments({
      cartId: cafeId,
    });

    res.json({
      success: true,
      data: {
        activeOrders,
        todayRevenue,
        pendingTasks,
        pendingKOTs,
        lowStockItems,
        todayAttendance,
        occupiedTables,
        totalTables,
        availableTables: totalTables - occupiedTables,
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
      activities.push({
        type: "order",
        action: order.status === "Finalized" ? "completed" : order.status.toLowerCase(),
        description: `Order #${order.orderNumber || order._id} ${order.status}`,
        amount: order.totalAmount,
        timestamp: order.createdAt,
        id: order._id,
      });
    });

    // Recent attendance check-ins
    const recentAttendance = await EmployeeAttendance.find({
      cafeId: cafeId,
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
      status: "Finalized",
    }).lean();

    const weeklyRevenue = weeklyOrders.reduce((sum, order) => sum + (order.totalAmount || 0), 0);

    // Monthly revenue
    const monthlyOrders = await Order.find({
      cartId: cafeId,
      createdAt: { $gte: monthAgo },
      status: "Finalized",
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
        status: "Finalized",
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

