require('dotenv').config();
const mongoose = require('mongoose');
const MenuCategory = require('../models/menuCategoryModel');
const { MenuItem } = require('../models/menuItemModel');
const User = require('../models/userModel');

async function check() {
  await mongoose.connect(process.env.MONGO_URI);
  
  console.log('========================================');
  console.log('MENU DATA CHECK');
  console.log('========================================\n');
  
  // Check for categories without cafeId
  const catsNoId = await MenuCategory.find({ cafeId: { $exists: false } }).lean();
  const catsNullId = await MenuCategory.find({ cafeId: null }).lean();
  console.log('Categories without cafeId field:', catsNoId.length);
  console.log('Categories with null cafeId:', catsNullId.length);
  
  // Check for items without cafeId
  const itemsNoId = await MenuItem.find({ cafeId: { $exists: false } }).lean();
  const itemsNullId = await MenuItem.find({ cafeId: null }).lean();
  console.log('Items without cafeId field:', itemsNoId.length);
  console.log('Items with null cafeId:', itemsNullId.length);
  
  // Get all cart admins
  const cartAdmins = await User.find({ role: 'admin' }).lean();
  console.log('\n=== Cart Admins ===');
  for (const cart of cartAdmins) {
    const cats = await MenuCategory.find({ cafeId: cart._id }).lean();
    const items = await MenuItem.find({ cafeId: cart._id }).lean();
    console.log(`${cart.cartName || cart.email} (${cart._id}): ${cats.length} categories, ${items.length} items`);
    if (cats.length > 0) {
      cats.forEach(c => console.log(`  - Category: ${c.name}`));
    }
    if (items.length > 0) {
      items.forEach(i => console.log(`    - Item: ${i.name}`));
    }
  }
  
  // Show all categories
  const allCats = await MenuCategory.find({}).select('name cafeId createdAt').lean();
  console.log('\n=== All Categories in DB ===');
  allCats.forEach(c => console.log(`${c.name} | cafeId: ${c.cafeId} | created: ${c.createdAt}`));
  
  // Show all items
  const allItems = await MenuItem.find({}).select('name cafeId category').lean();
  console.log('\n=== All Items in DB ===');
  allItems.forEach(i => console.log(`${i.name} | cafeId: ${i.cafeId} | category: ${i.category}`));
  
  console.log('\n========================================');
  console.log('TOTAL:', allCats.length, 'categories,', allItems.length, 'items');
  console.log('========================================');
  
  await mongoose.disconnect();
}

check().catch(console.error);











