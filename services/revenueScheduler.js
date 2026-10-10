const {businessDayBoundary, businessMonthRange, dateKeyOffset, getBusinessDateKey, businessParts} = require('../utils/businessTime');
const RevenueHistory = require("../models/revenueHistoryModel");
const Order = require("../models/orderModel");
const User = require("../models/userModel");
const { logError } = require('../logging/logger');
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
    const key = dateKeyOffset(-1);
    const yesterday = businessDayBoundary(key);
    const endDate = businessDayBoundary(key, true);

    // Get all settled orders for yesterday.
    const orders = await Order.find({
      status: ORDER_STATUSES.COMPLETED,
      paymentStatus: PAYMENT_STATUSES.PAID,
      paidAt: {
        $gte: yesterday,
        $lte: endDate,
      },
    }).select("kotLines.totalAmount franchiseId cartId cafeId").lean().cursor();

    let totalRevenue = 0;
    let totalOrders = 0;

    // Get franchise breakdown
    const franchiseMap = new Map();
    const cafeMap = new Map();

    for await (const order of orders) {
      totalOrders++;
      totalRevenue += calculateOrderRevenue([order]);
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
        const orderTotal = (order.kotLines || []).reduce((sum, kot) => sum + Number(kot.totalAmount || 0), 0);
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
        const orderTotal = (order.kotLines || []).reduce((sum, kot) => sum + Number(kot.totalAmount || 0), 0);
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
        totalOrders,
        totalPayments: totalOrders,
        calculatedAt: new Date(),
      },
      {
        upsert: true,
        new: true,
      }
    );

    console.log(`✅ Daily revenue calculated for ${getBusinessDateKey(yesterday)}: ₹${totalRevenue}`);
  } catch (error) {
    logError('revenue_calculation_failed', { period: 'daily' });
  }
}

// Calculate monthly revenue (runs at end of each month)
async function calculateMonthlyRevenue() {
  try {
    const current = businessParts(new Date());
    const range = businessMonthRange(current.year, current.month - 1);
    const lastMonth = range.startUTC;
    const endDate = new Date(range.endUTC.getTime() - 1);

    // Get all settled orders for last month.
    const orders = await Order.find({
      status: ORDER_STATUSES.COMPLETED,
      paymentStatus: PAYMENT_STATUSES.PAID,
      paidAt: {
        $gte: lastMonth,
        $lte: endDate,
      },
    }).select("kotLines.totalAmount franchiseId cartId cafeId").lean().cursor();

    let totalRevenue = 0;
    let totalOrders = 0;

    // Get franchise breakdown (same logic as daily)
    const franchiseMap = new Map();
    const cafeMap = new Map();

    for await (const order of orders) {
      totalOrders++;
      totalRevenue += calculateOrderRevenue([order]);
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
        const orderTotal = (order.kotLines || []).reduce((sum, kot) => sum + Number(kot.totalAmount || 0), 0);
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
        const orderTotal = (order.kotLines || []).reduce((sum, kot) => sum + Number(kot.totalAmount || 0), 0);
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
        totalOrders,
        totalPayments: totalOrders,
        calculatedAt: new Date(),
      },
      {
        upsert: true,
        new: true,
      }
    );

    console.log(`✅ Monthly revenue calculated for ${getBusinessDateKey(lastMonth)}: ₹${totalRevenue}`);
  } catch (error) {
    logError('revenue_calculation_failed', { period: 'monthly' });
  }
}

// One minute timer per job, with a mutex and per-business-day execution guard.
const timers = new Map();
function startRevenueJob(name, eligible, calculate) {
  if (timers.has(name)) return;
  const state = { busy: false, lastKey: null, timer: null };
  state.timer = setInterval(async () => {
    if (state.busy || !timers.has(name)) return;
    const now = new Date();
    const key = getBusinessDateKey(now);
    if (!eligible(businessParts(now)) || state.lastKey === key) return;
    state.busy = true;
    try { await calculate(); state.lastKey = key; }
    finally { state.busy = false; }
  }, 60000);
  state.timer.unref?.();
  timers.set(name, state);
}
const scheduleDailyRevenue = () => startRevenueJob('daily',
  ({hour, minute}) => hour === 0 && minute === 1, calculateDailyRevenue);
const scheduleMonthlyRevenue = () => startRevenueJob('monthly',
  ({day, hour, minute}) => day === 1 && hour === 0 && minute === 1, calculateMonthlyRevenue);
function stopRevenueSchedulers() {
  for (const state of timers.values()) clearInterval(state.timer);
  timers.clear();
}
module.exports = { scheduleDailyRevenue, scheduleMonthlyRevenue, stopRevenueSchedulers,
  calculateDailyRevenue, calculateMonthlyRevenue };
