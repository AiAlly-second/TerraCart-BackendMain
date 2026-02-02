const mongoose = require('mongoose');
require('dotenv').config();

async function findIngredientsCollection() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB\n');

    const db = mongoose.connection.db;
    
    // List all collections
    const collections = await db.listCollections().toArray();
    
    console.log(`📚 All collections in database:\n`);
    for (const col of collections) {
      const count = await db.collection(col.name).countDocuments({});
      console.log(`  - ${col.name}: ${count} documents`);
    }
    
    // Try to find collections with "ingredient" in the name
    console.log(`\n🔍 Collections with 'ingredient' in name:\n`);
    const ingredientCollections = collections.filter(c => 
      c.name.toLowerCase().includes('ingredient')
    );
    
    for (const col of ingredientCollections) {
      const count = await db.collection(col.name).countDocuments({});
      console.log(`\n  Collection: ${col.name} (${count} documents)`);
      
      if (count > 0) {
        const sample = await db.collection(col.name).find({}).limit(2).toArray();
        console.log(`  Sample documents:`);
        for (const doc of sample) {
          console.log(`    - ${doc.name || doc._id}`);
          console.log(`      cartId: ${doc.cartId} (type: ${typeof doc.cartId})`);
          console.log(`      franchiseId: ${doc.franchiseId}`);
        }
      }
    }
    
    await mongoose.connection.close();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

findIngredientsCollection();
