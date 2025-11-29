const mongoose = require("mongoose");

const defaultMenuSchema = new mongoose.Schema(
  {
    // Franchise association - null for super admin global menu, ObjectId for franchise-specific menu
    // CRITICAL: Each franchise should have ONLY ONE default menu
    franchiseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
      default: null,
    },
    // Single default menu template per franchise (or global for super admin)
    isActive: {
      type: Boolean,
      default: true,
    },
    // Categories with their items
    categories: [
      {
        name: { type: String, required: true },
        description: { type: String, default: "" },
        icon: { type: String, default: "" },
        sortOrder: { type: Number, default: 0 },
        isActive: { type: Boolean, default: true },
        items: [
          {
            name: { type: String, required: true },
            description: { type: String, default: "" },
            price: { type: Number, required: true, min: 0 },
            image: { type: String, default: "" },
            spiceLevel: {
              type: String,
              enum: ["NONE", "MILD", "MEDIUM", "HOT", "EXTREME"],
              default: "NONE",
            },
            isAvailable: { type: Boolean, default: true },
            isFeatured: { type: Boolean, default: false },
            sortOrder: { type: Number, default: 0 },
            tags: { type: [String], default: [] },
            allergens: { type: [String], default: [] },
            calories: { type: Number, min: 0 },
          },
        ],
      },
    ],
    // Metadata
    version: { type: Number, default: 1 },
    lastUpdatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  {
    timestamps: true,
  }
);

// CRITICAL: Ensure only ONE active menu per franchise
// Compound unique index: franchiseId + isActive = unique for active menus
// This prevents multiple active menus for the same franchise
// Note: MongoDB doesn't support partial unique indexes in all versions, so we'll handle uniqueness in code
// But we can still add a regular index for performance
defaultMenuSchema.index({ franchiseId: 1, isActive: 1 });

// Get default menu for a franchise (or global if franchiseId is null)
// NOTE: This returns a plain object (lean) for reading. For saving, use findOne() directly.
defaultMenuSchema.statics.getDefaultMenu = async function (franchiseId = null, lean = true) {
  // Normalize franchiseId - convert to ObjectId if string, or null if empty
  let normalizedFranchiseId = null;
  if (franchiseId) {
    if (typeof franchiseId === 'string' && franchiseId.trim() !== '') {
      // Use mongoose already imported at top of file
      normalizedFranchiseId = mongoose.Types.ObjectId.isValid(franchiseId) 
        ? new mongoose.Types.ObjectId(franchiseId) 
        : null;
    } else if (franchiseId.toString && franchiseId.toString() !== '') {
      normalizedFranchiseId = franchiseId;
    }
  }
  
  // CRITICAL: Use strict query to ensure we get the exact franchise menu
  // If franchiseId is provided, we MUST find that specific franchise's menu, not global
  const query = { isActive: true };
  if (normalizedFranchiseId !== null) {
    // For franchise-specific menu, use exact match
    query.franchiseId = normalizedFranchiseId;
  } else {
    // For global menu (super admin), franchiseId must be null
    query.franchiseId = null;
  }
  
  console.log(`[DEFAULT MENU MODEL] Looking for menu with franchiseId: ${normalizedFranchiseId || 'null (global)'}`);
  
  // CRITICAL: Always get the LATEST version by sorting by:
  // 1. updatedAt descending (most recently updated)
  // 2. version descending (highest version number)
  // This ensures we get the most recent menu with all items, not cached or old data
  let queryBuilder = this.findOne(query)
    .sort({ updatedAt: -1, version: -1 });
  
  // Use lean() only if requested (default true for reading)
  if (lean) {
    queryBuilder = queryBuilder.lean();
  }
  
  let defaultMenu = await queryBuilder;
  
  // Log what we found
  if (defaultMenu) {
    const menuId = defaultMenu._id ? defaultMenu._id.toString() : 'N/A';
    const totalItems = defaultMenu.categories 
      ? defaultMenu.categories.reduce((sum, cat) => sum + (cat.items ? cat.items.length : 0), 0)
      : 0;
    console.log(`[DEFAULT MENU MODEL] Found menu document ID: ${menuId}`);
    console.log(`[DEFAULT MENU MODEL] Menu has ${defaultMenu.categories?.length || 0} categories with ${totalItems} total items`);
  }
  
  if (!defaultMenu) {
    // CRITICAL: Do NOT auto-create menu - return null if menu doesn't exist
    // This allows users to delete the menu completely
    // Menu should be created explicitly via updateDefaultMenu endpoint
    console.log(`[DEFAULT MENU MODEL] No menu found for franchise: ${normalizedFranchiseId || 'null (global)'}`);
    console.log(`[DEFAULT MENU MODEL] Returning null - menu must be created explicitly via save/update endpoint`);
    return null;
  } else {
    // Verify the menu belongs to the correct franchise
    if (normalizedFranchiseId !== null) {
      const menuFranchiseId = defaultMenu.franchiseId ? defaultMenu.franchiseId.toString() : null;
      const expectedFranchiseId = normalizedFranchiseId.toString();
      if (menuFranchiseId !== expectedFranchiseId) {
        console.error(`[DEFAULT MENU MODEL] ERROR: Menu franchise mismatch! Expected: ${expectedFranchiseId}, Got: ${menuFranchiseId}`);
        throw new Error(`Menu franchise mismatch: Expected franchise ${expectedFranchiseId}, but menu belongs to ${menuFranchiseId || 'global'}`);
      }
    }
    const updatedAt = defaultMenu.updatedAt || (defaultMenu.toObject ? defaultMenu.toObject().updatedAt : null);
    const version = defaultMenu.version || 'N/A';
    const categoryCount = defaultMenu.categories?.length || 0;
    
    // Count items in each category
    const categoryDetails = defaultMenu.categories?.map((cat, idx) => {
      const itemCount = cat.items ? cat.items.length : 0;
      return `Category ${idx + 1}: "${cat.name}" (${itemCount} items)`;
    }).join(', ') || 'No categories';
    
    const totalItems = defaultMenu.categories 
      ? defaultMenu.categories.reduce((sum, cat) => sum + (cat.items ? cat.items.length : 0), 0)
      : 0;
    
    console.log(`[DEFAULT MENU MODEL] ✅ Found LATEST menu (updatedAt: ${updatedAt}) for franchise ${normalizedFranchiseId || 'global'}`);
    console.log(`[DEFAULT MENU MODEL] Menu version: ${version}, Categories: ${categoryCount}, Total items: ${totalItems}`);
    console.log(`[DEFAULT MENU MODEL] Category details: ${categoryDetails}`);
    
    // Verify items are present
    if (defaultMenu.categories && defaultMenu.categories.length > 0) {
      const categoriesWithItems = defaultMenu.categories.filter(cat => cat.items && cat.items.length > 0);
      const categoriesWithoutItems = defaultMenu.categories.filter(cat => !cat.items || cat.items.length === 0);
      
      if (categoriesWithoutItems.length > 0) {
        console.warn(`[DEFAULT MENU MODEL] ⚠️ WARNING: ${categoriesWithoutItems.length} categories have NO items: ${categoriesWithoutItems.map(c => c.name).join(', ')}`);
      }
      
      if (categoriesWithItems.length > 0) {
        console.log(`[DEFAULT MENU MODEL] ✅ ${categoriesWithItems.length} categories have items`);
      }
    }
  }
  
  // CRITICAL: Ensure items are properly included in the response
  // Sometimes mongoose might not include nested arrays properly, so we verify
  if (defaultMenu && defaultMenu.categories) {
    defaultMenu.categories = defaultMenu.categories.map(cat => {
      // Ensure items array exists
      if (!cat.items) {
        cat.items = [];
      }
      // Ensure items is an array (not undefined/null)
      if (!Array.isArray(cat.items)) {
        console.warn(`[DEFAULT MENU MODEL] ⚠️ Category "${cat.name}" items is not an array, converting to array`);
        cat.items = [];
      }
      return cat;
    });
  }
  
  // Return menu (as mongoose document if lean=false, as plain object if lean=true)
  return defaultMenu;
};

const DefaultMenu = mongoose.model("DefaultMenu", defaultMenuSchema);

module.exports = DefaultMenu;

