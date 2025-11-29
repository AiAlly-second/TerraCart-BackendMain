const mongoose = require('mongoose');
require('dotenv').config();

const MenuItem = require('../models/menuItemModel').MenuItem;
const MenuCategory = require('../models/menuCategoryModel');
const DefaultMenu = require('../models/defaultMenuModel');

const checkMenuImages = async () => {
  try {
    // Connect to database
    const mongoUri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/terra-cart";
    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB\n');

    // Check DefaultMenu (global menu)
    console.log('='.repeat(60));
    console.log('CHECKING DEFAULT MENU (Global Menu)');
    console.log('='.repeat(60));
    const globalMenu = await DefaultMenu.findOne({ franchiseId: null, isActive: true }).lean();
    if (globalMenu) {
      console.log(`Global Menu ID: ${globalMenu._id}`);
      console.log(`Categories: ${globalMenu.categories?.length || 0}`);
      let totalItems = 0;
      let itemsWithImages = 0;
      globalMenu.categories?.forEach((cat, catIdx) => {
        if (cat.items && cat.items.length > 0) {
          cat.items.forEach((item, itemIdx) => {
            totalItems++;
            if (item.image && item.image.trim()) {
              itemsWithImages++;
              console.log(`  ✅ Category "${cat.name}", Item "${item.name}": Image = ${item.image}`);
            } else {
              console.log(`  ❌ Category "${cat.name}", Item "${item.name}": NO IMAGE`);
            }
          });
        }
      });
      console.log(`\nTotal items: ${totalItems}, Items with images: ${itemsWithImages}\n`);
    } else {
      console.log('❌ No global default menu found\n');
    }

    // Check DefaultMenu for a specific franchise (if you have one)
    console.log('='.repeat(60));
    console.log('CHECKING FRANCHISE DEFAULT MENUS');
    console.log('='.repeat(60));
    const franchiseMenus = await DefaultMenu.find({ franchiseId: { $ne: null }, isActive: true }).lean();
    console.log(`Found ${franchiseMenus.length} franchise menus\n`);
    franchiseMenus.forEach((menu, idx) => {
      console.log(`Franchise Menu ${idx + 1} - Franchise ID: ${menu.franchiseId}`);
      console.log(`  Categories: ${menu.categories?.length || 0}`);
      let totalItems = 0;
      let itemsWithImages = 0;
      menu.categories?.forEach((cat) => {
        if (cat.items && cat.items.length > 0) {
          cat.items.forEach((item) => {
            totalItems++;
            if (item.image && item.image.trim()) {
              itemsWithImages++;
            }
          });
        }
      });
      console.log(`  Total items: ${totalItems}, Items with images: ${itemsWithImages}\n`);
    });

    // Check MenuItem collection (cart admin menus)
    console.log('='.repeat(60));
    console.log('CHECKING MENU ITEMS (Cart Admin Menus)');
    console.log('='.repeat(60));
    const allItems = await MenuItem.find({}).lean();
    console.log(`Total menu items in database: ${allItems.length}`);
    
    // Group by cafeId
    const itemsByCafe = {};
    allItems.forEach(item => {
      const cafeId = item.cafeId ? item.cafeId.toString() : 'NO_CAFE_ID';
      if (!itemsByCafe[cafeId]) {
        itemsByCafe[cafeId] = { total: 0, withImages: 0, items: [] };
      }
      itemsByCafe[cafeId].total++;
      if (item.image && item.image.trim()) {
        itemsByCafe[cafeId].withImages++;
      }
      itemsByCafe[cafeId].items.push(item);
    });

    Object.entries(itemsByCafe).forEach(([cafeId, data]) => {
      console.log(`\nCafe ID: ${cafeId}`);
      console.log(`  Total items: ${data.total}, Items with images: ${data.withImages}`);
      // Show first 3 items as sample
      data.items.slice(0, 3).forEach(item => {
        console.log(`    - "${item.name}": Image = ${item.image || 'NO IMAGE'}`);
      });
    });

    console.log('\n' + '='.repeat(60));
    console.log('SUMMARY');
    console.log('='.repeat(60));
    console.log(`Global Menu: ${globalMenu ? 'EXISTS' : 'NOT FOUND'}`);
    console.log(`Franchise Menus: ${franchiseMenus.length}`);
    console.log(`Total Menu Items: ${allItems.length}`);
    console.log(`Items with images: ${allItems.filter(item => item.image && item.image.trim()).length}`);
    console.log(`Items without images: ${allItems.filter(item => !item.image || !item.image.trim()).length}`);

    await mongoose.disconnect();
    console.log('\n✅ Database check complete');
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
};

checkMenuImages();

