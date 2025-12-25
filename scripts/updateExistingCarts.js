/**
 * Migration script to update existing carts with new pickup/delivery fields
 * Run this once to update existing carts in the database
 * 
 * Usage: node backend/scripts/updateExistingCarts.js
 */

const mongoose = require("mongoose");
require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const Cart = require("../models/cartModel");

async function updateExistingCarts() {
  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGO_URI || "mongodb://localhost:27017/TerraCart";
    await mongoose.connect(mongoUri);
    console.log("✅ Connected to MongoDB");

    // Find all carts
    const carts = await Cart.find({});
    console.log(`📦 Found ${carts.length} carts to update`);

    let updated = 0;
    let skipped = 0;

    for (const cart of carts) {
      let needsUpdate = false;
      const updates = {};

      // Set pickupEnabled if not set (default: true)
      if (cart.pickupEnabled === undefined) {
        updates.pickupEnabled = true;
        needsUpdate = true;
      }

      // Set deliveryEnabled if not set (default: false)
      if (cart.deliveryEnabled === undefined) {
        updates.deliveryEnabled = false;
        needsUpdate = true;
      }

      // Set deliveryRadius if not set (default: 5)
      if (cart.deliveryRadius === undefined) {
        updates.deliveryRadius = 5;
        needsUpdate = true;
      }

      // Set deliveryCharge if not set (default: 0)
      if (cart.deliveryCharge === undefined) {
        updates.deliveryCharge = 0;
        needsUpdate = true;
      }

      // Set isActive if not set (default: true)
      if (cart.isActive === undefined) {
        updates.isActive = true;
        needsUpdate = true;
      }

      if (needsUpdate) {
        await Cart.updateOne({ _id: cart._id }, { $set: updates });
        updated++;
        console.log(`✅ Updated cart: ${cart.name} (${cart._id})`);
      } else {
        skipped++;
        console.log(`⏭️  Skipped cart: ${cart.name} (already has all fields)`);
      }
    }

    console.log("\n📊 Summary:");
    console.log(`✅ Updated: ${updated} carts`);
    console.log(`⏭️  Skipped: ${skipped} carts`);
    console.log(`📦 Total: ${carts.length} carts`);

    await mongoose.disconnect();
    console.log("\n✅ Migration complete!");
  } catch (error) {
    console.error("❌ Error updating carts:", error);
    process.exit(1);
  }
}

// Run migration
updateExistingCarts();

