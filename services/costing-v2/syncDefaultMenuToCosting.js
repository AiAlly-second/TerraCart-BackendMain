/**
 * Sync Default Menu to Costing Menu Items
 * Updates costing menu items when default menu items are updated
 */

const MenuItemV2 = require("../../models/costing-v2/menuItemModel");
const DefaultMenu = require("../../models/defaultMenuModel");
const { MenuItem } = require("../../models/menuItemModel");
const MenuCategory = require("../../models/menuCategoryModel");

/**
 * Sync cart admin menu items (from MenuItem collection) to costing menu items
 * @param {String} cartId - Cart admin user ID (cafeId)
 * @param {String} outletId - Optional outlet ID to filter costing items
 * @returns {Promise<Object>} Sync summary
 */
async function syncCartMenuToCosting(cartId, outletId = null) {
  try {
    console.log(`[COSTING SYNC] Starting cart menu sync for cart: ${cartId}`);
    
    // Get all menu items for this cart admin
    const cartMenuItems = await MenuItem.find({ cafeId: cartId }).lean();
    
    if (!cartMenuItems || cartMenuItems.length === 0) {
      console.log(`[COSTING SYNC] No menu items found for cart: ${cartId}`);
      return {
        success: true,
        message: "No menu items found",
        updated: 0,
        errors: [],
      };
    }

    // Get category names for items
    const categoryIds = [...new Set(cartMenuItems.map(item => item.category))];
    const categories = await MenuCategory.find({ _id: { $in: categoryIds } }).lean();
    const categoryMap = {};
    categories.forEach(cat => {
      categoryMap[cat._id.toString()] = cat.name;
    });

    const syncSummary = {
      updated: 0,
      notFound: 0,
      errors: [],
    };

    // Process each cart menu item
    for (const cartItem of cartMenuItems) {
      try {
        const categoryName = categoryMap[cartItem.category?.toString()] || "Unknown";
        const itemName = cartItem.name.trim();

        // Find costing menu items by name (and optionally outletId)
        const query = {
          $or: [
            { name: itemName },
            { name: { $regex: new RegExp(`^${itemName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, "i") } },
            { defaultMenuItemName: itemName },
            { defaultMenuItemName: { $regex: new RegExp(`^${itemName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, "i") } },
          ],
        };

        // If outletId is provided, filter by it
        if (outletId) {
          query.outletId = outletId;
        }

        const costingMenuItems = await MenuItemV2.find(query);

        if (costingMenuItems.length === 0) {
          // Item not imported to costing yet - skip
          syncSummary.notFound++;
          continue;
        }

        // Update each costing menu item with new price
        for (const costingItem of costingMenuItems) {
          try {
            const oldPrice = costingItem.sellingPrice;
            const newPrice = Number(cartItem.price) || 0;

            // Update selling price if changed
            if (newPrice > 0 && newPrice !== oldPrice) {
              costingItem.sellingPrice = newPrice;
              // Recalculate metrics with new price
              if (costingItem.costPerPortion !== undefined) {
                costingItem.calculateMetrics(costingItem.costPerPortion);
              }
              await costingItem.save();
              syncSummary.updated++;
              console.log(
                `[COSTING SYNC] Updated ${costingItem.name}: Price ${oldPrice} → ${newPrice} (Outlet: ${costingItem.outletId || 'N/A'})`
              );
            } else if (newPrice === 0) {
              console.warn(`[COSTING SYNC] Skipping ${costingItem.name}: Invalid price ${newPrice}`);
            }
          } catch (updateError) {
            console.error(`[COSTING SYNC] Error updating costing item ${costingItem.name}:`, updateError.message);
            syncSummary.errors.push({
              item: cartItem.name,
              outletId: costingItem.outletId,
              error: updateError.message,
            });
          }
        }
      } catch (itemError) {
        console.error(`[COSTING SYNC] Error processing item ${cartItem.name}:`, itemError.message);
        syncSummary.errors.push({
          item: cartItem.name,
          error: itemError.message,
        });
      }
    }

    console.log(`[COSTING SYNC] Cart menu sync complete: ${syncSummary.updated} items updated, ${syncSummary.notFound} not found, ${syncSummary.errors.length} errors`);
    return {
      success: syncSummary.errors.length === 0,
      updated: syncSummary.updated,
      notFound: syncSummary.notFound,
      errors: syncSummary.errors,
    };
  } catch (error) {
    console.error(`[COSTING SYNC] Cart menu sync failed:`, error);
    return {
      success: false,
      error: error.message,
      updated: 0,
      errors: [{ error: error.message }],
    };
  }
}

/**
 * Sync default menu item updates to costing menu items
 * @param {String} franchiseId - Franchise ID (null for global menu)
 * @param {String} cartId - Optional cart ID for cart admin sync
 * @param {String} outletId - Optional outlet ID to filter costing items
 * @returns {Promise<Object>} Sync summary
 */
async function syncDefaultMenuToCosting(franchiseId = null, cartId = null, outletId = null) {
  try {
    // If cartId is provided, sync from cart menu (MenuItem collection)
    if (cartId) {
      return await syncCartMenuToCosting(cartId, outletId);
    }

    console.log(`[COSTING SYNC] Starting sync for franchise: ${franchiseId || 'GLOBAL'}`);
    
    // Get default menu
    const defaultMenu = await DefaultMenu.getDefaultMenu(franchiseId);
    if (!defaultMenu || !defaultMenu.categories || defaultMenu.categories.length === 0) {
      console.log(`[COSTING SYNC] No default menu found for franchise: ${franchiseId || 'GLOBAL'}`);
      return {
        success: true,
        message: "No default menu found",
        updated: 0,
        errors: [],
      };
    }

    const franchiseIdStr = franchiseId ? franchiseId.toString() : null;
    const syncSummary = {
      updated: 0,
      notFound: 0,
      errors: [],
    };

    // Process each category and item
    for (const category of defaultMenu.categories) {
      if (!category.items || category.items.length === 0) continue;

      for (const defaultItem of category.items) {
        try {
          // Build defaultMenuPath for lookup
          const defaultMenuPath = `${franchiseIdStr}/${category.name}/${defaultItem.name}`;

          // Find all costing menu items linked to this default menu item
          const query = {
            $or: [
              { defaultMenuPath: defaultMenuPath },
              {
                defaultMenuFranchiseId: franchiseId,
                defaultMenuCategoryName: category.name,
                defaultMenuItemName: defaultItem.name,
              },
            ],
          };

          // If outletId is provided, filter by it
          if (outletId) {
            query.outletId = outletId;
          }

          const costingMenuItems = await MenuItemV2.find(query);

          if (costingMenuItems.length === 0) {
            // Item not imported to costing yet - skip
            syncSummary.notFound++;
            continue;
          }

          // Update each costing menu item with new price and other fields
          for (const costingItem of costingMenuItems) {
            try {
              const oldPrice = costingItem.sellingPrice;
              const newPrice = Number(defaultItem.price) || 0;

              // Update selling price if changed
              if (newPrice > 0 && newPrice !== oldPrice) {
                costingItem.sellingPrice = newPrice;
                // Recalculate metrics with new price
                if (costingItem.costPerPortion !== undefined) {
                  costingItem.calculateMetrics(costingItem.costPerPortion);
                }
                await costingItem.save();
                syncSummary.updated++;
                console.log(
                  `[COSTING SYNC] Updated ${costingItem.name}: Price ${oldPrice} → ${newPrice} (Outlet: ${costingItem.outletId || 'N/A'})`
                );
              } else if (newPrice === 0) {
                console.warn(`[COSTING SYNC] Skipping ${costingItem.name}: Invalid price ${newPrice}`);
              }
            } catch (updateError) {
              console.error(`[COSTING SYNC] Error updating costing item ${costingItem.name}:`, updateError.message);
              syncSummary.errors.push({
                item: defaultItem.name,
                outletId: costingItem.outletId,
                error: updateError.message,
              });
            }
          }
        } catch (itemError) {
          console.error(`[COSTING SYNC] Error processing item ${defaultItem.name}:`, itemError.message);
          syncSummary.errors.push({
            item: defaultItem.name,
            error: itemError.message,
          });
        }
      }
    }

    console.log(`[COSTING SYNC] Sync complete: ${syncSummary.updated} items updated, ${syncSummary.notFound} not found, ${syncSummary.errors.length} errors`);
    return {
      success: syncSummary.errors.length === 0,
      updated: syncSummary.updated,
      notFound: syncSummary.notFound,
      errors: syncSummary.errors,
    };
  } catch (error) {
    console.error(`[COSTING SYNC] Sync failed:`, error);
    return {
      success: false,
      error: error.message,
      updated: 0,
      errors: [{ error: error.message }],
    };
  }
}

/**
 * Sync specific default menu item to costing
 * @param {String} franchiseId - Franchise ID
 * @param {String} categoryName - Category name
 * @param {String} itemName - Item name
 * @returns {Promise<Object>} Sync result
 */
async function syncSingleMenuItemToCosting(franchiseId, categoryName, itemName) {
  try {
    const defaultMenu = await DefaultMenu.getDefaultMenu(franchiseId);
    if (!defaultMenu || !defaultMenu.categories) {
      return { success: false, message: "Default menu not found" };
    }

    const category = defaultMenu.categories.find((c) => c.name === categoryName);
    if (!category || !category.items) {
      return { success: false, message: "Category not found" };
    }

    const defaultItem = category.items.find((i) => i.name === itemName);
    if (!defaultItem) {
      return { success: false, message: "Item not found in default menu" };
    }

    const franchiseIdStr = franchiseId ? franchiseId.toString() : null;
    const defaultMenuPath = `${franchiseIdStr}/${categoryName}/${itemName}`;

    const costingMenuItems = await MenuItemV2.find({
      $or: [
        { defaultMenuPath: defaultMenuPath },
        {
          defaultMenuFranchiseId: franchiseId,
          defaultMenuCategoryName: categoryName,
          defaultMenuItemName: itemName,
        },
      ],
    });

    if (costingMenuItems.length === 0) {
      return { success: true, message: "Item not imported to costing yet", updated: 0 };
    }

    let updated = 0;
    for (const costingItem of costingMenuItems) {
      const newPrice = Number(defaultItem.price) || 0;
      if (newPrice > 0 && newPrice !== costingItem.sellingPrice) {
        costingItem.sellingPrice = newPrice;
        if (costingItem.costPerPortion !== undefined) {
          costingItem.calculateMetrics(costingItem.costPerPortion);
        }
        await costingItem.save();
        updated++;
      }
    }

    return { success: true, updated };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

module.exports = {
  syncDefaultMenuToCosting,
  syncSingleMenuItemToCosting,
};

