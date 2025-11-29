/**
 * Force sync menu for a specific cart from franchise default menu
 * Usage: node scripts/force-sync-cart-menu.js <cartId>
 */

require('dotenv').config();
const mongoose = require('mongoose');
const MenuCategory = require('../models/menuCategoryModel');
const { MenuItem } = require('../models/menuItemModel');
const User = require('../models/userModel');
const DefaultMenu = require('../models/defaultMenuModel');

async function forceSyncMenu(cartId) {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ Connected to MongoDB\n');

  // Find the cart
  const cart = await User.findById(cartId);
  if (!cart) {
    console.error('❌ Cart not found:', cartId);
    await mongoose.disconnect();
    return;
  }

  console.log('📦 Cart:', cart.cartName || cart.email);
  console.log('   ID:', cart._id);
  console.log('   Franchise:', cart.franchiseId);

  if (!cart.franchiseId) {
    console.error('❌ Cart has no franchiseId!');
    await mongoose.disconnect();
    return;
  }

  // Get franchise default menu
  const franchiseMenu = await DefaultMenu.getDefaultMenu(cart.franchiseId.toString());
  if (!franchiseMenu || !franchiseMenu.categories || franchiseMenu.categories.length === 0) {
    console.error('❌ Franchise has no default menu!');
    await mongoose.disconnect();
    return;
  }

  console.log('\n📋 Franchise Menu:');
  console.log('   Categories:', franchiseMenu.categories.length);
  franchiseMenu.categories.forEach((cat, i) => {
    console.log(`   ${i + 1}. ${cat.name} - ${cat.items?.length || 0} items`);
    if (cat.items) {
      cat.items.forEach(item => console.log(`      - ${item.name} (₹${item.price})`));
    }
  });

  // STEP 1: Delete ALL existing menu for this cart
  console.log('\n🧹 Deleting existing menu for cart...');
  const deletedCats = await MenuCategory.deleteMany({ cafeId: cart._id });
  const deletedItems = await MenuItem.deleteMany({ cafeId: cart._id });
  console.log(`   Deleted ${deletedCats.deletedCount} categories, ${deletedItems.deletedCount} items`);

  // STEP 2: Create new menu from franchise
  console.log('\n✨ Creating new menu from franchise...');
  
  let categoriesCreated = 0;
  let itemsCreated = 0;

  for (const catData of franchiseMenu.categories) {
    // Create category
    const newCategory = await MenuCategory.create({
      name: catData.name,
      description: catData.description || '',
      icon: catData.icon || '',
      sortOrder: catData.sortOrder || 0,
      isActive: true,
      cafeId: cart._id
    });
    categoriesCreated++;
    console.log(`   ✅ Created category: ${catData.name}`);

    // Create items
    if (catData.items && catData.items.length > 0) {
      for (const itemData of catData.items) {
        await MenuItem.create({
          name: itemData.name,
          description: itemData.description || '',
          price: itemData.price,
          image: itemData.image || '',
          spiceLevel: itemData.spiceLevel || 'NONE',
          isAvailable: true,
          isFeatured: itemData.isFeatured || false,
          sortOrder: itemData.sortOrder || 0,
          tags: itemData.tags || [],
          allergens: itemData.allergens || [],
          category: newCategory._id,
          cafeId: cart._id
        });
        itemsCreated++;
        console.log(`      ✅ Created item: ${itemData.name}`);
      }
    }
  }

  console.log('\n========================================');
  console.log('SYNC COMPLETE');
  console.log(`Created: ${categoriesCreated} categories, ${itemsCreated} items`);
  console.log('========================================');

  // Verify
  const finalCats = await MenuCategory.find({ cafeId: cart._id }).lean();
  const finalItems = await MenuItem.find({ cafeId: cart._id }).lean();
  console.log(`\nFinal state: ${finalCats.length} categories, ${finalItems.length} items`);

  await mongoose.disconnect();
  console.log('\n✅ Done!');
}

// Get cart ID from command line
const cartId = process.argv[2];
if (!cartId) {
  console.log('Usage: node scripts/force-sync-cart-menu.js <cartId>');
  console.log('\nAvailable carts:');
  
  require('dotenv').config();
  mongoose.connect(process.env.MONGO_URI).then(async () => {
    const carts = await User.find({ role: 'admin' }).select('_id cartName email franchiseId').lean();
    carts.forEach(c => console.log(`  ${c._id} - ${c.cartName || c.email}`));
    await mongoose.disconnect();
  });
} else {
  forceSyncMenu(cartId).catch(console.error);
}











