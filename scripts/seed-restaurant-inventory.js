/**
 * Seed Script for Restaurant Inventory Categories and Items
 * Populates database with comprehensive restaurant inventory items
 * 
 * Usage: node backend/scripts/seed-restaurant-inventory.js
 */

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const mongoose = require("mongoose");
const Ingredient = require("../models/costing-v2/ingredientModel");
const connectDB = require("../config/db");

// Comprehensive restaurant inventory items organized by category
const inventoryItems = [
  // ========== RAW INGREDIENTS ==========
  // Vegetables
  { name: "Onion", category: "Vegetables", storageLocation: "Vegetables Section", uom: "kg", baseUnit: "kg", reorderLevel: 20, shelfTimeDays: 1, currentCostPerBaseUnit: 30 },
  { name: "Tomato", category: "Vegetables", storageLocation: "Vegetables Section", uom: "kg", baseUnit: "kg", reorderLevel: 15, shelfTimeDays: 1, currentCostPerBaseUnit: 40 },
  { name: "Potato", category: "Vegetables", storageLocation: "Vegetables Section", uom: "kg", baseUnit: "kg", reorderLevel: 25, shelfTimeDays: 1, currentCostPerBaseUnit: 25 },
  { name: "Capsicum", category: "Vegetables", storageLocation: "Vegetables Section", uom: "kg", baseUnit: "kg", reorderLevel: 10, shelfTimeDays: 1, currentCostPerBaseUnit: 60 },
  { name: "Carrot", category: "Vegetables", storageLocation: "Vegetables Section", uom: "kg", baseUnit: "kg", reorderLevel: 10, shelfTimeDays: 1, currentCostPerBaseUnit: 50 },
  { name: "Cabbage", category: "Vegetables", storageLocation: "Vegetables Section", uom: "kg", baseUnit: "kg", reorderLevel: 8, shelfTimeDays: 1, currentCostPerBaseUnit: 20 },
  { name: "Cauliflower", category: "Vegetables", storageLocation: "Vegetables Section", uom: "kg", baseUnit: "kg", reorderLevel: 8, shelfTimeDays: 1, currentCostPerBaseUnit: 35 },
  { name: "Green Beans", category: "Vegetables", storageLocation: "Vegetables Section", uom: "kg", baseUnit: "kg", reorderLevel: 5, shelfTimeDays: 1, currentCostPerBaseUnit: 80 },
  { name: "Peas", category: "Vegetables", storageLocation: "Frozen Storage", uom: "kg", baseUnit: "kg", reorderLevel: 5, shelfTimeDays: 2, currentCostPerBaseUnit: 100 },
  { name: "Spinach", category: "Vegetables", storageLocation: "Cold Storage", uom: "kg", baseUnit: "kg", reorderLevel: 5, shelfTimeDays: 1, currentCostPerBaseUnit: 40 },
  { name: "Coriander Leaves", category: "Vegetables", storageLocation: "Cold Storage", uom: "kg", baseUnit: "kg", reorderLevel: 2, shelfTimeDays: 1, currentCostPerBaseUnit: 120 },
  { name: "Mint Leaves", category: "Vegetables", storageLocation: "Cold Storage", uom: "kg", baseUnit: "kg", reorderLevel: 1, shelfTimeDays: 1, currentCostPerBaseUnit: 150 },
  
  // Dairy
  { name: "Milk", category: "Dairy", storageLocation: "Cold Storage", uom: "l", baseUnit: "l", reorderLevel: 10, shelfTimeDays: 1, currentCostPerBaseUnit: 60 },
  { name: "Cheese", category: "Dairy", storageLocation: "Cold Storage", uom: "kg", baseUnit: "kg", reorderLevel: 5, shelfTimeDays: 2, currentCostPerBaseUnit: 450 },
  { name: "Butter", category: "Dairy", storageLocation: "Cold Storage", uom: "kg", baseUnit: "kg", reorderLevel: 5, shelfTimeDays: 2, currentCostPerBaseUnit: 500 },
  { name: "Paneer", category: "Dairy", storageLocation: "Cold Storage", uom: "kg", baseUnit: "kg", reorderLevel: 8, shelfTimeDays: 1, currentCostPerBaseUnit: 350 },
  { name: "Curd", category: "Dairy", storageLocation: "Cold Storage", uom: "kg", baseUnit: "kg", reorderLevel: 5, shelfTimeDays: 1, currentCostPerBaseUnit: 80 },
  { name: "Cream", category: "Dairy", storageLocation: "Cold Storage", uom: "l", baseUnit: "l", reorderLevel: 3, shelfTimeDays: 2, currentCostPerBaseUnit: 200 },
  
  // Meat & Poultry
  { name: "Chicken", category: "Meat & Poultry", storageLocation: "Frozen Storage", uom: "kg", baseUnit: "kg", reorderLevel: 20, shelfTimeDays: 1, currentCostPerBaseUnit: 250 },
  { name: "Mutton", category: "Meat & Poultry", storageLocation: "Frozen Storage", uom: "kg", baseUnit: "kg", reorderLevel: 10, shelfTimeDays: 1, currentCostPerBaseUnit: 600 },
  { name: "Fish", category: "Meat & Poultry", storageLocation: "Frozen Storage", uom: "kg", baseUnit: "kg", reorderLevel: 8, shelfTimeDays: 1, currentCostPerBaseUnit: 400 },
  { name: "Eggs", category: "Meat & Poultry", storageLocation: "Cold Storage", uom: "dozen", baseUnit: "dozen", reorderLevel: 10, shelfTimeDays: 1, currentCostPerBaseUnit: 90 },
  
  // Grains & Staples
  { name: "Rice", category: "Grains & Staples", storageLocation: "Dry Storage", uom: "kg", baseUnit: "kg", reorderLevel: 30, shelfTimeDays: 5, currentCostPerBaseUnit: 60 },
  { name: "Wheat Flour", category: "Grains & Staples", storageLocation: "Dry Storage", uom: "kg", baseUnit: "kg", reorderLevel: 50, shelfTimeDays: 7, currentCostPerBaseUnit: 40 },
  { name: "Lentils (Dal)", category: "Grains & Staples", storageLocation: "Dry Storage", uom: "kg", baseUnit: "kg", reorderLevel: 20, shelfTimeDays: 5, currentCostPerBaseUnit: 80 },
  { name: "Chickpeas", category: "Grains & Staples", storageLocation: "Dry Storage", uom: "kg", baseUnit: "kg", reorderLevel: 15, shelfTimeDays: 5, currentCostPerBaseUnit: 100 },
  { name: "Black Gram", category: "Grains & Staples", storageLocation: "Dry Storage", uom: "kg", baseUnit: "kg", reorderLevel: 10, shelfTimeDays: 5, currentCostPerBaseUnit: 120 },
  { name: "Semolina (Sooji)", category: "Grains & Staples", storageLocation: "Dry Storage", uom: "kg", baseUnit: "kg", reorderLevel: 10, shelfTimeDays: 5, currentCostPerBaseUnit: 50 },
  
  // Spices & Seasoning
  { name: "Salt", category: "Spices & Seasoning", storageLocation: "Dry Storage", uom: "kg", baseUnit: "kg", reorderLevel: 10, shelfTimeDays: 2, currentCostPerBaseUnit: 25 },
  { name: "Sugar", category: "Spices & Seasoning", storageLocation: "Dry Storage", uom: "kg", baseUnit: "kg", reorderLevel: 15, shelfTimeDays: 3, currentCostPerBaseUnit: 45 },
  { name: "Turmeric Powder", category: "Spices & Seasoning", storageLocation: "Dry Storage", uom: "kg", baseUnit: "kg", reorderLevel: 2, shelfTimeDays: 5, currentCostPerBaseUnit: 400 },
  { name: "Chili Powder", category: "Spices & Seasoning", storageLocation: "Dry Storage", uom: "kg", baseUnit: "kg", reorderLevel: 3, shelfTimeDays: 5, currentCostPerBaseUnit: 300 },
  { name: "Coriander Powder", category: "Spices & Seasoning", storageLocation: "Dry Storage", uom: "kg", baseUnit: "kg", reorderLevel: 2, shelfTimeDays: 5, currentCostPerBaseUnit: 350 },
  { name: "Garam Masala", category: "Spices & Seasoning", storageLocation: "Dry Storage", uom: "kg", baseUnit: "kg", reorderLevel: 1, shelfTimeDays: 5, currentCostPerBaseUnit: 500 },
  { name: "Cumin Seeds", category: "Spices & Seasoning", storageLocation: "Dry Storage", uom: "kg", baseUnit: "kg", reorderLevel: 2, shelfTimeDays: 5, currentCostPerBaseUnit: 450 },
  { name: "Mustard Seeds", category: "Spices & Seasoning", storageLocation: "Dry Storage", uom: "kg", baseUnit: "kg", reorderLevel: 2, shelfTimeDays: 5, currentCostPerBaseUnit: 200 },
  { name: "Fenugreek Seeds", category: "Spices & Seasoning", storageLocation: "Dry Storage", uom: "kg", baseUnit: "kg", reorderLevel: 1, shelfTimeDays: 5, currentCostPerBaseUnit: 300 },
  { name: "Garlic", category: "Spices & Seasoning", storageLocation: "Dry Storage", uom: "kg", baseUnit: "kg", reorderLevel: 5, shelfTimeDays: 2, currentCostPerBaseUnit: 200 },
  { name: "Ginger", category: "Spices & Seasoning", storageLocation: "Dry Storage", uom: "kg", baseUnit: "kg", reorderLevel: 5, shelfTimeDays: 2, currentCostPerBaseUnit: 150 },
  { name: "Green Chilies", category: "Spices & Seasoning", storageLocation: "Cold Storage", uom: "kg", baseUnit: "kg", reorderLevel: 3, shelfTimeDays: 1, currentCostPerBaseUnit: 100 },
  
  // Cooking Oils & Ghee
  { name: "Cooking Oil", category: "Cooking Oils & Ghee", storageLocation: "Dry Storage", uom: "l", baseUnit: "l", reorderLevel: 20, shelfTimeDays: 3, currentCostPerBaseUnit: 120 },
  { name: "Ghee", category: "Cooking Oils & Ghee", storageLocation: "Dry Storage", uom: "kg", baseUnit: "kg", reorderLevel: 5, shelfTimeDays: 3, currentCostPerBaseUnit: 600 },
  { name: "Mustard Oil", category: "Cooking Oils & Ghee", storageLocation: "Dry Storage", uom: "l", baseUnit: "l", reorderLevel: 5, shelfTimeDays: 3, currentCostPerBaseUnit: 150 },
  
  // Bread, Buns & Rotis
  { name: "Bread", category: "Bread, Buns & Rotis", storageLocation: "Dry Storage", uom: "pack", baseUnit: "pack", reorderLevel: 20, shelfTimeDays: 1, currentCostPerBaseUnit: 40 },
  { name: "Burger Buns", category: "Bread, Buns & Rotis", storageLocation: "Dry Storage", uom: "pack", baseUnit: "pack", reorderLevel: 15, shelfTimeDays: 1, currentCostPerBaseUnit: 50 },
  { name: "Pav (Bread Rolls)", category: "Bread, Buns & Rotis", storageLocation: "Dry Storage", uom: "pack", baseUnit: "pack", reorderLevel: 20, shelfTimeDays: 1, currentCostPerBaseUnit: 35 },
  
  // Snacks Ingredients
  { name: "Pasta", category: "Snacks Ingredients", storageLocation: "Dry Storage", uom: "kg", baseUnit: "kg", reorderLevel: 10, shelfTimeDays: 5, currentCostPerBaseUnit: 80 },
  { name: "Noodles", category: "Snacks Ingredients", storageLocation: "Dry Storage", uom: "pack", baseUnit: "pack", reorderLevel: 20, shelfTimeDays: 3, currentCostPerBaseUnit: 15 },
  { name: "Cornflour", category: "Snacks Ingredients", storageLocation: "Dry Storage", uom: "kg", baseUnit: "kg", reorderLevel: 5, shelfTimeDays: 5, currentCostPerBaseUnit: 60 },
  { name: "Baking Soda", category: "Snacks Ingredients", storageLocation: "Dry Storage", uom: "kg", baseUnit: "kg", reorderLevel: 2, shelfTimeDays: 5, currentCostPerBaseUnit: 100 },
  { name: "Baking Powder", category: "Snacks Ingredients", storageLocation: "Dry Storage", uom: "kg", baseUnit: "kg", reorderLevel: 2, shelfTimeDays: 5, currentCostPerBaseUnit: 150 },
  
  // Packaged Items
  { name: "Tomato Ketchup", category: "Packaged Items", storageLocation: "Dry Storage", uom: "bottle", baseUnit: "bottle", reorderLevel: 10, shelfTimeDays: 7, currentCostPerBaseUnit: 80 },
  { name: "Mayonnaise", category: "Packaged Items", storageLocation: "Cold Storage", uom: "bottle", baseUnit: "bottle", reorderLevel: 5, shelfTimeDays: 7, currentCostPerBaseUnit: 120 },
  { name: "Soy Sauce", category: "Packaged Items", storageLocation: "Dry Storage", uom: "bottle", baseUnit: "bottle", reorderLevel: 5, shelfTimeDays: 7, currentCostPerBaseUnit: 60 },
  { name: "Vinegar", category: "Packaged Items", storageLocation: "Dry Storage", uom: "bottle", baseUnit: "bottle", reorderLevel: 5, shelfTimeDays: 7, currentCostPerBaseUnit: 50 },
  { name: "Pickle", category: "Packaged Items", storageLocation: "Dry Storage", uom: "bottle", baseUnit: "bottle", reorderLevel: 5, shelfTimeDays: 7, currentCostPerBaseUnit: 100 },
  
  // Beverages
  { name: "Tea Leaves", category: "Beverages", storageLocation: "Dry Storage", uom: "kg", baseUnit: "kg", reorderLevel: 5, shelfTimeDays: 5, currentCostPerBaseUnit: 300 },
  { name: "Coffee Powder", category: "Beverages", storageLocation: "Dry Storage", uom: "kg", baseUnit: "kg", reorderLevel: 3, shelfTimeDays: 5, currentCostPerBaseUnit: 400 },
  { name: "Soft Drinks", category: "Beverages", storageLocation: "Cold Storage", uom: "bottle", baseUnit: "bottle", reorderLevel: 24, shelfTimeDays: 3, currentCostPerBaseUnit: 30 },
  { name: "Juice", category: "Beverages", storageLocation: "Cold Storage", uom: "bottle", baseUnit: "bottle", reorderLevel: 12, shelfTimeDays: 3, currentCostPerBaseUnit: 50 },
  
  // ========== CONSUMABLES & NON-FOOD ITEMS ==========
  // Tissue & Paper Products
  { name: "Tissue Paper", category: "Tissue & Paper Products", storageLocation: "Packaging Supplies", uom: "pack", baseUnit: "pack", reorderLevel: 20, shelfTimeDays: 7, currentCostPerBaseUnit: 80 },
  { name: "Kitchen Paper Towels", category: "Tissue & Paper Products", storageLocation: "Packaging Supplies", uom: "pack", baseUnit: "pack", reorderLevel: 10, shelfTimeDays: 7, currentCostPerBaseUnit: 120 },
  { name: "Napkins", category: "Tissue & Paper Products", storageLocation: "Packaging Supplies", uom: "pack", baseUnit: "pack", reorderLevel: 15, shelfTimeDays: 7, currentCostPerBaseUnit: 100 },
  
  // Packaging Materials
  { name: "Aluminium Foil", category: "Packaging Materials", storageLocation: "Packaging Supplies", uom: "pack", baseUnit: "pack", reorderLevel: 10, shelfTimeDays: 7, currentCostPerBaseUnit: 150 },
  { name: "Cling Wrap", category: "Packaging Materials", storageLocation: "Packaging Supplies", uom: "pack", baseUnit: "pack", reorderLevel: 10, shelfTimeDays: 7, currentCostPerBaseUnit: 100 },
  { name: "Packaging Boxes", category: "Packaging Materials", storageLocation: "Packaging Supplies", uom: "box", baseUnit: "box", reorderLevel: 50, shelfTimeDays: 7, currentCostPerBaseUnit: 5 },
  { name: "Takeaway Containers", category: "Packaging Materials", storageLocation: "Packaging Supplies", uom: "box", baseUnit: "box", reorderLevel: 30, shelfTimeDays: 7, currentCostPerBaseUnit: 200 },
  
  // Disposable Items
  { name: "Paper Plates", category: "Disposable Items", storageLocation: "Packaging Supplies", uom: "pack", baseUnit: "pack", reorderLevel: 20, shelfTimeDays: 7, currentCostPerBaseUnit: 150 },
  { name: "Paper Cups", category: "Disposable Items", storageLocation: "Packaging Supplies", uom: "pack", baseUnit: "pack", reorderLevel: 20, shelfTimeDays: 7, currentCostPerBaseUnit: 120 },
  { name: "Disposable Spoons", category: "Disposable Items", storageLocation: "Packaging Supplies", uom: "pack", baseUnit: "pack", reorderLevel: 20, shelfTimeDays: 7, currentCostPerBaseUnit: 80 },
  { name: "Disposable Forks", category: "Disposable Items", storageLocation: "Packaging Supplies", uom: "pack", baseUnit: "pack", reorderLevel: 15, shelfTimeDays: 7, currentCostPerBaseUnit: 80 },
  { name: "Disposable Knives", category: "Disposable Items", storageLocation: "Packaging Supplies", uom: "pack", baseUnit: "pack", reorderLevel: 15, shelfTimeDays: 7, currentCostPerBaseUnit: 80 },
  
  // Cleaning Supplies
  { name: "Dish Soap", category: "Cleaning Supplies", storageLocation: "Cleaning Supplies", uom: "bottle", baseUnit: "bottle", reorderLevel: 5, shelfTimeDays: 7, currentCostPerBaseUnit: 80 },
  { name: "Floor Cleaner", category: "Cleaning Supplies", storageLocation: "Cleaning Supplies", uom: "bottle", baseUnit: "bottle", reorderLevel: 3, shelfTimeDays: 7, currentCostPerBaseUnit: 150 },
  { name: "Glass Cleaner", category: "Cleaning Supplies", storageLocation: "Cleaning Supplies", uom: "bottle", baseUnit: "bottle", reorderLevel: 2, shelfTimeDays: 7, currentCostPerBaseUnit: 100 },
  { name: "Bleach", category: "Cleaning Supplies", storageLocation: "Cleaning Supplies", uom: "bottle", baseUnit: "bottle", reorderLevel: 2, shelfTimeDays: 7, currentCostPerBaseUnit: 120 },
  { name: "Scrub Pads", category: "Cleaning Supplies", storageLocation: "Cleaning Supplies", uom: "pcs", baseUnit: "pcs", reorderLevel: 10, shelfTimeDays: 7, currentCostPerBaseUnit: 20 },
  { name: "Sponges", category: "Cleaning Supplies", storageLocation: "Cleaning Supplies", uom: "pack", baseUnit: "pack", reorderLevel: 5, shelfTimeDays: 7, currentCostPerBaseUnit: 50 },
  
  // Safety & Hygiene
  { name: "Disposable Gloves", category: "Safety & Hygiene", storageLocation: "Cleaning Supplies", uom: "box", baseUnit: "box", reorderLevel: 10, shelfTimeDays: 7, currentCostPerBaseUnit: 200 },
  { name: "Hairnets", category: "Safety & Hygiene", storageLocation: "Cleaning Supplies", uom: "pack", baseUnit: "pack", reorderLevel: 5, shelfTimeDays: 7, currentCostPerBaseUnit: 100 },
  { name: "Aprons", category: "Safety & Hygiene", storageLocation: "Cleaning Supplies", uom: "pcs", baseUnit: "pcs", reorderLevel: 5, shelfTimeDays: 7, currentCostPerBaseUnit: 300 },
  { name: "Hand Sanitizer", category: "Safety & Hygiene", storageLocation: "Cleaning Supplies", uom: "bottle", baseUnit: "bottle", reorderLevel: 5, shelfTimeDays: 7, currentCostPerBaseUnit: 150 },
  
  // Gas & Fuel
  { name: "Gas Cylinder", category: "Gas & Fuel", storageLocation: "Other", uom: "pcs", baseUnit: "pcs", reorderLevel: 1, shelfTimeDays: 1, currentCostPerBaseUnit: 1000 },
  
  // ========== PREPARED ITEMS / PRE-MIXES ==========
  { name: "Gravy Base", category: "Prepared Items", storageLocation: "Cold Storage", uom: "kg", baseUnit: "kg", reorderLevel: 5, shelfTimeDays: 1, currentCostPerBaseUnit: 150 },
  { name: "Roti Dough", category: "Prepared Items", storageLocation: "Cold Storage", uom: "kg", baseUnit: "kg", reorderLevel: 10, shelfTimeDays: 1, currentCostPerBaseUnit: 60 },
  { name: "Pizza Dough", category: "Prepared Items", storageLocation: "Cold Storage", uom: "kg", baseUnit: "kg", reorderLevel: 5, shelfTimeDays: 1, currentCostPerBaseUnit: 80 },
  { name: "Mint Chutney", category: "Prepared Items", storageLocation: "Cold Storage", uom: "kg", baseUnit: "kg", reorderLevel: 2, shelfTimeDays: 1, currentCostPerBaseUnit: 200 },
  { name: "Coriander Chutney", category: "Prepared Items", storageLocation: "Cold Storage", uom: "kg", baseUnit: "kg", reorderLevel: 2, shelfTimeDays: 1, currentCostPerBaseUnit: 180 },
  { name: "Marinated Chicken", category: "Prepared Items", storageLocation: "Frozen Storage", uom: "kg", baseUnit: "kg", reorderLevel: 10, shelfTimeDays: 1, currentCostPerBaseUnit: 300 },
  { name: "Sambar Base", category: "Prepared Items", storageLocation: "Cold Storage", uom: "kg", baseUnit: "kg", reorderLevel: 5, shelfTimeDays: 1, currentCostPerBaseUnit: 120 },
  { name: "Curry Base", category: "Prepared Items", storageLocation: "Cold Storage", uom: "kg", baseUnit: "kg", reorderLevel: 5, shelfTimeDays: 1, currentCostPerBaseUnit: 130 },
];

const seedInventory = async () => {
  try {
    await connectDB();
    console.log("✅ Connected to MongoDB");

    console.log("📦 Seeding restaurant inventory items...");
    
    let created = 0;
    let skipped = 0;
    let errors = 0;

    for (const item of inventoryItems) {
      try {
        // Check if ingredient already exists
        const existing = await Ingredient.findOne({ name: item.name });
        if (existing) {
          console.log(`⏭️  Skipping ${item.name} - already exists`);
          skipped++;
          continue;
        }

        // Create conversion factors map
        const conversionFactors = new Map();
        conversionFactors.set(item.baseUnit, 1);

        // Create ingredient
        const ingredient = new Ingredient({
          ...item,
          conversionFactors,
          qtyOnHand: 0, // Start with zero stock
          isActive: true,
        });

        await ingredient.save();
        created++;
        console.log(`✅ Created: ${item.name} (${item.category})`);
      } catch (error) {
        console.error(`❌ Error creating ${item.name}:`, error.message);
        errors++;
      }
    }

    console.log("\n✅ Inventory seeding completed!");
    console.log("\n📊 Summary:");
    console.log(`   - Created: ${created} items`);
    console.log(`   - Skipped: ${skipped} items (already exist)`);
    console.log(`   - Errors: ${errors} items`);
    console.log(`   - Total Categories: ${new Set(inventoryItems.map(i => i.category)).size}`);
    console.log(`   - Total Items: ${inventoryItems.length}`);

    process.exit(0);
  } catch (error) {
    console.error("❌ Error seeding inventory:", error);
    process.exit(1);
  }
};

seedInventory();



