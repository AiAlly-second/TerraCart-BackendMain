/**
 * Seed Script for Costing Management v2
 * Populates database with sample data for testing
 * 
 * Usage: node backend/scripts/seed-costing-v2.js
 */

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const mongoose = require("mongoose");
const Supplier = require("../models/costing-v2/supplierModel");
const Ingredient = require("../models/costing-v2/ingredientModel");
const Purchase = require("../models/costing-v2/purchaseModel");
const Recipe = require("../models/costing-v2/recipeModel");
const MenuItem = require("../models/costing-v2/menuItemModel");
const Waste = require("../models/costing-v2/wasteModel");
const LabourCost = require("../models/costing-v2/labourCostModel");
const Overhead = require("../models/costing-v2/overheadModel");
const User = require("../models/userModel");
const FIFOService = require("../services/costing-v2/fifoService");
const InventoryTransaction = require("../models/costing-v2/inventoryTransactionModel");

const connectDB = require("../config/db");

// Sample data
const sampleSuppliers = [
  {
    name: "Fresh Produce Co.",
    contact: {
      phone: "+91-9876543210",
      email: "contact@freshproduce.com",
      person: "Rajesh Kumar",
    },
    address: {
      street: "123 Market Street",
      city: "Mumbai",
      state: "Maharashtra",
      zipCode: "400001",
    },
    paymentTerms: "Net 30",
    isActive: true,
  },
  {
    name: "Spice Traders Ltd.",
    contact: {
      phone: "+91-9876543211",
      email: "sales@spicetraders.com",
      person: "Priya Sharma",
    },
    address: {
      street: "456 Spice Lane",
      city: "Delhi",
      state: "Delhi",
      zipCode: "110001",
    },
    paymentTerms: "Net 15",
    isActive: true,
  },
  {
    name: "Dairy Products Inc.",
    contact: {
      phone: "+91-9876543212",
      email: "info@dairyproducts.com",
      person: "Amit Patel",
    },
    address: {
      street: "789 Dairy Road",
      city: "Ahmedabad",
      state: "Gujarat",
      zipCode: "380001",
    },
    paymentTerms: "COD",
    isActive: true,
  },
];

const sampleIngredients = [
  { name: "Flour", uom: "kg", baseUnit: "kg", reorderLevel: 50, leadTimeDays: 7, currentCostPerBaseUnit: 40 },
  { name: "Rice", uom: "kg", baseUnit: "kg", reorderLevel: 30, leadTimeDays: 5, currentCostPerBaseUnit: 60 },
  { name: "Oil", uom: "l", baseUnit: "l", reorderLevel: 20, leadTimeDays: 3, currentCostPerBaseUnit: 120 },
  { name: "Salt", uom: "kg", baseUnit: "kg", reorderLevel: 10, leadTimeDays: 2, currentCostPerBaseUnit: 25 },
  { name: "Sugar", uom: "kg", baseUnit: "kg", reorderLevel: 15, leadTimeDays: 3, currentCostPerBaseUnit: 45 },
  { name: "Tomatoes", uom: "kg", baseUnit: "kg", reorderLevel: 20, leadTimeDays: 1, currentCostPerBaseUnit: 40 },
  { name: "Onions", uom: "kg", baseUnit: "kg", reorderLevel: 25, leadTimeDays: 1, currentCostPerBaseUnit: 30 },
  { name: "Garlic", uom: "kg", baseUnit: "kg", reorderLevel: 5, leadTimeDays: 2, currentCostPerBaseUnit: 200 },
  { name: "Ginger", uom: "kg", baseUnit: "kg", reorderLevel: 5, leadTimeDays: 2, currentCostPerBaseUnit: 150 },
  { name: "Chili Powder", uom: "kg", baseUnit: "kg", reorderLevel: 3, leadTimeDays: 5, currentCostPerBaseUnit: 300 },
  { name: "Turmeric Powder", uom: "kg", baseUnit: "kg", reorderLevel: 2, leadTimeDays: 5, currentCostPerBaseUnit: 400 },
  { name: "Coriander Powder", uom: "kg", baseUnit: "kg", reorderLevel: 2, leadTimeDays: 5, currentCostPerBaseUnit: 350 },
  { name: "Milk", uom: "l", baseUnit: "l", reorderLevel: 10, leadTimeDays: 1, currentCostPerBaseUnit: 60 },
  { name: "Butter", uom: "kg", baseUnit: "kg", reorderLevel: 5, leadTimeDays: 2, currentCostPerBaseUnit: 500 },
  { name: "Paper Plates", uom: "pcs", baseUnit: "pcs", reorderLevel: 500, leadTimeDays: 7, currentCostPerBaseUnit: 2 },
];

const seedData = async () => {
  try {
    await connectDB();
    console.log("✅ Connected to MongoDB");

    // Clear existing data (optional - comment out if you want to keep existing data)
    console.log("🗑️  Clearing existing data...");
    await Supplier.deleteMany({});
    await Ingredient.deleteMany({});
    await Purchase.deleteMany({});
    await Recipe.deleteMany({});
    await MenuItem.deleteMany({});
    await Waste.deleteMany({});
    await LabourCost.deleteMany({});
    await Overhead.deleteMany({});
    await InventoryTransaction.deleteMany({});

    // Create suppliers
    console.log("📦 Creating suppliers...");
    const suppliers = await Supplier.insertMany(sampleSuppliers);
    console.log(`✅ Created ${suppliers.length} suppliers`);

    // Create ingredients
    console.log("🥘 Creating ingredients...");
    const ingredients = [];
    for (let i = 0; i < sampleIngredients.length; i++) {
      const ingData = {
        ...sampleIngredients[i],
        preferredSupplierId: suppliers[i % suppliers.length]._id,
        conversionFactors: new Map([[sampleIngredients[i].baseUnit, 1]]),
        isActive: true,
      };
      const ingredient = new Ingredient(ingData);
      await ingredient.save();
      ingredients.push(ingredient);
    }
    console.log(`✅ Created ${ingredients.length} ingredients`);

    // Get or create a test user
    let testUser = await User.findOne({ role: "super_admin" });
    if (!testUser) {
      testUser = await User.findOne({ role: "franchise_admin" });
    }
    if (!testUser) {
      console.log("⚠️  No admin user found. Creating a test user...");
      testUser = new User({
        name: "Test Admin",
        email: "test@admin.com",
        password: "Test@123",
        role: "super_admin",
        isActive: true,
      });
      await testUser.save();
    }

    // Create purchases with FIFO layers
    console.log("🛒 Creating purchases...");
    const purchases = [];
    const purchaseData = [
      {
        supplierId: suppliers[0]._id,
        date: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // 30 days ago
        invoiceNo: "INV-001",
        items: [
          { ingredientId: ingredients[0]._id, qty: 100, uom: "kg", unitPrice: 38 },
          { ingredientId: ingredients[2]._id, qty: 50, uom: "l", unitPrice: 115 },
        ],
      },
      {
        supplierId: suppliers[1]._id,
        date: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000), // 20 days ago
        invoiceNo: "INV-002",
        items: [
          { ingredientId: ingredients[1]._id, qty: 80, uom: "kg", unitPrice: 58 },
          { ingredientId: ingredients[9]._id, qty: 5, uom: "kg", unitPrice: 290 },
        ],
      },
      {
        supplierId: suppliers[0]._id,
        date: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000), // 10 days ago
        invoiceNo: "INV-003",
        items: [
          { ingredientId: ingredients[0]._id, qty: 50, uom: "kg", unitPrice: 42 },
          { ingredientId: ingredients[5]._id, qty: 30, uom: "kg", unitPrice: 38 },
        ],
      },
      {
        supplierId: suppliers[2]._id,
        date: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000), // 5 days ago
        invoiceNo: "INV-004",
        items: [
          { ingredientId: ingredients[12]._id, qty: 20, uom: "l", unitPrice: 58 },
          { ingredientId: ingredients[13]._id, qty: 10, uom: "kg", unitPrice: 495 },
        ],
      },
      {
        supplierId: suppliers[1]._id,
        date: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // 2 days ago
        invoiceNo: "INV-005",
        items: [
          { ingredientId: ingredients[6]._id, qty: 40, uom: "kg", unitPrice: 28 },
          { ingredientId: ingredients[7]._id, qty: 3, uom: "kg", unitPrice: 195 },
        ],
      },
    ];

    for (const purchaseDataItem of purchaseData) {
      let totalAmount = 0;
      const items = purchaseDataItem.items.map(item => {
        const total = item.qty * item.unitPrice;
        totalAmount += total;
        return {
          ingredientId: item.ingredientId,
          qty: item.qty,
          uom: item.uom,
          unitPrice: item.unitPrice,
          total,
        };
      });

      const purchase = new Purchase({
        ...purchaseDataItem,
        items,
        totalAmount,
        status: "received",
        receivedDate: purchaseDataItem.date,
        receivedBy: testUser._id,
      });

      await purchase.save();

      // Add FIFO layers
      for (const item of purchase.items) {
        const ingredient = await Ingredient.findById(item.ingredientId);
        const qtyInBaseUnit = ingredient.convertToBaseUnit(item.qty, item.uom);
        const unitCostInBaseUnit = item.unitPrice / ingredient.convertToBaseUnit(1, item.uom);

        await FIFOService.addLayer(
          item.ingredientId,
          qtyInBaseUnit,
          unitCostInBaseUnit,
          purchase._id
        );

        // Create inventory transaction
        const transaction = new InventoryTransaction({
          ingredientId: item.ingredientId,
          type: "IN",
          qty: qtyInBaseUnit,
          uom: ingredient.baseUnit,
          refType: "purchase",
          refId: purchase._id,
          date: purchase.date,
          costAllocated: qtyInBaseUnit * unitCostInBaseUnit,
          recordedBy: testUser._id,
        });
        await transaction.save();
      }

      purchases.push(purchase);
    }
    console.log(`✅ Created ${purchases.length} purchases with FIFO layers`);

    // Create recipes
    console.log("📝 Creating recipes...");
    const recipes = [];
    const recipeData = [
      {
        name: "Biryani",
        yieldPercent: 95,
        portions: 10,
        instructions: "Cook rice, add spices, layer with meat, steam",
        ingredients: [
          { ingredientId: ingredients[1]._id, qty: 1, uom: "kg" },
          { ingredientId: ingredients[2]._id, qty: 0.5, uom: "l" },
          { ingredientId: ingredients[5]._id, qty: 0.5, uom: "kg" },
          { ingredientId: ingredients[6]._id, qty: 0.3, uom: "kg" },
          { ingredientId: ingredients[7]._id, qty: 0.05, uom: "kg" },
          { ingredientId: ingredients[9]._id, qty: 0.02, uom: "kg" },
        ],
      },
      {
        name: "Curry",
        yieldPercent: 90,
        portions: 8,
        instructions: "Sauté onions, add spices, add main ingredient, simmer",
        ingredients: [
          { ingredientId: ingredients[2]._id, qty: 0.3, uom: "l" },
          { ingredientId: ingredients[5]._id, qty: 0.4, uom: "kg" },
          { ingredientId: ingredients[6]._id, qty: 0.2, uom: "kg" },
          { ingredientId: ingredients[7]._id, qty: 0.03, uom: "kg" },
          { ingredientId: ingredients[9]._id, qty: 0.01, uom: "kg" },
          { ingredientId: ingredients[10]._id, qty: 0.01, uom: "kg" },
        ],
      },
      {
        name: "Rice Bowl",
        yieldPercent: 100,
        portions: 5,
        instructions: "Cook rice, add vegetables, serve",
        ingredients: [
          { ingredientId: ingredients[1]._id, qty: 0.5, uom: "kg" },
          { ingredientId: ingredients[5]._id, qty: 0.2, uom: "kg" },
          { ingredientId: ingredients[6]._id, qty: 0.1, uom: "kg" },
        ],
      },
      {
        name: "Naan",
        yieldPercent: 95,
        portions: 20,
        instructions: "Knead dough, roll, cook on tawa",
        ingredients: [
          { ingredientId: ingredients[0]._id, qty: 1, uom: "kg" },
          { ingredientId: ingredients[2]._id, qty: 0.2, uom: "l" },
          { ingredientId: ingredients[12]._id, qty: 0.3, uom: "l" },
          { ingredientId: ingredients[13]._id, qty: 0.1, uom: "kg" },
        ],
      },
      {
        name: "Dal",
        yieldPercent: 90,
        portions: 6,
        instructions: "Boil lentils, temper with spices",
        ingredients: [
          { ingredientId: ingredients[1]._id, qty: 0.3, uom: "kg" },
          { ingredientId: ingredients[2]._id, qty: 0.1, uom: "l" },
          { ingredientId: ingredients[5]._id, qty: 0.1, uom: "kg" },
          { ingredientId: ingredients[6]._id, qty: 0.05, uom: "kg" },
          { ingredientId: ingredients[10]._id, qty: 0.005, uom: "kg" },
        ],
      },
      {
        name: "Roti",
        yieldPercent: 98,
        portions: 15,
        instructions: "Knead dough, roll, cook on tawa",
        ingredients: [
          { ingredientId: ingredients[0]._id, qty: 0.5, uom: "kg" },
          { ingredientId: ingredients[2]._id, qty: 0.1, uom: "l" },
        ],
      },
    ];

    for (const recipeDataItem of recipeData) {
      const recipe = new Recipe(recipeDataItem);
      await recipe.calculateCost();
      await recipe.save();
      recipes.push(recipe);
    }
    console.log(`✅ Created ${recipes.length} recipes`);

    // Create menu items
    console.log("🍽️  Creating menu items...");
    const menuItems = [];
    const menuItemData = [
      { name: "Chicken Biryani", category: "Main Course", sellingPrice: 250, recipeId: recipes[0]._id },
      { name: "Vegetable Curry", category: "Main Course", sellingPrice: 180, recipeId: recipes[1]._id },
      { name: "Mixed Rice Bowl", category: "Main Course", sellingPrice: 150, recipeId: recipes[2]._id },
      { name: "Butter Naan", category: "Bread", sellingPrice: 30, recipeId: recipes[3]._id },
      { name: "Dal Tadka", category: "Side Dish", sellingPrice: 120, recipeId: recipes[4]._id },
      { name: "Plain Roti", category: "Bread", sellingPrice: 15, recipeId: recipes[5]._id },
      { name: "Mutton Biryani", category: "Main Course", sellingPrice: 300, recipeId: recipes[0]._id },
      { name: "Paneer Curry", category: "Main Course", sellingPrice: 200, recipeId: recipes[1]._id },
      { name: "Garlic Naan", category: "Bread", sellingPrice: 40, recipeId: recipes[3]._id },
      { name: "Dal Fry", category: "Side Dish", sellingPrice: 110, recipeId: recipes[4]._id },
    ];

    for (const menuItemDataItem of menuItemData) {
      const recipe = await Recipe.findById(menuItemDataItem.recipeId);
      const menuItem = new MenuItem(menuItemDataItem);
      menuItem.calculateMetrics(recipe.costPerPortion);
      await menuItem.save();
      menuItems.push(menuItem);
    }
    console.log(`✅ Created ${menuItems.length} menu items`);

    // Create sample waste entries
    console.log("🗑️  Creating waste records...");
    const wasteEntries = [];
    for (let i = 0; i < 3; i++) {
      const ingredient = ingredients[Math.floor(Math.random() * ingredients.length)];
      const qty = Math.random() * 2 + 0.5; // 0.5 to 2.5
      const qtyInBaseUnit = ingredient.convertToBaseUnit(qty, ingredient.uom);

      // Consume using FIFO
      const consumeResult = await FIFOService.consume(
        ingredient._id,
        qtyInBaseUnit,
        "waste",
        null,
        testUser._id
      );

      const waste = new Waste({
        ingredientId: ingredient._id,
        qty: qtyInBaseUnit,
        uom: ingredient.baseUnit,
        reason: ["spoilage", "overcooking", "expired"][Math.floor(Math.random() * 3)],
        reasonDetails: "Sample waste entry",
        date: new Date(Date.now() - (i + 1) * 24 * 60 * 60 * 1000),
        costAllocated: consumeResult.costAllocated,
        recordedBy: testUser._id,
      });
      await waste.save();
      wasteEntries.push(waste);
    }
    console.log(`✅ Created ${wasteEntries.length} waste records`);

    // Create labour costs
    console.log("👷 Creating labour costs...");
    const labourCosts = [];
    const labourData = [
      {
        periodFrom: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        periodTo: new Date(),
        amount: 40000,
        allocationMethod: "fixed_period",
        description: "Monthly staff salary",
        createdBy: testUser._id,
      },
      {
        periodFrom: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        periodTo: new Date(),
        amount: 10000,
        allocationMethod: "revenue_percent",
        meta: new Map([["percent", 5]]),
        description: "Performance bonus (5% of revenue)",
        createdBy: testUser._id,
      },
    ];

    for (const labourDataItem of labourData) {
      const labourCost = new LabourCost(labourDataItem);
      await labourCost.save();
      labourCosts.push(labourCost);
    }
    console.log(`✅ Created ${labourCosts.length} labour costs`);

    // Create overheads
    console.log("💰 Creating overheads...");
    const overheads = [];
    const overheadData = [
      {
        periodFrom: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        periodTo: new Date(),
        amount: 15000,
        allocationMethod: "fixed_period",
        category: "rent",
        description: "Monthly rent",
        createdBy: testUser._id,
      },
      {
        periodFrom: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        periodTo: new Date(),
        amount: 5000,
        allocationMethod: "fixed_period",
        category: "utilities",
        description: "Electricity and water",
        createdBy: testUser._id,
      },
      {
        periodFrom: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        periodTo: new Date(),
        amount: 3000,
        allocationMethod: "fixed_period",
        category: "marketing",
        description: "Social media and promotions",
        createdBy: testUser._id,
      },
    ];

    for (const overheadDataItem of overheadData) {
      const overhead = new Overhead(overheadDataItem);
      await overhead.save();
      overheads.push(overhead);
    }
    console.log(`✅ Created ${overheads.length} overheads`);

    console.log("\n✅ Seed data created successfully!");
    console.log("\n📊 Summary:");
    console.log(`   - Suppliers: ${suppliers.length}`);
    console.log(`   - Ingredients: ${ingredients.length}`);
    console.log(`   - Purchases: ${purchases.length}`);
    console.log(`   - Recipes: ${recipes.length}`);
    console.log(`   - Menu Items: ${menuItems.length}`);
    console.log(`   - Waste Records: ${wasteEntries.length}`);
    console.log(`   - Labour Costs: ${labourCosts.length}`);
    console.log(`   - Overheads: ${overheads.length}`);

    process.exit(0);
  } catch (error) {
    console.error("❌ Error seeding data:", error);
    process.exit(1);
  }
};

seedData();




