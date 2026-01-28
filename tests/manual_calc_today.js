const mongoose = require("mongoose");
const RevenueHistory = require("../models/revenueHistoryModel");
const User = require("../models/userModel");
const Order = require("../models/orderModel"); // Make sure this path is correct
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

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

const runManualCalculation = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log("MongoDB Connected");

        // 1. Fetch ALL Users
        const allUsers = await User.find({ role: { $in: ['franchise_admin', 'admin'] } }).lean();
        const activeFranchises = allUsers.filter(u => u.role === 'franchise_admin' && u.isActive === true);
        const activeFranchiseIds = new Set(activeFranchises.map(f => f._id.toString()));
        console.log("Active Franchise IDs:", Array.from(activeFranchiseIds));

        // 2. Fetch ALL Orders
        const allOrders = await Order.find({ status: "Paid" }).limit(50).sort({paidAt: -1}).lean();
        console.log(`Checking last ${allOrders.length} paid orders...`);
        
        // 3. Process each order to see why it might fail mapping
        allOrders.forEach(order => {
             const fId = order.franchiseId?.toString();
             const cId = order.cartId?.toString();
             const isActive = fId && activeFranchiseIds.has(fId);
             
             if (isActive) {
                 console.log(`[OK] Order ${order._id}: Franchise ${fId} (Active), Cart ${cId || 'NULL'}`);
             } else {
                 console.log(`[SKIP] Order ${order._id}: Franchise ${fId} (Inactive/Missing)`);
             }
        });

        // 4. Force run the "Current Revenue" logic from controller
        console.log("\n--- SIMULATING CURRENT REVENUE LOGIC ---");
        
        const activeOrders = await Order.find({ status: "Paid" }).lean();
        const validOrders = activeOrders.filter(o => {
            const fid = o.franchiseId?.toString();
            return fid && activeFranchiseIds.has(fid);
        });
        
        console.log(`Total Valid Orders: ${validOrders.length}`);
        
        const cartMap = new Map();
        
        validOrders.forEach(order => {
              const cartId = order.cartId?.toString();
              if (cartId) {
                  const orderFranchiseId = order.franchiseId?.toString();
                  // Logic check: DOES activeFranchiseIds.has(orderFranchiseId) return true?
                  if (activeFranchiseIds.has(orderFranchiseId)) {
                      if (!cartMap.has(cartId)) {
                          cartMap.set(cartId, { revenue: 0, orderCount: 0 });
                      }
                      const c = cartMap.get(cartId);
                      c.revenue += calculateOrderRevenue([order]);
                      c.orderCount++;
                  }
              }
        });
        
        console.log("Cart Map Result Keys:", Array.from(cartMap.keys()));
        console.log("Cart Map Result Values:", Array.from(cartMap.values()));

        process.exit();
    } catch (error) {
        console.error("Error:", error);
        process.exit(1);
    }
};

runManualCalculation();
