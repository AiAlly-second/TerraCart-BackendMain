const RevenueHistory = require("../models/revenueHistoryModel");
const Order = require("../models/orderModel");
const User = require("../models/userModel");
const {
  ORDER_STATUSES,
  PAYMENT_STATUSES,
} = require("../utils/orderContract");

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

// Calculate daily revenue (runs at end of each day)
async function calculateDailyRevenue() {
  try {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);
    
    const endDate = new Date(yesterday);
    endDate.setHours(23, 59, 59, 999);

    // Get all settled orders for yesterday.
    const orders = await Order.find({
      status: ORDER_STATUSES.COMPLETED,
      paymentStatus: PAYMENT_STATUSES.PAID,
      paidAt: {
        $gte: yesterday,
        $lte: endDate,
      },
    }).lean();

    const totalRevenue = calculateOrderRevenue(orders);

    // Get franchise breakdown
    const franchiseMap = new Map();
    const cafeMap = new Map();

    for (const order of orders) {
      const franchiseId = order.franchiseId?.toString() || order.franchiseId;
      const cafeId =
        order.cartId?.toString() ||
        order.cafeId?.toString() ||
        order.cafeId;

      if (franchiseId) {
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
        if (!cafeMap.has(cafeId)) {
          cafeMap.set(cafeId, {
            cafeId,
            franchiseId,
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

    // Get franchise and cafe names
    const franchiseIds = Array.from(franchiseMap.keys());
    const cafeIds = Array.from(cafeMap.keys());
    const franchises = await User.find({ _id: { $in: franchiseIds } }).select("name").lean();
    const cafes = await User.find({ _id: { $in: cafeIds } }).select("name franchiseId").lean();

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

    const franchiseRevenue = Array.from(franchiseMap.entries()).map(([id, data]) => ({
      franchiseId: id,
      franchiseName: franchiseMapNames.get(id) || "Unknown",
      revenue: data.revenue,
      cafeCount: data.cafeIds.size,
    }));

    const cafeRevenue = Array.from(cafeMap.entries()).map(([id, data]) => ({
      cafeId: id,
      cafeName: cafeMapNames.get(id)?.name || "Unknown",
      franchiseId: data.franchiseId,
      franchiseName: franchiseMapNames.get(data.franchiseId) || "Unknown",
      revenue: data.revenue,
      orderCount: data.orderCount,
    }));

    // Store daily revenue
    await RevenueHistory.findOneAndUpdate(
      {
        date: yesterday,
        periodType: "daily",
      },
      {
        date: yesterday,
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

    console.log(`✅ Daily revenue calculated for ${yesterday.toISOString().split('T')[0]}: ₹${totalRevenue}`);
  } catch (error) {
    console.error("Error calculating daily revenue:", error);
  }
}

// Calculate monthly revenue (runs at end of each month)
async function calculateMonthlyRevenue() {
  try {
    const lastMonth = new Date();
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    lastMonth.setDate(1);
    lastMonth.setHours(0, 0, 0, 0);

    const endDate = new Date(lastMonth.getFullYear(), lastMonth.getMonth() + 1, 0);
    endDate.setHours(23, 59, 59, 999);

    // Get all settled orders for last month.
    const orders = await Order.find({
      status: ORDER_STATUSES.COMPLETED,
      paymentStatus: PAYMENT_STATUSES.PAID,
      paidAt: {
        $gte: lastMonth,
        $lte: endDate,
      },
    }).lean();

    const totalRevenue = calculateOrderRevenue(orders);

    // Get franchise breakdown (same logic as daily)
    const franchiseMap = new Map();
    const cafeMap = new Map();

    for (const order of orders) {
      const franchiseId = order.franchiseId?.toString() || order.franchiseId;
      const cafeId =
        order.cartId?.toString() ||
        order.cafeId?.toString() ||
        order.cafeId;

      if (franchiseId) {
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
        if (!cafeMap.has(cafeId)) {
          cafeMap.set(cafeId, {
            cafeId,
            franchiseId,
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

    // Get franchise and cafe names
    const franchiseIds = Array.from(franchiseMap.keys());
    const cafeIds = Array.from(cafeMap.keys());
    const franchises = await User.find({ _id: { $in: franchiseIds } }).select("name").lean();
    const cafes = await User.find({ _id: { $in: cafeIds } }).select("name franchiseId").lean();

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

    const franchiseRevenue = Array.from(franchiseMap.entries()).map(([id, data]) => ({
      franchiseId: id,
      franchiseName: franchiseMapNames.get(id) || "Unknown",
      revenue: data.revenue,
      cafeCount: data.cafeIds.size,
    }));

    const cafeRevenue = Array.from(cafeMap.entries()).map(([id, data]) => ({
      cafeId: id,
      cafeName: cafeMapNames.get(id)?.name || "Unknown",
      franchiseId: data.franchiseId,
      franchiseName: franchiseMapNames.get(data.franchiseId) || "Unknown",
      revenue: data.revenue,
      orderCount: data.orderCount,
    }));

    // Store monthly revenue
    await RevenueHistory.findOneAndUpdate(
      {
        date: lastMonth,
        periodType: "monthly",
      },
      {
        date: lastMonth,
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

    console.log(`✅ Monthly revenue calculated for ${lastMonth.toISOString().split('T')[0]}: ₹${totalRevenue}`);
  } catch (error) {
    console.error("Error calculating monthly revenue:", error);
  }
}

// Schedule daily revenue calculation (runs at 11:59 PM every day)
const scheduleDailyRevenue = () => {
  const checkAndRunDaily = async () => {
    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes();
    
    // Run at 11:59 PM (23:59)
    if (hours === 23 && minutes === 59) {
      console.log("Running daily revenue calculation...");
      await calculateDailyRevenue();
    }
  };
  
  // Check every minute
  setInterval(checkAndRunDaily, 60000);
};

// Schedule monthly revenue calculation (runs on the 1st of each month at 12:01 AM)
const scheduleMonthlyRevenue = () => {
  const checkAndRunMonthly = async () => {
    const now = new Date();
    const day = now.getDate();
    const hours = now.getHours();
    const minutes = now.getMinutes();
    
    // Run on 1st of month at 12:01 AM (00:01)
    if (day === 1 && hours === 0 && minutes === 1) {
      console.log("Running monthly revenue calculation...");
      await calculateMonthlyRevenue();
    }
  };
  
  // Check every minute
  setInterval(checkAndRunMonthly, 60000);
};

module.exports = {
  scheduleDailyRevenue,
  scheduleMonthlyRevenue,
  calculateDailyRevenue,
  calculateMonthlyRevenue,
};

