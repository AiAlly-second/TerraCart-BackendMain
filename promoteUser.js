const mongoose = require("mongoose");
const User = require("./models/userModel");
require("dotenv").config();

const promoteUser = async () => {
  try {
    // You need to set your MONGO_URI in .env or paste it here directly
    const uri = process.env.MONGO_URI; 
    
    if (!uri) {
      console.error("❌ MONGO_URI not found in .env");
      process.exit(1);
    }

    console.log("🌐 Connecting to MongoDB...");
    await mongoose.connect(uri);
    console.log("✅ Connected.");

    const email = "superadmin@terra.cart";
    
    const user = await User.findOne({ email });
    
    if (!user) {
      console.error("❌ User not found:", email);
    } else {
      console.log("👤 Found user:", user.name, "| Current Role:", user.role);
      
      user.role = "super_admin";
      user.isApproved = true;
      user.isActive = true;
      
      await user.save();
      console.log("✅ User promoted to SUPER_ADMIN and APPROVED successfully!");
    }

  } catch (err) {
    console.error("Error:", err);
  } finally {
    mongoose.disconnect();
    console.log("👋 Disconnected.");
  }
};

promoteUser();
