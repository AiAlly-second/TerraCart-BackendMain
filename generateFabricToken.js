const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const User = require("./models/userModel");
require("dotenv").config();

const generateFabricToken = async () => {
  try {
    // 1. Get Secret (Must match Production)
    // Try to use the passed env var, or fallback to the one in .env, or the default hardcoded one
    const secret = process.env.JWT_SECRET || "sarva-cafe-secret-key-2025";
    
    console.log("🔑 Using Secret Key:", secret === "sarva-cafe-secret-key-2025" ? "(Default Dev Secret)" : "(Custom Secret found)");

    // 2. Connect to DB (to find the user ID)
    const uri = process.env.MONGO_URI; 
    if (!uri) {
      console.error("❌ MONGO_URI not found. Please provide it.");
      process.exit(1);
    }

    console.log("🌐 Connecting to DB...");
    await mongoose.connect(uri);

    // 3. Find the Super Admin User
    const email = "superadmin@terra.cart";
    const user = await User.findOne({ email });

    if (!user) {
      console.error("❌ User not found:", email);
      process.exit(1);
    }

    // 4. Generate Long-Lived Token (10 Years)
    const token = jwt.sign({ id: user._id }, secret, {
      expiresIn: "3650d", // 10 years
    });

    console.log("\n✅ ========================================================");
    console.log("🎉 PERMANENT API TOKEN GENERATED (Valid for 10 Years)");
    console.log("========================================================\n");
    console.log(token);
    console.log("\n========================================================");
    console.log("👉 Copy this token and give it to the Fabric team.");
    console.log("👉 It will NOT expire until 2035.");

  } catch (err) {
    console.error("Error:", err);
  } finally {
    mongoose.disconnect();
  }
};

generateFabricToken();
