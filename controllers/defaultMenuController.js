const mongoose = require("mongoose");
const DefaultMenu = require("../models/defaultMenuModel");
const MenuCategory = require("../models/menuCategoryModel");
const { MenuItem } = require("../models/menuItemModel");
const Addon = require("../models/addonModel");
const User = require("../models/userModel");

// Helper function to decode HTML entities in image URLs
const decodeImageUrl = (imageUrl) => {
  if (!imageUrl || typeof imageUrl !== 'string') return '';
  return imageUrl
    .replace(/&amp;#x2F;/g, '/')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x2F;/g, '/')
    .replace(/&#39;/g, "'")
    .trim();
};

// SYNC LOCK: Prevent concurrent syncs for the same cafe
const syncLocks = new Map(); // Map<cartId, Promise>

// SYNC TIMESTAMP: Track when last sync completed for each cafe (prevent rapid re-syncs)
const lastSyncTime = new Map(); // Map<cartId, timestamp>
const SYNC_COOLDOWN_MS = 30000; // 30 seconds - don't sync again within this time

const toObjectId = (value) => {
  if (!value) return null;
  const id = String(value).trim();
  if (!id || !mongoose.Types.ObjectId.isValid(id)) return null;
  return new mongoose.Types.ObjectId(id);
};

const getGlobalAddonTemplates = async () => {
  return Addon.find({
    $and: [
      { $or: [{ franchiseId: null }, { franchiseId: { $exists: false } }] },
      { $or: [{ cartId: null }, { cartId: { $exists: false } }] },
    ],
  })
    .sort({ sortOrder: 1, name: 1 })
    .lean();
};

const syncAddonTemplatesToCart = async ({
  cartAdminId,
  franchiseId,
  templates = [],
}) => {
  const cartObjectId = toObjectId(cartAdminId);
  const franchiseObjectId = toObjectId(franchiseId);
  if (!cartObjectId || !franchiseObjectId) {
    return { upserted: 0, modified: 0, matched: 0 };
  }
  if (!Array.isArray(templates) || templates.length === 0) {
    return { upserted: 0, modified: 0, matched: 0 };
  }

  const operations = templates.map((addon) => ({
    updateOne: {
      filter: {
        cartId: cartObjectId,
        name: String(addon.name || "").trim(),
      },
      update: {
        $set: {
          description: String(addon.description || ""),
          price: Number(addon.price) || 0,
          icon: addon.icon || "",
          sortOrder: Number(addon.sortOrder) || 0,
          isAvailable: addon.isAvailable !== false,
          cartId: cartObjectId,
          franchiseId: franchiseObjectId,
        },
        $setOnInsert: {
          createdAt: new Date(),
        },
      },
      upsert: true,
    },
  }));

  const bulkResult = await Addon.bulkWrite(operations, { ordered: false });
  return {
    upserted: Number(bulkResult?.upsertedCount || 0),
    modified: Number(bulkResult?.modifiedCount || 0),
    matched: Number(bulkResult?.matchedCount || 0),
  };
};

const pushGlobalAddonsToFranchise = async (franchiseId) => {
  const franchiseObjectId = toObjectId(franchiseId);
  if (!franchiseObjectId) {
    return {
      success: false,
      message: "Invalid franchiseId for add-on push",
      cartsUpdated: 0,
      templatesFound: 0,
      upserted: 0,
      modified: 0,
    };
  }

  const templates = await getGlobalAddonTemplates();
  if (templates.length === 0) {
    return {
      success: false,
      message: "No global add-ons found to push",
      cartsUpdated: 0,
      templatesFound: 0,
      upserted: 0,
      modified: 0,
    };
  }

  const carts = await User.find({
    role: "admin",
    franchiseId: franchiseObjectId,
  })
    .select("_id")
    .lean();

  let cartsUpdated = 0;
  let upserted = 0;
  let modified = 0;

  for (const cart of carts) {
    const syncResult = await syncAddonTemplatesToCart({
      cartAdminId: cart._id,
      franchiseId: franchiseObjectId,
      templates,
    });
    cartsUpdated += 1;
    upserted += syncResult.upserted;
    modified += syncResult.modified;
  }

  return {
    success: true,
    message: "Global add-ons pushed to franchise carts",
    cartsUpdated,
    templatesFound: templates.length,
    upserted,
    modified,
  };
};

const pushGlobalAddonsToCafe = async (cartId) => {
  const cartObjectId = toObjectId(cartId);
  if (!cartObjectId) {
    return {
      success: false,
      message: "Invalid cartId for add-on push",
      cartsUpdated: 0,
      templatesFound: 0,
      upserted: 0,
      modified: 0,
    };
  }

  const cart = await User.findOne({ _id: cartObjectId, role: "admin" })
    .select("_id franchiseId")
    .lean();
  if (!cart || !cart.franchiseId) {
    return {
      success: false,
      message: "Target cart or franchise not found for add-on push",
      cartsUpdated: 0,
      templatesFound: 0,
      upserted: 0,
      modified: 0,
    };
  }

  const templates = await getGlobalAddonTemplates();
  if (templates.length === 0) {
    return {
      success: false,
      message: "No global add-ons found to push",
      cartsUpdated: 0,
      templatesFound: 0,
      upserted: 0,
      modified: 0,
    };
  }

  const syncResult = await syncAddonTemplatesToCart({
    cartAdminId: cart._id,
    franchiseId: cart.franchiseId,
    templates,
  });

  return {
    success: true,
    message: "Global add-ons pushed to cart",
    cartsUpdated: 1,
    templatesFound: templates.length,
    upserted: syncResult.upserted,
    modified: syncResult.modified,
  };
};

// Get default menu (franchise admin gets their franchise menu, super admin gets global)
exports.getDefaultMenu = async (req, res) => {
  try {
    if (!["super_admin", "franchise_admin"].includes(req.user.role)) {
      return res.status(403).json({ message: "Access denied. Admin only." });
    }

    // Franchise admin gets their franchise menu, super admin gets global (null franchiseId)
    const franchiseId = req.user.role === "franchise_admin" ? req.user._id : null;
    
    const defaultMenu = await DefaultMenu.getDefaultMenu(franchiseId);
    
    // If menu doesn't exist, return null (don't auto-create)
    if (!defaultMenu) {
      return res.json(null);
    }
    
    // Verify menu structure
    const categoryCount = defaultMenu.categories?.length || 0;
    const totalItems = defaultMenu.categories 
      ? defaultMenu.categories.reduce((sum, cat) => sum + (cat.items ? cat.items.length : 0), 0)
      : 0;
    
    // Ensure categories array exists
    if (!defaultMenu.categories) {
      defaultMenu.categories = [];
    }
    
    // Ensure each category has items array
    defaultMenu.categories.forEach((cat, idx) => {
      if (!cat.items) {
        cat.items = [];
      }
    });
    
    return res.json(defaultMenu);
  } catch (err) {
    console.error('[DEFAULT MENU] Error fetching menu:', err);
    return res.status(500).json({ message: err.message });
  }
};

// Delete default menu (franchise admin deletes their franchise menu, super admin deletes global)
exports.deleteDefaultMenu = async (req, res) => {
  try {
    if (!["super_admin", "franchise_admin"].includes(req.user.role)) {
      return res.status(403).json({ message: "Access denied. Admin only." });
    }

    // Franchise admin deletes their franchise menu, super admin deletes global
    const franchiseId = req.user.role === "franchise_admin" ? req.user._id : null;
    
    // Build query to find the menu
    const query = { isActive: true };
    if (franchiseId !== null) {
      query.franchiseId = franchiseId;
    } else {
      query.franchiseId = null;
    }
    
    // Find and delete the menu
    const deletedMenu = await DefaultMenu.findOneAndDelete(query);
    
    if (!deletedMenu) {
      return res.status(404).json({ message: "Default menu not found" });
    }
    
    
    return res.json({ 
      message: "Default menu deleted successfully",
      deletedMenuId: deletedMenu._id 
    });
  } catch (err) {
    console.error('[DEFAULT MENU] Error deleting menu:', err);
    return res.status(500).json({ message: err.message });
  }
};

// Update default menu (franchise admin updates their franchise menu, super admin updates global)
exports.updateDefaultMenu = async (req, res) => {
  try {
    if (!["super_admin", "franchise_admin"].includes(req.user.role)) {
      return res.status(403).json({ message: "Access denied. Admin only." });
    }

    const { categories } = req.body;

    if (!Array.isArray(categories)) {
      return res.status(400).json({ message: "Categories must be an array" });
    }

    // Franchise admin gets their franchise menu, super admin gets global
    const franchiseId = req.user.role === "franchise_admin" ? req.user._id : null;
    
    // CRITICAL: Get menu as mongoose document (not lean) so we can save it
    // Build query to find the menu
    const query = { isActive: true };
    if (franchiseId !== null) {
      query.franchiseId = franchiseId;
    } else {
      query.franchiseId = null;
    }
    
    // CRITICAL: Each franchise should have ONLY ONE default menu
    // Check if there are multiple menus for this franchise (shouldn't happen, but cleanup if it does)
    const menuCount = await DefaultMenu.countDocuments(query);
    if (menuCount > 1) {
      
      // Get all menus for this franchise
      const allMenus = await DefaultMenu.find(query).sort({ updatedAt: -1, version: -1 }).lean();
      
      // Keep the first (latest) one, delete the rest
      const menuToKeep = allMenus[0];
      const menusToDelete = allMenus.slice(1);
      
      if (menusToDelete.length > 0) {
        const idsToDelete = menusToDelete.map(m => m._id);
        await DefaultMenu.deleteMany({ _id: { $in: idsToDelete } });
      }
      
      // Now get the menu we kept (as mongoose document for saving)
      defaultMenu = await DefaultMenu.findById(menuToKeep._id);
    } else {
      // Get the menu document (not lean) for saving
      defaultMenu = await DefaultMenu.findOne(query)
        .sort({ updatedAt: -1, version: -1 });
    }
    
    if (!defaultMenu) {
      // Create new UNIQUE menu for this franchise
      defaultMenu = await DefaultMenu.create({
        franchiseId: franchiseId,
        isActive: true,
        categories: [],
        version: 1,
      });
    } else {
    }
    
    // CRITICAL: Validate and log incoming data
    
    // Validate each category and count items
    let totalItemsReceived = 0;
    categories.forEach((cat, idx) => {
      const itemCount = cat.items ? cat.items.length : 0;
      totalItemsReceived += itemCount;
      
      if (cat.items && cat.items.length > 0) {
        cat.items.forEach((item, itemIdx) => {
        });
      } else {
      }
    });
    
    // Count items before update
    const oldItemCount = defaultMenu.categories 
      ? defaultMenu.categories.reduce((sum, cat) => sum + (cat.items ? cat.items.length : 0), 0)
      : 0;
    
    // CRITICAL: Ensure categories have proper structure with items arrays
    const validatedCategories = categories.map(cat => ({
      name: (cat.name || '').trim(),
      description: (cat.description || '').trim(),
      icon: (cat.icon || '').trim(),
      sortOrder: cat.sortOrder || 0,
      isActive: cat.isActive !== false,
      items: Array.isArray(cat.items) ? cat.items.map(item => ({
        name: (item.name || '').trim(),
        description: (item.description || '').trim(),
        price: Number(item.price) || 0,
        image: decodeImageUrl(item.image), // Decode HTML entities in image URL
        spiceLevel: item.spiceLevel || 'NONE',
        isAvailable: item.isAvailable !== false,
        isFeatured: item.isFeatured || false,
        sortOrder: item.sortOrder || 0,
        tags: Array.isArray(item.tags) ? item.tags : [],
        allergens: Array.isArray(item.allergens) ? item.allergens : [],
        calories: item.calories ? Number(item.calories) : undefined,
      })) : []
    }));
    
    // Update menu data with validated categories
    defaultMenu.categories = validatedCategories;
    defaultMenu.lastUpdatedBy = req.user._id;
    defaultMenu.version = (defaultMenu.version || 0) + 1;
    defaultMenu.updatedAt = new Date(); // Ensure updatedAt is set
    
    // Count items after update
    const newItemCount = validatedCategories.reduce((sum, cat) => sum + (cat.items ? cat.items.length : 0), 0);
    
    
    await defaultMenu.save();
    
    // CRITICAL: Verify saved data by reading from database
    const savedMenu = await DefaultMenu.findById(defaultMenu._id).lean();
    const savedItemCount = savedMenu.categories 
      ? savedMenu.categories.reduce((sum, cat) => sum + (cat.items ? cat.items.length : 0), 0)
      : 0;
    
    
    // Log each category and item count from saved menu, including images
    if (savedMenu.categories && savedMenu.categories.length > 0) {
      savedMenu.categories.forEach((cat, idx) => {
        const itemCount = cat.items ? cat.items.length : 0;
        if (itemCount === 0) {
        } else if (cat.items) {
          // Verify images are present in saved items
          cat.items.forEach((item, itemIdx) => {
            if (item.image && item.image.trim()) {
            } else {
            }
          });
        }
      });
    }
    
    if (savedItemCount !== newItemCount) {
      console.error(`[DEFAULT MENU] ❌ ERROR: Item count mismatch! Expected ${newItemCount} but saved ${savedItemCount}`);
    }

    // If franchise admin, automatically update all cafes under this franchise
    // CRITICAL: This ensures all carts under this franchise get the EXACT menu the franchise admin just saved
    if (req.user.role === "franchise_admin" && franchiseId) {
      try {
        
        const result = await pushDefaultMenuToFranchise(franchiseId, franchiseId, true); // true = replace mode (clean sync)
        
      } catch (err) {
        console.error("[DEFAULT MENU] ❌ Error auto-updating carts:", err);
        console.error("[DEFAULT MENU] Error details:", err.message);
        // Don't fail the save if auto-update fails, but log it
        // Carts will sync when they're created or when menu page is opened
      }
    }

    // Sync default menu updates to costing menu items
    try {
      const { syncDefaultMenuToCosting } = require("../services/costing-v2/syncDefaultMenuToCosting");
      const syncResult = await syncDefaultMenuToCosting(franchiseId);
      if (syncResult.success && syncResult.updated > 0) {
        console.log(`[DEFAULT MENU] ✅ Synced ${syncResult.updated} costing menu items with updated prices`);
      } else if (syncResult.errors && syncResult.errors.length > 0) {
        console.warn(`[DEFAULT MENU] ⚠️ Some costing items failed to sync:`, syncResult.errors);
      }
    } catch (syncError) {
      console.error("[DEFAULT MENU] ❌ Error syncing to costing:", syncError);
      // Don't fail the menu update if costing sync fails
    }

    // Return the saved menu (convert to plain object for response)
    const responseMenu = defaultMenu.toObject ? defaultMenu.toObject() : defaultMenu;

    return res.json({
      message: `Default menu updated successfully. This is your franchise's UNIQUE menu. All carts under your franchise have been automatically updated with this EXACT menu.`,
      defaultMenu: responseMenu,
      categoriesCount: validatedCategories.length,
      itemsCount: newItemCount,
      savedItemsCount: savedItemCount,
      note: "Each franchise has ONE unique default menu. All carts under your franchise will have this exact menu.",
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Push default menu to a specific franchise (super admin or franchise admin)
exports.pushToFranchise = async (req, res) => {
  try {
    const { franchiseId } = req.params;

    // Franchise admin can only push to their own franchise
    if (req.user.role === "franchise_admin") {
      if (franchiseId !== req.user._id.toString()) {
        return res.status(403).json({ message: "Access denied. You can only push to your own franchise." });
      }
    } else if (req.user.role !== "super_admin") {
      return res.status(403).json({ message: "Access denied. Admin only." });
    }

    const franchise = await User.findById(franchiseId);
    if (!franchise || franchise.role !== "franchise_admin") {
      return res.status(404).json({ message: "Franchise not found" });
    }

    // For Super Admin: First copy GLOBAL menu to franchise's DefaultMenu
    if (req.user.role === "super_admin") {
      
      // Get the global default menu (franchiseId = null)
      const globalMenu = await DefaultMenu.getDefaultMenu(null);
      
      if (!globalMenu || !globalMenu.categories || globalMenu.categories.length === 0) {
        return res.status(400).json({ 
          message: "No global default menu found. Please create a global menu first." 
        });
      }

      // Create or update the franchise's DefaultMenu with global menu data
      // CRITICAL: Preserve all item fields including images
      const franchiseMenuUpdate = {
        categories: globalMenu.categories.map(cat => ({
          name: cat.name || '',
          description: cat.description || '',
          icon: cat.icon || '',
          sortOrder: cat.sortOrder || 0,
          isActive: cat.isActive !== false,
          items: (cat.items || []).map(item => {
            const plainItem = item.toObject ? item.toObject() : item;
            return {
              name: plainItem.name || '',
              description: plainItem.description || '',
              price: Number(plainItem.price) || 0,
              image: decodeImageUrl(plainItem.image), // CRITICAL: Preserve decoded image URL
              spiceLevel: plainItem.spiceLevel || 'NONE',
              isAvailable: plainItem.isAvailable !== false,
              isFeatured: plainItem.isFeatured || false,
              sortOrder: plainItem.sortOrder || 0,
              tags: Array.isArray(plainItem.tags) ? plainItem.tags : [],
              allergens: Array.isArray(plainItem.allergens) ? plainItem.allergens : [],
              calories: plainItem.calories ? Number(plainItem.calories) : undefined,
            };
          })
        })),
        version: (globalMenu.version || 0) + 1,
        updatedAt: new Date()
      };
      
      // Log image data being copied
      const totalItems = franchiseMenuUpdate.categories.reduce((sum, cat) => sum + (cat.items ? cat.items.length : 0), 0);
      const itemsWithImages = franchiseMenuUpdate.categories.reduce((sum, cat) => {
        return sum + (cat.items ? cat.items.filter(item => item.image && item.image.trim()).length : 0);
      }, 0);

      await DefaultMenu.findOneAndUpdate(
        { franchiseId: new mongoose.Types.ObjectId(franchiseId), isActive: true },
        { 
          $set: franchiseMenuUpdate,
          $setOnInsert: { 
            franchiseId: new mongoose.Types.ObjectId(franchiseId),
            isActive: true,
            createdAt: new Date()
          }
        },
        { upsert: true, new: true }
      );

    }

    // Now push the franchise's menu to all their carts
    // For franchise admin: uses their own menu
    // For super admin: uses the menu we just copied above
    const result = await pushDefaultMenuToFranchise(franchiseId, franchiseId, true);

    let addonsResult = null;
    if (req.user.role === "super_admin") {
      addonsResult = await pushGlobalAddonsToFranchise(franchiseId);
    }
    
    return res.json({
      message: req.user.role === "super_admin" 
        ? "Global menu copied to franchise and pushed to all carts successfully" 
        : "Default menu updated for all carts successfully (previous menus replaced)",
      ...result,
      addonsResult,
    });
  } catch (err) {
    console.error("[DEFAULT MENU] Error in pushToFranchise:", err);
    return res.status(500).json({ message: err.message || "Failed to push menu to franchise" });
  }
};

// Push default menu to a specific cafe (franchise admin can push to cafes under their franchise)
exports.pushToCafe = async (req, res) => {
  try {
    const { cartId } = req.params;

    const cafe = await User.findById(cartId);
    if (!cafe || cafe.role !== "admin") {
      return res.status(404).json({ message: "Cafe not found" });
    }

    // Franchise admin can only push to cafes under their franchise
    if (req.user.role === "franchise_admin") {
      if (!cafe.franchiseId || cafe.franchiseId.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: "Access denied. This cafe does not belong to your franchise." });
      }
    } else if (req.user.role !== "super_admin") {
      return res.status(403).json({ message: "Access denied. Admin only." });
    }

    const franchiseId = req.user.role === "franchise_admin" ? req.user._id : null;
    // Use replace mode to replace existing menu
    const result = await pushDefaultMenuToCafe(cartId, franchiseId, true);

    let addonsResult = null;
    if (req.user.role === "super_admin") {
      addonsResult = await pushGlobalAddonsToCafe(cartId);
    }

    return res.json({
      message: "Default menu updated for cafe successfully (previous menu replaced)",
      ...result,
      addonsResult,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Helper function to push default menu to a franchise (and all its cafes)
async function pushDefaultMenuToFranchise(franchiseId, requestingFranchiseId = null, replaceMode = false) {
  try {
    
    // Normalize IDs to strings for comparison
    const franchiseIdStr = franchiseId ? franchiseId.toString() : null;
    const requestingFranchiseIdStr = requestingFranchiseId ? requestingFranchiseId.toString() : null;
    
    // Use the franchise's own default menu (franchiseId), or global menu if super admin (null)
    // If requesting user is the same franchise, use their menu; otherwise use global (super admin case)
    const menuFranchiseId = (requestingFranchiseIdStr && franchiseIdStr && requestingFranchiseIdStr === franchiseIdStr) ? franchiseIdStr : null;
    
    const defaultMenu = await DefaultMenu.getDefaultMenu(menuFranchiseId);

    if (!defaultMenu.categories || defaultMenu.categories.length === 0) {
      return {
        success: false,
        message: "No default menu found. Please create a default menu first.",
        cafesUpdated: 0,
        categoriesCreated: 0,
        itemsCreated: 0,
      };
    }

    // Get all cafes under this franchise - use ObjectId for query
    const franchiseObjectId = typeof franchiseId === 'string' ? new mongoose.Types.ObjectId(franchiseId) : franchiseId;
    const cafes = await User.find({
      role: "admin",
      franchiseId: franchiseObjectId,
    });


    let totalCafesUpdated = 0;
    let totalCategoriesCreated = 0;
    let totalItemsCreated = 0;

    for (const cafe of cafes) {
      try {
        // Use the franchise's menu ID (not null, use the actual franchiseId)
        const result = await pushDefaultMenuToCafe(cafe._id, franchiseIdStr, replaceMode);
        if (result.success) {
          totalCafesUpdated++;
          totalCategoriesCreated += result.categoriesCreated;
          totalItemsCreated += result.itemsCreated;
        } else {
        }
      } catch (cafeErr) {
        console.error(`[DEFAULT MENU] Error pushing to cafe ${cafe.cartName || cafe._id}:`, cafeErr);
        // Continue with other cafes even if one fails
      }
    }

    return {
      success: true,
      cafesUpdated: totalCafesUpdated,
      categoriesCreated: totalCategoriesCreated,
      itemsCreated: totalItemsCreated,
    };
  } catch (error) {
    console.error(`[DEFAULT MENU] Error pushing to franchise ${franchiseId}:`, error);
    throw error;
  }
}

// Helper function to push default menu to a cafe
// CRITICAL: This function should only be called once per sync operation to prevent duplicates
// AUTOMATIC CLEANUP: Always cleans up duplicates and old data before syncing
// SYNC LOCK: Prevents concurrent syncs for the same cafe
async function pushDefaultMenuToCafe(cartId, franchiseId = null, replaceMode = false) {
  const cartIdStr = cartId.toString();
  
  // CRITICAL: Check if sync was recently completed (within cooldown period)
  // BUT: Skip cooldown if replaceMode is true (force sync for new carts or manual updates)
  const lastSync = lastSyncTime.get(cartIdStr);
  if (lastSync && !replaceMode) {
    const timeSinceLastSync = Date.now() - lastSync;
    if (timeSinceLastSync < SYNC_COOLDOWN_MS) {
      const remainingSeconds = Math.ceil((SYNC_COOLDOWN_MS - timeSinceLastSync) / 1000);
      return {
        success: true,
        message: `Sync skipped - menu was recently synced (${remainingSeconds}s ago)`,
        categoriesCreated: 0,
        itemsCreated: 0,
        finalCategoryCount: 0,
        finalItemCount: 0,
        skipped: true,
      };
    }
  }
  
  // If replaceMode is true, clear cooldown to allow forced sync
  if (replaceMode && lastSync) {
    lastSyncTime.delete(cartIdStr);
  }
  
  // Check if sync is already in progress for this cafe
  if (syncLocks.has(cartIdStr)) {
    try {
      await syncLocks.get(cartIdStr);
      
      // After waiting, check cooldown again
      const lastSyncAfterWait = lastSyncTime.get(cartIdStr);
      if (lastSyncAfterWait) {
        const timeSinceLastSync = Date.now() - lastSyncAfterWait;
        if (timeSinceLastSync < SYNC_COOLDOWN_MS) {
          const remainingSeconds = Math.ceil((SYNC_COOLDOWN_MS - timeSinceLastSync) / 1000);
          return {
            success: true,
            message: `Sync skipped - menu was recently synced (${remainingSeconds}s ago)`,
            categoriesCreated: 0,
            itemsCreated: 0,
            finalCategoryCount: 0,
            finalItemCount: 0,
            skipped: true,
          };
        }
      }
      
      // If cooldown passed, continue with sync
    } catch (err) {
      console.error(`[DEFAULT MENU] Previous sync failed:`, err);
      // Continue with new sync if previous failed
    }
  }
  
  // Create sync promise and lock
  const syncPromise = (async () => {
    try {
    
    // CRITICAL: AGGRESSIVE CLEANUP - Delete ALL existing menu data FIRST
    // This ensures we start completely fresh, preventing any duplicates
    // CRITICAL: Each cart must have UNIQUE menu data - no sharing between carts
    
    // CRITICAL: Convert cartId to ObjectId to ensure proper query matching
    const cafeObjectId = mongoose.Types.ObjectId.isValid(cartId) 
      ? (typeof cartId === 'string' ? new mongoose.Types.ObjectId(cartId) : cartId)
      : cartId;
    
    
    // STEP 1: Find ALL existing categories using ALL possible query formats
    // This ensures we catch everything, regardless of how cartId was stored
    // Support both cartId (new) and cafeId (old) for backward compatibility
    const categories1 = await MenuCategory.find({ cartId: cafeObjectId }).lean();
    const categories2 = await MenuCategory.find({ cartId: cartIdStr }).lean();
    const categories3 = await MenuCategory.find({ cartId: cartId }).lean();
    const categories4 = await MenuCategory.find({ cafeId: cafeObjectId }).lean(); // Old format
    const categories5 = await MenuCategory.find({ cafeId: cartIdStr }).lean(); // Old format
    const categories6 = await MenuCategory.find({ cafeId: cartId }).lean(); // Old format
    
    // Combine and deduplicate
    const allExistingCategories = [];
    const seenCategoryIds = new Set();
    [...categories1, ...categories2, ...categories3, ...categories4, ...categories5, ...categories6].forEach(cat => {
      const catId = cat._id.toString();
      if (!seenCategoryIds.has(catId)) {
        seenCategoryIds.add(catId);
        allExistingCategories.push(cat);
      }
    });
    
    const allCategoryIds = allExistingCategories.map(cat => cat._id);
    
    if (allExistingCategories.length > 0) {
    }
    
    // STEP 2: Find ALL existing items using ALL possible query formats
    // Support both cartId (new) and cafeId (old) for backward compatibility
    const items1 = await MenuItem.find({ cartId: cafeObjectId }).lean();
    const items2 = await MenuItem.find({ cartId: cartIdStr }).lean();
    const items3 = await MenuItem.find({ cartId: cartId }).lean();
    const items4 = await MenuItem.find({ cafeId: cafeObjectId }).lean(); // Old format
    const items5 = await MenuItem.find({ cafeId: cartIdStr }).lean(); // Old format
    const items6 = await MenuItem.find({ cafeId: cartId }).lean(); // Old format
    const itemsByCategory = allCategoryIds.length > 0 
      ? await MenuItem.find({ category: { $in: allCategoryIds } }).lean()
      : [];
    
    // Combine and deduplicate
    const allExistingItems = [];
    const seenItemIds = new Set();
    [...items1, ...items2, ...items3, ...items4, ...items5, ...items6, ...itemsByCategory].forEach(item => {
      const itemId = item._id.toString();
      if (!seenItemIds.has(itemId)) {
        seenItemIds.add(itemId);
        allExistingItems.push(item);
      }
    });
    
    
    // STEP 3: Delete ALL items using multiple strategies
    
    // Delete by category IDs first (catches items linked to categories)
    if (allCategoryIds.length > 0) {
      const deletedItemsByCat = await MenuItem.deleteMany({ category: { $in: allCategoryIds } });
    }
    
    // Delete by cartId using $or query (catches all formats at once)
    // Support both cartId (new) and cafeId (old) for backward compatibility
    const deletedItemsOr = await MenuItem.deleteMany({ 
      $or: [
        { cartId: cafeObjectId },
        { cartId: cartIdStr },
        { cartId: cartId },
        { cafeId: cafeObjectId }, // Old format
        { cafeId: cartIdStr }, // Old format
        { cafeId: cartId } // Old format
      ]
    });
    
    // Also delete individually to be absolutely sure
    const deletedItems1 = await MenuItem.deleteMany({ cartId: cafeObjectId });
    const deletedItems2 = await MenuItem.deleteMany({ cartId: cartIdStr });
    const deletedItems3 = await MenuItem.deleteMany({ cartId: cartId });
    const deletedItems4 = await MenuItem.deleteMany({ cafeId: cafeObjectId }); // Old format
    const deletedItems5 = await MenuItem.deleteMany({ cafeId: cartIdStr }); // Old format
    const deletedItems6 = await MenuItem.deleteMany({ cafeId: cartId }); // Old format
    
    // STEP 4: Delete ALL categories using multiple strategies
    
    // Delete by cartId using $or query (catches all formats at once)
    // Support both cartId (new) and cafeId (old) for backward compatibility
    const deletedCatsOr = await MenuCategory.deleteMany({ 
      $or: [
        { cartId: cafeObjectId },
        { cartId: cartIdStr },
        { cartId: cartId },
        { cafeId: cafeObjectId }, // Old format
        { cafeId: cartIdStr }, // Old format
        { cafeId: cartId } // Old format
      ]
    });
    
    // Also delete individually to be absolutely sure
    const deletedCats1 = await MenuCategory.deleteMany({ cartId: cafeObjectId });
    const deletedCats2 = await MenuCategory.deleteMany({ cartId: cartIdStr });
    const deletedCats3 = await MenuCategory.deleteMany({ cartId: cartId });
    const deletedCats4 = await MenuCategory.deleteMany({ cafeId: cafeObjectId }); // Old format
    const deletedCats5 = await MenuCategory.deleteMany({ cafeId: cartIdStr }); // Old format
    const deletedCats6 = await MenuCategory.deleteMany({ cafeId: cartId }); // Old format
    
    // Wait to ensure deletion is committed to database
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // CRITICAL: Verify ALL data is deleted using all possible formats
    // Support both cartId (new) and cafeId (old) for backward compatibility
    const remainingItems1 = await MenuItem.countDocuments({ cartId: cafeObjectId });
    const remainingItems2 = await MenuItem.countDocuments({ cartId: cartIdStr });
    const remainingItems3 = await MenuItem.countDocuments({ cafeId: cafeObjectId }); // Old format
    const remainingItems4 = await MenuItem.countDocuments({ cafeId: cartIdStr }); // Old format
    const remainingCategories1 = await MenuCategory.countDocuments({ cartId: cafeObjectId });
    const remainingCategories2 = await MenuCategory.countDocuments({ cartId: cartIdStr });
    const remainingCategories3 = await MenuCategory.countDocuments({ cafeId: cafeObjectId }); // Old format
    const remainingCategories4 = await MenuCategory.countDocuments({ cafeId: cartIdStr }); // Old format
    
    const totalRemainingItems = Math.max(remainingItems1, remainingItems2, remainingItems3, remainingItems4);
    const totalRemainingCategories = Math.max(remainingCategories1, remainingCategories2, remainingCategories3, remainingCategories4);
    
    if (totalRemainingItems > 0 || totalRemainingCategories > 0) {
      console.error(`[DEFAULT MENU] ❌ ERROR: Still have ${totalRemainingItems} items and ${totalRemainingCategories} categories after cleanup!`);
      console.error(`[DEFAULT MENU] Attempting FORCE DELETE with all query formats...`);
      
      // Force delete everything using all possible formats
      // Support both cartId (new) and cafeId (old) for backward compatibility
      await MenuItem.deleteMany({ 
        $or: [
          { cartId: cafeObjectId },
          { cartId: cartIdStr },
          { cartId: cartId },
          { cafeId: cafeObjectId }, // Old format
          { cafeId: cartIdStr }, // Old format
          { cafeId: cartId } // Old format
        ]
      });
      
      await MenuCategory.deleteMany({ 
        $or: [
          { cartId: cafeObjectId },
          { cartId: cartIdStr },
          { cartId: cartId },
          { cafeId: cafeObjectId }, // Old format
          { cafeId: cartIdStr }, // Old format
          { cafeId: cartId } // Old format
        ]
      });
      
      // Also delete any items that might be orphaned
      if (allCategoryIds.length > 0) {
        await MenuItem.deleteMany({ category: { $in: allCategoryIds } });
      }
      
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Final check with all formats
      // Support both cartId (new) and cafeId (old) for backward compatibility
      const finalRemainingItems1 = await MenuItem.countDocuments({ cartId: cafeObjectId });
      const finalRemainingItems2 = await MenuItem.countDocuments({ cartId: cartIdStr });
      const finalRemainingItems3 = await MenuItem.countDocuments({ cafeId: cafeObjectId }); // Old format
      const finalRemainingItems4 = await MenuItem.countDocuments({ cafeId: cartIdStr }); // Old format
      const finalRemainingCategories1 = await MenuCategory.countDocuments({ cartId: cafeObjectId });
      const finalRemainingCategories2 = await MenuCategory.countDocuments({ cartId: cartIdStr });
      const finalRemainingCategories3 = await MenuCategory.countDocuments({ cafeId: cafeObjectId }); // Old format
      const finalRemainingCategories4 = await MenuCategory.countDocuments({ cafeId: cartIdStr }); // Old format
      
      const finalTotalRemainingItems = Math.max(finalRemainingItems1, finalRemainingItems2, finalRemainingItems3, finalRemainingItems4);
      const finalTotalRemainingCategories = Math.max(finalRemainingCategories1, finalRemainingCategories2, finalRemainingCategories3, finalRemainingCategories4);
      
      if (finalTotalRemainingItems > 0 || finalTotalRemainingCategories > 0) {
        console.error(`[DEFAULT MENU] ❌ CRITICAL: Force delete failed!`);
        console.error(`[DEFAULT MENU] Remaining items: ${finalTotalRemainingItems} (ObjectId: ${finalRemainingItems1}, String: ${finalRemainingItems2})`);
        console.error(`[DEFAULT MENU] Remaining categories: ${finalTotalRemainingCategories} (ObjectId: ${finalRemainingCategories1}, String: ${finalRemainingCategories2})`);
        
        // Try one more time with collection-level delete
        const MenuItemCollection = MenuItem.collection;
        const MenuCategoryCollection = MenuCategory.collection;
        
        // Support both cartId (new) and cafeId (old) for backward compatibility
        await MenuItemCollection.deleteMany({ cartId: cafeObjectId });
        await MenuItemCollection.deleteMany({ cartId: cartIdStr });
        await MenuItemCollection.deleteMany({ cafeId: cafeObjectId }); // Old format
        await MenuItemCollection.deleteMany({ cafeId: cartIdStr }); // Old format
        await MenuCategoryCollection.deleteMany({ cartId: cafeObjectId });
        await MenuCategoryCollection.deleteMany({ cartId: cartIdStr });
        await MenuCategoryCollection.deleteMany({ cafeId: cafeObjectId }); // Old format
        await MenuCategoryCollection.deleteMany({ cafeId: cartIdStr }); // Old format
        
        await new Promise(resolve => setTimeout(resolve, 300));
        
        const ultimateRemainingItems = await MenuItem.countDocuments({ 
          $or: [
            { cartId: cafeObjectId }, 
            { cartId: cartIdStr },
            { cafeId: cafeObjectId }, // Old format
            { cafeId: cartIdStr } // Old format
          ] 
        });
        const ultimateRemainingCategories = await MenuCategory.countDocuments({ 
          $or: [
            { cartId: cafeObjectId }, 
            { cartId: cartIdStr },
            { cafeId: cafeObjectId }, // Old format
            { cafeId: cartIdStr } // Old format
          ] 
        });
        
        if (ultimateRemainingItems > 0 || ultimateRemainingCategories > 0) {
          throw new Error(`CRITICAL: Failed to delete all menu data after multiple attempts. Still have ${ultimateRemainingItems} items and ${ultimateRemainingCategories} categories.`);
        }
      }
    }
    
    
    // CRITICAL: Verify cleanup worked - check one more time
    // Support both cartId (new) and cafeId (old) for backward compatibility
    const finalCleanupCheckItems = await MenuItem.countDocuments({ 
      $or: [
        { cartId: cafeObjectId }, 
        { cartId: cartIdStr },
        { cafeId: cafeObjectId }, // Old format
        { cafeId: cartIdStr } // Old format
      ] 
    });
    const finalCleanupCheckCategories = await MenuCategory.countDocuments({ 
      $or: [
        { cartId: cafeObjectId }, 
        { cartId: cartIdStr },
        { cafeId: cafeObjectId }, // Old format
        { cafeId: cartIdStr } // Old format
      ] 
    });
    
    if (finalCleanupCheckItems > 0 || finalCleanupCheckCategories > 0) {
      console.error(`[DEFAULT MENU] ❌ CRITICAL: Cleanup verification failed!`);
      console.error(`[DEFAULT MENU] Still have ${finalCleanupCheckItems} items and ${finalCleanupCheckCategories} categories`);
      throw new Error(`Cleanup failed: Cannot proceed with sync. Still have ${finalCleanupCheckItems} items and ${finalCleanupCheckCategories} categories.`);
    }
    
    
    // Get cafe's franchise to use their default menu
    const cafe = await User.findById(cartId);
    
    if (!cafe) {
      throw new Error(`Cafe with ID ${cartId} not found`);
    }
    
    // CRITICAL: Log cart info to ensure we're syncing the right cart
    
    // Determine which franchise menu to use
    // CRITICAL: Always use the cafe's franchise menu, never fall back to global menu
    // CRITICAL: NEVER copy menu from another cart - ALWAYS get from franchise default menu
    // Priority: 1) passed franchiseId, 2) cafe's franchiseId
    // If no franchiseId is available, throw error (don't use global menu)
    let menuFranchiseId = null;
    if (franchiseId !== null && franchiseId !== undefined && franchiseId !== '') {
      menuFranchiseId = franchiseId.toString();
    } else if (cafe?.franchiseId) {
      menuFranchiseId = cafe.franchiseId.toString();
    }
    
    // CRITICAL: Do not allow using global menu (null) for carts
    // Carts must always use their franchise's menu
    if (!menuFranchiseId) {
      throw new Error(`Cannot sync menu: Cart ${cafe.cartName || cartId} has no franchiseId. Cart must belong to a franchise.`);
    }
    
    // CRITICAL: Get FRESH menu from database - always get the LATEST version
    // This ensures we get the current franchise menu, not old/cached data
    // Use lean() to get plain object and avoid any mongoose caching
    // CRITICAL: Force fresh read by clearing any potential cache
    const defaultMenu = await DefaultMenu.getDefaultMenu(menuFranchiseId, true);
    
    // CRITICAL: Verify we got the menu and it has the correct franchiseId
    if (!defaultMenu) {
      throw new Error(`Failed to retrieve default menu for franchise ${menuFranchiseId}. Franchise admin must create a default menu first.`);
    }
    
    // CRITICAL: Double-check by querying database directly to ensure we have the latest
    // Convert franchiseId to ObjectId for query
    // Note: mongoose is already required earlier in this function
    const franchiseObjectId = mongoose.Types.ObjectId.isValid(menuFranchiseId) 
      ? (typeof menuFranchiseId === 'string' ? new mongoose.Types.ObjectId(menuFranchiseId) : menuFranchiseId)
      : menuFranchiseId;
    
    const directMenuCheck = await DefaultMenu.findOne({ 
      franchiseId: franchiseObjectId, 
      isActive: true 
    })
      .sort({ updatedAt: -1, version: -1 })
      .lean();
    
    if (!directMenuCheck) {
      throw new Error(`Menu not found in database for franchise ${menuFranchiseId}`);
    }
    
    // CRITICAL: Verify the menu belongs to the correct franchise (not another cart)
    const menuFranchiseIdCheck = directMenuCheck.franchiseId 
      ? directMenuCheck.franchiseId.toString() 
      : null;
    
    if (menuFranchiseIdCheck !== menuFranchiseId) {
      console.error(`[DEFAULT MENU] ❌ CRITICAL ERROR: Menu franchise mismatch!`);
      console.error(`[DEFAULT MENU] Expected franchise: ${menuFranchiseId}`);
      console.error(`[DEFAULT MENU] Menu belongs to: ${menuFranchiseIdCheck || 'GLOBAL'}`);
      throw new Error(`Menu franchise mismatch: Expected ${menuFranchiseId}, but menu belongs to ${menuFranchiseIdCheck || 'global'}`);
    }
    
    
    // Use the direct query result to ensure we have the absolute latest
    const menuPlain = directMenuCheck;
    
    // CRITICAL: Ensure categories array exists and has proper structure
    if (!menuPlain.categories || !Array.isArray(menuPlain.categories)) {
      console.error(`[DEFAULT MENU] ❌ ERROR: Menu categories is not an array! Type: ${typeof menuPlain.categories}`);
      throw new Error(`Invalid menu structure: categories must be an array`);
    }
    
    // CRITICAL: Verify each category has items array (even if empty)
    menuPlain.categories.forEach((cat, idx) => {
      if (!cat.items || !Array.isArray(cat.items)) {
        cat.items = Array.isArray(cat.items) ? cat.items : [];
      }
    });
    
    
    // Use the plain menu object for processing
    const defaultMenuProcessed = menuPlain;
    
    // Log category names and item counts to verify we're getting the CURRENT menu
    if (defaultMenuProcessed.categories && defaultMenuProcessed.categories.length > 0) {
      
      // Detailed logging for each category
      defaultMenuProcessed.categories.forEach((cat, idx) => {
        const itemCount = cat.items ? cat.items.length : 0;
        const itemNames = cat.items && cat.items.length > 0 
          ? cat.items.map(item => `"${item.name || 'NO NAME'}" (₹${item.price || 'NO PRICE'})`).join(', ')
          : 'NO ITEMS';
      });
      
      // Count total items
      const totalItems = defaultMenuProcessed.categories.reduce((sum, cat) => sum + (cat.items ? cat.items.length : 0), 0);
      
      // CRITICAL: Verify items are actually present
      if (totalItems === 0) {
        console.error(`[DEFAULT MENU] ❌ ERROR: Franchise menu has categories but NO ITEMS!`);
        console.error(`[DEFAULT MENU] This means the default menu was saved without items.`);
        console.error(`[DEFAULT MENU] Please check the franchise default menu and ensure items are saved.`);
        console.error(`[DEFAULT MENU] Menu structure:`, JSON.stringify(defaultMenuProcessed, null, 2));
      }
    } else {
    }

    // Verify this is the franchise's menu, not global menu
    const menuFranchiseIdStr = defaultMenuProcessed.franchiseId ? defaultMenuProcessed.franchiseId.toString() : null;
    if (menuFranchiseIdStr !== menuFranchiseId) {
      console.error(`[DEFAULT MENU] ERROR: Retrieved menu has wrong franchiseId. Expected: ${menuFranchiseId}, Got: ${menuFranchiseIdStr || 'null'}`);
      throw new Error(`Menu sync failed: Retrieved menu does not belong to franchise ${menuFranchiseId}`);
    }

    if (!defaultMenuProcessed.categories || defaultMenuProcessed.categories.length === 0) {
      return {
        success: false,
        message: `Franchise default menu is empty. Please create a default menu for this franchise first.`,
        categoriesCreated: 0,
        itemsCreated: 0,
      };
    }

    // NOTE: Cleanup already done above, this section is now just for verification
    // But we'll keep a final check to ensure database is clean
    
    // Final verification - should be 0 after aggressive cleanup
    // CRITICAL: Use ObjectId format for queries
    // Support both cartId (new) and cafeId (old) for backward compatibility
    const preSyncItemCount = await MenuItem.countDocuments({ 
      $or: [
        { cartId: cafeObjectId }, 
        { cartId: cartIdStr },
        { cafeId: cafeObjectId }, // Old format
        { cafeId: cartIdStr } // Old format
      ] 
    });
    const preSyncCategoryCount = await MenuCategory.countDocuments({ 
      $or: [
        { cartId: cafeObjectId }, 
        { cartId: cartIdStr },
        { cafeId: cafeObjectId }, // Old format
        { cafeId: cartIdStr } // Old format
      ] 
    });
    
    if (preSyncItemCount > 0 || preSyncCategoryCount > 0) {
      console.error(`[DEFAULT MENU] ❌ CRITICAL: Database still has data after cleanup!`);
      console.error(`[DEFAULT MENU] Items: ${preSyncItemCount}, Categories: ${preSyncCategoryCount}`);
      throw new Error(`Database cleanup failed. Cannot proceed with sync. Still have ${preSyncItemCount} items and ${preSyncCategoryCount} categories.`);
    }
    
    
    // Wait to ensure database is ready
    await new Promise(resolve => setTimeout(resolve, 100));

    let categoriesCreated = 0;
    let itemsCreated = 0;

    // CRITICAL: Log EXACTLY what we're about to create from franchise menu
    
    // CRITICAL: Check for duplicate category names in franchise menu BEFORE syncing
    const franchiseCategoryNames = new Map();
    const duplicateCategoriesInFranchiseMenu = [];
    defaultMenuProcessed.categories.forEach((cat, idx) => {
      const catName = cat.name ? cat.name.trim().toLowerCase() : '';
      if (franchiseCategoryNames.has(catName)) {
        duplicateCategoriesInFranchiseMenu.push({ index: idx, name: cat.name });
      } else {
        franchiseCategoryNames.set(catName, cat);
      }
    });
    
    if (duplicateCategoriesInFranchiseMenu.length > 0) {
      console.error(`[DEFAULT MENU] ❌ ERROR: Franchise menu has ${duplicateCategoriesInFranchiseMenu.length} duplicate category names!`);
      duplicateCategoriesInFranchiseMenu.forEach(dup => {
        console.error(`[DEFAULT MENU]   Duplicate at index ${dup.index}: "${dup.name}"`);
      });
      console.error(`[DEFAULT MENU] This will cause duplicate categories in cart. Please fix franchise menu first.`);
      // Continue anyway, but we'll skip duplicates during creation
    }
    
    let totalItemsInFranchiseMenu = 0;
    defaultMenuProcessed.categories.forEach((cat, idx) => {
      const itemCount = cat.items ? (Array.isArray(cat.items) ? cat.items.length : 0) : 0;
      totalItemsInFranchiseMenu += itemCount;
      if (cat.items && cat.items.length > 0) {
        cat.items.forEach((item, itemIdx) => {
        });
      }
    });
    
    // CRITICAL: Track categories processed in THIS sync to prevent duplicates
    let processedCategoryNames = new Set();
    
    // Process each category from default menu
    // CRITICAL: This creates NEW menu items from the franchise's CURRENT default menu
    // IMPORTANT: Process categories one at a time to avoid race conditions
    for (let i = 0; i < defaultMenuProcessed.categories.length; i++) {
      const categoryData = defaultMenuProcessed.categories[i];
      
      
      // CRITICAL: Safely extract items - ensure we get the items array properly
      // Handle both mongoose documents and plain objects
      let items = null;
      let categoryFields = {};
      
      if (categoryData && typeof categoryData === 'object') {
        // Convert to plain object if it's a mongoose document
        const plainCategory = categoryData.toObject ? categoryData.toObject() : categoryData;
        
        // Extract items array - ensure it exists and is an array
        items = plainCategory.items;
        if (items && !Array.isArray(items)) {
          items = Array.isArray(items) ? items : [];
        }
        
        // Extract all other category fields
        const { items: _, ...rest } = plainCategory;
        categoryFields = rest;
      } else {
        console.error(`[DEFAULT MENU] ❌ ERROR: Category ${i + 1} data is invalid:`, typeof categoryData);
        continue;
      }

      // Verify category data
      if (!categoryFields.name || !categoryFields.name.trim()) {
        continue;
      }
      
      const categoryNameTrimmed = categoryFields.name.trim();
      const categoryNameLower = categoryNameTrimmed.toLowerCase();
      
      // CRITICAL: Check if we've already processed this category name in THIS sync
      if (processedCategoryNames.has(categoryNameLower)) {
        console.error(`[DEFAULT MENU] ❌ DUPLICATE DETECTED: Category "${categoryNameTrimmed}" appears multiple times in franchise menu!`);
        console.error(`[DEFAULT MENU] Skipping duplicate category to prevent creating multiple categories with same name`);
        continue; // Skip this duplicate
      }
      
      // Mark this category as processed
      processedCategoryNames.add(categoryNameLower);
      
      // CRITICAL: Log items extraction for debugging
      const itemCount = items ? (Array.isArray(items) ? items.length : 0) : 0;
      if (items && items.length > 0) {
      }

      // CRITICAL: Safety check - verify category doesn't exist (shouldn't happen after cleanup)
      // This is a final safety check to prevent duplicates
      // Note: categoryNameTrimmed is already set above
      
      // Check for existing categories with same name (case-insensitive) using ObjectId format
      const existingCategoryCheck = await MenuCategory.findOne({ 
        cartId: cafeObjectId, // Use cartId instead of cafeId
        name: { $regex: new RegExp(`^${categoryNameTrimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
      });
      
      if (existingCategoryCheck) {
        console.error(`[DEFAULT MENU] ❌ CRITICAL ERROR: Category "${categoryNameTrimmed}" already exists (ID: ${existingCategoryCheck._id})!`);
        console.error(`[DEFAULT MENU] This should not happen after cleanup. Deleting it...`);
        
        // Delete all items in this category
        const deletedItems = await MenuItem.deleteMany({ category: existingCategoryCheck._id });
        
        // Delete the category
        await MenuCategory.findByIdAndDelete(existingCategoryCheck._id);
        
        // Wait to ensure deletion
        await new Promise(resolve => setTimeout(resolve, 200));
        
        // Triple-check it's deleted
        const stillExists = await MenuCategory.findById(existingCategoryCheck._id);
        if (stillExists) {
          console.error(`[DEFAULT MENU] ❌ Category still exists after deletion! Force deleting...`);
          await MenuCategory.deleteOne({ _id: existingCategoryCheck._id });
          await MenuItem.deleteMany({ category: existingCategoryCheck._id });
          await new Promise(resolve => setTimeout(resolve, 150));
        }
      }
      
      // Also check for any other categories with same name (case-insensitive) - delete ALL duplicates
      // Support both cartId (new) and cafeId (old) for backward compatibility
      const allDuplicateCategories = await MenuCategory.find({ 
        $or: [
          { cartId: cafeObjectId },
          { cafeId: cafeObjectId } // Old format
        ],
        name: { $regex: new RegExp(`^${categoryNameTrimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
      });
      
      if (allDuplicateCategories.length > 1) {
        console.error(`[DEFAULT MENU] ❌ Found ${allDuplicateCategories.length} duplicate categories with name "${categoryNameTrimmed}"!`);
        console.error(`[DEFAULT MENU] Deleting all duplicates except the first one...`);
        
        // Keep the first one, delete the rest
        const toDelete = allDuplicateCategories.slice(1);
        const duplicateIds = toDelete.map(cat => cat._id);
        
        // Delete items in duplicate categories
        await MenuItem.deleteMany({ category: { $in: duplicateIds } });
        
        // Delete duplicate categories
        await MenuCategory.deleteMany({ _id: { $in: duplicateIds } });
        
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      // Create new category from franchise default menu
      // CRITICAL: Use ObjectId format for cartId to ensure proper linking
      const category = await MenuCategory.create({
        name: categoryFields.name.trim(),
        description: (categoryFields.description || '').trim(),
        icon: (categoryFields.icon || '').trim(),
        sortOrder: categoryFields.sortOrder || 0,
        isActive: categoryFields.isActive !== false, // Default to true
        cartId: cafeObjectId, // Link to this cart (use ObjectId format) - use cartId instead of cafeId
      });
      categoriesCreated++;

      // Process items in this category from franchise default menu
      // CRITICAL: Verify items exist and are an array
      // Ensure items is always an array (even if empty)
      if (!items) {
        console.error(`[DEFAULT MENU] ❌ ERROR: Category "${categoryFields.name}" has NO items property!`);
        console.error(`[DEFAULT MENU] This means the default menu was not saved correctly.`);
        console.error(`[DEFAULT MENU] Category data structure:`, JSON.stringify(categoryFields, null, 2));
        items = []; // Set to empty array to prevent errors
      } else if (!Array.isArray(items)) {
        console.error(`[DEFAULT MENU] ❌ ERROR: Category "${categoryFields.name}" items is not an array! Type: ${typeof items}`);
        console.error(`[DEFAULT MENU] Items value:`, items);
        items = []; // Set to empty array to prevent errors
      } else if (items.length === 0) {
      } else {
        
        // Log all items before processing with full details
        items.forEach((item, idx) => {
          const itemName = item?.name || 'NO NAME';
          const itemPrice = item?.price !== undefined ? item.price : 'NO PRICE';
          const itemSpice = item?.spiceLevel || 'NONE';
          const itemImage = item?.image || 'NO IMAGE';
          
          // Validate item structure
          if (!item || typeof item !== 'object') {
            console.error(`[DEFAULT MENU]     ❌ Item ${idx + 1} is not a valid object!`);
          } else if (!item.name || !item.name.trim()) {
            console.error(`[DEFAULT MENU]     ❌ Item ${idx + 1} has no name!`);
          } else if (item.price === undefined || item.price === null) {
            console.error(`[DEFAULT MENU]     ❌ Item "${item.name}" has no price!`);
          }
        });
        
        for (let j = 0; j < items.length; j++) {
          const itemData = items[j];
          
          // CRITICAL: Verify item data structure
          if (!itemData) {
            console.error(`[DEFAULT MENU] ❌ Skipping item ${j + 1} in category "${categoryFields.name}": Item data is null/undefined`);
            continue;
          }
          
          // Convert to plain object if it's a mongoose document
          const plainItem = itemData.toObject ? itemData.toObject() : itemData;
          
          if (!plainItem || typeof plainItem !== 'object') {
            console.error(`[DEFAULT MENU] ❌ Skipping item ${j + 1} in category "${categoryFields.name}": Invalid item data type: ${typeof plainItem}`);
            continue;
          }
          
          // Validate required fields
          if (!plainItem.name || typeof plainItem.name !== 'string' || !plainItem.name.trim()) {
            console.error(`[DEFAULT MENU] ❌ Skipping item ${j + 1} in category "${categoryFields.name}": No name provided or invalid name`);
            console.error(`[DEFAULT MENU] Item data:`, JSON.stringify(plainItem, null, 2));
            continue;
          }
          
          if (plainItem.price === undefined || plainItem.price === null) {
            console.error(`[DEFAULT MENU] ❌ Skipping item "${plainItem.name}" in category "${categoryFields.name}": No price provided`);
            console.error(`[DEFAULT MENU] Item data:`, JSON.stringify(plainItem, null, 2));
            continue;
          }
          
          // Validate price is a valid number
          const priceNum = Number(plainItem.price);
          if (isNaN(priceNum) || priceNum < 0) {
            console.error(`[DEFAULT MENU] ❌ Skipping item "${plainItem.name}" in category "${categoryFields.name}": Invalid price: ${plainItem.price}`);
            continue;
          }

          // Create new item from franchise default menu
          try {
          // CRITICAL: Extract and validate image URL
          const imageUrl = decodeImageUrl(plainItem.image);
            
            // Log image extraction for debugging
            if (imageUrl) {
            } else {
            }
            
            const itemPayload = {
              name: plainItem.name.trim(),
              description: (plainItem.description || '').trim(),
              price: priceNum,
              image: imageUrl, // Use validated image URL
              spiceLevel: plainItem.spiceLevel || 'NONE',
              isAvailable: plainItem.isAvailable !== false, // Default to true
              isFeatured: plainItem.isFeatured || false,
              sortOrder: plainItem.sortOrder || 0,
              tags: Array.isArray(plainItem.tags) ? plainItem.tags : [],
              allergens: Array.isArray(plainItem.allergens) ? plainItem.allergens : [],
              category: category._id, // Link to the category we just created
              cartId: cafeObjectId, // Link to this cart (use ObjectId format) - use cartId instead of cafeId
            };
            
            // Only add calories if it's a valid number
            if (plainItem.calories !== undefined && plainItem.calories !== null) {
              const caloriesNum = Number(plainItem.calories);
              if (!isNaN(caloriesNum) && caloriesNum >= 0) {
                itemPayload.calories = caloriesNum;
              }
            }
            
            const createdItem = await MenuItem.create(itemPayload);
            itemsCreated++;
          } catch (itemErr) {
            console.error(`[DEFAULT MENU] ❌ Error creating item "${plainItem.name}" in category "${categoryFields.name}":`, itemErr.message);
            console.error(`[DEFAULT MENU] Error stack:`, itemErr.stack);
            console.error(`[DEFAULT MENU] Item data:`, JSON.stringify(plainItem, null, 2));
            // Continue with next item - don't fail entire sync for one item
          }
        }
        
        // Verify items were created - wait a moment for database to commit
        await new Promise(resolve => setTimeout(resolve, 200));
        const createdItemsCount = await MenuItem.countDocuments({ category: category._id });
        
        if (createdItemsCount !== items.length) {
          console.error(`[DEFAULT MENU] ❌ ERROR: Expected ${items.length} items but created ${createdItemsCount} for category "${categoryFields.name}"`);
          // Try to find what went wrong
          const createdItems = await MenuItem.find({ category: category._id }).lean();
          console.error(`[DEFAULT MENU] Created items:`, createdItems.map(item => item.name).join(', '));
        }
      }
    }

    // Final detailed verification - use ObjectId format for queries
    // Support both cartId (new) and cafeId (old) for backward compatibility
    const finalCategoryCount = await MenuCategory.countDocuments({ cartId: cafeObjectId });
    const finalItemCount = await MenuItem.countDocuments({ cartId: cafeObjectId });
    
    // Get final categories and items for detailed logging - use ObjectId format
    const finalCategoriesList = await MenuCategory.find({ cartId: cafeObjectId }).sort({ createdAt: 1 }).lean();
    const finalItemsList = await MenuItem.find({ cartId: cafeObjectId }).lean();
    
    
    // CRITICAL: Verify we have EXACTLY what franchise admin defined
    if (finalCategoryCount !== defaultMenuProcessed.categories.length) {
      console.error(`[DEFAULT MENU] ❌ ERROR: Category count mismatch! Expected ${defaultMenuProcessed.categories.length}, got ${finalCategoryCount}`);
    }
    if (finalItemCount !== totalItemsInFranchiseMenu) {
      console.error(`[DEFAULT MENU] ❌ ERROR: Item count mismatch! Expected ${totalItemsInFranchiseMenu}, got ${finalItemCount}`);
    }
    
    // CRITICAL: Check for duplicate categories by name (case-insensitive)
    const categoryNameMap = new Map();
    const duplicateCategories = [];
    
    finalCategoriesList.forEach((cat, idx) => {
      const normalizedName = cat.name.toLowerCase().trim();
      if (categoryNameMap.has(normalizedName)) {
        duplicateCategories.push({ name: cat.name, id: cat._id, index: idx });
      } else {
        categoryNameMap.set(normalizedName, cat);
      }
    });
    
    if (duplicateCategories.length > 0) {
      console.error(`[DEFAULT MENU] ❌ ERROR: Found ${duplicateCategories.length} duplicate categories!`);
      duplicateCategories.forEach(dup => {
        console.error(`[DEFAULT MENU]   Duplicate: "${dup.name}" (ID: ${dup.id})`);
      });
      console.error(`[DEFAULT MENU] Cleaning up duplicates...`);
      
      // Delete duplicate categories (keep the first one)
      for (const dup of duplicateCategories) {
        const dupCategory = finalCategoriesList.find(c => c._id.toString() === dup.id.toString());
        if (dupCategory) {
          // Delete items in duplicate category
          const deletedItems = await MenuItem.deleteMany({ category: dupCategory._id });
          
          // Delete duplicate category
          await MenuCategory.findByIdAndDelete(dupCategory._id);
        }
      }
      
      // Re-count after cleanup - use ObjectId format
      // Support both cartId (new) and cafeId (old) for backward compatibility
      const afterCleanupCategoryCount = await MenuCategory.countDocuments({ cartId: cafeObjectId });
      const afterCleanupItemCount = await MenuItem.countDocuments({ cartId: cafeObjectId });
    }
    
    // Log each category and its items - use ObjectId format
    const cleanedCategoriesList = await MenuCategory.find({ cartId: cafeObjectId }).sort({ createdAt: 1 }).lean();
    const cleanedItemsList = await MenuItem.find({ cartId: cafeObjectId }).lean();
    
    if (cleanedCategoriesList.length > 0) {
      cleanedCategoriesList.forEach((cat, idx) => {
        const catItems = cleanedItemsList.filter(item => item.category.toString() === cat._id.toString());
        if (catItems.length > 0) {
          catItems.forEach((item, itemIdx) => {
          });
        } else {
          console.error(`[DEFAULT MENU]     ❌ Category "${cat.name}" has NO ITEMS in database!`);
        }
      });
    }
    
    // Final count verification - use ObjectId format
    // Support both cartId (new) and cafeId (old) for backward compatibility
    const finalCategoryCountAfterCleanup = await MenuCategory.countDocuments({ cartId: cafeObjectId });
    const finalItemCountAfterCleanup = await MenuItem.countDocuments({ cartId: cafeObjectId });
    
    
    // CRITICAL: Verify we have EXACTLY what franchise admin defined
    const categoryMatch = finalCategoryCountAfterCleanup === defaultMenuProcessed.categories.length;
    const itemMatch = finalItemCountAfterCleanup === totalItemsInFranchiseMenu;
    
    if (!categoryMatch || !itemMatch) {
      console.error(`[DEFAULT MENU] ❌ ERROR: Cart menu does NOT match franchise admin's definition!`);
      console.error(`[DEFAULT MENU] Category match: ${categoryMatch ? '✅' : '❌'} (Expected: ${defaultMenuProcessed.categories.length}, Got: ${finalCategoryCountAfterCleanup})`);
      console.error(`[DEFAULT MENU] Item match: ${itemMatch ? '✅' : '❌'} (Expected: ${totalItemsInFranchiseMenu}, Got: ${finalItemCountAfterCleanup})`);
      
      if (duplicateCategories && duplicateCategories.length > 0) {
        console.error(`[DEFAULT MENU] Note: ${duplicateCategories.length} duplicates were removed during sync`);
      }
      
      // Log what's actually in the database vs what should be
      console.error(`[DEFAULT MENU] Expected categories:`);
      defaultMenuProcessed.categories.forEach((cat, idx) => {
        const itemCount = cat.items ? cat.items.length : 0;
        console.error(`[DEFAULT MENU]   ${idx + 1}. "${cat.name}" - ${itemCount} items`);
      });
      
      console.error(`[DEFAULT MENU] Actual categories in database:`);
      cleanedCategoriesList.forEach((cat, idx) => {
        const catItems = cleanedItemsList.filter(item => item.category.toString() === cat._id.toString());
        console.error(`[DEFAULT MENU]   ${idx + 1}. "${cat.name}" - ${catItems.length} items`);
      });
    } else {
    }
    
      // CRITICAL: Record sync completion time to prevent rapid re-syncs
      lastSyncTime.set(cartIdStr, Date.now());
      
      return {
        success: true,
        categoriesCreated,
        itemsCreated,
        finalCategoryCount,
        finalItemCount,
      };
    } catch (error) {
      console.error(`[DEFAULT MENU] ❌ Error pushing to cafe ${cartIdStr}:`, error);
      console.error(`[DEFAULT MENU] Error details:`, error.message);
      throw error;
    } finally {
      // Release sync lock
      syncLocks.delete(cartIdStr);
    }
  })();
  
  // Store sync promise in lock map
  syncLocks.set(cartIdStr, syncPromise);
  
  // Wait for sync to complete
  return await syncPromise;
}

// Export helper functions for use in user creation
module.exports.pushDefaultMenuToFranchise = pushDefaultMenuToFranchise;
module.exports.pushDefaultMenuToCafe = pushDefaultMenuToCafe;
