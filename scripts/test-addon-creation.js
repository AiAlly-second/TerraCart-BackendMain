/**
 * Test script to verify addon creation works
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Addon = require("../models/addonModel");
const User = require("../models/userModel");

async function testAddonCreation() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("✅ Connected to MongoDB\n");

    // Find a cart admin user
    const cartAdmin = await User.findOne({ role: "admin", isActive: true });
    
    if (!cartAdmin) {
      console.log("❌ No cart admin found");
      process.exit(1);
    }

    console.log("🛒 Cart Admin Found:");
    console.log(`  Name: ${cartAdmin.name || cartAdmin.cartName}`);
    console.log(`  ID: ${cartAdmin._id}`);
    console.log(`  Role: ${cartAdmin.role}`);
    console.log(`  Franchise ID: ${cartAdmin.franchiseId || "N/A"}\n`);

    // Try to create an addon
    const testAddon = {
      name: "Test Extra Napkins",
      description: "Test addon for debugging",
      price: 0,
      icon: "🧻",
      sortOrder: 0,
      isAvailable: true,
      cartId: cartAdmin._id,
      franchiseId: cartAdmin.franchiseId || null,
    };

    console.log("📝 Creating test addon:");
    console.log(JSON.stringify(testAddon, null, 2));

    const addon = await Addon.create(testAddon);
    
    console.log("\n✅ Addon created successfully!");
    console.log(`  Addon ID: ${addon._id}`);
    console.log(`  Name: ${addon.name}`);
    console.log(`  Price: ₹${addon.price}`);

    // Verify it's in the database
    const count = await Addon.countDocuments({ cartId: cartAdmin._id });
    console.log(`\n📊 Total addons for this cart: ${count}`);

    // Clean up - delete test addon
    await Addon.findByIdAndDelete(addon._id);
    console.log("\n🧹 Test addon deleted");

  } catch (error) {
    console.error("❌ Error:", error);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log("\n✅ Disconnected from MongoDB");
  }
}

testAddonCreation();


