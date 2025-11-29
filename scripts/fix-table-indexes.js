const mongoose = require('mongoose');
require('dotenv').config();

const Table = require('../models/tableModel').Table;

async function fixTableIndexes() {
  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/terra-cart';
    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB');

    const collection = Table.collection;
    
    // Get all indexes
    const indexes = await collection.indexes();
    console.log('\n📋 Current indexes on tables collection:');
    indexes.forEach(idx => {
      console.log(`  - ${idx.name}:`, JSON.stringify(idx.key));
    });

    // Drop old unique index on 'number' if it exists
    try {
      const numberIndex = indexes.find(idx => idx.name === 'number_1' && idx.unique);
      if (numberIndex) {
        console.log('\n🗑️  Dropping old unique index on "number"...');
        await collection.dropIndex('number_1');
        console.log('✅ Dropped old unique index on "number"');
      } else {
        console.log('\n✅ No old unique index on "number" found');
      }
    } catch (err) {
      if (err.codeName === 'IndexNotFound') {
        console.log('✅ Old unique index on "number" does not exist');
      } else {
        console.error('❌ Error dropping index:', err.message);
      }
    }

    // Drop old unique index on 'tableNumber' if it exists
    try {
      const tableNumberIndex = indexes.find(idx => idx.name === 'tableNumber_1' && idx.unique);
      if (tableNumberIndex) {
        console.log('\n🗑️  Dropping old unique index on "tableNumber"...');
        await collection.dropIndex('tableNumber_1');
        console.log('✅ Dropped old unique index on "tableNumber"');
      } else {
        console.log('✅ No old unique index on "tableNumber" found');
      }
    } catch (err) {
      if (err.codeName === 'IndexNotFound') {
        console.log('✅ Old unique index on "tableNumber" does not exist');
      } else {
        console.error('❌ Error dropping index:', err.message);
      }
    }

    // Drop old cafeId index if exists
    try {
      const cafeIdIndex = indexes.find(idx => idx.name === 'number_1_cafeId_1' || (idx.key && idx.key.cafeId));
      if (cafeIdIndex) {
        console.log('\n🗑️  Dropping old cafeId index...');
        await collection.dropIndex(cafeIdIndex.name);
        console.log('✅ Dropped old cafeId index');
      }
    } catch (err) {
      if (err.codeName === 'IndexNotFound') {
        console.log('✅ No old cafeId index found');
      } else {
        console.log('ℹ️  Could not drop cafeId index:', err.message);
      }
    }

    // Ensure the new compound index exists (using cartId)
    console.log('\n🔧 Ensuring compound index { number: 1, cartId: 1 } exists...');
    try {
      await collection.createIndex(
        { number: 1, cartId: 1 },
        { unique: true, sparse: true, name: 'number_1_cartId_1' }
      );
      console.log('✅ Compound index created/verified');
    } catch (err) {
      if (err.code === 85) {
        console.log('✅ Compound index already exists');
      } else {
        console.error('❌ Error creating compound index:', err.message);
      }
    }

    // Verify final indexes
    const finalIndexes = await collection.indexes();
    console.log('\n📋 Final indexes:');
    finalIndexes.forEach(idx => {
      console.log(`  - ${idx.name}:`, JSON.stringify(idx.key), idx.unique ? '(unique)' : '');
    });

    console.log('\n✅ Index migration complete!');
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await mongoose.connection.close();
    console.log('\n🔌 MongoDB connection closed');
  }
}

fixTableIndexes();








