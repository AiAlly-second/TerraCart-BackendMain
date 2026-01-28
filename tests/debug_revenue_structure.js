const mongoose = require("mongoose");
const RevenueHistory = require("../models/revenueHistoryModel");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log("MongoDB Connected");
    } catch (error) {
        console.error("MongoDB Connection Error:", error);
        process.exit(1);
    }
};

const checkRevenueData = async () => {
    await connectDB();

    try {
        console.log("\n--- Checking Revenue History Records ---");
        
        // Find the most recent record (which corresponds to the one in the user's screenshot)
        const latestRecord = await RevenueHistory.findOne().sort({ date: -1 }).lean();

        if (!latestRecord) {
            console.log("No historical revenue records found.");
        } else {
            console.log("Latest Record Found:");
            console.log(`Date: ${latestRecord.date}`);
            console.log(`Period Type: ${latestRecord.periodType}`);
            console.log(`Total Revenue: ${latestRecord.totalRevenue}`);
            
            console.log("\nFRANCHISE REVENUE:");
            if (latestRecord.franchiseRevenue && latestRecord.franchiseRevenue.length > 0) {
                console.log(JSON.stringify(latestRecord.franchiseRevenue, null, 2));
            } else {
                console.log("EMPTY ARRAY");
            }

            console.log("\nCART REVENUE (The problematic field):");
            if (latestRecord.cartRevenue) {
                console.log(`Length: ${latestRecord.cartRevenue.length}`);
                if (latestRecord.cartRevenue.length > 0) {
                     console.log(JSON.stringify(latestRecord.cartRevenue, null, 2));
                } else {
                    console.log("EMPTY ARRAY - This confirms the issue.");
                }
            } else if (latestRecord.cafeRevenue) {
                 console.log("\nWAIT! found legacy 'cafeRevenue' field instead:");
                 console.log(JSON.stringify(latestRecord.cafeRevenue, null, 2));
            } else {
                console.log("MISSING completely.");
            }
        }
    } catch (error) {
        console.error("Error:", error);
    } finally {
        process.exit();
    }
};

checkRevenueData();
