const mongoose = require("mongoose");
const User = require("./models/userModel");
const crypto = require("crypto");
require("dotenv").config();

const createApiKey = async () => {
  try {
    const uri = process.env.MONGO_URI; 
    if (!uri) {
      console.error("❌ MONGO_URI not found");
      process.exit(1);
    }

    console.log("🌐 Connecting to DB...");
    await mongoose.connect(uri);

    const email = "superadmin@terra.cart";
    const user = await User.findOne({ email });

    if (!user) {
      console.error("❌ User not found:", email);
      process.exit(1);
    }

    // Check if key already exists
    const existingKey = user.apiKeys && user.apiKeys.find(k => k.name === "Fabric Dashboard Key");
    let key;

    if (existingKey) {
      key = existingKey.key;
      console.log("ℹ️  Existing Fabric Key found.");
    } else {
      // Generate Key
      const randomPart = crypto.randomBytes(24).toString("hex");
      key = `tc_live_${randomPart}`;

      // Add to user
      if (!user.apiKeys) user.apiKeys = [];
      
      user.apiKeys.push({
        key: key,
        name: "Fabric Dashboard Key",
        createdAt: new Date()
      });

      await user.save();
    }

    console.log("\n✅ ========================================================");
    console.log("🎉 API KEY GENERATED SUCCESSFULLY");
    console.log("========================================================\n");
    console.log("KEY: ", key);
    console.log("\n========================================================");
    console.log("👉 Provide this Key to the Fabric Team");
    console.log("👉 Header Usage:  x-api-key: " + key);

  } catch (err) {
    console.error("Error:", err);
  } finally {
    mongoose.disconnect();
  }
};

createApiKey();
