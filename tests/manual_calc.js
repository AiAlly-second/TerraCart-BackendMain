const mongoose = require("mongoose");
const RevenueHistory = require("../models/revenueHistoryModel");
const User = require("../models/userModel");
const Order = require("../models/orderModel"); // Make sure this path is correct
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

// --- MOCKING THE CALCULATE FUNCTION TO RUN LOCALLY ---
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

        // 1. Fetch ALL Users to debug active status
        const allUsers = await User.find({ role: { $in: ['franchise_admin', 'admin'] } }).lean();
        console.log(`Total Franchises/Carts Found: ${allUsers.length}`);
        
        const activeFranchises = allUsers.filter(u => u.role === 'franchise_admin' && u.isActive === true);
        const inactiveFranchises = allUsers.filter(u => u.role === 'franchise_admin' && u.isActive !== true);
        
        console.log(`Active Franchises: ${activeFranchises.length}`);
        console.log(`Inactive Franchises: ${inactiveFranchises.length}`);
        
        // 2. Fetch ALL Paid Orders for the last 30 days to ensure we have data
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        
        const allOrders = await Order.find({ 
            status: "Paid",
            paidAt: { $gte: thirtyDaysAgo }
        }).lean();
        
        console.log(`Total Paid Orders (Last 30 Days): ${allOrders.length}`);
        
        if (allOrders.length === 0) {
            console.log("NO ORDERS FOUND. Cannot calculate revenue.");
            process.exit();
        }

        // 3. Simulate the Controller Logic for ONE day (Yesterday)
        const targetDate = new Date();
        targetDate.setDate(targetDate.getDate() - 1); // Yesterday
        targetDate.setHours(0,0,0,0);
        
        const endDate = new Date(targetDate);
        endDate.setHours(23,59,59,999);
        
        console.log(`\nSimulating calculation for: ${targetDate.toDateString()}`);
        
        // ACTIVE FRANCHISE IDS
        const activeFranchiseIds = new Set(activeFranchises.map(f => f._id.toString()));
        console.log("Active Franchise IDs:", Array.from(activeFranchiseIds));

        // FILTER ORDERS FOR DATE
        const daysOrders = allOrders.filter(o => {
            const d = new Date(o.paidAt);
            return d >= targetDate && d <= endDate;
        });
        console.log(`Orders for ${targetDate.toDateString()}: ${daysOrders.length}`);
        
        // FILTER FOR ACTIVE FRANCHISES
        const activeOrders = daysOrders.filter(order => {
            const fId = order.franchiseId?.toString();
            const isActive = fId && activeFranchiseIds.has(fId);
            if (!isActive) {
               console.log(`[Excluded] Order ${order._id} - Franchise ${fId} is inactive/missing`);
            }
            return isActive;
        });
        
        console.log(`Orders linked to Active Franchises: ${activeOrders.length}`);
        
        if (activeOrders.length === 0) {
             console.log("No eligible orders for revenue calculation.");
        } else {
             // BUILD CART MAP
             const cartMap = new Map();
             
             activeOrders.forEach(order => {
                  const cartId = order.cartId?.toString();
                  if (cartId) {
                      if (!cartMap.has(cartId)) {
                           cartMap.set(cartId, { revenue: 0, count: 0 });
                      }
                      const c = cartMap.get(cartId);
                      c.revenue += calculateOrderRevenue([order]);
                      c.count++;
                  } else {
                      console.log(`[Warning] Order ${order._id} has NO cartID`);
                  }
             });
             
             console.log("\n--- CART REVENUE RESULT ---");
             console.log(Array.from(cartMap.entries()));
        }

        process.exit();
    } catch (error) {
        console.error("Error:", error);
        process.exit(1);
    }
};

runManualCalculation();
