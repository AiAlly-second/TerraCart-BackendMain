/**
 * Force Menu Sync - Manually sync franchise menu to a cart
 * 
 * Usage:
 *   node backend/scripts/force-menu-sync.js <cart-id>
 *   node backend/scripts/force-menu-sync.js <cart-id> <franchise-id>
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');
const { pushDefaultMenuToCafe } = require('../controllers/defaultMenuController');

async function forceMenuSync(cartId, franchiseId = null) {
  try {
    const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/terra-cart';
    
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
    });
    console.log('✅ Connected to MongoDB\n');
    
    console.log(`🔄 Forcing menu sync for cart: ${cartId}`);
    if (franchiseId) {
      console.log(`   Using franchise: ${franchiseId}\n`);
    }
    
    // Call the push function directly
    const result = await pushDefaultMenuToCafe(cartId, franchiseId, true);
    
    console.log('\n═══════════════════════════════════════════════════════════');
    if (result.success) {
      console.log('✅ Menu sync completed successfully!');
      console.log(`   Categories created: ${result.categoriesCreated}`);
      console.log(`   Items created: ${result.itemsCreated}`);
      console.log(`   Final categories: ${result.finalCategoryCount}`);
      console.log(`   Final items: ${result.finalItemCount}`);
    } else {
      console.error('❌ Menu sync failed!');
      console.error(`   Error: ${result.message || 'Unknown error'}`);
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
  console.error('Usage: node backend/scripts/force-menu-sync.js <cart-id> [franchise-id]');
  process.exit(1);
}

forceMenuSync(cartId, franchiseId);















