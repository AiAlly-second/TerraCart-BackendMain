/**
 * Clone Global Default Menu to Franchise
 * 
 * When a new franchise is created, this function:
 * 1. Gets the global default menu (franchiseId = null)
 * 2. Creates a new DefaultMenu document for the franchise
 * 3. Clones all categories and items with new IDs
 * 
 * This ensures each franchise has its own independent menu template
 */

const DefaultMenu = require("../models/defaultMenuModel");

/**
 * Clone global default menu to create a franchise-specific default menu
 * @param {ObjectId} franchiseId - The franchise ID
 * @returns {Promise<Object>} Result with success status and message
 */
async function cloneGlobalDefaultMenuToFranchise(franchiseId) {
  try {
    console.log(`[MENU CLONE] ========================================`);
    console.log(`[MENU CLONE] Cloning global default menu to franchise ${franchiseId}`);
    
    // Check if franchise already has a default menu
    const existingMenu = await DefaultMenu.findOne({
      franchiseId: franchiseId,
      isActive: true
    });
    
    if (existingMenu) {
      console.log(`[MENU CLONE] Franchise ${franchiseId} already has a default menu. Skipping clone.`);
      return {
        success: false,
        message: "Franchise already has a default menu",
        menuId: existingMenu._id
      };
    }
    
    // Get the global default menu (franchiseId = null)
    const globalMenu = await DefaultMenu.getDefaultMenu(null, true);
    
    if (!globalMenu) {
      console.warn(`[MENU CLONE] No global default menu found. Franchise will have no menu until one is created.`);
      return {
        success: false,
        message: "No global default menu found. Super admin must create a default menu first.",
        menuId: null
      };
    }
    
    console.log(`[MENU CLONE] Found global menu with ${globalMenu.categories?.length || 0} categories`);
    
    // Clone the menu structure for the franchise
    const franchiseMenuData = {
      franchiseId: franchiseId,
      isActive: true,
      categories: globalMenu.categories ? globalMenu.categories.map(cat => ({
        name: cat.name,
        description: cat.description || "",
        icon: cat.icon || "",
        sortOrder: cat.sortOrder || 0,
        isActive: cat.isActive !== undefined ? cat.isActive : true,
        items: cat.items ? cat.items.map(item => ({
          name: item.name,
          description: item.description || "",
          price: item.price,
          image: item.image || "",
          spiceLevel: item.spiceLevel || "NONE",
          isAvailable: item.isAvailable !== undefined ? item.isAvailable : true,
          isFeatured: item.isFeatured || false,
          sortOrder: item.sortOrder || 0,
          tags: item.tags || [],
          allergens: item.allergens || [],
          calories: item.calories || null,
        })) : []
      })) : [],
      version: 1,
      lastUpdatedBy: franchiseId, // Set franchise as the updater
    };
    
    // Create the franchise default menu
    const franchiseMenu = await DefaultMenu.create(franchiseMenuData);
    
    const categoryCount = franchiseMenu.categories?.length || 0;
    const totalItems = franchiseMenu.categories 
      ? franchiseMenu.categories.reduce((sum, cat) => sum + (cat.items ? cat.items.length : 0), 0)
      : 0;
    
    console.log(`[MENU CLONE] ✅ Successfully cloned global menu to franchise ${franchiseId}`);
    console.log(`[MENU CLONE] Created ${categoryCount} categories with ${totalItems} total items`);
    console.log(`[MENU CLONE] Franchise menu ID: ${franchiseMenu._id}`);
    console.log(`[MENU CLONE] ========================================`);
    
    return {
      success: true,
      message: `Cloned global menu to franchise. Created ${categoryCount} categories with ${totalItems} items.`,
      menuId: franchiseMenu._id,
      categoryCount: categoryCount,
      itemCount: totalItems
    };
  } catch (error) {
    console.error(`[MENU CLONE] ❌ Error cloning global menu to franchise ${franchiseId}:`, error);
    throw error;
  }
}

module.exports = {
  cloneGlobalDefaultMenuToFranchise
};












