const Order = require("../models/orderModel");
const Table = require("../models/tableModel").Table;
const InventoryItem = require("../models/inventoryModel");
const Task = require("../models/taskModel");
const CustomerRequest = require("../models/customerRequestModel");
const EmployeeAttendance = require("../models/employeeAttendanceModel");
const Employee = require("../models/employeeModel");
const { asyncHandler } = require("../utils/asyncHandler");

/**
 * @desc    Get dashboard statistics (role-based)
 * @route   GET /api/dashboard/stats
 * @access  Private
 */
exports.getDashboardStats = asyncHandler(async (req, res) => {
  const userRole = req.user.role;
  const query = {};

  // Data isolation - Filter based on role (same logic as tables/orders/requests)
  if (req.user && req.user.role === "admin" && req.user._id) {
    // Cafe admin - only see data from their cafe
    query.cafeId = req.user._id;
    query.cartId = req.user._id;
  } else if (req.user && req.user.role === "franchise_admin" && req.user._id) {
    // Franchise admin - only see data from cafes under their franchise
    query.franchiseId = req.user._id;
  } else if (req.user && ["waiter", "cook", "captain", "manager"].includes(req.user.role)) {
    // Mobile roles - filter by cartId (cafeId in user should match cartId/cafeId in data)
    let cafeId = req.user.cafeId;
    
    if (!cafeId) {
      // Fallback: Try to get cafeId from Employee model by matching name
      const employee = await Employee.findOne({ 
        name: req.user.name
      }).select('cafeId franchiseId').lean();
      if (employee && employee.cafeId) {
        cafeId = employee.cafeId;
      }
    }
    
    if (cafeId) {
      // Filter by cartId (which references the cafe admin's user ID)
      query.cafeId = cafeId;
      query.cartId = cafeId;
    } else if (req.user.franchiseId) {
      // Fallback to franchiseId if cafeId not available
      query.franchiseId = req.user.franchiseId;
    }
  } else if (req.user && req.user.cafeId) {
    // For other roles with cafeId, use it directly
    query.cafeId = req.user.cafeId;
    query.cartId = req.user.cafeId;
  } else if (req.user && req.user.franchiseId) {
    // For other roles with franchiseId, use it directly
    query.franchiseId = req.user.franchiseId;
  }
  // For super_admin, no filter (see all data)

  const stats = {};

  // Common stats for all roles
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  // Role-based stats
  if (userRole === "waiter" || userRole === "cashier" || userRole === "cleaner") {
    // Staff stats
    const orderQuery = { ...query, createdAt: { $gte: today, $lt: tomorrow } };
    const tableQuery = { ...query };

    const [todayOrders, activeTables, pendingRequests, myTasks] = await Promise.all([
      Order.countDocuments(orderQuery),
      Table.countDocuments({ ...tableQuery, status: "OCCUPIED" }),
      CustomerRequest.countDocuments({ ...query, status: "pending" }),
      (async () => {
        const employee = await Employee.findOne({
          $or: [
            { _id: req.user.employeeId },
            { userId: req.user._id }
          ]
        });
        if (employee) {
          return Task.countDocuments({ ...query, assignedTo: employee._id, status: { $ne: "completed" } });
        }
        return Task.countDocuments({ ...query, assignedToUser: req.user._id, status: { $ne: "completed" } });
      })(),
    ]);

    stats.todayOrders = todayOrders;
    stats.activeTables = activeTables;
    stats.pendingRequests = pendingRequests;
    stats.myTasks = myTasks;

  } else if (userRole === "chef" || userRole === "cook") {
    // Cook stats
    const kotQuery = {
      ...query,
      kotLines: { $exists: true, $ne: [] },
      status: { $in: ["Pending", "Confirmed", "Preparing"] },
    };

    const [pendingKOTs, preparingKOTs, lowStockItems] = await Promise.all([
      Order.countDocuments({ ...kotQuery, status: "Pending" }),
      Order.countDocuments({ ...kotQuery, status: "Preparing" }),
      // Low stock items for cook: use $expr to compare quantity vs minStockLevel
      InventoryItem.countDocuments({
        ...query,
        $expr: { $lte: ["$quantity", "$minStockLevel"] },
        isActive: true,
      }),
    ]);

    stats.pendingKOTs = pendingKOTs;
    stats.preparingKOTs = preparingKOTs;
    stats.lowStockItems = lowStockItems;

  } else if (userRole === "manager" || userRole === "admin" || userRole === "franchise_admin") {
    // Manager/Admin stats
    const orderQuery = { ...query, createdAt: { $gte: today, $lt: tomorrow } };
    const tableQuery = { ...query };

    const [
      todayOrders,
      todayRevenue,
      activeTables,
      totalTables,
      pendingRequests,
      totalTasks,
      completedTasks,
      lowStockItems,
      expiringCompliance,
    ] = await Promise.all([
      Order.countDocuments(orderQuery),
      (async () => {
        const orders = await Order.find({ ...orderQuery, status: "Paid" }).lean();
        return orders.reduce((sum, order) => {
          if (order.kotLines && order.kotLines.length > 0) {
            const lastKOT = order.kotLines[order.kotLines.length - 1];
            return sum + (lastKOT.totalAmount || 0);
          }
          return sum;
        }, 0);
      })(),
      Table.countDocuments({ ...tableQuery, status: "OCCUPIED" }),
      Table.countDocuments(tableQuery),
      CustomerRequest.countDocuments({ ...query, status: "pending" }),
      Task.countDocuments(query),
      Task.countDocuments({ ...query, status: "completed" }),
      InventoryItem.countDocuments({
        ...query,
        $expr: { $lte: ["$quantity", "$minStockLevel"] },
        isActive: true,
      }),
      (async () => {
        const Compliance = require("../models/complianceModel");
        const futureDate = new Date();
        futureDate.setDate(futureDate.getDate() + 30);
        return Compliance.countDocuments({
          ...query,
          expiryDate: { $lte: futureDate, $gte: new Date() },
          status: { $ne: "expired" },
        });
      })(),
    ]);

    stats.todayOrders = todayOrders;
    stats.todayRevenue = todayRevenue;
    stats.activeTables = activeTables;
    stats.totalTables = totalTables;
    stats.pendingRequests = pendingRequests;
    stats.totalTasks = totalTasks;
    stats.completedTasks = completedTasks;
    stats.lowStockItems = lowStockItems;
    stats.expiringCompliance = expiringCompliance;
  }

  res.status(200).json({
    success: true,
    data: stats,
  });
});

/**
 * @desc    Get recent activity
 * @route   GET /api/dashboard/recent-activity
 * @access  Private
 */
exports.getRecentActivity = asyncHandler(async (req, res) => {
  const { limit = 20 } = req.query;
  const query = {};

  // Data isolation
  if (req.user.cafeId) {
    query.cafeId = req.user.cafeId;
    query.cartId = req.user.cafeId;
  } else if (req.user.franchiseId) {
    query.franchiseId = req.user.franchiseId;
  }

  const activities = [];

  // Recent orders
  const recentOrders = await Order.find(query)
    .populate("table", "number name")
    .sort("-createdAt")
    .limit(5)
    .lean();

  recentOrders.forEach((order) => {
    activities.push({
      type: "order",
      action: "created",
      message: `Order #${order._id} created for ${order.tableNumber || "Takeaway"}`,
      timestamp: order.createdAt,
      data: { orderId: order._id, status: order.status },
    });
  });

  // Recent requests
  const recentRequests = await CustomerRequest.find(query)
    .populate("tableId", "number name")
    .sort("-createdAt")
    .limit(5)
    .lean();

  recentRequests.forEach((request) => {
    activities.push({
      type: "request",
      action: request.status,
      message: `${request.requestType} request from Table ${request.tableId?.number || "N/A"}`,
      timestamp: request.createdAt,
      data: { requestId: request._id, status: request.status },
    });
  });

  // Recent tasks
  const recentTasks = await Task.find(query)
    .populate("assignedTo", "name")
    .sort("-createdAt")
    .limit(5)
    .lean();

  recentTasks.forEach((task) => {
    activities.push({
      type: "task",
      action: task.status,
      message: `Task "${task.title}" ${task.status}`,
      timestamp: task.createdAt,
      data: { taskId: task._id, status: task.status },
    });
  });

  // Sort by timestamp and limit
  activities.sort((a, b) => b.timestamp - a.timestamp);
  activities.splice(parseInt(limit));

  res.status(200).json({
    success: true,
    data: activities,
  });
});

/**
 * @desc    Get performance metrics
 * @route   GET /api/dashboard/performance
 * @access  Private (Manager only)
 */
exports.getPerformanceMetrics = asyncHandler(async (req, res) => {
  const query = {};

  // Data isolation
  if (req.user.cafeId) {
    query.cafeId = req.user.cafeId;
    query.cartId = req.user.cafeId;
  } else if (req.user.franchiseId) {
    query.franchiseId = req.user.franchiseId;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const weekAgo = new Date(today);
  weekAgo.setDate(weekAgo.getDate() - 7);
  const monthAgo = new Date(today);
  monthAgo.setMonth(monthAgo.getMonth() - 1);

  const [
    todayOrders,
    weekOrders,
    monthOrders,
    todayRevenue,
    weekRevenue,
    monthRevenue,
    avgOrderValue,
    taskCompletionRate,
  ] = await Promise.all([
    Order.countDocuments({ ...query, createdAt: { $gte: today } }),
    Order.countDocuments({ ...query, createdAt: { $gte: weekAgo } }),
    Order.countDocuments({ ...query, createdAt: { $gte: monthAgo } }),
    (async () => {
      const orders = await Order.find({ ...query, status: "Paid", createdAt: { $gte: today } }).lean();
      return orders.reduce((sum, order) => {
        if (order.kotLines && order.kotLines.length > 0) {
          const lastKOT = order.kotLines[order.kotLines.length - 1];
          return sum + (lastKOT.totalAmount || 0);
        }
        return sum;
      }, 0);
    })(),
    (async () => {
      const orders = await Order.find({ ...query, status: "Paid", createdAt: { $gte: weekAgo } }).lean();
      return orders.reduce((sum, order) => {
        if (order.kotLines && order.kotLines.length > 0) {
          const lastKOT = order.kotLines[order.kotLines.length - 1];
          return sum + (lastKOT.totalAmount || 0);
        }
        return sum;
      }, 0);
    })(),
    (async () => {
      const orders = await Order.find({ ...query, status: "Paid", createdAt: { $gte: monthAgo } }).lean();
      return orders.reduce((sum, order) => {
        if (order.kotLines && order.kotLines.length > 0) {
          const lastKOT = order.kotLines[order.kotLines.length - 1];
          return sum + (lastKOT.totalAmount || 0);
        }
        return sum;
      }, 0);
    })(),
    (async () => {
      const orders = await Order.find({ ...query, status: "Paid", createdAt: { $gte: monthAgo } }).lean();
      if (orders.length === 0) return 0;
      const total = orders.reduce((sum, order) => {
        if (order.kotLines && order.kotLines.length > 0) {
          const lastKOT = order.kotLines[order.kotLines.length - 1];
          return sum + (lastKOT.totalAmount || 0);
        }
        return sum;
      }, 0);
      return total / orders.length;
    })(),
    (async () => {
      const total = await Task.countDocuments(query);
      const completed = await Task.countDocuments({ ...query, status: "completed" });
      return total > 0 ? (completed / total) * 100 : 0;
    })(),
  ]);

  res.status(200).json({
    success: true,
    data: {
      orders: {
        today: todayOrders,
        week: weekOrders,
        month: monthOrders,
      },
      revenue: {
        today: todayRevenue,
        week: weekRevenue,
        month: monthRevenue,
      },
      avgOrderValue,
      taskCompletionRate: Math.round(taskCompletionRate * 100) / 100,
    },
  });
});

