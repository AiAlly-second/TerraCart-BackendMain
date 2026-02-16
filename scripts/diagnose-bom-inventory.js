/**
 * BOM & Inventory Diagnosis Script
 * For a given cartId: lists MenuItem (cart menu) vs MenuItemV2 (Finances) vs RecipeV2.
 * Reports: items in cart menu with no MenuItemV2, MenuItemV2 with no recipeId, name mismatches.
 *
 * Usage (from project root):
 *   node backend/scripts/diagnose-bom-inventory.js
 *   node backend/scripts/diagnose-bom-inventory.js <cartAdminUserId>
 * If cartId omitted, uses first active cart admin.
 * On PowerShell, pass the ID in quotes: node backend/scripts/diagnose-bom-inventory.js "USER_ID_HERE"
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
if (!process.env.MONGO_URI) {
  console.error("MONGO_URI is not set. Add MONGO_URI to backend/.env (or run from backend with: node scripts/diagnose-bom-inventory.js)");
  process.exit(1);
}

const mongoose = require("mongoose");
const { MenuItem } = require("../models/menuItemModel");
const MenuItemV2 = require("../models/costing-v2/menuItemModel");
const RecipeV2 = require("../models/costing-v2/recipeModel");
const User = require("../models/userModel");

async function diagnoseBomInventory(cartId) {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to MongoDB\n");

    let targetCartId = cartId;
    if (!targetCartId) {
      const cartAdmin = await User.findOne({ role: "admin", isActive: { $ne: false } });
      if (!cartAdmin) {
        console.log("No active cart admin found. Provide cartId as argument.");
        process.exit(1);
      }
      targetCartId = cartAdmin._id;
      console.log(`Using first cart admin: ${cartAdmin.cartName || cartAdmin.name} (${targetCartId})\n`);
    }

    const cartMenuItems = await MenuItem.find({
      $or: [{ cafeId: targetCartId }, { cartId: targetCartId }],
    })
      .populate("category", "name")
      .lean();

    const costingMenuItems = await MenuItemV2.find({ cartId: targetCartId })
      .populate("recipeId", "name portions")
      .lean();

    const recipes = await RecipeV2.find({
      $or: [
        { cartId: targetCartId },
        { cartId: null },
        { franchiseId: (await User.findById(targetCartId).select("franchiseId").lean())?.franchiseId },
      ],
    })
      .select("name nameNormalized cartId")
      .lean();

    console.log("=".repeat(70));
    console.log("BOM & INVENTORY DIAGNOSIS");
    console.log("=".repeat(70));
    console.log(`Cart ID: ${targetCartId}\n`);

    // 1. Cart menu items
    console.log("1. CART MENU (MenuItem)");
    console.log("-".repeat(50));
    console.log(`Total: ${cartMenuItems.length}`);
    if (cartMenuItems.length > 0) {
      cartMenuItems.slice(0, 15).forEach((m) => {
        const cat = m.category?.name || m.category || "?";
        console.log(`  - ${m.name} (${cat})`);
      });
      if (cartMenuItems.length > 15) {
        console.log(`  ... and ${cartMenuItems.length - 15} more`);
      }
    }
    console.log("");

    // 2. Finances menu items (MenuItemV2)
    console.log("2. FINANCES MENU (MenuItemV2)");
    console.log("-".repeat(50));
    console.log(`Total: ${costingMenuItems.length}`);
    const withBom = costingMenuItems.filter((m) => m.recipeId && m.recipeId._id);
    const withoutBom = costingMenuItems.filter((m) => !m.recipeId || !m.recipeId._id);
    console.log(`  With BOM: ${withBom.length}`);
    console.log(`  Without BOM: ${withoutBom.length}`);
    if (withoutBom.length > 0) {
      console.log("\n  Items WITHOUT BOM (inventory will NOT be consumed):");
      withoutBom.forEach((m) => console.log(`    - ${m.name}`));
    }
    console.log("");

    // 3. Recipes (BOM)
    console.log("3. RECIPES / BOM (RecipeV2)");
    console.log("-".repeat(50));
    console.log(`Total: ${recipes.length}`);
    if (recipes.length > 0) {
      recipes.slice(0, 15).forEach((r) => {
        const scope = r.cartId ? "cart" : "shared";
        console.log(`  - ${r.name} (${scope})`);
      });
      if (recipes.length > 15) {
        console.log(`  ... and ${recipes.length - 15} more`);
      }
    }
    console.log("");

    // 4. Cart items with no MenuItemV2
    const cartNames = new Set(cartMenuItems.map((m) => m.name?.trim().toLowerCase()));
    const costingNames = new Set(
      costingMenuItems.map((m) => (m.name || m.defaultMenuItemName || "").trim().toLowerCase())
    );
    const missingInCosting = cartMenuItems.filter((m) => {
      const n = (m.name || "").trim().toLowerCase();
      return !costingMenuItems.some(
        (c) =>
          (c.name || "").trim().toLowerCase() === n ||
          (c.defaultMenuItemName || "").trim().toLowerCase() === n
      );
    });

    console.log("4. CART ITEMS WITH NO FINANCES ENTRY");
    console.log("-".repeat(50));
    if (missingInCosting.length === 0) {
      console.log("  All cart items have a Finances Menu Item.");
    } else {
      console.log(`  ${missingInCosting.length} item(s) in cart menu but NOT in Finances:`);
      missingInCosting.forEach((m) => console.log(`    - ${m.name}`));
      console.log("\n  Action: Run 'Sync from Cart Menu' in Finances > Menu Items.");
    }
    console.log("");

    // 5. Name mismatches (cart name vs costing name)
    console.log("5. NAME MISMATCHES");
    console.log("-".repeat(50));
    const mismatches = [];
    for (const cartItem of cartMenuItems) {
      const cartName = (cartItem.name || "").trim();
      const costingItem = costingMenuItems.find(
        (c) =>
          (c.name || "").trim().toLowerCase() === cartName.toLowerCase() ||
          (c.defaultMenuItemName || "").trim().toLowerCase() === cartName.toLowerCase()
      );
      if (costingItem && costingItem.name !== cartName) {
        mismatches.push({ cart: cartName, costing: costingItem.name });
      }
    }
    if (mismatches.length === 0) {
      console.log("  No significant name mismatches found.");
    } else {
      console.log(`  ${mismatches.length} potential mismatch(es):`);
      mismatches.forEach((m) => console.log(`    Cart: "${m.cart}" | Finances: "${m.costing}"`));
    }
    console.log("");

    // 6. Summary
    console.log("6. SUMMARY");
    console.log("-".repeat(50));
    console.log(`  Cart menu items: ${cartMenuItems.length}`);
    console.log(`  Finances menu items: ${costingMenuItems.length}`);
    console.log(`  Finances items with BOM: ${withBom.length}`);
    console.log(`  Finances items without BOM: ${withoutBom.length}`);
    console.log(`  Recipes available: ${recipes.length}`);
    console.log(`  Cart items missing in Finances: ${missingInCosting.length}`);
    if (withoutBom.length > 0 || missingInCosting.length > 0) {
      console.log("\n  RECOMMENDATIONS:");
      if (missingInCosting.length > 0) {
        console.log("    - Run 'Sync from Cart Menu' in Finances > Menu Items");
      }
      if (withoutBom.length > 0) {
        console.log("    - Run 'Link matching BOMs' to auto-link recipes by name");
        console.log("    - Or manually link each menu item to a recipe in Finances > Menu Items");
      }
    }
    console.log("");

    // 7. Recipes that could match unlinked items
    if (withoutBom.length > 0 && recipes.length > 0) {
      console.log("7. POSSIBLE BOM MATCHES FOR UNLINKED ITEMS");
      console.log("-".repeat(50));
      const recipeNames = new Set(recipes.map((r) => (r.nameNormalized || r.name || "").toLowerCase()));
      for (const mi of withoutBom) {
        const nameNorm = (mi.name || "").trim().replace(/\s+/g, " ").toLowerCase();
        const matching = recipes.find(
          (r) =>
            (r.nameNormalized || "").toLowerCase() === nameNorm ||
            (r.name || "").toLowerCase() === nameNorm
        );
        if (matching) {
          console.log(`  "${mi.name}" -> can link to BOM "${matching.name}"`);
        } else {
          console.log(`  "${mi.name}" -> no matching BOM found`);
        }
      }
    }

    console.log("\nDone.");
  } catch (err) {
    console.error("Error:", err);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

const cartId = process.argv[2] || null;
diagnoseBomInventory(cartId);
