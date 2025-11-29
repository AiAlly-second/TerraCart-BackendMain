/**
 * Verify Menu Sync - Check if cart menu matches franchise menu exactly
 * 
 * Usage:
 *   node backend/scripts/verify-menu-sync.js <cart-id>
 *   node backend/scripts/verify-menu-sync.js <cart-id> <franchise-id>
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');
const DefaultMenu = require('../models/defaultMenuModel');
const MenuCategory = require('../models/menuCategoryModel');
const { MenuItem } = require('../models/menuItemModel');
const User = require('../models/userModel');

async function verifyMenuSync(cartId, franchiseId = null) {
  try {
    const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/terra-cart';
    
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
    });
    console.log('✅ Connected to MongoDB\n');
    
    // Get cart
    const cart = await User.findById(cartId);
    if (!cart) {
      console.error(`❌ Cart with ID ${cartId} not found`);
      process.exit(1);
    }
    
    console.log(`📋 Cart: ${cart.cafeName || cart.name} (ID: ${cart._id})`);
    console.log(`📋 Franchise ID: ${cart.franchiseId || 'NOT SET'}\n`);
    
    // Get franchise ID
    const actualFranchiseId = franchiseId || (cart.franchiseId ? cart.franchiseId.toString() : null);
    
    if (!actualFranchiseId) {
      console.error(`❌ Cart has no franchiseId. Cannot verify menu sync.`);
      process.exit(1);
    }
    
    // Get franchise menu
    console.log(`🔍 Fetching franchise ${actualFranchiseId}'s default menu...`);
    const franchiseMenu = await DefaultMenu.getDefaultMenu(actualFranchiseId);
    
    if (!franchiseMenu) {
      console.error(`❌ Franchise ${actualFranchiseId} has no default menu!`);
      console.error(`   Franchise admin needs to create a default menu first.`);
      process.exit(1);
    }
    
    console.log(`✅ Found franchise menu (ID: ${franchiseMenu._id})`);
    console.log(`   Categories: ${franchiseMenu.categories?.length || 0}`);
    
    // Count items in franchise menu
    let franchiseTotalItems = 0;
    const franchiseMenuStructure = [];
    
    if (franchiseMenu.categories && franchiseMenu.categories.length > 0) {
      franchiseMenu.categories.forEach((cat, idx) => {
        const itemCount = cat.items ? cat.items.length : 0;
        franchiseTotalItems += itemCount;
        franchiseMenuStructure.push({
          name: cat.name,
          itemCount: itemCount,
          items: cat.items ? cat.items.map(item => ({
            name: item.name,
            price: item.price
          })) : []
        });
      });
    }
    
    console.log(`   Total Items: ${franchiseTotalItems}\n`);
    
    // Get cart menu
    console.log(`🔍 Fetching cart ${cartId}'s menu...`);
    const cartObjectId = mongoose.Types.ObjectId.isValid(cartId) 
      ? (typeof cartId === 'string' ? new mongoose.Types.ObjectId(cartId) : cartId)
      : cartId;
    
    const cartCategories = await MenuCategory.find({ cafeId: cartObjectId }).lean();
    const cartItems = await MenuItem.find({ cafeId: cartObjectId }).lean();
    
    console.log(`✅ Found cart menu`);
    console.log(`   Categories: ${cartCategories.length}`);
    console.log(`   Total Items: ${cartItems.length}\n`);
    
    // Build cart menu structure
    const cartMenuStructure = [];
    let cartTotalItems = 0;
    
    cartCategories.forEach((cat) => {
      const catItems = cartItems.filter(item => item.category.toString() === cat._id.toString());
      cartTotalItems += catItems.length;
      cartMenuStructure.push({
        name: cat.name,
        itemCount: catItems.length,
        items: catItems.map(item => ({
          name: item.name,
          price: item.price
        }))
      });
    });
    
    // Compare
    console.log('═══════════════════════════════════════════════════════════');
    console.log('📊 MENU COMPARISON');
    console.log('═══════════════════════════════════════════════════════════\n');
    
    console.log('🏢 FRANCHISE MENU:');
    console.log(`   Categories: ${franchiseMenu.categories?.length || 0}`);
    console.log(`   Total Items: ${franchiseTotalItems}`);
    franchiseMenuStructure.forEach((cat, idx) => {
      console.log(`   ${idx + 1}. "${cat.name}" - ${cat.itemCount} items`);
      cat.items.forEach((item, itemIdx) => {
        console.log(`      ${itemIdx + 1}. ${item.name} - ₹${item.price}`);
      });
    });
    
    console.log('\n🛒 CART MENU:');
    console.log(`   Categories: ${cartCategories.length}`);
    console.log(`   Total Items: ${cartTotalItems}`);
    cartMenuStructure.forEach((cat, idx) => {
      console.log(`   ${idx + 1}. "${cat.name}" - ${cat.itemCount} items`);
      cat.items.forEach((item, itemIdx) => {
        console.log(`      ${itemIdx + 1}. ${item.name} - ₹${item.price}`);
      });
    });
    
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('✅ VERIFICATION RESULTS');
    console.log('═══════════════════════════════════════════════════════════\n');
    
    // Check category count
    const categoryMatch = cartCategories.length === (franchiseMenu.categories?.length || 0);
    console.log(`Category Count: ${categoryMatch ? '✅ MATCH' : '❌ MISMATCH'}`);
    console.log(`   Franchise: ${franchiseMenu.categories?.length || 0}`);
    console.log(`   Cart: ${cartCategories.length}`);
    
    // Check item count
    const itemMatch = cartTotalItems === franchiseTotalItems;
    console.log(`\nItem Count: ${itemMatch ? '✅ MATCH' : '❌ MISMATCH'}`);
    console.log(`   Franchise: ${franchiseTotalItems}`);
    console.log(`   Cart: ${cartTotalItems}`);
    
    // Check category names
    const franchiseCategoryNames = franchiseMenuStructure.map(c => c.name.toLowerCase().trim());
    const cartCategoryNames = cartMenuStructure.map(c => c.name.toLowerCase().trim());
    const categoryNamesMatch = JSON.stringify(franchiseCategoryNames.sort()) === JSON.stringify(cartCategoryNames.sort());
    
    console.log(`\nCategory Names: ${categoryNamesMatch ? '✅ MATCH' : '❌ MISMATCH'}`);
    if (!categoryNamesMatch) {
      console.log(`   Franchise: ${franchiseCategoryNames.join(', ')}`);
      console.log(`   Cart: ${cartCategoryNames.join(', ')}`);
    }
    
    // Check for duplicates in cart
    const duplicateCategories = [];
    const seenNames = new Set();
    cartCategories.forEach(cat => {
      const nameLower = cat.name.toLowerCase().trim();
      if (seenNames.has(nameLower)) {
        duplicateCategories.push(cat.name);
      } else {
        seenNames.add(nameLower);
      }
    });
    
    if (duplicateCategories.length > 0) {
      console.log(`\n❌ DUPLICATE CATEGORIES IN CART: ${duplicateCategories.join(', ')}`);
    } else {
      console.log(`\n✅ No duplicate categories in cart`);
    }
    
    // Detailed item comparison
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('📝 DETAILED ITEM COMPARISON');
    console.log('═══════════════════════════════════════════════════════════\n');
    
    franchiseMenuStructure.forEach((franchiseCat, idx) => {
      const cartCat = cartMenuStructure.find(c => c.name.toLowerCase().trim() === franchiseCat.name.toLowerCase().trim());
      
      if (!cartCat) {
        console.log(`❌ Category "${franchiseCat.name}" NOT FOUND in cart!`);
        return;
      }
      
      console.log(`Category "${franchiseCat.name}":`);
      console.log(`   Franchise: ${franchiseCat.itemCount} items`);
      console.log(`   Cart: ${cartCat.itemCount} items`);
      
      if (franchiseCat.itemCount !== cartCat.itemCount) {
        console.log(`   ❌ Item count mismatch!`);
      } else {
        console.log(`   ✅ Item count matches`);
      }
      
      // Compare items
      franchiseCat.items.forEach((franchiseItem, itemIdx) => {
        const cartItem = cartCat.items.find(i => i.name.toLowerCase().trim() === franchiseItem.name.toLowerCase().trim());
        if (!cartItem) {
          console.log(`   ❌ Item "${franchiseItem.name}" NOT FOUND in cart!`);
        } else if (cartItem.price !== franchiseItem.price) {
          console.log(`   ⚠️ Item "${franchiseItem.name}" price mismatch: Franchise ₹${franchiseItem.price}, Cart ₹${cartItem.price}`);
        }
      });
      
      // Check for extra items in cart
      cartCat.items.forEach((cartItem) => {
        const franchiseItem = franchiseCat.items.find(i => i.name.toLowerCase().trim() === cartItem.name.toLowerCase().trim());
        if (!franchiseItem) {
          console.log(`   ⚠️ Extra item in cart: "${cartItem.name}" (not in franchise menu)`);
        }
      });
      
      console.log('');
    });
    
    // Final verdict
    console.log('═══════════════════════════════════════════════════════════');
    if (categoryMatch && itemMatch && categoryNamesMatch && duplicateCategories.length === 0) {
      console.log('✅ PERFECT MATCH! Cart menu matches franchise menu exactly!');
    } else {
      console.log('❌ MISMATCH DETECTED! Cart menu does not match franchise menu.');
      console.log('\n💡 To fix:');
      console.log('   1. Check if franchise menu was saved correctly');
      console.log('   2. Run menu sync: The menu should sync automatically');
      console.log('   3. Or manually sync: POST /api/default-menu/push/cafe/:cafeId');
    }
    console.log('═══════════════════════════════════════════════════════════\n');
    
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
const franchiseId = process.argv[3] || null;

if (!cartId) {
  console.error('Usage: node backend/scripts/verify-menu-sync.js <cart-id> [franchise-id]');
  process.exit(1);
}

verifyMenuSync(cartId, franchiseId);















