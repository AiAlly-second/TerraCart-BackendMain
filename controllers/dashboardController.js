const Order = require("../models/orderModel");
const { Table } = require("../models/tableModel");
const InventoryItem = require("../models/inventoryModel");
const EmployeeAttendance = require("../models/employeeAttendanceModel");
const Employee = require("../models/employeeModel");
const User = require("../models/userModel");
const Task = require("../models/taskModel");

// Helper to get cartId based on user role (returns cartId, not cafeId)
const getCafeId = async (user) => {
  if (user.role === "admin") {
    return user._id; // Cart admin's _id is the cartId
  } else if (["waiter", "cook", "captain", "manager"].includes(user.role)) {
    // Mobile users - prioritize cartId, fallback to cafeId for backward compatibility
    if (user.cartId) {
      return user.cartId;
    }
    if (user.cafeId) {
      // Fallback for backward compatibility
      return user.cafeId;
    }
    // Fallback: try to find Employee record by email or userId
    const employee = await Employee.findOne({
      $or: [
        { email: user.email?.toLowerCase() },
        { userId: user._id }
      ]
    }).lean();
    if (employee) {
      // Prioritize cartId, fallback to cafeId
      const cartId = employee.cartId || employee.cafeId;
      if (cartId) {
        console.log('[DASHBOARD] getCafeId - Found employee by email/userId:', {
          userId: user._id,
          email: user.email,
          employeeId: employee._id,
          cartId: cartId
        });
        return cartId;
      }
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
    return employee?.cartId || employee?.cafeId; // Prioritize cartId, fallback to cafeId
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
    const orderScope = {
      $or: [
        { cartId: cafeId },
        { cafeId: cafeId }, // Backward compatibility for old records
      ],
    };

    // Run all queries in parallel for faster response
    const [
      activeOrders,
      todayOrders,
      pendingKOTs,
      lowStockItems,
      todayAttendance,
      occupiedTables,
      totalTables,
      pendingTasks,
    ] = await Promise.all([
      // Active orders (real-time, excluding terminal statuses)
      Order.countDocuments({
        ...orderScope,
        $nor: [
          { status: /^paid$/i },
          { status: /^cancelled$/i },
          { status: /^returned$/i },
          { status: /^exit$/i },
        ],
      }),

      // Today's revenue orders - use aggregation for faster calculation
      Order.aggregate([
        {
          $match: {
            ...orderScope,
            createdAt: { $gte: today, $lt: tomorrow },
            status: { $in: ["Paid", "Finalized", "Exit"] },
          },
        },
        {
          $project: {
            revenue: {
              $reduce: {
                input: { $ifNull: ["$kotLines", []] },
                initialValue: 0,
                in: { $add: ["$$value", { $ifNull: ["$$this.totalAmount", 0] }] },
              },
            },
          },
        },
        {
          $group: {
            _id: null,
            totalRevenue: { $sum: "$revenue" },
          },
        },
      ]),

      // Pending KOTs (orders with status pending/preparing/ready)
      // Keep cart scope and status scope in separate clauses to avoid key collisions.
      Order.countDocuments({
        $and: [
          orderScope,
          {
            $or: [
              { status: /^pending$/i },
              { status: /^confirmed$/i },
              { status: /^preparing$/i },
              { status: /^ready$/i },
            ],
          },
        ],
      }),

      // Low stock items (threshold can be configured)
      // InventoryItem model uses cartId, support cafeId for backward compatibility
      InventoryItem.countDocuments({
        $and: [
          {
            $or: [
              { cartId: cafeId },
              { cafeId: cafeId } // Fallback for backward compatibility
            ]
          },
          {
            $or: [
              { quantity: { $lt: 10 } }, // Use 'quantity' field, not 'stockQuantity'
              { quantity: { $exists: false } },
            ]
          }
        ]
      }),

      // Today's attendance count
      // EmployeeAttendance model uses cartId, support cafeId for backward compatibility
      EmployeeAttendance.countDocuments({
        $or: [
          { cartId: cafeId },
          { cafeId: cafeId } // Fallback for backward compatibility
        ],
        date: { $gte: today, $lt: tomorrow },
        "checkIn.time": { $exists: true },
      }),

      // Occupied tables (Table model uses cartId)
      Table.countDocuments({
        cartId: cafeId,
        isOccupied: true,
      }),

      // Total tables
      Table.countDocuments({
        cartId: cafeId,
      }),

      // Pending tasks (not completed or cancelled)
      Task.countDocuments({
        cartId: cafeId,
        status: { $nin: ["completed", "cancelled"] },
      }),
    ]);

    // Extract revenue from aggregation result
    const todayRevenue = todayOrders.length > 0 ? todayOrders[0].totalRevenue || 0 : 0;

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

