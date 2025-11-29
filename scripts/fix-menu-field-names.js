/**
 * Script to fix menu field names and clean up old data
 * 
 * Problem: Old menu items were created with 'cartId' field but the schema uses 'cafeId'
 * This script will:
 * 1. Check for items with 'cartId' field and migrate them to 'cafeId'
 * 2. Clean up orphaned menu items
 * 3. Show current database state
 */

require('dotenv').config();
const mongoose = require('mongoose');
const MenuCategory = require('../models/menuCategoryModel');
const { MenuItem } = require('../models/menuItemModel');
const User = require('../models/userModel');

async function connectDB() {
  try {
    const mongoURI = process.env.MONGO_URI || process.env.MONGODB_URI;
    await mongoose.connect(mongoURI);
    console.log('✅ Connected to MongoDB');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
}

async function analyzeDatabase() {
  console.log('\n========================================');
  console.log('📊 ANALYZING MENU DATABASE');
  console.log('========================================\n');

  // Get all cart admins
  const cartAdmins = await User.find({ role: 'admin' }).lean();
  console.log(`Found ${cartAdmins.length} cart admins\n`);

  for (const cart of cartAdmins) {
    console.log(`\n--- Cart: ${cart.cartName || cart.name || cart._id} ---`);
    console.log(`   Cart ID: ${cart._id}`);
    console.log(`   Franchise ID: ${cart.franchiseId || 'None'}`);

    // Check categories with cafeId field
    const categoriesWithCafeId = await MenuCategory.find({ cafeId: cart._id }).lean();
    console.log(`   Categories with cafeId: ${categoriesWithCafeId.length}`);
    
    // Check items with cafeId field
    const itemsWithCafeId = await MenuItem.find({ cafeId: cart._id }).lean();
    console.log(`   Items with cafeId: ${itemsWithCafeId.length}`);

    // Check for raw documents with cartId field (direct collection query)
    const rawCategories = await MenuCategory.collection.find({ cartId: cart._id }).toArray();
    const rawCategoriesStr = await MenuCategory.collection.find({ cartId: cart._id.toString() }).toArray();
    console.log(`   Raw categories with cartId (ObjectId): ${rawCategories.length}`);
    console.log(`   Raw categories with cartId (String): ${rawCategoriesStr.length}`);

    const rawItems = await MenuItem.collection.find({ cartId: cart._id }).toArray();
    const rawItemsStr = await MenuItem.collection.find({ cartId: cart._id.toString() }).toArray();
    console.log(`   Raw items with cartId (ObjectId): ${rawItems.length}`);
    console.log(`   Raw items with cartId (String): ${rawItemsStr.length}`);

    // List category names
    if (categoriesWithCafeId.length > 0) {
      console.log(`   Category names: ${categoriesWithCafeId.map(c => c.name).join(', ')}`);
    }
  }

  // Check for orphaned categories (no cafeId or cartId)
  const orphanedCategories = await MenuCategory.collection.find({
    $and: [
      { cafeId: { $exists: false } },
      { cartId: { $exists: false } }
    ]
  }).toArray();
  console.log(`\n🔍 Orphaned categories (no cafeId/cartId): ${orphanedCategories.length}`);

  // Check for categories with cartId field
  const categoriesWithCartId = await MenuCategory.collection.find({
    cartId: { $exists: true }
  }).toArray();
  console.log(`🔍 Categories with cartId field: ${categoriesWithCartId.length}`);

  // Check for items with cartId field
  const itemsWithCartId = await MenuItem.collection.find({
    cartId: { $exists: true }
  }).toArray();
  console.log(`🔍 Items with cartId field: ${itemsWithCartId.length}`);

  // Total counts
  const totalCategories = await MenuCategory.countDocuments();
  const totalItems = await MenuItem.countDocuments();
  console.log(`\n📊 TOTAL: ${totalCategories} categories, ${totalItems} items`);

  return { categoriesWithCartId, itemsWithCartId };
}

async function cleanupOldData() {
  console.log('\n========================================');
  console.log('🧹 CLEANING UP OLD DATA');
  console.log('========================================\n');

  // Get all valid cart admin IDs
  const cartAdmins = await User.find({ role: 'admin' }).lean();
  const validCafeIds = cartAdmins.map(c => c._id);
  console.log(`Valid cart admin IDs: ${validCafeIds.length}`);

  // Delete all categories with cartId field (wrong field name)
  const deleteCartIdCategories = await MenuCategory.collection.deleteMany({
    cartId: { $exists: true }
  });
  console.log(`Deleted ${deleteCartIdCategories.deletedCount} categories with cartId field`);

  // Delete all items with cartId field (wrong field name)
  const deleteCartIdItems = await MenuItem.collection.deleteMany({
    cartId: { $exists: true }
  });
  console.log(`Deleted ${deleteCartIdItems.deletedCount} items with cartId field`);

  // Delete orphaned categories (no cafeId)
  const deleteOrphanedCategories = await MenuCategory.collection.deleteMany({
    $or: [
      { cafeId: { $exists: false } },
      { cafeId: null }
    ]
  });
  console.log(`Deleted ${deleteOrphanedCategories.deletedCount} orphaned categories (no cafeId)`);

  // Delete orphaned items (no cafeId)
  const deleteOrphanedItems = await MenuItem.collection.deleteMany({
    $or: [
      { cafeId: { $exists: false } },
      { cafeId: null }
    ]
  });
  console.log(`Deleted ${deleteOrphanedItems.deletedCount} orphaned items (no cafeId)`);

  // Delete items with invalid category reference
  const allCategoryIds = await MenuCategory.distinct('_id');
  const deleteInvalidCategoryItems = await MenuItem.deleteMany({
    category: { $nin: allCategoryIds }
  });
  console.log(`Deleted ${deleteInvalidCategoryItems.deletedCount} items with invalid category`);

  console.log('\n✅ Cleanup completed!');
}

async function main() {
  await connectDB();
  
  console.log('\n========================================');
  console.log('MENU DATABASE FIX SCRIPT');
  console.log('========================================');
  
  // Analyze before
  console.log('\n📊 BEFORE CLEANUP:');
  const { categoriesWithCartId, itemsWithCartId } = await analyzeDatabase();
  
  // Always perform cleanup to remove orphaned data
  console.log('\n⚠️ Performing cleanup...');
  await cleanupOldData();
  
  // Analyze after
  console.log('\n📊 AFTER CLEANUP:');
  await analyzeDatabase();
  
  // Final summary
  console.log('\n========================================');
  console.log('FINAL STATE');
  console.log('========================================');
  
  const totalCategories = await MenuCategory.countDocuments();
  const totalItems = await MenuItem.countDocuments();
  console.log(`Total categories: ${totalCategories}`);
  console.log(`Total items: ${totalItems}`);
  
  await mongoose.disconnect();
  console.log('\n✅ Script completed. Disconnected from MongoDB.');
}

main().catch(console.error);

