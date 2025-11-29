/**
 * Cleanup Cart Menu - Delete ALL menu data for a specific cart
 * 
 * Usage:
 *   node backend/scripts/cleanup-cart-menu.js <cart-id>
 * 
 * This script will:
 * 1. Find ALL menu data (categories and items) for the cart
 * 2. Delete everything, regardless of how cafeId is stored
 * 3. Verify deletion was successful
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');
const MenuCategory = require('../models/menuCategoryModel');
const { MenuItem } = require('../models/menuItemModel');
const User = require('../models/userModel');

async function cleanupCartMenu(cartId) {
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
    console.log(`📋 Franchise ID: ${cart.franchiseId || 'NOT SET'}\n`);
    
    // Convert cartId to all possible formats
    const cartIdStr = cartId.toString();
    const cartObjectId = mongoose.Types.ObjectId.isValid(cartId) 
      ? (typeof cartId === 'string' ? new mongoose.Types.ObjectId(cartId) : cartId)
      : cartId;
    
    console.log('🔍 Finding ALL menu data for this cart...');
    console.log(`   Searching with cartId formats: ObjectId(${cartObjectId}), String(${cartIdStr})\n`);
    
    // Find ALL categories (try all formats)
    const categories1 = await MenuCategory.find({ cafeId: cartObjectId }).lean();
    const categories2 = await MenuCategory.find({ cafeId: cartIdStr }).lean();
    const categories3 = await MenuCategory.find({ cafeId: cartId }).lean();
    
    // Combine and deduplicate
    const allCategories = [];
    const seenCategoryIds = new Set();
    
    [...categories1, ...categories2, ...categories3].forEach(cat => {
      const catId = cat._id.toString();
      if (!seenCategoryIds.has(catId)) {
        seenCategoryIds.add(catId);
        allCategories.push(cat);
      }
    });
    
    console.log(`📊 Found ${allCategories.length} categories`);
    if (allCategories.length > 0) {
      allCategories.forEach((cat, idx) => {
        console.log(`   ${idx + 1}. "${cat.name}" (ID: ${cat._id}) - cafeId: ${cat.cafeId} (type: ${typeof cat.cafeId})`);
      });
    }
    
    // Get all category IDs
    const categoryIds = allCategories.map(cat => cat._id);
    
    // Find ALL items (try all formats)
    const items1 = await MenuItem.find({ cafeId: cartObjectId }).lean();
    const items2 = await MenuItem.find({ cafeId: cartIdStr }).lean();
    const items3 = await MenuItem.find({ cafeId: cartId }).lean();
    
    // Also find items by category IDs
    const itemsByCategory = categoryIds.length > 0 
      ? await MenuItem.find({ category: { $in: categoryIds } }).lean()
      : [];
    
    // Combine and deduplicate
    const allItems = [];
    const seenItemIds = new Set();
    
    [...items1, ...items2, ...items3, ...itemsByCategory].forEach(item => {
      const itemId = item._id.toString();
      if (!seenItemIds.has(itemId)) {
        seenItemIds.add(itemId);
        allItems.push(item);
      }
    });
    
    console.log(`\n📊 Found ${allItems.length} items`);
    if (allItems.length > 0) {
      const itemsByCat = {};
      allItems.forEach(item => {
        const catId = item.category.toString();
        if (!itemsByCat[catId]) itemsByCat[catId] = [];
        itemsByCat[catId].push(item);
      });
      
      Object.entries(itemsByCat).forEach(([catId, items]) => {
        const cat = allCategories.find(c => c._id.toString() === catId);
        console.log(`   Category "${cat?.name || catId}": ${items.length} items`);
        items.forEach((item, idx) => {
          console.log(`     ${idx + 1}. "${item.name}" (₹${item.price}) - cafeId: ${item.cafeId} (type: ${typeof item.cafeId})`);
        });
      });
    }
    
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('🗑️ DELETING ALL MENU DATA...');
    console.log('═══════════════════════════════════════════════════════════\n');
    
    // Delete items by category IDs first
    if (categoryIds.length > 0) {
      const deletedItemsByCat = await MenuItem.deleteMany({ category: { $in: categoryIds } });
      console.log(`✅ Deleted ${deletedItemsByCat.deletedCount} items by category IDs`);
    }
    
    // Delete items by cafeId (all formats)
    const deletedItems1 = await MenuItem.deleteMany({ cafeId: cartObjectId });
    console.log(`✅ Deleted ${deletedItems1.deletedCount} items by cafeId (ObjectId)`);
    
    const deletedItems2 = await MenuItem.deleteMany({ cafeId: cartIdStr });
    console.log(`✅ Deleted ${deletedItems2.deletedCount} items by cafeId (string)`);
    
    const deletedItems3 = await MenuItem.deleteMany({ cafeId: cartId });
    console.log(`✅ Deleted ${deletedItems3.deletedCount} items by cafeId (direct)`);
    
    // Delete items using $or query
    const deletedItemsOr = await MenuItem.deleteMany({ 
      $or: [
        { cafeId: cartObjectId },
        { cafeId: cartIdStr },
        { cafeId: cartId }
      ]
    });
    console.log(`✅ Deleted ${deletedItemsOr.deletedCount} items using $or query`);
    
    // Delete categories by cafeId (all formats)
    const deletedCats1 = await MenuCategory.deleteMany({ cafeId: cartObjectId });
    console.log(`✅ Deleted ${deletedCats1.deletedCount} categories by cafeId (ObjectId)`);
    
    const deletedCats2 = await MenuCategory.deleteMany({ cafeId: cartIdStr });
    console.log(`✅ Deleted ${deletedCats2.deletedCount} categories by cafeId (string)`);
    
    const deletedCats3 = await MenuCategory.deleteMany({ cafeId: cartId });
    console.log(`✅ Deleted ${deletedCats3.deletedCount} categories by cafeId (direct)`);
    
    // Delete categories using $or query
    const deletedCatsOr = await MenuCategory.deleteMany({ 
      $or: [
        { cafeId: cartObjectId },
        { cafeId: cartIdStr },
        { cafeId: cartId }
      ]
    });
    console.log(`✅ Deleted ${deletedCatsOr.deletedCount} categories using $or query`);
    
    // Wait for deletion to commit
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Verify deletion
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('✅ VERIFICATION');
    console.log('═══════════════════════════════════════════════════════════\n');
    
    const remainingItems1 = await MenuItem.countDocuments({ cafeId: cartObjectId });
    const remainingItems2 = await MenuItem.countDocuments({ cafeId: cartIdStr });
    const remainingItems3 = await MenuItem.countDocuments({ cafeId: cartId });
    const remainingItemsOr = await MenuItem.countDocuments({ 
      $or: [
        { cafeId: cartObjectId },
        { cafeId: cartIdStr },
        { cafeId: cartId }
      ]
    });
    
    const remainingCats1 = await MenuCategory.countDocuments({ cafeId: cartObjectId });
    const remainingCats2 = await MenuCategory.countDocuments({ cafeId: cartIdStr });
    const remainingCats3 = await MenuCategory.countDocuments({ cafeId: cartId });
    const remainingCatsOr = await MenuCategory.countDocuments({ 
      $or: [
        { cafeId: cartObjectId },
        { cafeId: cartIdStr },
        { cafeId: cartId }
      ]
    });
    
    const totalRemainingItems = Math.max(remainingItems1, remainingItems2, remainingItems3, remainingItemsOr);
    const totalRemainingCategories = Math.max(remainingCats1, remainingCats2, remainingCats3, remainingCatsOr);
    
    if (totalRemainingItems === 0 && totalRemainingCategories === 0) {
      console.log('✅ SUCCESS: All menu data deleted!');
      console.log(`   Remaining items: 0`);
      console.log(`   Remaining categories: 0`);
    } else {
      console.error('❌ ERROR: Some menu data still exists!');
      console.error(`   Remaining items: ${totalRemainingItems}`);
      console.error(`   Remaining categories: ${totalRemainingCategories}`);
      console.error(`   ObjectId query: ${remainingItems1} items, ${remainingCats1} categories`);
      console.error(`   String query: ${remainingItems2} items, ${remainingCats2} categories`);
      console.error(`   Direct query: ${remainingItems3} items, ${remainingCats3} categories`);
      console.error(`   $or query: ${remainingItemsOr} items, ${remainingCatsOr} categories`);
      
      // Try collection-level delete
      console.log('\n🔄 Attempting collection-level delete...');
      const MenuItemCollection = MenuItem.collection;
      const MenuCategoryCollection = MenuCategory.collection;
      
      await MenuItemCollection.deleteMany({ cafeId: cartObjectId });
      await MenuItemCollection.deleteMany({ cafeId: cartIdStr });
      await MenuCategoryCollection.deleteMany({ cafeId: cartObjectId });
      await MenuCategoryCollection.deleteMany({ cafeId: cartIdStr });
      
      await new Promise(resolve => setTimeout(resolve, 500));
      
      const finalRemainingItems = await MenuItem.countDocuments({ 
        $or: [{ cafeId: cartObjectId }, { cafeId: cartIdStr }] 
      });
      const finalRemainingCategories = await MenuCategory.countDocuments({ 
        $or: [{ cafeId: cartObjectId }, { cafeId: cartIdStr }] 
      });
      
      if (finalRemainingItems === 0 && finalRemainingCategories === 0) {
        console.log('✅ SUCCESS: Collection-level delete worked!');
      } else {
        console.error(`❌ Still have ${finalRemainingItems} items and ${finalRemainingCategories} categories`);
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
  console.error('Usage: node backend/scripts/cleanup-cart-menu.js <cart-id>');
  process.exit(1);
}

cleanupCartMenu(cartId);
