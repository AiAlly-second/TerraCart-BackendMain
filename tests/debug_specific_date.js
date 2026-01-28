const mongoose = require("mongoose");
const Order = require("../models/orderModel");
const User = require("../models/userModel");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const debugDate = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log("MongoDB Connected");

        // Target Date: Jan 21, 2026
        const start = new Date("2026-01-21T00:00:00.000+05:30");
        const end = new Date("2026-01-21T23:59:59.999+05:30");
        
        console.log(`Searching orders between ${start.toISOString()} and ${end.toISOString()}`);

        const orders = await Order.find({
            paidAt: { $gte: start, $lte: end },
            status: "Paid"
        }).lean();

        console.log(`Found ${orders.length} orders.`);

        if (orders.length > 0) {
            orders.forEach(o => {
                console.log(`Order ${o._id}:`);
                console.log(`  Total: ${o.totalAmount}`); // Simplified check
                console.log(`  FranchiseID: ${o.franchiseId}`);
                console.log(`  CartID: ${o.cartId}`); // This is likely the culprit if missing
                
                if (!o.cartId) {
                    console.log("  [ERROR] Cart ID is MISSING on this order!");
                }
            });
        }
        
        // Also check if Franchise is considered "Active"
        if (orders.length > 0) {
            const fId = orders[0].franchiseId;
            const franchise = await User.findById(fId);
            console.log(`\nFranchise Status for ${fId}:`);
            console.log(`  Name: ${franchise?.name}`);
            console.log(`  isActive: ${franchise?.isActive}`);
            console.log(`  Role: ${franchise?.role}`);
        }

        process.exit();
    } catch (error) {
        console.error(error);
        process.exit(1);
    }
};

debugDate();
