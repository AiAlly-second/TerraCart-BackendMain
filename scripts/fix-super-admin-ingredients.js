/**
 * Script to check and fix super admin ingredients
 * Ensures all super admin ingredients have cartId: null so cart admins can see them
 * Run: node backend/scripts/fix-super-admin-ingredients.js
 */

const mongoose = require("mongoose");
const path = require("path");

// Load environment variables
require("dotenv").config({ path: path.join(__dirname, "../.env") });

// Import models
const Ingredient = require("../models/costing-v2/ingredientModel");
const User = require("../models/userModel");

async function fixSuperAdminIngredients() {
  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/terra-cart";
    await mongoose.connect(mongoUri);
    console.log("✅ Connected to MongoDB\n");

    // Find super admin user
    const superAdmin = await User.findOne({ role: "super_admin" });
    if (!superAdmin) {
      console.error("❌ Super admin user not found!");
      process.exit(1);
    }
    console.log(`✅ Super admin found: ${superAdmin.name} (${superAdmin._id})\n`);

    // Find all ingredients
    const allIngredients = await Ingredient.find({}).lean();
    console.log(`📊 Total ingredients in database: ${allIngredients.length}\n`);

    // Check ingredients by cartId
    const withCartIdNull = await Ingredient.countDocuments({ cartId: null });
    const withCartId = await Ingredient.countDocuments({ cartId: { $ne: null, $exists: true } });
    const withNoCartId = await Ingredient.countDocuments({ cartId: { $exists: false } });

    console.log(`📊 Ingredients breakdown:`);
    console.log(`   - cartId: null (shared): ${withCartIdNull}`);
    console.log(`   - cartId: <some value>: ${withCartId}`);
    console.log(`   - cartId: <missing>: ${withNoCartId}\n`);

    // Find ingredients that should be shared but aren't
    // These are ingredients that don't have cartId: null
    const ingredientsToFix = await Ingredient.find({
      $or: [
        { cartId: { $ne: null, $exists: true } },
        { cartId: { $exists: false } }
      ]
    }).lean();

    console.log(`🔍 Found ${ingredientsToFix.length} ingredients that might need fixing\n`);

    if (ingredientsToFix.length > 0) {
      console.log(`📋 Sample ingredients to check:`);
      ingredientsToFix.slice(0, 10).forEach((ing, index) => {
        console.log(`   ${index + 1}. ${ing.name}`);
        console.log(`      - cartId: ${ing.cartId ? ing.cartId.toString() : 'missing'}`);
        console.log(`      - isActive: ${ing.isActive}`);
        console.log(`      - created: ${ing.createdAt}`);
        console.log(``);
      });

      console.log(`\n❓ Do you want to set cartId to null for these ingredients?`);
      console.log(`   This will make them visible to all cart admins.`);
      console.log(`   Note: This script will NOT automatically fix them.`);
      console.log(`   You need to manually update them or use MongoDB directly.\n`);

      // Show MongoDB command to fix
      console.log(`💡 To fix, run this in MongoDB:`);
      console.log(`   db.ingredientv2s.updateMany(`);
      console.log(`     { cartId: { $ne: null } },`);
      console.log(`     { $set: { cartId: null } }`);
      console.log(`   )\n`);

      // Or fix automatically (commented out for safety)
      // Uncomment to auto-fix:
      /*
      console.log(`🔧 Fixing ingredients...`);
      const result = await Ingredient.updateMany(
        {
          $or: [
            { cartId: { $ne: null, $exists: true } },
            { cartId: { $exists: false } }
          ]
        },
        { $set: { cartId: null } }
      );
      console.log(`✅ Fixed ${result.modifiedCount} ingredients\n`);
      */
    } else {
      console.log(`✅ All ingredients already have cartId: null or are cart-specific\n`);
    }

    // Verify shared ingredients
    const sharedCount = await Ingredient.countDocuments({ cartId: null });
    console.log(`✅ Final count - Shared ingredients (cartId: null): ${sharedCount}`);

    await mongoose.disconnect();
    console.log("\n✅ Script completed");
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }
}

fixSuperAdminIngredients();

