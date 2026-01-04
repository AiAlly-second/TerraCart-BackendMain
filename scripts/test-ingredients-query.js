/**
 * Test script to verify ingredients query for cart admins
 * Run: node backend/scripts/test-ingredients-query.js <cartAdminId>
 */

const mongoose = require("mongoose");
const path = require("path");

// Load environment variables
require("dotenv").config({ path: path.join(__dirname, "../.env") });

// Import models
const Ingredient = require("../models/costing-v2/ingredientModel");
const User = require("../models/userModel");

async function testIngredientsQuery(cartAdminId) {
  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/terra-cart";
    await mongoose.connect(mongoUri);
    console.log("✅ Connected to MongoDB\n");

    // Verify cart admin exists
    const cartAdmin = await User.findById(cartAdminId);
    if (!cartAdmin) {
      console.error(`❌ Cart admin with ID ${cartAdminId} not found`);
      process.exit(1);
    }
    console.log(`✅ Cart admin found: ${cartAdmin.name || cartAdmin.cartName} (${cartAdmin._id})\n`);

    // Convert to ObjectId
    const userCartIdObj = mongoose.Types.ObjectId.isValid(cartAdminId) 
      ? new mongoose.Types.ObjectId(cartAdminId) 
      : cartAdminId;

    // Test 1: Count all ingredients
    const totalCount = await Ingredient.countDocuments({});
    console.log(`📊 Total ingredients in database: ${totalCount}`);

    // Test 2: Count cart-specific ingredients
    const cartSpecificCount = await Ingredient.countDocuments({ cartId: userCartIdObj });
    console.log(`📊 Ingredients with cartId=${userCartIdObj}: ${cartSpecificCount}`);

    // Test 3: Count shared ingredients (cartId: null)
    const sharedCount = await Ingredient.countDocuments({ cartId: null });
    console.log(`📊 Ingredients with cartId=null (shared): ${sharedCount}`);

    // Test 4: Count ingredients without cartId field
    const noCartIdCount = await Ingredient.countDocuments({ cartId: { $exists: false } });
    console.log(`📊 Ingredients without cartId field: ${noCartIdCount}\n`);

    // Test 5: Execute the actual query
    const query = {
      $or: [
        { cartId: userCartIdObj },
        { cartId: null },
        { cartId: { $exists: false } }
      ]
    };
    
    console.log(`🔍 Executing query:`, JSON.stringify(query, null, 2));
    const results = await Ingredient.find(query)
      .select("name cartId isActive category")
      .lean();
    
    console.log(`\n✅ Query returned ${results.length} ingredients:\n`);
    
    if (results.length > 0) {
      results.slice(0, 10).forEach((ing, index) => {
        console.log(`${index + 1}. ${ing.name}`);
        console.log(`   - cartId: ${ing.cartId ? ing.cartId.toString() : 'null'}`);
        console.log(`   - category: ${ing.category}`);
        console.log(`   - isActive: ${ing.isActive}\n`);
      });
      if (results.length > 10) {
        console.log(`... and ${results.length - 10} more ingredients\n`);
      }
    } else {
      console.log("❌ No ingredients found with the query!\n");
      console.log("💡 Possible issues:");
      console.log("   1. Super admin hasn't created any ingredients");
      console.log("   2. Ingredients don't have cartId: null (they might have a different cartId)");
      console.log("   3. All ingredients are inactive (isActive: false)\n");
      
      // Show sample ingredients
      const sampleIngredients = await Ingredient.find({}).limit(5).select("name cartId isActive").lean();
      if (sampleIngredients.length > 0) {
        console.log("📋 Sample ingredients in database:");
        sampleIngredients.forEach((ing, index) => {
          console.log(`   ${index + 1}. ${ing.name} - cartId: ${ing.cartId ? ing.cartId.toString() : 'null'} - isActive: ${ing.isActive}`);
        });
      }
    }

    await mongoose.disconnect();
    console.log("\n✅ Test completed");
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }
}

// Get cart admin ID from command line
const cartAdminId = process.argv[2];

if (!cartAdminId) {
  console.error("❌ Please provide cart admin ID as argument");
  console.log("Usage: node backend/scripts/test-ingredients-query.js <cartAdminId>");
  process.exit(1);
}

testIngredientsQuery(cartAdminId);

