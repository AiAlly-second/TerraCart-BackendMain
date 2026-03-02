const Order = require("../models/orderModel");
const { MenuItem } = require("../models/menuItemModel");
const Employee = require("../models/employeeModel");
const EmployeeAttendance = require("../models/employeeAttendanceModel");
const Customer = require("../models/customerModel");
const User = require("../models/userModel");
const mongoose = require("mongoose");
const {
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  normalizeOrderStatus,
  normalizePaymentStatus,
} = require("../utils/orderContract");

const isSettledOrder = (order) =>
  normalizeOrderStatus(order?.status, ORDER_STATUSES.NEW) ===
    ORDER_STATUSES.COMPLETED &&
  normalizePaymentStatus(order?.paymentStatus, PAYMENT_STATUSES.PENDING) ===
    PAYMENT_STATUSES.PAID;

// Helper function to build hierarchy query based on user role
const buildHierarchyQuery = (user) => {
  const query = {};
  
  // Convert user._id to ObjectId if it's a string
  const userId = typeof user._id === 'string' ? new mongoose.Types.ObjectId(user._id) : user._id;
  
  if (user.role === "admin") {
    // Cart admin - filter by cartId (support both cartId and cafeId for backward compatibility)
    query.$or = [
      { cartId: userId },
      { cafeId: userId }
    ];
  } else if (user.role === "franchise_admin") {
    // Franchise admin - filter by franchiseId
    query.franchiseId = userId;
  }
  // Super admin sees everything (no filter)
  return query;
};

// Helper function to parse date range from query params
const parseDateRange = (req) => {
  const { startDate, endDate, period } = req.query;
  
  let start, end;
  
  if (period) {
    // Predefined periods
    end = new Date();
    switch (period) {
      case "today":
        start = new Date();
        start.setHours(0, 0, 0, 0);
        break;
      case "yesterday":
        start = new Date();
        start.setDate(start.getDate() - 1);
        start.setHours(0, 0, 0, 0);
        end = new Date();
        end.setDate(end.getDate() - 1);
        end.setHours(23, 59, 59, 999);
        break;
      case "week":
        start = new Date();
        start.setDate(start.getDate() - 7);
        break;
      case "month":
        start = new Date();
        start.setMonth(start.getMonth() - 1);
        break;
      case "quarter":
        start = new Date();
        start.setMonth(start.getMonth() - 3);
        break;
      case "year":
        start = new Date();
        start.setFullYear(start.getFullYear() - 1);
        break;
      default:
        start = new Date();
        start.setDate(start.getDate() - 30); // Default to last 30 days
    }
  } else {
    // Custom date range
    start = startDate ? new Date(startDate) : new Date(new Date().setDate(new Date().getDate() - 30));
    end = endDate ? new Date(endDate) : new Date();
  }
  
  return { start, end };
};

// GET /api/analytics/summary - Overall analytics summary
exports.getAnalyticsSummary = async (req, res) => {
  try {
    const hierarchyQuery = buildHierarchyQuery(req.user);
    const { start, end } = parseDateRange(req);
    
    // Build date filter
    const dateFilter = {
      ...hierarchyQuery,
      createdAt: { $gte: start, $lte: end },
    };
    
    // Get order statistics
    const orders = await Order.find(dateFilter);
    const totalOrders = orders.length;
    const completedOrders = orders.filter((o) => isSettledOrder(o)).length;
    const cancelledOrders = orders.filter((o) => {
      const token = String(o?.status || "").trim().toLowerCase();
      return token === "cancelled" || token === "canceled";
    }).length;
    const totalRevenue = orders
      .filter((o) => isSettledOrder(o))
      .reduce((sum, o) => sum + (o.totalAmount || 0), 0);
    
    // Get average order value
    const avgOrderValue = completedOrders > 0 ? totalRevenue / completedOrders : 0;
    
    // Get customer count
    const customerQuery = { ...hierarchyQuery };
    const totalCustomers = await Customer.countDocuments(customerQuery);
    
    // Get employee count
    const employeeQuery = { ...hierarchyQuery };
    const totalEmployees = await Employee.countDocuments(employeeQuery);
    
    // Get menu items count
    const menuQuery = { ...hierarchyQuery };
    const totalMenuItems = await MenuItem.countDocuments(menuQuery);
    
    // Get today's attendance
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    const attendanceQuery = {
      ...hierarchyQuery,
      date: { $gte: today, $lt: tomorrow },
    };
    const todayAttendance = await EmployeeAttendance.find(attendanceQuery);
    const presentToday = todayAttendance.filter(a => a.checkIn?.time).length;
    
    return res.json({
      success: true,
      period: {
        start,
        end,
        days: Math.ceil((end - start) / (1000 * 60 * 60 * 24)),
      },
      summary: {
        orders: {
          total: totalOrders,
          completed: completedOrders,
          cancelled: cancelledOrders,
          pending: totalOrders - completedOrders - cancelledOrders,
        },
        revenue: {
          total: totalRevenue,
          average: avgOrderValue,
          currency: "INR",
        },
        customers: {
          total: totalCustomers,
        },
        employees: {
          total: totalEmployees,
          presentToday,
        },
        menu: {
          totalItems: totalMenuItems,
        },
      },
    });
  } catch (err) {
    console.error("[ANALYTICS] Error in getAnalyticsSummary:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/analytics/orders - Order analytics
exports.getOrderAnalytics = async (req, res) => {
  try {
    const hierarchyQuery = buildHierarchyQuery(req.user);
    const { start, end } = parseDateRange(req);
    
    const dateFilter = {
      ...hierarchyQuery,
      createdAt: { $gte: start, $lte: end },
    };
    
    const orders = await Order.find(dateFilter).lean();
    
    // Orders by status
    const ordersByStatus = orders.reduce((acc, order) => {
      acc[order.status] = (acc[order.status] || 0) + 1;
      return acc;
    }, {});
    
    // Orders by service type
    const ordersByServiceType = orders.reduce((acc, order) => {
      const type = order.serviceType || "dine-in";
      acc[type] = (acc[type] || 0) + 1;
      return acc;
    }, {});
    
    // Revenue by day
    const revenueByDay = {};
    orders.forEach(order => {
      if (isSettledOrder(order)) {
        const day = new Date(order.createdAt).toISOString().split('T')[0];
        revenueByDay[day] = (revenueByDay[day] || 0) + (order.totalAmount || 0);
      }
    });
    
    // Popular items (from KOT lines)
    const itemCounts = {};
    orders.forEach(order => {
      if (order.kotLines && Array.isArray(order.kotLines)) {
        order.kotLines.forEach(kot => {
          if (kot.items && Array.isArray(kot.items)) {
            kot.items.forEach(item => {
              if (item.name) {
                itemCounts[item.name] = (itemCounts[item.name] || 0) + (item.quantity || 1);
              }
            });
          }
        });
      }
    });
    
    const popularItems = Object.entries(itemCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, count]) => ({ name, count }));
    
    // Average order value
    const completedOrders = orders.filter((o) => isSettledOrder(o));
    const totalRevenue = completedOrders.reduce((sum, o) => sum + (o.totalAmount || 0), 0);
    const avgOrderValue = completedOrders.length > 0 ? totalRevenue / completedOrders.length : 0;
    
    // Peak hours
    const ordersByHour = {};
    orders.forEach(order => {
      const hour = new Date(order.createdAt).getHours();
      ordersByHour[hour] = (ordersByHour[hour] || 0) + 1;
    });
    
    return res.json({
      success: true,
      period: { start, end },
      analytics: {
        totalOrders: orders.length,
        ordersByStatus,
        ordersByServiceType,
        revenueByDay,
        popularItems,
        avgOrderValue,
        totalRevenue,
        ordersByHour,
      },
    });
  } catch (err) {
    console.error("[ANALYTICS] Error in getOrderAnalytics:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/analytics/menu - Menu performance analytics
exports.getMenuAnalytics = async (req, res) => {
  try {
    const hierarchyQuery = buildHierarchyQuery(req.user);
    const { start, end } = parseDateRange(req);
    
    // Get all menu items
    const menuItems = await MenuItem.find(hierarchyQuery).lean();
    
    // Get orders in date range
    const orders = await Order.find({
      ...hierarchyQuery,
      createdAt: { $gte: start, $lte: end },
      status: ORDER_STATUSES.COMPLETED,
      paymentStatus: PAYMENT_STATUSES.PAID,
    }).lean();
    
    // Calculate item performance
    const itemPerformance = {};
    orders.forEach(order => {
      if (order.kotLines && Array.isArray(order.kotLines)) {
        order.kotLines.forEach(kot => {
          if (kot.items && Array.isArray(kot.items)) {
            kot.items.forEach(item => {
              if (item.name) {
                if (!itemPerformance[item.name]) {
                  itemPerformance[item.name] = {
                    name: item.name,
                    quantity: 0,
                    revenue: 0,
                  };
                }
                itemPerformance[item.name].quantity += item.quantity || 1;
                itemPerformance[item.name].revenue += (item.price || 0) * (item.quantity || 1);
              }
            });
          }
        });
      }
    });
    
    const itemStats = Object.values(itemPerformance)
      .sort((a, b) => b.revenue - a.revenue);
    
    // Top performers
    const topByRevenue = itemStats.slice(0, 10);
    const topByQuantity = [...itemStats].sort((a, b) => b.quantity - a.quantity).slice(0, 10);
    
    // Low performers (items with low sales)
    const lowPerformers = itemStats.slice(-10).reverse();
    
    return res.json({
      success: true,
      period: { start, end },
      analytics: {
        totalMenuItems: menuItems.length,
        activeItems: menuItems.filter(i => i.isAvailable).length,
        topByRevenue,
        topByQuantity,
        lowPerformers,
        itemStats,
      },
    });
  } catch (err) {
    console.error("[ANALYTICS] Error in getMenuAnalytics:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/analytics/employees - Employee performance analytics
exports.getEmployeeAnalytics = async (req, res) => {
  try {
    const hierarchyQuery = buildHierarchyQuery(req.user);
    const { start, end } = parseDateRange(req);
    
    const employees = await Employee.find(hierarchyQuery).lean();
    
    // Get attendance data
    const attendance = await EmployeeAttendance.find({
      ...hierarchyQuery,
      date: { $gte: start, $lte: end },
    }).populate("employeeId", "name employeeRole").lean();
    
    // Calculate employee stats
    const employeeStats = {};
    attendance.forEach(record => {
      const empId = record.employeeId?._id?.toString();
      if (!empId) return;
      
      if (!employeeStats[empId]) {
        employeeStats[empId] = {
          name: record.employeeId?.name || "Unknown",
          role: record.employeeId?.employeeRole || "Unknown",
          totalDays: 0,
          present: 0,
          absent: 0,
          late: 0,
          totalHours: 0,
          overtime: 0,
        };
      }
      
      employeeStats[empId].totalDays++;
      if (record.status === "present") employeeStats[empId].present++;
      if (record.status === "absent") employeeStats[empId].absent++;
      if (record.status === "late") employeeStats[empId].late++;
      employeeStats[empId].totalHours += record.workingHours || 0;
      employeeStats[empId].overtime += record.overtime || 0;
    });
    
    return res.json({
      success: true,
      period: { start, end },
      analytics: {
        totalEmployees: employees.length,
        employeeStats: Object.values(employeeStats),
        byRole: employees.reduce((acc, emp) => {
          acc[emp.employeeRole] = (acc[emp.employeeRole] || 0) + 1;
          return acc;
        }, {}),
      },
    });
  } catch (err) {
    console.error("[ANALYTICS] Error in getEmployeeAnalytics:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/analytics/revenue - Revenue analytics
exports.getRevenueAnalytics = async (req, res) => {
  try {
    const hierarchyQuery = buildHierarchyQuery(req.user);
    const { start, end } = parseDateRange(req);
    
    const orders = await Order.find({
      ...hierarchyQuery,
      createdAt: { $gte: start, $lte: end },
      status: ORDER_STATUSES.COMPLETED,
      paymentStatus: PAYMENT_STATUSES.PAID,
    }).lean();
    
    // Revenue by day
    const revenueByDay = {};
    const revenueByServiceType = {};
    const revenueByPaymentMethod = {};
    
    orders.forEach(order => {
      const day = new Date(order.createdAt).toISOString().split('T')[0];
      const amount = order.totalAmount || 0;
      
      revenueByDay[day] = (revenueByDay[day] || 0) + amount;
      
      const serviceType = order.serviceType || "dine-in";
      revenueByServiceType[serviceType] = (revenueByServiceType[serviceType] || 0) + amount;
      
      const paymentMethod = order.paymentMethod || "cash";
      revenueByPaymentMethod[paymentMethod] = (revenueByPaymentMethod[paymentMethod] || 0) + amount;
    });
    
    const totalRevenue = orders.reduce((sum, o) => sum + (o.totalAmount || 0), 0);
    const avgOrderValue = orders.length > 0 ? totalRevenue / orders.length : 0;
    
    // Calculate taxes and discounts
    const totalTax = orders.reduce((sum, o) => sum + (o.tax || 0), 0);
    const totalDiscount = orders.reduce((sum, o) => sum + (o.discount || 0), 0);
    
    return res.json({
      success: true,
      period: { start, end },
      analytics: {
        totalRevenue,
        totalOrders: orders.length,
        avgOrderValue,
        totalTax,
        totalDiscount,
        revenueByDay,
        revenueByServiceType,
        revenueByPaymentMethod,
      },
    });
  } catch (err) {
    console.error("[ANALYTICS] Error in getRevenueAnalytics:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/analytics/customers - Customer analytics
exports.getCustomerAnalytics = async (req, res) => {
  try {
    const hierarchyQuery = buildHierarchyQuery(req.user);
    const { start, end } = parseDateRange(req);
    
    const customers = await Customer.find(hierarchyQuery).lean();
    
    // Get orders for customer analysis
    const orders = await Order.find({
      ...hierarchyQuery,
      createdAt: { $gte: start, $lte: end },
    }).lean();
    
    // Customer order frequency
    const customerOrders = {};
    orders.forEach(order => {
      const customerId = order.customerId?.toString() || order.customerPhone || "walk-in";
      customerOrders[customerId] = (customerOrders[customerId] || 0) + 1;
    });
    
    // New vs returning customers
    const newCustomers = customers.filter(c => {
      const createdDate = new Date(c.createdAt);
      return createdDate >= start && createdDate <= end;
    }).length;
    
    return res.json({
      success: true,
      period: { start, end },
      analytics: {
        totalCustomers: customers.length,
        newCustomers,
        returningCustomers: customers.length - newCustomers,
        totalOrders: orders.length,
        avgOrdersPerCustomer: customers.length > 0 ? orders.length / customers.length : 0,
        topCustomers: Object.entries(customerOrders)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([id, count]) => ({ customerId: id, orderCount: count })),
      },
    });
  } catch (err) {
    console.error("[ANALYTICS] Error in getCustomerAnalytics:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/analytics/attendance - Attendance analytics
exports.getAttendanceAnalytics = async (req, res) => {
  try {
    const hierarchyQuery = buildHierarchyQuery(req.user);
    const { start, end } = parseDateRange(req);
    
    const attendance = await EmployeeAttendance.find({
      ...hierarchyQuery,
      date: { $gte: start, $lte: end },
    }).lean();
    
    const stats = {
      totalRecords: attendance.length,
      present: attendance.filter(a => a.status === "present").length,
      absent: attendance.filter(a => a.status === "absent").length,
      late: attendance.filter(a => a.status === "late").length,
      halfDay: attendance.filter(a => a.status === "half_day").length,
      onLeave: attendance.filter(a => a.status === "on_leave").length,
      totalWorkingHours: attendance.reduce((sum, a) => sum + (a.workingHours || 0), 0),
      totalOvertime: attendance.reduce((sum, a) => sum + (a.overtime || 0), 0),
    };
    
    // Attendance by day
    const attendanceByDay = {};
    attendance.forEach(record => {
      const day = new Date(record.date).toISOString().split('T')[0];
      if (!attendanceByDay[day]) {
        attendanceByDay[day] = { present: 0, absent: 0, late: 0, total: 0 };
      }
      attendanceByDay[day].total++;
      if (record.status === "present") attendanceByDay[day].present++;
      if (record.status === "absent") attendanceByDay[day].absent++;
      if (record.status === "late") attendanceByDay[day].late++;
    });
    
    return res.json({
      success: true,
      period: { start, end },
      analytics: {
        ...stats,
        attendanceByDay,
        attendanceRate: stats.totalRecords > 0 ? (stats.present / stats.totalRecords) * 100 : 0,
      },
    });
  } catch (err) {
    console.error("[ANALYTICS] Error in getAttendanceAnalytics:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/analytics/inventory - Inventory analytics (placeholder)
exports.getInventoryAnalytics = async (req, res) => {
  try {
    // Placeholder for inventory analytics
    // Implement when inventory system is available
    return res.json({
      success: true,
      message: "Inventory analytics not yet implemented",
      analytics: {},
    });
  } catch (err) {
    console.error("[ANALYTICS] Error in getInventoryAnalytics:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/analytics/export - Export all analytics data
exports.exportAnalyticsData = async (req, res) => {
  try {
    const hierarchyQuery = buildHierarchyQuery(req.user);
    
    // Check if "all" data is requested
    const fetchAll = req.query.all === "true";
    
    let dateQuery = {};
    let attendanceDateQuery = {};
    let start, end;

    if (!fetchAll) {
      const range = parseDateRange(req);
      start = range.start;
      end = range.end;
      dateQuery = { createdAt: { $gte: start, $lte: end } };
      attendanceDateQuery = { date: { $gte: start, $lte: end } };
    }

    // Gather all data
    const [orders, menuItems, employees, customers, attendance] = await Promise.all([
      Order.find({
        ...hierarchyQuery,
        ...dateQuery,
      }).lean(),
      MenuItem.find(hierarchyQuery).lean(),
      Employee.find(hierarchyQuery).lean(),
      Customer.find(hierarchyQuery).lean(),
      EmployeeAttendance.find({
        ...hierarchyQuery,
        ...attendanceDateQuery,
      }).lean(),
    ]);
    
    return res.json({
      success: true,
      exportedAt: new Date(),
      period: { start, end },
      user: {
        id: req.user._id,
        role: req.user.role,
        email: req.user.email,
      },
      data: {
        orders: {
          count: orders.length,
          data: orders,
        },
        menuItems: {
          count: menuItems.length,
          data: menuItems,
        },
        employees: {
          count: employees.length,
          data: employees,
        },
        customers: {
          count: customers.length,
          data: customers,
        },
        attendance: {
          count: attendance.length,
          data: attendance,
        },
      },
    });
  } catch (err) {
    console.error("[ANALYTICS] Error in exportAnalyticsData:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};
