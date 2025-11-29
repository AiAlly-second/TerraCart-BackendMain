/**
 * Cleanup Cart Menu Data - Delete ALL menu data for a specific cart
 * 
 * Usage:
 *   node backend/scripts/cleanup-cart-menu-data.js <cart-id>
 * 
 * This script will:
 * 1. Find ALL menu data (items) for the cart using ALL query formats
 * 2. Delete everything, regardless of how cartId is stored
 * 3. Verify deletion was successful
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');
const CartMenuItem = require('../models/cartMenuModel');
const Cart = require('../models/cartModel');

async function cleanupCartMenuData(cartId) {
  try {
    const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/terra-cart';
    
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
    });
    console.log('✅ Connected to MongoDB\n');
    
    // Get cart info
    const cart = await Cart.findById(cartId);
    if (!cart) {
      console.error(`❌ Cart with ID ${cartId} not found`);
      process.exit(1);
    }
    
    console.log(`📋 Cart: ${cart.name} (ID: ${cart._id})`);
    console.log(`📋 Franchise ID: ${cart.franchiseId}\n`);
    
    // Convert cartId to all possible formats
    const cartIdStr = cartId.toString();
    const cartObjectId = mongoose.Types.ObjectId.isValid(cartId) 
      ? (typeof cartId === 'string' ? new mongoose.Types.ObjectId(cartId) : cartId)
      : cartId;
    
    console.log('🔍 Finding ALL menu data for this cart...');
    console.log(`   Searching with cartId formats: ObjectId(${cartObjectId}), String(${cartIdStr})\n`);
    
    // Find ALL items using ALL query formats
    const items1 = await CartMenuItem.find({ cartId: cartObjectId }).lean();
    const items2 = await CartMenuItem.find({ cartId: cartIdStr }).lean();
    const items3 = await CartMenuItem.find({ cartId: cartId }).lean();
    
    // Combine and deduplicate
    const allItems = [];
    const seenItemIds = new Set();
    [...items1, ...items2, ...items3].forEach(item => {
      const itemId = item._id.toString();
      if (!seenItemIds.has(itemId)) {
        seenItemIds.add(itemId);
        allItems.push(item);
      }
    });
    
    console.log(`📊 Found ${allItems.length} items to delete`);
    if (allItems.length > 0) {
      allItems.forEach((item, idx) => {
        console.log(`   ${idx + 1}. "${item.name}" (₹${item.price}) - cartId: ${item.cartId} (type: ${typeof item.cartId})`);
      });
    }
    
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('🗑️ DELETING ALL MENU DATA...');
    console.log('═══════════════════════════════════════════════════════════\n');
    
    // Delete using $or query (catches all formats)
    const deletedOr = await CartMenuItem.deleteMany({ 
      $or: [
        { cartId: cartObjectId },
        { cartId: cartIdStr },
        { cartId: cartId }
      ]
    });
    console.log(`✅ Deleted ${deletedOr.deletedCount} items using $or query`);
    
    // Delete individually for each format
    const deleted1 = await CartMenuItem.deleteMany({ cartId: cartObjectId });
    const deleted2 = await CartMenuItem.deleteMany({ cartId: cartIdStr });
    const deleted3 = await CartMenuItem.deleteMany({ cartId: cartId });
    console.log(`✅ Deleted ${deleted1.deletedCount} (ObjectId) + ${deleted2.deletedCount} (string) + ${deleted3.deletedCount} (direct)`);
    
    // Wait for deletion to commit
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Verify deletion
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('✅ VERIFICATION');
    console.log('═══════════════════════════════════════════════════════════\n');
    
    const remaining1 = await CartMenuItem.countDocuments({ cartId: cartObjectId });
    const remaining2 = await CartMenuItem.countDocuments({ cartId: cartIdStr });
    const remaining3 = await CartMenuItem.countDocuments({ cartId: cartId });
    const remainingOr = await CartMenuItem.countDocuments({ 
      $or: [
        { cartId: cartObjectId },
        { cartId: cartIdStr },
        { cartId: cartId }
      ]
    });
    
    const totalRemaining = Math.max(remaining1, remaining2, remaining3, remainingOr);
    
    if (totalRemaining === 0) {
      console.log('✅ SUCCESS: All menu data deleted!');
      console.log(`   Remaining items: 0`);
      
      // Reset cart menu initialization status
      await Cart.findByIdAndUpdate(cartId, {
        menuInitialized: false,
        menuInitializedAt: null,
      });
      console.log(`✅ Cart menu initialization status reset`);
    } else {
      console.error('❌ ERROR: Some menu data still exists!');
      console.error(`   Remaining items: ${totalRemaining}`);
      console.error(`   ObjectId query: ${remaining1} items`);
      console.error(`   String query: ${remaining2} items`);
      console.error(`   Direct query: ${remaining3} items`);
      console.error(`   $or query: ${remainingOr} items`);
      
      // Try collection-level delete
      console.log('\n🔄 Attempting collection-level delete...');
      const CartMenuItemCollection = CartMenuItem.collection;
      await CartMenuItemCollection.deleteMany({ cartId: cartObjectId });
      await CartMenuItemCollection.deleteMany({ cartId: cartIdStr });
      
      await new Promise(resolve => setTimeout(resolve, 500));
      
      const finalRemaining = await CartMenuItem.countDocuments({ 
        $or: [{ cartId: cartObjectId }, { cartId: cartIdStr }] 
      });
      
      if (finalRemaining === 0) {
        console.log('✅ SUCCESS: Collection-level delete worked!');
        await Cart.findByIdAndUpdate(cartId, {
          menuInitialized: false,
          menuInitializedAt: null,
        });
      } else {
        console.error(`❌ Still have ${finalRemaining} items`);
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
  console.error('Usage: node backend/scripts/cleanup-cart-menu-data.js <cart-id>');
  process.exit(1);
}

cleanupCartMenuData(cartId);















