/**
 * Script to fix cart menu issues:
 * 1. Delete all duplicate categories
 * 2. Delete all items
 * 3. Re-sync menu from franchise default menu
 * 
 * Usage: node backend/scripts/fix-cart-menu.js <cartId> [franchiseId]
 */

const mongoose = require('mongoose');
const path = require('path');

// Load models
const User = require(path.join(__dirname, '../models/userModel'));
const MenuCategory = require(path.join(__dirname, '../models/menuCategoryModel'));
const MenuItem = require(path.join(__dirname, '../models/menuItemModel'));
const DefaultMenu = require(path.join(__dirname, '../models/defaultMenuModel'));

async function fixCartMenu(cartId, franchiseId = null) {
  try {
    // Connect to database
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/terra-cart');
    console.log('✅ Connected to MongoDB\n');

    // Get cart
    const cart = await User.findById(cartId);
    if (!cart) {
      console.error(`❌ Cart with ID ${cartId} not found`);
      process.exit(1);
    }

    if (cart.role !== 'admin') {
      console.error(`❌ User ${cartId} is not a cart admin (role: ${cart.role})`);
      process.exit(1);
    }

    const finalFranchiseId = franchiseId || cart.franchiseId;
    if (!finalFranchiseId) {
      console.error(`❌ Cart ${cart.cafeName || cartId} has no franchiseId`);
      process.exit(1);
    }

    console.log(`🔍 Cart: ${cart.cafeName || cart.name}`);
    console.log(`🔍 Cart ID: ${cartId}`);
    console.log(`🔍 Franchise ID: ${finalFranchiseId}\n`);

    // Step 1: Get current menu counts
    const currentCategories = await MenuCategory.countDocuments({ cafeId: cartId });
    const currentItems = await MenuItem.countDocuments({ cafeId: cartId });
    console.log(`📊 Current menu: ${currentCategories} categories, ${currentItems} items\n`);

    // Step 2: Get franchise default menu
    console.log('📋 Fetching franchise default menu...');
    const defaultMenu = await DefaultMenu.findOne({ 
      franchiseId: finalFranchiseId, 
      isActive: true 
    }).sort({ updatedAt: -1, version: -1 }).lean();

    if (!defaultMenu) {
      console.error(`❌ No default menu found for franchise ${finalFranchiseId}`);
      process.exit(1);
    }

    console.log(`✅ Found default menu (ID: ${defaultMenu._id}, Version: ${defaultMenu.version})`);
    console.log(`📋 Categories: ${defaultMenu.categories?.length || 0}`);
    
    const totalItems = defaultMenu.categories?.reduce((sum, cat) => sum + (cat.items ? cat.items.length : 0), 0) || 0;
    console.log(`📊 Total items: ${totalItems}\n`);

    // Log each category and its items
    if (defaultMenu.categories && defaultMenu.categories.length > 0) {
      defaultMenu.categories.forEach((cat, idx) => {
        const itemCount = cat.items ? cat.items.length : 0;
        console.log(`   Category ${idx + 1}: "${cat.name}" - ${itemCount} items`);
        if (cat.items && cat.items.length > 0) {
          cat.items.forEach((item, itemIdx) => {
            console.log(`      Item ${itemIdx + 1}: "${item.name}" - ₹${item.price}`);
          });
        }
      });
      console.log('');
    }

    // Step 3: Delete ALL existing menu data
    console.log('🗑️  Deleting ALL existing menu data...');
    const deletedItems = await MenuItem.deleteMany({ cafeId: cartId });
    const deletedCategories = await MenuCategory.deleteMany({ cafeId: cartId });
    console.log(`✅ Deleted ${deletedCategories.deletedCount} categories and ${deletedItems.deletedCount} items\n`);

    // Step 4: Create new menu from default menu
    console.log('🔄 Creating new menu from franchise default menu...');
    let categoriesCreated = 0;
    let itemsCreated = 0;

    for (const categoryData of defaultMenu.categories) {
      const { items, ...categoryFields } = categoryData;

      // Create category
      const category = await MenuCategory.create({
        name: categoryFields.name.trim(),
        description: (categoryFields.description || '').trim(),
        icon: (categoryFields.icon || '').trim(),
        sortOrder: categoryFields.sortOrder || 0,
        isActive: categoryFields.isActive !== false,
        cafeId: cartId,
      });
      categoriesCreated++;
      console.log(`✅ Created category: "${categoryFields.name}"`);

      // Create items
      if (items && Array.isArray(items) && items.length > 0) {
        for (const itemData of items) {
          try {
            await MenuItem.create({
              name: itemData.name.trim(),
              description: (itemData.description || '').trim(),
              price: Number(itemData.price),
              image: (itemData.image || '').trim(),
              spiceLevel: itemData.spiceLevel || 'NONE',
              isAvailable: itemData.isAvailable !== false,
              isFeatured: itemData.isFeatured || false,
              sortOrder: itemData.sortOrder || 0,
              tags: Array.isArray(itemData.tags) ? itemData.tags : [],
              allergens: Array.isArray(itemData.allergens) ? itemData.allergens : [],
              calories: itemData.calories ? Number(itemData.calories) : undefined,
              category: category._id,
              cafeId: cartId,
            });
            itemsCreated++;
            console.log(`   ✅ Created item: "${itemData.name}" (₹${itemData.price})`);
          } catch (itemErr) {
            console.error(`   ❌ Error creating item "${itemData.name}":`, itemErr.message);
          }
        }
      } else {
        console.log(`   ⚠️  No items in category "${categoryFields.name}"`);
      }
    }

    // Step 5: Verify
    console.log('\n📊 Verification:');
    const finalCategories = await MenuCategory.countDocuments({ cafeId: cartId });
    const finalItems = await MenuItem.countDocuments({ cafeId: cartId });
    console.log(`✅ Final menu: ${finalCategories} categories, ${finalItems} items`);

    if (finalCategories === categoriesCreated && finalItems === itemsCreated) {
      console.log('\n✅ SUCCESS: Menu fixed successfully!');
    } else {
      console.warn(`\n⚠️  WARNING: Count mismatch! Created ${categoriesCreated} categories but have ${finalCategories}`);
      console.warn(`⚠️  Created ${itemsCreated} items but have ${finalItems}`);
    }

    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

// Get command line arguments
const cartId = process.argv[2];
const franchiseId = process.argv[3] || null;

if (!cartId) {
  console.error('Usage: node backend/scripts/fix-cart-menu.js <cartId> [franchiseId]');
  process.exit(1);
}

fixCartMenu(cartId, franchiseId);



