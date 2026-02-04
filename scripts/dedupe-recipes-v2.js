/**
 * Dedupe Costing-v2 Recipes (BOM) per outlet
 *
 * Why:
 * - Mongo unique indexes may not exist in production (autoIndex disabled)
 * - Name duplicates can be created with different casing/spaces or double-submit
 *
 * What it does:
 * - Normalizes recipe names to nameNormalized (lowercase + collapsed spaces)
 * - Groups by (cartId, nameNormalized) and disables duplicates by setting isActive=false
 *   and renaming them with a suffix so they no longer collide.
 *
 * Usage (on server):
 *   cd backend
 *   node scripts/dedupe-recipes-v2.js
 */

const mongoose = require("mongoose");
const Recipe = require("../models/costing-v2/recipeModel");

function normalizeName(name) {
  return (name || "").toString().trim().replace(/\s+/g, " ").toLowerCase();
}

async function main() {
  const mongoUri =
    process.env.MONGO_URI || "mongodb://127.0.0.1:27017/terra-cart";

  await mongoose.connect(mongoUri, {
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  });

  console.log("✅ Connected. Loading recipes...");

  const recipes = await Recipe.find({}).sort({ updatedAt: -1 }).lean();
  console.log(`Found ${recipes.length} recipes`);

  // First pass: ensure normalized fields exist (without saving yet)
  const groups = new Map();
  for (const r of recipes) {
    const cartKey = r.cartId ? r.cartId.toString() : "null";
    const nn = r.nameNormalized || normalizeName(r.name);
    const key = `${cartKey}::${nn}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  let duplicates = 0;
  let updated = 0;

  for (const [key, list] of groups.entries()) {
    if (list.length <= 1) continue;
    duplicates += list.length - 1;

    // Keep the most recently updated recipe as the "winner"
    const [winner, ...losers] = list;
    console.log(
      `\nDuplicate group ${key}: keeping "${winner.name}" (${winner._id}) and disabling ${losers.length} duplicate(s)`
    );

    for (const loser of losers) {
      const suffix = loser._id.toString().slice(-6);
      await Recipe.updateOne(
        { _id: loser._id },
        {
          $set: {
            isActive: false,
            name: `${(loser.name || "Recipe").toString().trim()} (DUPLICATE ${suffix})`,
            nameNormalized: normalizeName(
              `${(loser.name || "Recipe").toString().trim()} (DUPLICATE ${suffix})`
            ),
          },
        }
      );
      updated += 1;
    }

    // Also ensure winner has normalized name fields
    const winnerName = (winner.name || "").toString().trim().replace(/\s+/g, " ");
    const winnerNormalized = normalizeName(winnerName);
    await Recipe.updateOne(
      { _id: winner._id },
      { $set: { name: winnerName, nameNormalized: winnerNormalized } }
    );
  }

  console.log("\n========== DONE ==========");
  console.log(`Duplicate docs found: ${duplicates}`);
  console.log(`Duplicate docs updated/disabled: ${updated}`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("❌ Script failed:", err);
  process.exit(1);
});


