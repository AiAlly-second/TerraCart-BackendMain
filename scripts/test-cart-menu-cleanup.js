/**
 * Test Cart Menu Cleanup - Verify cleanup is working correctly
 * 
 * Usage:
 *   node backend/scripts/test-cart-menu-cleanup.js <cart-id>
 * 
 * This script will:
 * 1. Show ALL menu data for the cart (categories and items)
 * 2. Show how cafeId is stored
 * 3. Test cleanup queries
 * 4. Show what would be deleted
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');
const MenuCategory = require('../models/menuCategoryModel');
const { MenuItem } = require('../models/menuItemModel');
const User = require('../models/userModel');

async function testCartMenuCleanup(cartId) {
  try {
    const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/terra-cart';
    
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
    });
    console.log('✅ Connected to MongoDB\n');
    
    // Get cart info
    const cart = await User.findById(cartId);
    if (!cart) {
      console.error(`❌ Cart with ID ${cartId} not found`);
      process.exit(1);
    }
    
    console.log(`📋 Cart: ${cart.cafeName || cart.name} (ID: ${cart._id})`);
    console.log(`📋 Cart ID Type: ${typeof cart._id}`);
    console.log(`📋 Cart ID String: ${cart._id.toString()}`);
    console.log(`📋 Franchise ID: ${cart.franchiseId || 'NOT SET'}\n`);
    
    // Convert cartId to all possible formats
    const cartIdStr = cart._id.toString();
    const cartObjectId = mongoose.Types.ObjectId.isValid(cart._id) 
      ? (typeof cart._id === 'string' ? new mongoose.Types.ObjectId(cart._id) : cart._id)
      : cart._id;
    
    console.log('═══════════════════════════════════════════════════════════');
    console.log('🔍 TESTING CLEANUP QUERIES');
    console.log('═══════════════════════════════════════════════════════════\n');
    
    // Test Category queries
    console.log('📊 CATEGORIES:');
    console.log(`   Query 1: cafeId = ObjectId(${cartObjectId})`);
    const cats1 = await MenuCategory.find({ cafeId: cartObjectId }).lean();
    console.log(`   Found: ${cats1.length} categories`);
    if (cats1.length > 0) {
      cats1.forEach((cat, idx) => {
        console.log(`     ${idx + 1}. "${cat.name}" - cafeId: ${cat.cafeId} (type: ${typeof cat.cafeId}, isObjectId: ${cat.cafeId instanceof mongoose.Types.ObjectId})`);
      });
    }
    
    console.log(`\n   Query 2: cafeId = String("${cartIdStr}")`);
    const cats2 = await MenuCategory.find({ cafeId: cartIdStr }).lean();
    console.log(`   Found: ${cats2.length} categories`);
    if (cats2.length > 0) {
      cats2.forEach((cat, idx) => {
        console.log(`     ${idx + 1}. "${cat.name}" - cafeId: ${cat.cafeId} (type: ${typeof cat.cafeId})`);
      });
    }
    
    console.log(`\n   Query 3: cafeId = Direct(${cart._id})`);
    const cats3 = await MenuCategory.find({ cafeId: cart._id }).lean();
    console.log(`   Found: ${cats3.length} categories`);
    
    console.log(`\n   Query 4: $or query (all formats)`);
    const cats4 = await MenuCategory.find({ 
      $or: [
        { cafeId: cartObjectId },
        { cafeId: cartIdStr },
        { cafeId: cart._id }
      ]
    }).lean();
    console.log(`   Found: ${cats4.length} categories`);
    
    // Combine and deduplicate
    const allCategories = [];
    const seenCatIds = new Set();
    [...cats1, ...cats2, ...cats3].forEach(cat => {
      const catId = cat._id.toString();
      if (!seenCatIds.has(catId)) {
        seenCatIds.add(catId);
        allCategories.push(cat);
      }
    });
    
    console.log(`\n   ✅ TOTAL UNIQUE CATEGORIES: ${allCategories.length}`);
    
    // Test Item queries
    console.log('\n📊 ITEMS:');
    const categoryIds = allCategories.map(cat => cat._id);
    
    console.log(`   Query 1: cafeId = ObjectId(${cartObjectId})`);
    const items1 = await MenuItem.find({ cafeId: cartObjectId }).lean();
    console.log(`   Found: ${items1.length} items`);
    if (items1.length > 0) {
      items1.slice(0, 5).forEach((item, idx) => {
        console.log(`     ${idx + 1}. "${item.name}" - cafeId: ${item.cafeId} (type: ${typeof item.cafeId})`);
      });
      if (items1.length > 5) {
        console.log(`     ... and ${items1.length - 5} more`);
      }
    }
    
    console.log(`\n   Query 2: cafeId = String("${cartIdStr}")`);
    const items2 = await MenuItem.find({ cafeId: cartIdStr }).lean();
    console.log(`   Found: ${items2.length} items`);
    
    console.log(`\n   Query 3: cafeId = Direct(${cart._id})`);
    const items3 = await MenuItem.find({ cafeId: cart._id }).lean();
    console.log(`   Found: ${items3.length} items`);
    
    console.log(`\n   Query 4: category in [${categoryIds.length} category IDs]`);
    const itemsByCat = categoryIds.length > 0 
      ? await MenuItem.find({ category: { $in: categoryIds } }).lean()
      : [];
    console.log(`   Found: ${itemsByCat.length} items`);
    
    console.log(`\n   Query 5: $or query (all formats)`);
    const items4 = await MenuItem.find({ 
      $or: [
        { cafeId: cartObjectId },
        { cafeId: cartIdStr },
        { cafeId: cart._id }
      ]
    }).lean();
    console.log(`   Found: ${items4.length} items`);
    
    // Combine and deduplicate
    const allItems = [];
    const seenItemIds = new Set();
    [...items1, ...items2, ...items3, ...itemsByCat].forEach(item => {
      const itemId = item._id.toString();
      if (!seenItemIds.has(itemId)) {
        seenItemIds.add(itemId);
        allItems.push(item);
      }
    });
    
    console.log(`\n   ✅ TOTAL UNIQUE ITEMS: ${allItems.length}`);
    
    // Show what would be deleted
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('🗑️ WHAT WOULD BE DELETED:');
    console.log('═══════════════════════════════════════════════════════════\n');
    
    console.log(`Categories: ${allCategories.length}`);
    allCategories.forEach((cat, idx) => {
      const catItems = allItems.filter(item => item.category.toString() === cat._id.toString());
      console.log(`   ${idx + 1}. "${cat.name}" - ${catItems.length} items`);
    });
    
    console.log(`\nTotal Items: ${allItems.length}`);
    
    // Test delete queries (dry run - don't actually delete)
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('🧪 TESTING DELETE QUERIES (DRY RUN):');
    console.log('═══════════════════════════════════════════════════════════\n');
    
    // Count what would be deleted
    const wouldDeleteCats1 = await MenuCategory.countDocuments({ cafeId: cartObjectId });
    const wouldDeleteCats2 = await MenuCategory.countDocuments({ cafeId: cartIdStr });
    const wouldDeleteCats3 = await MenuCategory.countDocuments({ cafeId: cart._id });
    const wouldDeleteCatsOr = await MenuCategory.countDocuments({ 
      $or: [
        { cafeId: cartObjectId },
        { cafeId: cartIdStr },
        { cafeId: cart._id }
      ]
    });
    
    const wouldDeleteItems1 = await MenuItem.countDocuments({ cafeId: cartObjectId });
    const wouldDeleteItems2 = await MenuItem.countDocuments({ cafeId: cartIdStr });
    const wouldDeleteItems3 = await MenuItem.countDocuments({ cafeId: cart._id });
    const wouldDeleteItemsOr = await MenuItem.countDocuments({ 
      $or: [
        { cafeId: cartObjectId },
        { cafeId: cartIdStr },
        { cafeId: cart._id }
      ]
    });
    
    console.log('Categories that would be deleted:');
    console.log(`   ObjectId query: ${wouldDeleteCats1}`);
    console.log(`   String query: ${wouldDeleteCats2}`);
    console.log(`   Direct query: ${wouldDeleteCats3}`);
    console.log(`   $or query: ${wouldDeleteCatsOr}`);
    console.log(`   Max: ${Math.max(wouldDeleteCats1, wouldDeleteCats2, wouldDeleteCats3, wouldDeleteCatsOr)}`);
    
    console.log('\nItems that would be deleted:');
    console.log(`   ObjectId query: ${wouldDeleteItems1}`);
    console.log(`   String query: ${wouldDeleteItems2}`);
    console.log(`   Direct query: ${wouldDeleteItems3}`);
    console.log(`   $or query: ${wouldDeleteItemsOr}`);
    console.log(`   Max: ${Math.max(wouldDeleteItems1, wouldDeleteItems2, wouldDeleteItems3, wouldDeleteItemsOr)}`);
    
    // Check for items with category IDs
    if (categoryIds.length > 0) {
      const wouldDeleteItemsByCat = await MenuItem.countDocuments({ category: { $in: categoryIds } });
      console.log(`   By category IDs: ${wouldDeleteItemsByCat}`);
    }
    
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('✅ SUMMARY');
    console.log('═══════════════════════════════════════════════════════════\n');
    
    const totalCategories = allCategories.length;
    const totalItems = allItems.length;
    const maxCategories = Math.max(wouldDeleteCats1, wouldDeleteCats2, wouldDeleteCats3, wouldDeleteCatsOr);
    const maxItems = Math.max(wouldDeleteItems1, wouldDeleteItems2, wouldDeleteItems3, wouldDeleteItemsOr);
    
    if (totalCategories === maxCategories && totalItems === maxItems) {
      console.log('✅ CLEANUP WOULD WORK CORRECTLY');
      console.log(`   All ${totalCategories} categories and ${totalItems} items would be deleted`);
    } else {
      console.error('❌ CLEANUP MIGHT MISS DATA');
      console.error(`   Found ${totalCategories} categories, but queries would delete ${maxCategories}`);
      console.error(`   Found ${totalItems} items, but queries would delete ${maxItems}`);
      console.error('\n   ISSUE: Some data might not be deleted!');
    }
    
    console.log('\n═══════════════════════════════════════════════════════════\n');
    
  } catch (error) {
    console.error('\n❌ ERROR:', error.message);
    if (error.stack) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('🔌 Database connection closed');
  }
}

// Get arguments
const cartId = process.argv[2];

if (!cartId) {
  console.error('Usage: node backend/scripts/test-cart-menu-cleanup.js <cart-id>');
  process.exit(1);
}

testCartMenuCleanup(cartId);















