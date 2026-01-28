const mongoose = require("mongoose");
const RevenueHistory = require("../models/revenueHistoryModel");
const Order = require("../models/orderModel");
const User = require("../models/userModel");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

// Helper function (copied from controller)
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

const repairRevenueHistory = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log("MongoDB Connected");

        // Repair last 45 days
        const daysToRepair = 45;
        console.log(`Starting repair for the last ${daysToRepair} days...`);

        for (let i = 0; i < daysToRepair; i++) {
            const date = new Date();
            date.setDate(date.getDate() - i);
            date.setHours(0, 0, 0, 0);
            
            const endDate = new Date(date);
            endDate.setHours(23, 59, 59, 999);

            console.log(`Processing ${date.toLocaleDateString()}...`);

            // 1. Get Active Franchises (Snapshotted as of NOW, which is the best we can do)
            const activeFranchises = await User.find({ 
                role: "franchise_admin",
                isActive: true
            }).select("_id name").lean();
            
            const activeFranchiseIds = new Set(activeFranchises.map(f => f._id.toString()));

            // 2. Get Orders
            const allOrders = await Order.find({
                status: "Paid",
                paidAt: { $gte: date, $lte: endDate },
            }).lean();

            if (allOrders.length === 0) {
                console.log(`  No orders found.`);
                continue;
            }

            // 3. Filter Active
            const orders = allOrders.filter(order => {
                const franchiseId = order.franchiseId?.toString() || order.franchiseId;
                return franchiseId && activeFranchiseIds.has(franchiseId);
            });

            console.log(`  Found ${orders.length} active orders (out of ${allOrders.length}).`);

            // 4. Calculate
            const totalRevenue = calculateOrderRevenue(orders);
            const franchiseMap = new Map();
            const cartMap = new Map();

            for (const order of orders) {
                const franchiseId = order.franchiseId?.toString();
                const cartId = order.cartId?.toString();

                if (franchiseId && activeFranchiseIds.has(franchiseId)) {
                    if (!franchiseMap.has(franchiseId)) {
                        franchiseMap.set(franchiseId, {
                            franchiseId,
                            revenue: 0,
                            cartIds: new Set(),
                        });
                    }
                    const franchise = franchiseMap.get(franchiseId);
                    const orderTotal = calculateOrderRevenue([order]);
                    franchise.revenue += orderTotal;
                    if (cartId) franchise.cartIds.add(cartId);
                }

                 if (cartId && franchiseId && activeFranchiseIds.has(franchiseId)) {
                    if (!cartMap.has(cartId)) {
                        cartMap.set(cartId, {
                            cartId,
                            franchiseId,
                            revenue: 0,
                            orderCount: 0,
                        });
                    }
                    const cart = cartMap.get(cartId);
                    const orderTotal = calculateOrderRevenue([order]);
                    cart.revenue += orderTotal;
                    cart.orderCount += 1;
                }
            }

            // 5. Lookups
            const franchiseIds = Array.from(franchiseMap.keys());
            const cartIds = Array.from(cartMap.keys());
            
            const franchises = await User.find({ _id: { $in: franchiseIds } }).select("name").lean();
            const carts = await User.find({ _id: { $in: cartIds } }).select("name franchiseId").lean();
            
            const fNames = new Map(franchises.map(f => [f._id.toString(), f.name]));
            const cNames = new Map(carts.map(c => [c._id.toString(), { name: c.name, fid: c.franchiseId?.toString() }]));

            // 6. Build Arrays
            const franchiseRevenue = Array.from(franchiseMap.entries()).map(([id, data]) => ({
                franchiseId: id,
                franchiseName: fNames.get(id) || "Unknown",
                revenue: data.revenue,
                cartCount: data.cartIds.size // This is the field I added to schema
            }));

            const cartRevenue = Array.from(cartMap.entries()).map(([id, data]) => ({
                cartId: id,
                cartName: cNames.get(id)?.name || "Unknown",
                franchiseId: data.franchiseId,
                franchiseName: fNames.get(data.franchiseId) || "Unknown",
                revenue: data.revenue,
                orderCount: data.orderCount
            }));
            
            console.log(`  Generated: ${franchiseRevenue.length} franchise records, ${cartRevenue.length} cart records.`);

            // 7. Save
            await RevenueHistory.findOneAndUpdate(
                { date: date, periodType: "daily" },
                {
                    date,
                    periodType: "daily",
                    totalRevenue,
                    franchiseRevenue,
                    cartRevenue, // Updating this array
                    totalOrders: orders.length,
                    totalPayments: orders.length,
                    calculatedAt: new Date()
                },
                { upsert: true, new: true }
            );
        }

        console.log("Repair complete.");
        process.exit();

    } catch (error) {
        console.error("Critical Error during repair:", error);
        process.exit(1);
    }
};

repairRevenueHistory();
