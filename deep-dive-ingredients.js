const mongoose = require('mongoose');
require('dotenv').config();

async function deepDiveIngredients() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB\n');

    // Get raw data from database
    const db = mongoose.connection.db;
    const ingredientsCollection = db.collection('ingredients_v2');
    
    const allIngredients = await ingredientsCollection.find({}).limit(5).toArray();
    
    console.log('🔍 RAW DATABASE INSPECTION (first 5 ingredients):\n');
    
    for (const ing of allIngredients) {
      console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`Ingredient: ${ing.name}`);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`  _id: ${ing._id}`);
      console.log(`  cartId field exists: ${ing.hasOwnProperty('cartId')}`);
      console.log(`  cartId value: ${ing.cartId}`);
      console.log(`  cartId type: ${typeof ing.cartId}`);
      console.log(`  cartId === null: ${ing.cartId === null}`);
      console.log(`  cartId === undefined: ${ing.cartId === undefined}`);
      console.log(`  franchiseId: ${ing.franchiseId}`);
      console.log(`  isActive: ${ing.isActive}`);
      console.log(`  category: ${ing.category}`);
    }
    
    // Test different query strategies
    console.log(`\n\n📊 QUERY STRATEGY TESTS:\n`);
    
    const test1 = await ingredientsCollection.countDocuments({ cartId: null });
    const test2 = await ingredientsCollection.countDocuments({ cartId: { $exists: false } });
    const test3 = await ingredientsCollection.countDocuments({ cartId: { $type: 'null' } });
    const test4 = await ingredientsCollection.countDocuments({ 
      cartId: { $in: [null, undefined] } 
    });
    const test5 = await ingredientsCollection.countDocuments({ 
      $or: [{ cartId: null }, { cartId: { $exists: false } }] 
    });
    const test6 = await ingredientsCollection.countDocuments({
      cartId: { $ne: null, $exists: true }
    });
    
    console.log(`  {cartId: null}: ${test1}`);
    console.log(`  {cartId: {$exists: false}}: ${test2}`);
    console.log(`  {cartId: {$type: 'null'}}: ${test3}`);
    console.log(`  {cartId: {$in: [null, undefined]}}: ${test4}`);
    console.log(`  {$or: [{cartId: null}, {cartId: {$exists: false}}]}: ${test5}`);
    console.log(`  {cartId: {$ne: null, $exists: true}}: ${test6}`);
    
    console.log(`\n✅ Total ingredients: ${allIngredients.length}`);
    
    await mongoose.connection.close();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

deepDiveIngredients();
