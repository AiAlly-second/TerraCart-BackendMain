/**
 * Menu Cloning Utilities
 * 
 * CRITICAL: These functions ensure complete data isolation between menu levels.
 * Each menu is cloned with new IDs - no shared references that could cause data leakage.
 */

const GlobalMenuItem = require("../models/globalMenuModel");
const FranchiseMenuItem = require("../models/franchiseMenuModel");
const CartMenuItem = require("../models/cartMenuModel");
const Franchise = require("../models/franchiseModel");
const Cart = require("../models/cartModel");

/**
 * Clone global menu items to create a franchise menu
 * 
 * This function:
 * 1. Gets all available global menu items
 * 2. Creates new franchise menu items with new IDs
 * 3. Stores sourceGlobalMenuItemId for reference (not dependency)
 * 4. Marks franchise menu as initialized
 * 
 * @param {ObjectId} franchiseId - The franchise ID
 * @param {ObjectId} franchiseAdminId - The franchise admin user ID
 * @returns {Promise<Object>} Result with counts
 */
async function cloneGlobalMenuToFranchise(franchiseId, franchiseAdminId) {
  try {
    // Verify franchise exists
    const franchise = await Franchise.findById(franchiseId);
    if (!franchise) {
      throw new Error(`Franchise ${franchiseId} not found`);
    }

    // Check if menu already initialized
    if (franchise.menuInitialized) {
      // console.log(`[MENU CLONE] Franchise ${franchiseId} menu already initialized`);
      return {
        success: false,
        message: "Franchise menu already initialized",
        itemsCloned: 0,
      };
    }

    // CRITICAL: Delete ANY existing menu data for this franchise first
    // This prevents old/duplicate data from appearing
    const existingItems = await FranchiseMenuItem.find({ franchiseId: franchiseId }).lean();
    if (existingItems.length > 0) {
      // console.log(`[MENU CLONE] ⚠️ Found ${existingItems.length} existing items for franchise ${franchiseId}, deleting...`);
      await FranchiseMenuItem.deleteMany({ franchiseId: franchiseId });
      // console.log(`[MENU CLONE] ✅ Deleted ${existingItems.length} existing items`);
    }

    // Get all global menu items
    const globalItems = await GlobalMenuItem.find({ isAvailable: true })
      .sort({ category: 1, sortOrder: 1 })
      .lean();
    
    if (globalItems.length === 0) {
      console.warn(`[MENU CLONE] No global menu items found`);
      return {
        success: false,
        message: "No global menu items available to clone",
        itemsCloned: 0,
      };
    }

    // console.log(`[MENU CLONE] Cloning ${globalItems.length} items from global menu to franchise ${franchiseId}`);

    // Clone each item with new ID
    // CRITICAL: Each item gets a NEW _id - no shared references
    const franchiseItems = globalItems.map((item) => ({
      franchiseId: franchiseId,
      sourceGlobalMenuItemId: item._id, // Reference for tracking only
      name: item.name,
      description: item.description,
      category: item.category,
      price: item.price,
      taxRate: item.taxRate,
      isAvailable: item.isAvailable,
      image: item.image,
      tags: item.tags || [],
      allergens: item.allergens || [],
      calories: item.calories,
      spiceLevel: item.spiceLevel,
      sortOrder: item.sortOrder,
      isCustom: false, // Cloned from global
      lastUpdatedBy: franchiseAdminId,
    }));

    // Insert all items
    const createdItems = await FranchiseMenuItem.insertMany(franchiseItems);

    // Update franchise menu initialization status
    await Franchise.findByIdAndUpdate(franchiseId, {
      menuInitialized: true,
      menuInitializedAt: new Date(),
    });

    // console.log(`[MENU CLONE] ✅ Successfully cloned ${createdItems.length} items to franchise ${franchiseId}`);
    // console.log(`[MENU CLONE] ✅ Franchise ${franchiseId} now has UNIQUE menu data (not shared with global)`);

    return {
      success: true,
      message: `Cloned ${createdItems.length} items from global menu`,
      itemsCloned: createdItems.length,
    };
  } catch (error) {
    console.error(`[MENU CLONE] ❌ Error cloning global menu to franchise:`, error);
    throw error;
  }
}

/**
 * Clone franchise menu items to create a cart menu
 * 
 * CRITICAL: This ensures each cart has UNIQUE menu data
 * 
 * This function:
 * 1. Deletes ANY existing menu data for the cart (prevents old data)
 * 2. Gets all available franchise menu items
 * 3. Creates new cart menu items with new IDs
 * 4. Stores sourceFranchiseMenuItemId for reference (not dependency)
 * 5. Marks cart menu as initialized
 * 
 * @param {ObjectId} cartId - The cart ID
 * @param {ObjectId} franchiseId - The franchise ID (for validation)
 * @returns {Promise<Object>} Result with counts
 */
async function cloneFranchiseMenuToCart(cartId, franchiseId) {
  try {
    const mongoose = require('mongoose');
    
    // Verify cart exists and belongs to franchise
    const cart = await Cart.findOne({ _id: cartId, franchiseId: franchiseId });
    if (!cart) {
      throw new Error(`Cart ${cartId} not found or doesn't belong to franchise ${franchiseId}`);
    }

    // CRITICAL: ALWAYS delete ALL existing menu data for this cart first
    // This prevents old/duplicate data from appearing in new carts
    // We do this REGARDLESS of initialization status to ensure clean state
    // console.log(`[MENU CLONE] 🧹 AGGRESSIVE CLEANUP: Deleting ALL existing menu data for cart ${cartId}`);
    
    // Convert cartId to all possible formats
    const cartIdStr = cartId.toString();
    const cartObjectId = mongoose.Types.ObjectId.isValid(cartId) 
      ? (typeof cartId === 'string' ? new mongoose.Types.ObjectId(cartId) : cartId)
      : cartId;
    
    // Find ALL existing items using ALL query formats (ObjectId, String, Direct)
    const items1 = await CartMenuItem.find({ cartId: cartObjectId }).lean();
    const items2 = await CartMenuItem.find({ cartId: cartIdStr }).lean();
    const items3 = await CartMenuItem.find({ cartId: cartId }).lean();
    
    // Combine and deduplicate
    const allExistingItems = [];
    const seenItemIds = new Set();
    [...items1, ...items2, ...items3].forEach(item => {
      const itemId = item._id.toString();
      if (!seenItemIds.has(itemId)) {
        seenItemIds.add(itemId);
        allExistingItems.push(item);
      }
    });
    
    // console.log(`[MENU CLONE] Found ${allExistingItems.length} existing items to delete`);
    
    if (allExistingItems.length > 0) {
      // console.log(`[MENU CLONE] Item details: ${allExistingItems.map(i => `"${i.name}" (cartId: ${i.cartId}, type: ${typeof i.cartId})`).join(', ')}`);
    }
    
    // Delete using multiple strategies to catch all formats
    // Strategy 1: Delete using $or query (catches all formats at once)
    const deletedOr = await CartMenuItem.deleteMany({ 
      $or: [
        { cartId: cartObjectId },
        { cartId: cartIdStr },
        { cartId: cartId }
      ]
    });
    // console.log(`[MENU CLONE] 🗑️ Deleted ${deletedOr.deletedCount} items using $or query`);
    
    // Strategy 2: Delete individually for each format (to be absolutely sure)
    const deleted1 = await CartMenuItem.deleteMany({ cartId: cartObjectId });
    const deleted2 = await CartMenuItem.deleteMany({ cartId: cartIdStr });
    const deleted3 = await CartMenuItem.deleteMany({ cartId: cartId });
    // console.log(`[MENU CLONE] 🗑️ Deleted ${deleted1.deletedCount} (ObjectId) + ${deleted2.deletedCount} (string) + ${deleted3.deletedCount} (direct)`);
    
    // Wait for deletion to commit
    await new Promise(resolve => setTimeout(resolve, 300));
    
    // Verify deletion using all formats
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
    
    if (totalRemaining > 0) {
      console.error(`[MENU CLONE] ❌ ERROR: Still have ${totalRemaining} items after cleanup!`);
      console.error(`[MENU CLONE] ObjectId: ${remaining1}, String: ${remaining2}, Direct: ${remaining3}, $or: ${remainingOr}`);
      
      // Try collection-level delete as last resort
      const CartMenuItemCollection = CartMenuItem.collection;
      await CartMenuItemCollection.deleteMany({ cartId: cartObjectId });
      await CartMenuItemCollection.deleteMany({ cartId: cartIdStr });
      
      await new Promise(resolve => setTimeout(resolve, 300));
      
      const finalRemaining = await CartMenuItem.countDocuments({ 
        $or: [{ cartId: cartObjectId }, { cartId: cartIdStr }] 
      });
      
      if (finalRemaining > 0) {
        throw new Error(`CRITICAL: Failed to delete all menu data. Still have ${finalRemaining} items.`);
      }
    }
    
    // console.log(`[MENU CLONE] ✅ CLEANUP COMPLETE: All menu data deleted (0 items remaining)`);
    // console.log(`[MENU CLONE] Database is now clean and ready for fresh menu clone`);

    // Get all franchise menu items
    const franchiseItems = await FranchiseMenuItem.find({
      franchiseId: franchiseId,
      isAvailable: true,
    })
      .sort({ category: 1, sortOrder: 1 })
      .lean();

    if (franchiseItems.length === 0) {
      console.warn(`[MENU CLONE] No franchise menu items found for franchise ${franchiseId}`);
      return {
        success: false,
        message: "No franchise menu items available to clone",
        itemsCloned: 0,
      };
    }

    // console.log(`[MENU CLONE] Cloning ${franchiseItems.length} items from franchise ${franchiseId} to cart ${cartId}`);

    // Clone each item with new ID
    // CRITICAL: Each item gets a NEW _id - no shared references
    const cartItems = franchiseItems.map((item) => ({
      cartId: cartId,
      franchiseId: franchiseId, // For validation
      sourceFranchiseMenuItemId: item._id, // Reference for tracking only
      name: item.name,
      description: item.description,
      category: item.category,
      price: item.price,
      taxRate: item.taxRate,
      isAvailable: item.isAvailable,
      image: item.image,
      tags: item.tags || [],
      allergens: item.allergens || [],
      calories: item.calories,
      spiceLevel: item.spiceLevel,
      sortOrder: item.sortOrder,
      cartAvailabilityOverride: null, // No override initially
    }));

    // Insert all items
    const createdItems = await CartMenuItem.insertMany(cartItems);

    // Update cart menu initialization status
    await Cart.findByIdAndUpdate(cartId, {
      menuInitialized: true,
      menuInitializedAt: new Date(),
    });

    // Final verification - ensure we have the correct number of items
    const finalItemCount = await CartMenuItem.countDocuments({ cartId: cartObjectId });
    // console.log(`[MENU CLONE] ✅ Successfully cloned ${createdItems.length} items to cart ${cartId}`);
    // console.log(`[MENU CLONE] ✅ Final verification: ${finalItemCount} items in database (expected: ${createdItems.length})`);
    
    if (finalItemCount !== createdItems.length) {
      console.error(`[MENU CLONE] ⚠️ WARNING: Item count mismatch! Expected ${createdItems.length}, got ${finalItemCount}`);
    }
    
    // console.log(`[MENU CLONE] ✅ Cart ${cartId} now has UNIQUE menu data (not shared with other carts)`);
    // console.log(`[MENU CLONE] ✅ All previous menu data has been deleted and replaced with fresh clone`);

    return {
      success: true,
      message: `Cloned ${createdItems.length} items from franchise menu`,
      itemsCloned: createdItems.length,
      finalItemCount: finalItemCount,
    };
  } catch (error) {
    console.error(`[MENU CLONE] ❌ Error cloning franchise menu to cart:`, error);
    throw error;
  }
}

module.exports = {
  cloneGlobalMenuToFranchise,
  cloneFranchiseMenuToCart,
};

