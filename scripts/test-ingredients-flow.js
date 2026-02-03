/**
 * Test script to verify ingredients flow from Super Admin to Cart Admin
 * Run: node backend/scripts/test-ingredients-flow.js
 */

const mongoose = require("mongoose");
require("dotenv").config({ path: ".env" });

const Ingredient = require("../models/costing-v2/ingredientModel");
const User = require("../models/userModel");

async function testIngredientsFlow() {
  try {
    // Connect to database
    await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
    console.log("✅ Connected to MongoDB");

    // Step 1: Check if super admin ingredients exist
    console.log("\n📊 STEP 1: Checking Super Admin Ingredients (cartId: null)");
    const superAdminIngredients = await Ingredient.find({ cartId: null });
    console.log(`   Found ${superAdminIngredients.length} shared ingredients (cartId: null)`);
    
    if (superAdminIngredients.length > 0) {
      console.log("   Sample ingredients:");
      superAdminIngredients.slice(0, 5).forEach(ing => {
        console.log(`     - ${ing.name} (isActive: ${ing.isActive}, cartId: ${ing.cartId})`);
      });
    } else {
      console.log("   ⚠️ NO SHARED INGREDIENTS FOUND!");
      console.log("   Super admin must create ingredients with cartId: null");
    }

    // Step 2: Check all ingredients by cartId
    console.log("\n📊 STEP 2: Checking All Ingredients by cartId");
    const allIngredients = await Ingredient.find({});
    const byCartId = {};
    allIngredients.forEach(ing => {
      const key = ing.cartId ? ing.cartId.toString() : 'null';
      if (!byCartId[key]) byCartId[key] = [];
      byCartId[key].push(ing.name);
    });
    
    console.log("   Ingredients grouped by cartId:");
    Object.keys(byCartId).forEach(key => {
      console.log(`     - cartId: ${key} → ${byCartId[key].length} ingredients`);
      if (byCartId[key].length <= 5) {
        console.log(`       ${byCartId[key].join(', ')}`);
      } else {
        console.log(`       ${byCartId[key].slice(0, 5).join(', ')}... (+${byCartId[key].length - 5} more)`);
      }
    });

    // Step 3: Test cart admin query
    console.log("\n📊 STEP 3: Testing Cart Admin Query");
    const cartAdmins = await User.find({ role: "admin" }).limit(3);
    
    if (cartAdmins.length === 0) {
      console.log("   ⚠️ No cart admins found!");
    } else {
      for (const cartAdmin of cartAdmins) {
        const cartId = cartAdmin._id;
        const cartIdObj = mongoose.Types.ObjectId.isValid(cartId) 
          ? new mongoose.Types.ObjectId(cartId) 
          : cartId;
        
        console.log(`\n   Testing for cart admin: ${cartAdmin.name || cartAdmin.email} (${cartId})`);
        
        // Test the exact query used by cart admin
        const query = {
          $or: [
            { cartId: null },
            { cartId: cartIdObj },
            { cartId: { $exists: false } }
          ]
        };
        
        const count = await Ingredient.countDocuments(query);
        const ingredients = await Ingredient.find(query).limit(5).select('name cartId isActive');
        
        console.log(`     Query result: ${count} ingredients`);
        if (ingredients.length > 0) {
          console.log(`     Sample ingredients:`);
          ingredients.forEach(ing => {
            const cartIdStr = ing.cartId ? ing.cartId.toString() : 'null';
            console.log(`       - ${ing.name} (cartId: ${cartIdStr}, isActive: ${ing.isActive})`);
          });
        } else {
          console.log(`     ⚠️ No ingredients found for this cart admin!`);
        }
      }
    }

    // Step 4: Recommendations
    console.log("\n📋 RECOMMENDATIONS:");
    if (superAdminIngredients.length === 0) {
      console.log("   1. Super admin must create ingredients");
      console.log("   2. When creating, ensure cartId is NOT set (will default to null)");
      console.log("   3. Ingredients should be created with cartId: null for sharing");
    } else {
      console.log(`   ✅ ${superAdminIngredients.length} shared ingredients exist`);
      console.log("   ✅ Cart admins should be able to see these ingredients");
      if (cartAdmins.length > 0) {
        const testCartAdmin = cartAdmins[0];
        const testQuery = {
          $or: [
            { cartId: null },
            { cartId: testCartAdmin._id },
            { cartId: { $exists: false } }
          ]
        };
        const testCount = await Ingredient.countDocuments(testQuery);
        if (testCount === 0) {
          console.log("   ⚠️ BUT: Query returns 0 for cart admin - check query logic!");
        } else {
          console.log(`   ✅ Query works: Returns ${testCount} ingredients for cart admin`);
        }
      }
    }

    console.log("\n✅ Test completed!");
    process.exit(0);
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }
}

testIngredientsFlow();

