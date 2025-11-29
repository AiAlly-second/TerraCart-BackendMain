/**
 * Diagnose and Fix Cart Menu - Find and delete ALL menu data for a cart
 * 
 * Usage:
 *   node backend/scripts/diagnose-and-fix-cart-menu.js <cart-id>
 * 
 * This script will:
 * 1. Find ALL menu data (categories and items) using ALL query formats
 * 2. Show exactly what's in the database
 * 3. Delete everything
 * 4. Verify deletion succeeded
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');
const MenuCategory = require('../models/menuCategoryModel');
const { MenuItem } = require('../models/menuItemModel');
const User = require('../models/userModel');

async function diagnoseAndFixCartMenu(cartId) {
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
    
    console.log('═══════════════════════════════════════════════════════════');
    console.log('📋 CART INFORMATION');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`Cart ID: ${cart._id}`);
    console.log(`Cart Name: ${cart.cafeName || cart.name}`);
    console.log(`Cart ID Type: ${typeof cart._id}`);
    console.log(`Cart ID String: ${cart._id.toString()}`);
    console.log(`Franchise ID: ${cart.franchiseId || 'NOT SET'}\n`);
    
    // Convert cartId to all possible formats
    const cartIdStr = cart._id.toString();
    const cartObjectId = mongoose.Types.ObjectId.isValid(cart._id) 
      ? (typeof cart._id === 'string' ? new mongoose.Types.ObjectId(cart._id) : cart._id)
      : cart._id;
    
    console.log('═══════════════════════════════════════════════════════════');
    console.log('🔍 STEP 1: FINDING ALL MENU DATA');
    console.log('═══════════════════════════════════════════════════════════\n');
    
    // Find ALL categories using ALL query formats
    console.log('📊 Searching for CATEGORIES...');
    const cats1 = await MenuCategory.find({ cafeId: cartObjectId }).lean();
    const cats2 = await MenuCategory.find({ cafeId: cartIdStr }).lean();
    const cats3 = await MenuCategory.find({ cafeId: cart._id }).lean();
    
    // Also try finding by string comparison
    const allCatsRaw = await MenuCategory.find({}).lean();
    const catsByStringMatch = allCatsRaw.filter(cat => {
      if (!cat.cafeId) return false;
      return cat.cafeId.toString() === cartIdStr || 
             cat.cafeId.toString() === cart._id.toString() ||
             (cat.cafeId && cat.cafeId.toString && cat.cafeId.toString() === cartObjectId.toString());
    });
    
    console.log(`   Query 1 (ObjectId): ${cats1.length} categories`);
    console.log(`   Query 2 (String): ${cats2.length} categories`);
    console.log(`   Query 3 (Direct): ${cats3.length} categories`);
    console.log(`   Query 4 (String match): ${catsByStringMatch.length} categories`);
    
    // Combine and deduplicate
    const allCategories = [];
    const seenCatIds = new Set();
    [...cats1, ...cats2, ...cats3, ...catsByStringMatch].forEach(cat => {
      const catId = cat._id.toString();
      if (!seenCatIds.has(catId)) {
        seenCatIds.add(catId);
        allCategories.push(cat);
      }
    });
    
    console.log(`\n   ✅ TOTAL UNIQUE CATEGORIES FOUND: ${allCategories.length}`);
    
    if (allCategories.length > 0) {
      console.log('\n   Category Details:');
      allCategories.forEach((cat, idx) => {
        console.log(`   ${idx + 1}. "${cat.name}"`);
        console.log(`      ID: ${cat._id}`);
        console.log(`      cafeId: ${cat.cafeId} (type: ${typeof cat.cafeId}, isObjectId: ${cat.cafeId instanceof mongoose.Types.ObjectId})`);
        console.log(`      cafeId.toString(): ${cat.cafeId ? cat.cafeId.toString() : 'null'}`);
        console.log(`      Matches cart ID? ${cat.cafeId && (cat.cafeId.toString() === cartIdStr || cat.cafeId.toString() === cart._id.toString())}`);
        console.log('');
      });
    }
    
    // Get category IDs
    const categoryIds = allCategories.map(cat => cat._id);
    
    // Find ALL items using ALL query formats
    console.log('📊 Searching for ITEMS...');
    const items1 = await MenuItem.find({ cafeId: cartObjectId }).lean();
    const items2 = await MenuItem.find({ cafeId: cartIdStr }).lean();
    const items3 = await MenuItem.find({ cafeId: cart._id }).lean();
    const itemsByCategory = categoryIds.length > 0 
      ? await MenuItem.find({ category: { $in: categoryIds } }).lean()
      : [];
    
    // Also try finding by string comparison
    const allItemsRaw = await MenuItem.find({}).lean();
    const itemsByStringMatch = allItemsRaw.filter(item => {
      if (!item.cafeId) return false;
      return item.cafeId.toString() === cartIdStr || 
             item.cafeId.toString() === cart._id.toString() ||
             (item.cafeId && item.cafeId.toString && item.cafeId.toString() === cartObjectId.toString());
    });
    
    console.log(`   Query 1 (ObjectId): ${items1.length} items`);
    console.log(`   Query 2 (String): ${items2.length} items`);
    console.log(`   Query 3 (Direct): ${items3.length} items`);
    console.log(`   Query 4 (By category): ${itemsByCategory.length} items`);
    console.log(`   Query 5 (String match): ${itemsByStringMatch.length} items`);
    
    // Combine and deduplicate
    const allItems = [];
    const seenItemIds = new Set();
    [...items1, ...items2, ...items3, ...itemsByCategory, ...itemsByStringMatch].forEach(item => {
      const itemId = item._id.toString();
      if (!seenItemIds.has(itemId)) {
        seenItemIds.add(itemId);
        allItems.push(item);
      }
    });
    
    console.log(`\n   ✅ TOTAL UNIQUE ITEMS FOUND: ${allItems.length}`);
    
    if (allItems.length > 0) {
      console.log('\n   Item Details (first 10):');
      allItems.slice(0, 10).forEach((item, idx) => {
        console.log(`   ${idx + 1}. "${item.name}" - ₹${item.price}`);
        console.log(`      ID: ${item._id}`);
        console.log(`      cafeId: ${item.cafeId} (type: ${typeof item.cafeId})`);
        console.log(`      category: ${item.category}`);
        console.log('');
      });
      if (allItems.length > 10) {
        console.log(`   ... and ${allItems.length - 10} more items\n`);
      }
    }
    
    console.log('═══════════════════════════════════════════════════════════');
    console.log('🗑️ STEP 2: DELETING ALL MENU DATA');
    console.log('═══════════════════════════════════════════════════════════\n');
    
    if (allCategories.length === 0 && allItems.length === 0) {
      console.log('✅ No menu data found - nothing to delete!');
    } else {
      // Delete items first (they reference categories)
      console.log('Deleting items...');
      
      // Strategy 1: Delete by category IDs
      if (categoryIds.length > 0) {
        const deletedByCat = await MenuItem.deleteMany({ category: { $in: categoryIds } });
        console.log(`   ✅ Deleted ${deletedByCat.deletedCount} items by category IDs`);
      }
      
      // Strategy 2: Delete by cafeId using $or
      const deletedItemsOr = await MenuItem.deleteMany({ 
        $or: [
          { cafeId: cartObjectId },
          { cafeId: cartIdStr },
          { cafeId: cart._id }
        ]
      });
      console.log(`   ✅ Deleted ${deletedItemsOr.deletedCount} items using $or query`);
      
      // Strategy 3: Delete individually
      const deletedItems1 = await MenuItem.deleteMany({ cafeId: cartObjectId });
      const deletedItems2 = await MenuItem.deleteMany({ cafeId: cartIdStr });
      const deletedItems3 = await MenuItem.deleteMany({ cafeId: cart._id });
      console.log(`   ✅ Deleted ${deletedItems1.deletedCount} (ObjectId) + ${deletedItems2.deletedCount} (string) + ${deletedItems3.deletedCount} (direct)`);
      
      // Strategy 4: Delete by string match (manual)
      if (allItems.length > 0) {
        const itemIdsToDelete = allItems.map(item => item._id);
        const deletedByIds = await MenuItem.deleteMany({ _id: { $in: itemIdsToDelete } });
        console.log(`   ✅ Deleted ${deletedByIds.deletedCount} items by direct IDs`);
      }
      
      // Wait for deletion
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Delete categories
      console.log('\nDeleting categories...');
      
      // Strategy 1: Delete by cafeId using $or
      const deletedCatsOr = await MenuCategory.deleteMany({ 
        $or: [
          { cafeId: cartObjectId },
          { cafeId: cartIdStr },
          { cafeId: cart._id }
        ]
      });
      console.log(`   ✅ Deleted ${deletedCatsOr.deletedCount} categories using $or query`);
      
      // Strategy 2: Delete individually
      const deletedCats1 = await MenuCategory.deleteMany({ cafeId: cartObjectId });
      const deletedCats2 = await MenuCategory.deleteMany({ cafeId: cartIdStr });
      const deletedCats3 = await MenuCategory.deleteMany({ cafeId: cart._id });
      console.log(`   ✅ Deleted ${deletedCats1.deletedCount} (ObjectId) + ${deletedCats2.deletedCount} (string) + ${deletedCats3.deletedCount} (direct)`);
      
      // Strategy 3: Delete by direct IDs
      if (allCategories.length > 0) {
        const catIdsToDelete = allCategories.map(cat => cat._id);
        const deletedByIds = await MenuCategory.deleteMany({ _id: { $in: catIdsToDelete } });
        console.log(`   ✅ Deleted ${deletedByIds.deletedCount} categories by direct IDs`);
      }
      
      // Wait for deletion
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('✅ STEP 3: VERIFICATION');
    console.log('═══════════════════════════════════════════════════════════\n');
    
    // Verify deletion using all formats
    const remainingCats1 = await MenuCategory.countDocuments({ cafeId: cartObjectId });
    const remainingCats2 = await MenuCategory.countDocuments({ cafeId: cartIdStr });
    const remainingCats3 = await MenuCategory.countDocuments({ cafeId: cart._id });
    const remainingCatsOr = await MenuCategory.countDocuments({ 
      $or: [
        { cafeId: cartObjectId },
        { cafeId: cartIdStr },
        { cafeId: cart._id }
      ]
    });
    
    const remainingItems1 = await MenuItem.countDocuments({ cafeId: cartObjectId });
    const remainingItems2 = await MenuItem.countDocuments({ cafeId: cartIdStr });
    const remainingItems3 = await MenuItem.countDocuments({ cafeId: cart._id });
    const remainingItemsOr = await MenuItem.countDocuments({ 
      $or: [
        { cafeId: cartObjectId },
        { cafeId: cartIdStr },
        { cafeId: cart._id }
      ]
    });
    
    const maxRemainingCats = Math.max(remainingCats1, remainingCats2, remainingCats3, remainingCatsOr);
    const maxRemainingItems = Math.max(remainingItems1, remainingItems2, remainingItems3, remainingItemsOr);
    
    if (maxRemainingCats === 0 && maxRemainingItems === 0) {
      console.log('✅ SUCCESS: All menu data deleted!');
      console.log(`   Remaining categories: 0`);
      console.log(`   Remaining items: 0`);
    } else {
      console.error('❌ ERROR: Some menu data still exists!');
      console.error(`   Remaining categories: ${maxRemainingCats}`);
      console.error(`   Remaining items: ${maxRemainingItems}`);
      console.error(`   Category queries: ObjectId=${remainingCats1}, String=${remainingCats2}, Direct=${remainingCats3}, $or=${remainingCatsOr}`);
      console.error(`   Item queries: ObjectId=${remainingItems1}, String=${remainingItems2}, Direct=${remainingItems3}, $or=${remainingItemsOr}`);
      
      // Try collection-level delete
      console.log('\n🔄 Attempting collection-level delete...');
      const MenuCategoryCollection = MenuCategory.collection;
      const MenuItemCollection = MenuItem.collection;
      
      await MenuCategoryCollection.deleteMany({ cafeId: cartObjectId });
      await MenuCategoryCollection.deleteMany({ cafeId: cartIdStr });
      await MenuItemCollection.deleteMany({ cafeId: cartObjectId });
      await MenuItemCollection.deleteMany({ cafeId: cartIdStr });
      
      await new Promise(resolve => setTimeout(resolve, 500));
      
      const finalCats = await MenuCategory.countDocuments({ 
        $or: [{ cafeId: cartObjectId }, { cafeId: cartIdStr }] 
      });
      const finalItems = await MenuItem.countDocuments({ 
        $or: [{ cafeId: cartObjectId }, { cafeId: cartIdStr }] 
      });
      
      if (finalCats === 0 && finalItems === 0) {
        console.log('✅ SUCCESS: Collection-level delete worked!');
      } else {
        console.error(`❌ Still have ${finalCats} categories and ${finalItems} items`);
        console.error('   Manual database cleanup may be required');
      }
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
  console.error('Usage: node backend/scripts/diagnose-and-fix-cart-menu.js <cart-id>');
  process.exit(1);
}

diagnoseAndFixCartMenu(cartId);















