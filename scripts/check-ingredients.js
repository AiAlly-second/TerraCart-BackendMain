/**
 * Quick script to check ingredients in database
 * Run: node backend/scripts/check-ingredients.js
 */

const mongoose = require("mongoose");
require("dotenv").config({ path: ".env" });

const Ingredient = require("../models/costing-v2/ingredientModel");

async function checkIngredients() {
  try {
    await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
    console.log("✅ Connected too MongoDB\n");

    // Check all ingredients
    const all = await Ingredient.find({}).select("name cartId isActive").lean();
    console.log(`📊 Total ingredients in database: ${all.length}\n`);

    // Group by cartId
    const byCartId = {};
    all.forEach((ing) => {
      const key = ing.cartId ? ing.cartId.toString() : "null (SHARED)";
      if (!byCartId[key]) byCartId[key] = [];
      byCartId[key].push({
        name: ing.name,
        isActive: ing.isActive,
      });
    });

    console.log("📦 Ingredients grouped by cartId:");
    Object.keys(byCartId).forEach((key) => {
      console.log(`\n  cartId: ${key}`);
      console.log(`  Count: ${byCartId[key].length}`);
      if (byCartId[key].length <= 10) {
        byCartId[key].forEach((ing) => {
          console.log(`    - ${ing.name} (active: ${ing.isActive})`);
        });
      } else {
        byCartId[key].slice(0, 5).forEach((ing) => {
          console.log(`    - ${ing.name} (active: ${ing.isActive})`);
        });
        console.log(`    ... and ${byCartId[key].length - 5} more`);
      }
    });

    // Check shared ingredients specifically
    const shared = await Ingredient.find({ cartId: null })
      .select("name isActive")
      .lean();
    console.log(`\n✅ Shared ingredients (cartId: null): ${shared.length}`);
    if (shared.length > 0) {
      console.log("   These should be visible to ALL cart admins:");
      shared.slice(0, 10).forEach((ing) => {
        console.log(`     - ${ing.name} (active: ${ing.isActive})`);
      });
      if (shared.length > 10) {
        console.log(`     ... and ${shared.length - 10} more`);
      }
    } else {
      console.log("   ⚠️ NO SHARED INGREDIENTS FOUND!");
      console.log(
        "   Super admin must create ingredients (they will automatically have cartId: null)",
      );
    }

    process.exit(0);
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }
}

checkIngredients();
