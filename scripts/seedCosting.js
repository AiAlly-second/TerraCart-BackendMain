/**
 * Seed script for Costing feature
 * Populates sample data for development and testing
 * 
 * Usage: node backend/scripts/seedCosting.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Investment = require('../models/investmentModel');
const Expense = require('../models/expenseModel');
const ExpenseCategory = require('../models/expenseCategoryModel');
const Ingredient = require('../models/ingredientModel');
const Recipe = require('../models/recipeModel');
const RecipeIngredient = require('../models/recipeIngredientModel');
const User = require('../models/userModel');

const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/terra-cart';

async function seedCosting() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB');

    // Get or create a super admin user for createdBy fields
    let superAdmin = await User.findOne({ role: 'super_admin' });
    if (!superAdmin) {
      console.log('Creating super admin user for seeding...');
      superAdmin = new User({
        name: 'Super Admin',
        email: 'superadmin@terracart.com',
        password: 'hashedpassword', // In production, use bcrypt
        role: 'super_admin',
      });
      await superAdmin.save();
    }

    // Seed Expense Categories
    console.log('Seeding expense categories...');
    const categories = [
      { name: 'Raw Materials', description: 'Food ingredients and raw materials' },
      { name: 'Utilities', description: 'Electricity, water, gas bills' },
      { name: 'Salaries', description: 'Employee salaries and wages' },
      { name: 'Rent', description: 'Shop/space rent' },
      { name: 'Marketing', description: 'Advertising and promotional expenses' },
      { name: 'Maintenance', description: 'Equipment and facility maintenance' },
    ];

    const expenseCategories = [];
    for (const cat of categories) {
      const existing = await ExpenseCategory.findOne({ name: cat.name });
      if (!existing) {
        const category = new ExpenseCategory({
          ...cat,
          createdBy: superAdmin._id,
        });
        await category.save();
        expenseCategories.push(category);
        console.log(`  ✓ Created category: ${cat.name}`);
      } else {
        expenseCategories.push(existing);
        console.log(`  - Category already exists: ${cat.name}`);
      }
    }

    // Seed Ingredients
    console.log('\nSeeding ingredients...');
    const ingredients = [
      { name: 'Wheat Flour', unit: 'kg', costPerUnit: 45.00 },
      { name: 'Sugar', unit: 'kg', costPerUnit: 42.00 },
      { name: 'Milk', unit: 'l', costPerUnit: 60.00 },
      { name: 'Butter', unit: 'kg', costPerUnit: 550.00 },
      { name: 'Cheese', unit: 'kg', costPerUnit: 450.00 },
      { name: 'Tomato', unit: 'kg', costPerUnit: 40.00 },
      { name: 'Onion', unit: 'kg', costPerUnit: 30.00 },
      { name: 'Chicken', unit: 'kg', costPerUnit: 200.00 },
      { name: 'Bread', unit: 'pcs', costPerUnit: 25.00 },
      { name: 'Eggs', unit: 'pcs', costPerUnit: 8.00 },
    ];

    const seededIngredients = [];
    for (const ing of ingredients) {
      const existing = await Ingredient.findOne({ name: ing.name });
      if (!existing) {
        const ingredient = new Ingredient({
          ...ing,
          lastUpdatedBy: superAdmin._id,
          lastUpdatedAt: new Date(),
        });
        await ingredient.save();
        seededIngredients.push(ingredient);
        console.log(`  ✓ Created ingredient: ${ing.name} (₹${ing.costPerUnit}/${ing.unit})`);
      } else {
        seededIngredients.push(existing);
        console.log(`  - Ingredient already exists: ${ing.name}`);
      }
    }

    // Seed Recipes
    console.log('\nSeeding recipes...');
    const recipes = [
      {
        name: 'Cheese Sandwich',
        sku: 'CS-001',
        sellingPrice: 89.00,
        ingredients: [
          { ingredientId: seededIngredients.find(i => i.name === 'Bread')._id, quantity: 2, unit: 'pcs' },
          { ingredientId: seededIngredients.find(i => i.name === 'Cheese')._id, quantity: 0.05, unit: 'kg' },
          { ingredientId: seededIngredients.find(i => i.name === 'Butter')._id, quantity: 0.01, unit: 'kg' },
        ],
      },
      {
        name: 'Chicken Sandwich',
        sku: 'CHS-001',
        sellingPrice: 120.00,
        ingredients: [
          { ingredientId: seededIngredients.find(i => i.name === 'Bread')._id, quantity: 2, unit: 'pcs' },
          { ingredientId: seededIngredients.find(i => i.name === 'Chicken')._id, quantity: 0.1, unit: 'kg' },
          { ingredientId: seededIngredients.find(i => i.name === 'Onion')._id, quantity: 0.02, unit: 'kg' },
          { ingredientId: seededIngredients.find(i => i.name === 'Tomato')._id, quantity: 0.02, unit: 'kg' },
        ],
      },
    ];

    for (const recipeData of recipes) {
      const existing = await Recipe.findOne({ sku: recipeData.sku });
      if (!existing) {
        // Calculate plate cost
        let plateCost = 0;
        for (const ing of recipeData.ingredients) {
          const ingredient = seededIngredients.find(i => i._id.toString() === ing.ingredientId.toString());
          if (ingredient) {
            const quantityInBaseUnit = convertToBaseUnit(ing.quantity, ing.unit);
            plateCost += quantityInBaseUnit * ingredient.costPerUnit;
          }
        }
        plateCost += 5.00; // Overhead

        const recipe = new Recipe({
          name: recipeData.name,
          sku: recipeData.sku,
          sellingPrice: recipeData.sellingPrice,
          plateCost: Number(plateCost.toFixed(2)),
          overheadPerPlate: 5.00,
          createdBy: superAdmin._id,
        });
        await recipe.save();

        // Create recipe ingredients
        for (const ing of recipeData.ingredients) {
          const recipeIngredient = new RecipeIngredient({
            recipeId: recipe._id,
            ingredientId: ing.ingredientId,
            quantity: ing.quantity,
            unit: ing.unit,
          });
          await recipeIngredient.save();
        }

        console.log(`  ✓ Created recipe: ${recipeData.name} (Plate Cost: ₹${plateCost.toFixed(2)})`);
      } else {
        console.log(`  - Recipe already exists: ${recipeData.name}`);
      }
    }

    // Seed Sample Investment
    console.log('\nSeeding sample investment...');
    const investment = new Investment({
      title: 'Kiosk Setup - POS & Kiosk Machine',
      amount: 42000.00,
      category: 'Equipment',
      description: 'POS system, kiosk installation',
      purchaseDate: new Date('2025-11-01'),
      vendor: 'Tech Solutions Inc',
      createdBy: superAdmin._id,
    });
    await investment.save();
    console.log(`  ✓ Created investment: ${investment.title}`);

    // Seed Sample Expenses
    console.log('\nSeeding sample expenses...');
    const expenses = [
      {
        expenseCategoryId: expenseCategories.find(c => c.name === 'Raw Materials')._id,
        amount: 1540.50,
        description: 'Daily raw material purchase',
        expenseDate: new Date(),
        paymentMode: 'UPI',
      },
      {
        expenseCategoryId: expenseCategories.find(c => c.name === 'Utilities')._id,
        amount: 2500.00,
        description: 'Monthly electricity bill',
        expenseDate: new Date(),
        paymentMode: 'Bank Transfer',
      },
    ];

    for (const exp of expenses) {
      const expense = new Expense({
        ...exp,
        createdBy: superAdmin._id,
      });
      await expense.save();
      console.log(`  ✓ Created expense: ₹${exp.amount} - ${exp.description}`);
    }

    console.log('\n✅ Seeding completed successfully!');
  } catch (error) {
    console.error('❌ Error seeding costing data:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
}

function convertToBaseUnit(quantity, unit) {
  const conversions = {
    kg: 1,
    g: 0.001,
    l: 1,
    ml: 0.001,
    pcs: 1,
  };
  return quantity * (conversions[unit] || 1);
}

// Run the seed script
if (require.main === module) {
  seedCosting();
}

module.exports = { seedCosting };

















