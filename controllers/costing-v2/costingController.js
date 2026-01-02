const fs = require("fs");
const path = require("path");
const Supplier = require("../../models/costing-v2/supplierModel");
const Ingredient = require("../../models/costing-v2/ingredientModel");
const Purchase = require("../../models/costing-v2/purchaseModel");
const InventoryTransaction = require("../../models/costing-v2/inventoryTransactionModel");
const Recipe = require("../../models/costing-v2/recipeModel");

// Helper function for logging
const logDebug = (location, message, data, hypothesisId) => {
  try {
    const logEntry = {
      location,
      message,
      data,
      timestamp: Date.now(),
      sessionId: "debug-session",
      runId: "pre-fix",
      hypothesisId,
    };
    const logPath = path.join(__dirname, "../../../.cursor/debug.log");
    fs.appendFileSync(logPath, JSON.stringify(logEntry) + "\n");
  } catch (err) {
    // Silently fail if logging fails
  }
};
const MenuItem = require("../../models/costing-v2/menuItemModel");
const { MenuItem: OperationalMenuItem } = require("../../models/menuItemModel");
const MenuCategory = require("../../models/menuCategoryModel");
const Waste = require("../../models/costing-v2/wasteModel");
const LabourCost = require("../../models/costing-v2/labourCostModel");
const Overhead = require("../../models/costing-v2/overheadModel");
const User = require("../../models/userModel");
const Cart = require("../../models/cartModel");
const CartMenuItem = require("../../models/cartMenuModel");
const CostingExpense = require("../../models/costing-v2/expenseModel");
const CostingExpenseCategory = require("../../models/costing-v2/expenseCategoryModel");
const Order = require("../../models/orderModel");
const DefaultMenu = require("../../models/defaultMenuModel");
const FIFOService = require("../../services/costing-v2/fifoService");
const WeightedAverageService = require("../../services/costing-v2/weightedAverageService");
const { convertUnit } = require("../../utils/costing-v2/unitConverter");
const {
  buildCostingQuery,
  getAllowedOutlets,
  validateOutletAccess,
  setOutletContext,
} = require("../../utils/costing-v2/accessControl");

/**
 * Decode HTML entities in a string
 * Handles common HTML entities like &amp;, &lt;, &gt;, &quot;, &#39;
 */
const decodeHtmlEntities = (str) => {
  if (typeof str !== "string") return str;
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/");
};

// ==================== SUPPLIERS ====================

/**
 * @route   GET /api/costing-v2/suppliers
 * @desc    Get suppliers filtered by cart/kiosk/cafe
 * @note    Suppliers are now cart-specific (have outletId field)
 */
exports.getSuppliers = async (req, res) => {
  try {
    const { isActive, search } = req.query;
    const filter = {};

    if (isActive !== undefined) filter.isActive = isActive === "true";
    if (search) filter.name = { $regex: search, $options: "i" };

    // Apply role-based filtering using buildCostingQuery (suppliers now have outletId)
    const costingFilter = await buildCostingQuery(req.user, filter);

    console.log(
      "[GET_SUPPLIERS] Filter:",
      JSON.stringify(costingFilter),
      "User role:",
      req.user.role
    );

    const suppliers = await Supplier.find(costingFilter).sort({ name: 1 });
    res.json({ success: true, data: suppliers });
  } catch (error) {
    console.error("[GET_SUPPLIERS] Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   POST /api/costing-v2/suppliers
 * @desc    Create supplier (automatically associates with cart/kiosk/cafe)
 */
exports.createSupplier = async (req, res) => {
  try {
    // Use setOutletContext to automatically set cartId and franchiseId based on user role
    const supplierData = { ...req.body };
    
    // Handle outletId from request body (convert to cartId for consistency)
    if (supplierData.outletId && !supplierData.cartId) {
      supplierData.cartId = supplierData.outletId;
      delete supplierData.outletId;
    }
    
    // Use setOutletContext utility to set cartId and franchiseId
    const data = await setOutletContext(req.user, supplierData, true);

    console.log("[CREATE_SUPPLIER] Creating supplier with:", {
      name: data.name,
      cartId: data.cartId,
      franchiseId: data.franchiseId,
      userRole: req.user.role,
    });

    const supplier = new Supplier(data);
    await supplier.save();
    res.status(201).json({ success: true, data: supplier });
  } catch (error) {
    console.error("[CREATE_SUPPLIER] Error:", error);
    res.status(400).json({ success: false, message: error.message });
  }
};

/**
 * @route   PUT /api/costing-v2/suppliers/:id
 * @desc    Update supplier
 */
exports.updateSupplier = async (req, res) => {
  try {
    const supplier = await Supplier.findById(req.params.id);
    if (!supplier) {
      return res
        .status(404)
        .json({ success: false, message: "Supplier not found" });
    }

    // Check access: cart admin can only update their own suppliers
    if (req.user.role === "admin") {
      if (supplier.cartId?.toString() !== req.user._id.toString()) {
        return res.status(403).json({
          success: false,
          message:
            "Access denied: You can only update suppliers belonging to your cart",
        });
      }
    } else if (req.user.role === "franchise_admin") {
      // Franchise admin can update suppliers from their franchise carts
      const outlet = await User.findById(supplier.cartId);
      if (
        !outlet ||
        outlet.franchiseId?.toString() !== req.user._id.toString()
      ) {
        return res.status(403).json({
          success: false,
          message: "Access denied: Supplier does not belong to your franchise",
        });
      }
    }
    // Super admin can update any supplier

    // Prevent changing cartId/franchiseId (suppliers are cart-specific)
    const updateData = { ...req.body };
    delete updateData.cartId;
    delete updateData.franchiseId;

    const updatedSupplier = await Supplier.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    );

    res.json({ success: true, data: updatedSupplier });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

/**
 * @route   DELETE /api/costing-v2/suppliers/:id
 * @desc    Delete supplier
 */
exports.deleteSupplier = async (req, res) => {
  try {
    const supplier = await Supplier.findById(req.params.id);
    if (!supplier) {
      return res
        .status(404)
        .json({ success: false, message: "Supplier not found" });
    }

    // Check access: cart admin can only delete their own suppliers
    if (req.user.role === "admin") {
      if (supplier.cartId?.toString() !== req.user._id.toString()) {
        return res.status(403).json({
          success: false,
          message:
            "Access denied: You can only delete suppliers belonging to your cart",
        });
      }
    } else if (req.user.role === "franchise_admin") {
      // Franchise admin can delete suppliers from their franchise carts
      const outlet = await User.findById(supplier.cartId);
      if (
        !outlet ||
        outlet.franchiseId?.toString() !== req.user._id.toString()
      ) {
        return res.status(403).json({
          success: false,
          message: "Access denied: Supplier does not belong to your franchise",
        });
      }
    }
    // Super admin can delete any supplier

    await Supplier.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: "Supplier deleted" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ==================== INGREDIENTS ====================

/**
 * @route   GET /api/costing-v2/ingredients
 * @desc    Get all ingredients with filters
 */
exports.getIngredients = async (req, res) => {
  try {
    const {
      uom,
      lowStock,
      search,
      isActive,
      outletId,
      category,
      storageLocation,
    } = req.query;
    const filter = {};

    if (uom) filter.uom = uom;
    if (isActive !== undefined) filter.isActive = isActive === "true";
    if (search) filter.name = { $regex: search, $options: "i" };
    if (outletId) filter.cartId = outletId;
    if (category) filter.category = category;
    if (storageLocation) filter.storageLocation = storageLocation;

    // Apply role-based filtering
    // For cart admins (role: "admin"), always filter by their outletId (req.user._id)
    // This ensures cart admins only see ingredients belonging to their cart/kiosk
    // For franchise/super admins, can see shared ingredients (outletId=null) or filter by specific outletId.
    // Additionally, for franchise_admin we include shared/global ingredients (franchiseId=null).
    const shouldSkipOutletFilter =
      (req.user.role === "franchise_admin" ||
        req.user.role === "super_admin") &&
      !outletId;
    const costingFilter = await buildCostingQuery(req.user, filter, {
      skipOutletFilter: shouldSkipOutletFilter,
      includeShared: true,
    });

    // Log filtering for debugging
    if (req.user.role === "admin") {
      console.log(
        "[GET_INGREDIENTS] Cart admin filter - outletId:",
        req.user._id.toString(),
        "Filter:",
        JSON.stringify(costingFilter)
      );
    }

    let ingredients = await Ingredient.find(costingFilter)
      .populate("preferredSupplierId", "name")
      .populate("cartId", "name cafeName")
      .sort({ category: 1, name: 1 }); // Sort by category first, then name

    // For Cart Admin, calculate outlet-specific qtyOnHand and currentCostPerBaseUnit
    // This ensures each cart admin only sees their own inventory quantities and costs
    if (req.user.role === "admin") {
      const outletId = req.user._id;
      for (const ingredient of ingredients) {
        let outletSpecificQty = 0;
        let outletSpecificCost = 0;

        // If ingredient is outlet-specific and belongs to this outlet, recalculate from transactions
        // This ensures we use actual transaction-based stock, not just database qtyOnHand
        if (
          ingredient.cartId &&
          ingredient.cartId.toString() === outletId.toString()
        ) {
          // Cart-specific ingredient - recalculate from transactions to get accurate stock
          const cartTransactions = await InventoryTransaction.find({
            ingredientId: ingredient._id,
            cartId: outletId,
          }).sort({ date: 1 });

          // Debug: Also check if there are any transactions at all for this ingredient
          const allTransactions = await InventoryTransaction.find({
            ingredientId: ingredient._id,
          });
          
          if (process.env.NODE_ENV === 'development') {
            console.log(`[STOCK DEBUG] Cart-specific ingredient ${ingredient.name}:`, {
              ingredientId: ingredient._id,
              cartId: ingredient.cartId,
              outletId: outletId,
              transactionsWithCartId: cartTransactions.length,
              allTransactions: allTransactions.length,
              qtyOnHand: ingredient.qtyOnHand,
            });
          }

          let totalQty = 0;
          let lastPurchaseCost = 0;

          // If we have transactions, calculate from them
          if (cartTransactions.length > 0) {
            // Find the most recent purchase transaction (IN type) for last purchase cost
            const purchaseTransactions = cartTransactions
              .filter(txn => txn.type === "IN")
              .sort((a, b) => new Date(b.date) - new Date(a.date)); // Sort by date descending
            
            if (purchaseTransactions.length > 0) {
              const lastPurchase = purchaseTransactions[0];
              const lastPurchaseQty = lastPurchase.qtyInBaseUnit || lastPurchase.qty;
              const lastPurchaseCostAllocated = lastPurchase.costAllocated || 0;
              if (lastPurchaseQty > 0 && lastPurchaseCostAllocated > 0) {
                lastPurchaseCost = lastPurchaseCostAllocated / lastPurchaseQty;
                console.log(`[INVENTORY COST] ${ingredient.name}: Last purchase cost = ₹${lastPurchaseCost.toFixed(6)}/${ingredient.baseUnit} (from transaction dated ${lastPurchase.date}, costAllocated=${lastPurchaseCostAllocated}, qty=${lastPurchaseQty})`);
              }
            }
            
            // Calculate total quantity from all transactions
            for (const txn of cartTransactions) {
              const txnQty = txn.qtyInBaseUnit || txn.qty;
              if (txn.type === "IN" || txn.type === "RETURN") {
                totalQty += txnQty;
              } else if (txn.type === "OUT" || txn.type === "WASTE") {
                totalQty -= txnQty;
                if (totalQty < 0) totalQty = 0;
              }
            }
            outletSpecificQty = Math.max(0, totalQty);
            
            // CRITICAL: Cost MUST be 0 when stock is 0
            if (outletSpecificQty <= 0) {
              outletSpecificCost = 0;
            } else if (lastPurchaseCost > 0) {
              outletSpecificCost = lastPurchaseCost;
            } else {
              // Use database cost only if stock > 0 and no purchase found
              outletSpecificCost = Number(ingredient.currentCostPerBaseUnit) || 0;
            }
          } else {
            // No transactions found - use ingredient's qtyOnHand and cost directly
            // This handles cases where stock was set manually or before transaction tracking
            outletSpecificQty = Number(ingredient.qtyOnHand) || 0;
            
            // CRITICAL: If stock is 0, cost MUST be 0 (no exceptions)
            if (outletSpecificQty <= 0) {
              outletSpecificCost = 0;
            } else {
              // Stock > 0 - use database cost
              outletSpecificCost = Number(ingredient.currentCostPerBaseUnit) || 0;
            }
            
            if (process.env.NODE_ENV === 'development') {
              console.log(`[STOCK DEBUG] Cart-specific ingredient ${ingredient.name} has no transactions, using qtyOnHand: ${outletSpecificQty}, cost: ${outletSpecificCost}`);
            }
          }

          // Update ingredient values
          ingredient.qtyOnHand = outletSpecificQty;
          
          // CRITICAL: Set cost - MUST be 0 when stock is 0 (absolute rule)
          // This check happens AFTER all cost calculations to ensure it's never overridden
          if (outletSpecificQty <= 0) {
            // Stock is 0 - cost MUST be 0 (no exceptions)
            ingredient.currentCostPerBaseUnit = 0;
          } else {
            // Stock > 0 - use calculated cost
            ingredient.currentCostPerBaseUnit = outletSpecificCost;
          }
          
          // Final safety check - ensure cost is 0 if stock is 0 (absolute guarantee)
          // This is a redundant check to catch any edge cases
          if (ingredient.qtyOnHand <= 0) {
            ingredient.currentCostPerBaseUnit = 0;
          }
          
          ingredient.markModified("qtyOnHand");
          ingredient.markModified("currentCostPerBaseUnit");
          continue;
        }

        // For shared ingredients, calculate outlet-specific values from transactions
        // This uses weighted average costing (same as BOM calculation)
        // IMPORTANT: For shared ingredients, we need to check BOTH:
        // 1. Outlet-specific transactions (cartId = outletId)
        // 2. Global transactions (cartId = null or missing) - for shared ingredients purchased globally
        const cartTransactions = await InventoryTransaction.find({
          ingredientId: ingredient._id,
          $or: [
            { cartId: outletId },
            { cartId: null }, // Global transactions
            { cartId: { $exists: false } } // Also check for missing cartId field
          ]
        }).sort({ date: 1 }); // Sort by date ascending to calculate weighted average

        // Debug: Check transaction counts
        const outletSpecificTransactions = await InventoryTransaction.find({
          ingredientId: ingredient._id,
          cartId: outletId,
        });
        const globalTransactions = await InventoryTransaction.find({
          ingredientId: ingredient._id,
          cartId: null,
        });
        const allTransactions = await InventoryTransaction.find({
          ingredientId: ingredient._id,
        });
        
        if (process.env.NODE_ENV === 'development') {
          console.log(`[STOCK DEBUG] Shared ingredient ${ingredient.name}:`, {
            ingredientId: ingredient._id,
            cartId: ingredient.cartId,
            outletId: outletId,
            outletSpecificTransactions: outletSpecificTransactions.length,
            globalTransactions: globalTransactions.length,
            totalTransactions: cartTransactions.length,
            allTransactions: allTransactions.length,
            qtyOnHand: ingredient.qtyOnHand,
          });
        }

        let totalQty = 0;
        let lastPurchaseCost = 0;

        // If we have transactions, calculate from them
        if (cartTransactions.length > 0) {
          console.log(`[INVENTORY COST] ${ingredient.name}: Processing ${cartTransactions.length} transactions for cost calculation`);
          
          // Find the most recent purchase transaction (IN type) for last purchase cost
          const purchaseTransactions = cartTransactions
            .filter(txn => txn.type === "IN")
            .sort((a, b) => new Date(b.date) - new Date(a.date)); // Sort by date descending
          
          if (purchaseTransactions.length > 0) {
            const lastPurchase = purchaseTransactions[0];
            const lastPurchaseQty = lastPurchase.qtyInBaseUnit || lastPurchase.qty;
            const lastPurchaseCostAllocated = lastPurchase.costAllocated || 0;
            if (lastPurchaseQty > 0 && lastPurchaseCostAllocated > 0) {
              lastPurchaseCost = lastPurchaseCostAllocated / lastPurchaseQty;
              console.log(`[INVENTORY COST] ${ingredient.name}: Last purchase cost = ₹${lastPurchaseCost.toFixed(6)}/${ingredient.baseUnit} (from transaction dated ${lastPurchase.date}, costAllocated=${lastPurchaseCostAllocated}, qty=${lastPurchaseQty})`);
            }
          }
          
          // Calculate total quantity from all transactions
          for (const txn of cartTransactions) {
            const txnQty = txn.qtyInBaseUnit || txn.qty;
            if (txn.type === "IN" || txn.type === "RETURN") {
              totalQty += txnQty;
            } else if (txn.type === "OUT" || txn.type === "WASTE") {
              totalQty -= txnQty;
              if (totalQty < 0) totalQty = 0;
            }
          }
          console.log(`[INVENTORY COST] ${ingredient.name}: Final calculated cost = ₹${lastPurchaseCost.toFixed(6)}/${ingredient.baseUnit}, total qty = ${totalQty} ${ingredient.baseUnit}`);
          outletSpecificQty = Math.max(0, totalQty);
        } else {
          // No transactions found for shared ingredient
          // For shared ingredients, if there are no transactions at all, use the ingredient's qtyOnHand
          // This handles cases where stock was set manually or before transaction tracking
          // OR if the ingredient has global stock that should be visible to all outlets
          outletSpecificQty = Number(ingredient.qtyOnHand) || 0;
          lastPurchaseCost = 0;
          
          if (process.env.NODE_ENV === 'development') {
            console.log(`[STOCK DEBUG] Shared ingredient ${ingredient.name} has no transactions, using qtyOnHand: ${outletSpecificQty}`);
          }
        }
        
        // CRITICAL: For inventory value calculation, cost MUST be 0 when stock is 0
        // This is the most important rule - no exceptions
        // Check stock FIRST before calculating cost
        if (outletSpecificQty <= 0) {
          // Stock is 0 - cost MUST be 0 regardless of any other factors
          // This is the absolute rule - no exceptions, no fallbacks
          outletSpecificCost = 0;
        } else {
          // Stock > 0 - use last purchase cost
          if (lastPurchaseCost > 0) {
            // We have a last purchase - use its cost
            outletSpecificCost = lastPurchaseCost;
          } else {
            // No purchase found - use ingredient's cost from database
            // This handles cases where stock exists but no transactions were recorded
            outletSpecificCost = Number(ingredient.currentCostPerBaseUnit) || 0;
          }
        }
        
        // ABSOLUTE FINAL CHECK: If stock is 0, cost MUST be 0 (no exceptions)
        // This overrides any previous cost calculation
        if (outletSpecificQty <= 0) {
          outletSpecificCost = 0;
        }

        // Override qtyOnHand and currentCostPerBaseUnit with outlet-specific values
        ingredient.qtyOnHand = outletSpecificQty;
        
        // CRITICAL: Set cost - MUST be 0 when stock is 0 (absolute rule)
        // This check happens AFTER all cost calculations to ensure it's never overridden
        if (outletSpecificQty <= 0) {
          // Stock is 0 - cost MUST be 0 (no exceptions)
          ingredient.currentCostPerBaseUnit = 0;
        } else {
          // Stock > 0 - use calculated cost
          ingredient.currentCostPerBaseUnit = outletSpecificCost;
        }
        
        // Final safety check: ensure cost is 0 if stock is 0 (absolute guarantee)
        // This is a redundant check to catch any edge cases
        if (ingredient.qtyOnHand <= 0) {
          ingredient.currentCostPerBaseUnit = 0;
        }
        
        // CRITICAL: Absolute final check - use threshold to catch any floating point issues
        const finalQtyCheck = Math.abs(Number(ingredient.qtyOnHand) || 0);
        const finalCostCheck = Math.abs(Number(ingredient.currentCostPerBaseUnit) || 0);
        
        if (finalQtyCheck < 0.0001 && finalCostCheck > 0) {
          // Stock is essentially 0 but cost is > 0 - force cost to 0
          if (process.env.NODE_ENV === 'development') {
            console.warn(`[INVENTORY VALUE BUG] Ingredient ${ingredient.name} has qtyOnHand=${finalQtyCheck} but cost=${finalCostCheck}. Forcing cost to 0.`);
          }
          ingredient.currentCostPerBaseUnit = 0;
          ingredient.markModified("currentCostPerBaseUnit");
        }
        
        // Mark as modified so it's included in the response
        ingredient.markModified("qtyOnHand");
        ingredient.markModified("currentCostPerBaseUnit");
        // #region agent log
        logDebug(
          "costingController.js:395",
          "Updated ingredient with outlet-specific values",
          {
            ingredientId: ingredient._id,
            ingredientName: ingredient.name,
            outletId: outletId,
            outletSpecificQty: outletSpecificQty,
            outletSpecificCost: outletSpecificCost,
            originalQtyOnHand: ingredient.qtyOnHand,
            originalCost: ingredient.currentCostPerBaseUnit,
          },
          "D"
        );
        // #endregion
      }
    }

    // FINAL SAFETY CHECK: Ensure ALL ingredients have cost = 0 when stock = 0
    // This is a critical check to prevent any inventory value calculation errors
    // Use strict comparison with threshold to catch floating point issues
    for (const ingredient of ingredients) {
      const qty = Math.abs(Number(ingredient.qtyOnHand) || 0);
      let cost = Math.abs(Number(ingredient.currentCostPerBaseUnit) || 0);
      
      // CRITICAL: If stock is 0 or very close to 0 (within 0.0001), cost MUST be 0
      // This catches any edge cases where stock might be 0.00001 or similar
      if (qty < 0.0001) {
        // Stock is essentially 0 - force cost to 0 regardless of any other factors
        if (cost > 0) {
          if (process.env.NODE_ENV === 'development') {
            console.warn(`[FINAL CHECK] Forcing cost to 0 for ${ingredient.name}: qty=${qty}, cost=${cost}`);
          }
          ingredient.currentCostPerBaseUnit = 0;
          cost = 0; // Update local variable too
          ingredient.markModified("currentCostPerBaseUnit");
        }
      }
      
      // Double-check: ensure cost is exactly 0 when qty is exactly 0
      if (qty === 0 && cost !== 0) {
        ingredient.currentCostPerBaseUnit = 0;
        ingredient.markModified("currentCostPerBaseUnit");
      }
      
      // TRIPLE-CHECK: Convert to plain object and verify before response
      // This ensures the value is actually 0 in the response, not just in the Mongoose document
      if (qty < 0.0001) {
        // Force to 0 in the response object
        ingredient.currentCostPerBaseUnit = 0;
      }
    }

    // Filter low stock after fetching (needs qtyOnHand comparison)
    if (lowStock === "true") {
      ingredients = ingredients.filter(
        (ing) => ing.qtyOnHand <= ing.reorderLevel
      );
    }

    // ABSOLUTE FINAL CHECK: Before sending response, ensure cost = 0 when stock = 0
    // Convert to plain objects and verify one last time
    const sanitizedIngredients = ingredients.map((ing) => {
      const qty = Math.abs(Number(ing.qtyOnHand) || 0);
      let cost = Math.abs(Number(ing.currentCostPerBaseUnit) || 0);
      
      // CRITICAL: If stock is 0, cost MUST be 0 (absolute rule)
      if (qty < 0.0001) {
        cost = 0;
      }
      
      // Convert to plain object and set cost explicitly
      const plainIng = ing.toObject ? ing.toObject() : ing;
      
      // CRITICAL: Force cost to 0 if stock is 0 (no exceptions)
      if (qty < 0.0001) {
        plainIng.currentCostPerBaseUnit = 0;
        cost = 0; // Ensure local variable is also 0
      } else {
        // Stock > 0 - use the calculated cost
        plainIng.currentCostPerBaseUnit = cost;
      }
      
      // Debug logging for cart admin in development
      if (process.env.NODE_ENV === 'development' && req.user.role === 'admin' && qty < 0.0001 && cost > 0) {
        console.error(`[SANITIZATION ERROR] ${ing.name}: qty=${qty}, cost=${cost} - forcing cost to 0`);
        plainIng.currentCostPerBaseUnit = 0;
      }
      
      return plainIng;
    });

    res.json({ success: true, data: sanitizedIngredients });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   POST /api/costing-v2/ingredients
 * @desc    Create ingredient
 */
exports.createIngredient = async (req, res) => {
  try {
    // Decode HTML entities in category field if present
    let bodyData = { ...req.body };
    if (bodyData.category) {
      bodyData.category = decodeHtmlEntities(bodyData.category);
    }

    // Ingredients can be shared (outletId optional) or kiosk-specific
    const data = await setOutletContext(req.user, bodyData, false);
    const ingredient = new Ingredient(data);
    await ingredient.save();
    await ingredient.populate("cartId", "name cafeName");

    // Emit socket event for real-time sync
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    if (ingredient.outletId) {
      emitToCafe(
        io,
        ingredient.outletId.toString(),
        "ingredient:created",
        ingredient
      );
    }

    res.status(201).json({ success: true, data: ingredient });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

/**
 * @route   PUT /api/costing-v2/ingredients/:id
 * @desc    Update ingredient
 */
exports.updateIngredient = async (req, res) => {
  try {
    // First find the ingredient to check access
    const existingIngredient = await Ingredient.findById(req.params.id);
    if (!existingIngredient) {
      return res
        .status(404)
        .json({ success: false, message: "Ingredient not found" });
    }

    // Check access control - cart admins can only update their own ingredients
    if (req.user.role === "admin") {
      if (
        existingIngredient.outletId &&
        existingIngredient.outletId.toString() !== req.user._id.toString()
      ) {
        return res.status(403).json({
          success: false,
          message:
            "Access denied. You can only update ingredients belonging to your cart.",
        });
      }
    }

    // Decode HTML entities in category field if present
    let updateData = { ...req.body };
    if (updateData.category) {
      updateData.category = decodeHtmlEntities(updateData.category);
    }

    // Update the ingredient
    const ingredient = await Ingredient.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    );

    if (!ingredient) {
      return res
        .status(404)
        .json({ success: false, message: "Ingredient not found" });
    }

    // Emit socket event for real-time sync
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    if (ingredient.outletId) {
      emitToCafe(
        io,
        ingredient.outletId.toString(),
        "ingredient:updated",
        ingredient
      );

      // Also sync to inventory if linked
      try {
        const InventoryItem = require("../../models/inventoryModel");
        const linkedInventory = await InventoryItem.findOne({
          ingredientId: ingredient._id,
        });
        if (linkedInventory) {
          // Update inventory item with ingredient data
          linkedInventory.quantity =
            ingredient.qtyOnHand || linkedInventory.quantity;
          linkedInventory.minStockLevel =
            ingredient.reorderLevel || linkedInventory.minStockLevel;
          linkedInventory.unitPrice =
            ingredient.currentCostPerBaseUnit || linkedInventory.unitPrice;
          await linkedInventory.save();
          emitToCafe(
            io,
            ingredient.outletId.toString(),
            "inventory:updated",
            linkedInventory
          );
        }
      } catch (syncError) {
        console.error(
          "[COSTING] Error syncing ingredient to inventory:",
          syncError
        );
        // Don't fail the request if sync fails
      }
    }

    res.json({ success: true, data: ingredient });
  } catch (error) {
    console.error("[COSTING] Update ingredient error:", error);
    res.status(400).json({
      success: false,
      message: error.message || "Failed to update ingredient",
    });
  }
};

/**
 * @route   DELETE /api/costing-v2/ingredients/:id
 * @desc    Delete ingredient
 */
exports.deleteIngredient = async (req, res) => {
  try {
    // First find the ingredient to check access and validate
    const ingredient = await Ingredient.findById(req.params.id);
    if (!ingredient) {
      return res
        .status(404)
        .json({ success: false, message: "Ingredient not found" });
    }

    // Check access control
    if (req.user.role === "admin") {
      // If ingredient has outletId, it must match the cart admin's ID
      if (
        ingredient.outletId &&
        ingredient.outletId.toString() !== req.user._id.toString()
      ) {
        return res.status(403).json({
          success: false,
          message:
            "Access denied: You can only delete ingredients belonging to your cart",
        });
      }
      // If ingredient is shared (outletId is null), cart admin cannot delete it
      if (!ingredient.outletId) {
        return res.status(403).json({
          success: false,
          message: "Access denied: You cannot delete shared ingredients",
        });
      }
    } else if (req.user.role === "franchise_admin") {
      // Franchise admin can delete ingredients from their franchise carts
      if (ingredient.outletId) {
        const outlet = await User.findById(ingredient.outletId);
        if (
          !outlet ||
          outlet.franchiseId?.toString() !== req.user._id.toString()
        ) {
          return res.status(403).json({
            success: false,
            message:
              "Access denied: You can only delete ingredients from your franchise carts",
          });
        }
      } else if (
        ingredient.franchiseId &&
        ingredient.franchiseId.toString() !== req.user._id.toString()
      ) {
        return res.status(403).json({
          success: false,
          message:
            "Access denied: You can only delete ingredients from your franchise",
        });
      }
    }

    // Check if ingredient is used in recipes
    const Recipe = require("../../models/costing-v2/recipeModel");
    const recipesUsingIngredient = await Recipe.find({
      "ingredients.ingredientId": ingredient._id,
    });

    if (recipesUsingIngredient.length > 0) {
      // Instead of blocking deletion, automatically remove this ingredient
      // from all BOMs/recipes that reference it.
      console.log(
        `[COSTING] Deleting ingredient ${ingredient._id} used in ${recipesUsingIngredient.length} recipe(s). Removing from BOMs.`
      );

      for (const recipe of recipesUsingIngredient) {
        recipe.ingredients = recipe.ingredients.filter(
          (ing) =>
            !ing.ingredientId ||
            ing.ingredientId.toString() !== ingredient._id.toString()
        );
        await recipe.save();
      }
    }

    // Check if ingredient has active inventory transactions
    const InventoryTransaction = require("../../models/costing-v2/inventoryTransactionModel");
    const hasTransactions = await InventoryTransaction.exists({
      ingredientId: ingredient._id,
    });

    if (hasTransactions) {
      // Allow deletion but warn - or we could prevent it
      console.log(
        `[COSTING] Warning: Deleting ingredient ${ingredient._id} with existing inventory transactions`
      );
    }

    // Delete the ingredient
    await Ingredient.findByIdAndDelete(req.params.id);

    // Emit socket event for real-time sync
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    if (ingredient.outletId) {
      emitToCafe(io, ingredient.outletId.toString(), "ingredient:deleted", {
        id: ingredient._id,
      });
    }

    res.json({ success: true, message: "Ingredient deleted successfully" });
  } catch (error) {
    console.error("[COSTING] Delete ingredient error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to delete ingredient",
    });
  }
};

/**
 * @route   GET /api/costing-v2/ingredients/:id/fifo-layers
 * @desc    Get FIFO layers for ingredient
 */
exports.getFIFOLayers = async (req, res) => {
  try {
    // First verify the ingredient exists and check access
    const ingredient = await Ingredient.findById(req.params.id);
    if (!ingredient) {
      return res
        .status(404)
        .json({ success: false, message: "Ingredient not found" });
    }

    // Check access control - cart admins can only view FIFO for their own ingredients
    if (req.user.role === "admin") {
      if (
        ingredient.outletId &&
        ingredient.outletId.toString() !== req.user._id.toString()
      ) {
        return res.status(403).json({
          success: false,
          message:
            "Access denied. You can only view FIFO layers for ingredients belonging to your cart.",
        });
      }
    }

    // Get FIFO layers
    const layers = await FIFOService.getLayers(req.params.id);
    res.json({ success: true, data: layers || [] });
  } catch (error) {
    console.error("[COSTING] Get FIFO layers error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch FIFO layers",
    });
  }
};

// ==================== PURCHASES ====================

/**
 * @route   GET /api/costing-v2/purchases
 * @desc    Get all purchases
 */
exports.getPurchases = async (req, res) => {
  try {
    const { status, supplierId, from, to, outletId } = req.query;
    const filter = {};

    if (status) filter.status = status;
    if (supplierId) filter.supplierId = supplierId;
    if (outletId) filter.cartId = outletId;
    if (from || to) {
      filter.date = {};
      if (from) filter.date.$gte = new Date(from);
      if (to) filter.date.$lte = new Date(to);
    }

    // Apply role-based filtering
    const costingFilter = await buildCostingQuery(req.user, filter);

    const purchases = await Purchase.find(costingFilter)
      .populate("supplierId", "name")
      .populate("items.ingredientId", "name uom baseUnit")
      .populate("receivedBy", "name email")
      .populate("cartId", "name cafeName")
      .sort({ date: -1 });

    res.json({ success: true, data: purchases });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   POST /api/costing-v2/purchases
 * @desc    Create purchase order
 */
exports.createPurchase = async (req, res) => {
  try {
    const { items, ...purchaseData } = req.body;

    // Set outlet context based on user role
    const data = await setOutletContext(req.user, purchaseData);

    // Calculate totals
    let totalAmount = 0;
    const purchaseItems = [];

    for (const item of items) {
      const total = item.qty * item.unitPrice;
      totalAmount += total;
      purchaseItems.push({
        ingredientId: item.ingredientId,
        qty: item.qty,
        uom: item.uom,
        unitPrice: item.unitPrice,
        total,
      });
    }

    const purchase = new Purchase({
      ...data,
      items: purchaseItems,
      totalAmount,
      status: "created",
    });

    await purchase.save();
    await purchase.populate("supplierId", "name");
    await purchase.populate("items.ingredientId", "name uom");
    await purchase.populate("cartId", "name cafeName");

    res.status(201).json({ success: true, data: purchase });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

/**
 * @route   POST /api/costing-v2/purchases/:id/receive
 * @desc    Receive purchase and update inventory (FIFO)
 */
exports.receivePurchase = async (req, res) => {
  try {
    const purchase = await Purchase.findById(req.params.id);
    if (!purchase) {
      return res
        .status(404)
        .json({ success: false, message: "Purchase not found" });
    }

    // Validate outlet access
    if (!(await validateOutletAccess(req.user, purchase.cartId))) {
      return res
        .status(403)
        .json({ success: false, message: "Access denied to this purchase" });
    }

    if (purchase.status === "received") {
      return res
        .status(400)
        .json({ success: false, message: "Purchase already received" });
    }

    // Track which ingredients were purchased for BOM recalculation
    const purchasedIngredientIds = [];

    // Process each item: update weighted average cost and update inventory
    for (const item of purchase.items) {
      const ingredient = await Ingredient.findById(item.ingredientId);
      if (!ingredient) continue;

      purchasedIngredientIds.push(item.ingredientId);

      // Convert to base unit
      const qtyInBaseUnit = ingredient.convertToBaseUnit(item.qty, item.uom);
      
      // Calculate unit cost in base unit
      // Formula: unitCostInBaseUnit = unitPrice (per display unit) / conversionFactor (display units per base unit)
      // Example: If unitPrice is ₹608.26/kg and baseUnit is "g":
      //   convertToBaseUnit(1, "kg") = 1000 (grams in 1 kg)
      //   unitCostInBaseUnit = 608.26 / 1000 = 0.60826 per gram ✓
      const conversionFactor = ingredient.convertToBaseUnit(1, item.uom);
      const unitCostInBaseUnit = item.unitPrice / conversionFactor;
      
      // Validate the calculated cost is reasonable
      // For ingredients with baseUnit "g" or "ml", cost per base unit should typically be < 100
      // If it's > 100, it might indicate the calculation is wrong
      if ((ingredient.baseUnit === 'g' || ingredient.baseUnit === 'ml') && unitCostInBaseUnit > 100) {
        console.error(`[PURCHASE COST ERROR] ${ingredient.name}: Calculated cost per ${ingredient.baseUnit} is ₹${unitCostInBaseUnit.toFixed(6)}, which seems too high. Unit price: ₹${item.unitPrice}/${item.uom}, Conversion factor: ${conversionFactor}`);
      }
      
      // Always log purchase cost calculation for debugging
      console.log(`[PURCHASE] ${ingredient.name}: unitPrice=₹${item.unitPrice}/${item.uom}, baseUnit=${ingredient.baseUnit}, conversionFactor=${conversionFactor}, unitCostInBaseUnit=₹${unitCostInBaseUnit.toFixed(6)}/${ingredient.baseUnit}`);

      // Update weighted average cost
      // Use cartId for weighted average calculation
      const cartId = purchase.cartId || null;
      const weightedAvgResult = await WeightedAverageService.updateWeightedAverage(
        item.ingredientId,
        qtyInBaseUnit,
        unitCostInBaseUnit,
        cartId
      );

      // Calculate cost allocated using the actual purchase cost (not weighted average)
      // The transaction should record the actual cost of this purchase
      // The weighted average is used to update ingredient.currentCostPerBaseUnit
      // IMPORTANT: costAllocated = qtyInBaseUnit × unitCostInBaseUnit
      // This is the total cost for this purchase transaction
      // When calculating weighted average in inventory: weightedAvgCost = costAllocated / qtyInBaseUnit
      // This should equal unitCostInBaseUnit, ensuring consistency
      const costAllocated = qtyInBaseUnit * unitCostInBaseUnit;
      
      // Validate costAllocated calculation
      if (process.env.NODE_ENV === 'development') {
        const expectedCost = item.unitPrice * item.qty; // Total purchase cost
        const calculatedCost = costAllocated;
        if (Math.abs(expectedCost - calculatedCost) > 0.01) {
          console.warn(`[PURCHASE] ${ingredient.name}: Cost mismatch! Expected: ₹${expectedCost.toFixed(2)}, Calculated: ₹${calculatedCost.toFixed(2)}. qtyInBaseUnit=${qtyInBaseUnit}, unitCostInBaseUnit=${unitCostInBaseUnit.toFixed(6)}`);
        }
      }

      // Create inventory transaction
      const transaction = new InventoryTransaction({
        ingredientId: item.ingredientId,
        type: "IN",
        qty: item.qty, // Original quantity
        uom: item.uom, // Original unit
        qtyInBaseUnit: qtyInBaseUnit, // Quantity in base unit
        refType: "purchase",
        refId: purchase._id,
        date: new Date(),
        costAllocated: costAllocated, // Use weighted average cost
        recordedBy: req.user._id,
        cartId: purchase.cartId || null,
      });
      await transaction.save();
      // #region agent log
      logDebug(
        "costingController.js:776",
        "Inventory transaction created",
        {
          transactionId: transaction._id,
          ingredientId: item.ingredientId,
          ingredientName: ingredient.name,
          outletId: purchase.cartId,
          purchaseId: purchase._id,
          qty: qtyInBaseUnit,
          costAllocated: transaction.costAllocated,
        },
        "B"
      );
      // #endregion
    }

    // Update purchase status
    purchase.status = "received";
    purchase.receivedDate = new Date();
    purchase.receivedBy = req.user._id;
    await purchase.save();

    // Recalculate costs for all BOMs that use the purchased ingredients
    // This ensures BOM costs are updated when purchases are received
    if (purchasedIngredientIds.length > 0) {
      // Small delay to ensure all transactions are committed to database
      // This prevents race conditions where BOM recalculation happens before transactions are visible
      await new Promise((resolve) => setTimeout(resolve, 100));
      // #region agent log
      logDebug(
        "costingController.js:760",
        "Recalculating BOMs after purchase",
        {
          purchaseId: purchase._id,
          outletId: purchase.cartId,
          ingredientIds: purchasedIngredientIds,
        },
        "B"
      );
      // #endregion
      // Find all recipes that use any of the purchased ingredients
      const affectedRecipes = await Recipe.find({
        "ingredients.ingredientId": { $in: purchasedIngredientIds },
      });

      // #region agent log
      logDebug(
        "costingController.js:768",
        "Found affected BOMs",
        {
          recipeCount: affectedRecipes.length,
          recipeIds: affectedRecipes.map((r) => r._id),
        },
        "B"
      );
      // #endregion

      // Recalculate costs for each affected recipe
      for (const recipe of affectedRecipes) {
        // Use outletId from purchase to recalculate outlet-specific costs
        const outletIdForRecalc = purchase.cartId || null;
        await recipe.calculateCost(outletIdForRecalc);
        await recipe.save();
        // #region agent log
        logDebug(
          "costingController.js:777",
          "BOM cost updated after purchase",
          {
            recipeId: recipe._id,
            recipeName: recipe.name,
            totalCost: recipe.totalCostCached,
            costPerPortion: recipe.costPerPortion,
            outletId: outletIdForRecalc,
          },
          "B"
        );
        // #endregion
      }
    }

    await purchase.populate("supplierId", "name");
    await purchase.populate("items.ingredientId", "name uom");

    res.json({ success: true, data: purchase });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// ==================== INVENTORY ====================

/**
 * @route   POST /api/costing-v2/inventory/consume
 * @desc    Consume ingredient (for recipes or manual usage)
 */
exports.consumeInventory = async (req, res) => {
  try {
    const { ingredientId, qty, uom, refType, refId, outletId } = req.body;

    const ingredient = await Ingredient.findById(ingredientId);
    if (!ingredient) {
      return res
        .status(404)
        .json({ success: false, message: "Ingredient not found" });
    }

    // For cart admin, always use their own outletId
    // For franchise admin and super admin, use provided outletId or validate
    let finalOutletId = outletId;
    if (req.user.role === "admin") {
      // Cart admin - always use their own kiosk
      finalOutletId = req.user._id;
    } else if (req.user.role === "franchise_admin") {
      // Franchise admin - must provide outletId
      if (!outletId) {
        return res.status(400).json({
          success: false,
          message: "outletId is required for franchise admin",
        });
      }
      if (!(await validateOutletAccess(req.user, outletId))) {
        return res
          .status(403)
          .json({ success: false, message: "Access denied to this kiosk" });
      }
      finalOutletId = outletId;
    } else if (req.user.role === "super_admin") {
      // Super admin - must provide outletId
      if (!outletId) {
        return res.status(400).json({
          success: false,
          message: "outletId is required for super admin",
        });
      }
      finalOutletId = outletId;
    }

    // Convert to base unit
    const qtyInBaseUnit = ingredient.convertToBaseUnit(qty, uom);

    // Consume using weighted average
    const result = await WeightedAverageService.consume(
      ingredientId,
      qtyInBaseUnit,
      refType || "manual",
      refId || null,
      req.user._id,
      finalOutletId
    );

    // Create inventory transaction
    const transaction = new InventoryTransaction({
      ingredientId: ingredientId,
      type: "OUT",
      qty: qty,
      uom: uom,
      qtyInBaseUnit: qtyInBaseUnit,
      refType: refType || "manual",
      refId: refId || null,
      date: new Date(),
      costAllocated: result.costAllocated,
      recordedBy: req.user._id,
      cartId: finalOutletId,
    });
    await transaction.save();

    res.json({ success: true, data: { ...result, transaction } });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

/**
 * @route   POST /api/costing-v2/inventory/return
 * @desc    Return ingredient to inventory
 */
exports.returnToInventory = async (req, res) => {
  try {
    const { ingredientId, qty, uom, refType, refId, originalTransactionId, outletId, notes } = req.body;

    const ingredient = await Ingredient.findById(ingredientId);
    if (!ingredient) {
      return res
        .status(404)
        .json({ success: false, message: "Ingredient not found" });
    }

    // For cart admin, always use their own outletId
    // For franchise admin and super admin, use provided outletId or validate
    let finalOutletId = outletId;
    if (req.user.role === "admin") {
      // Cart admin - always use their own kiosk
      finalOutletId = req.user._id;
    } else if (req.user.role === "franchise_admin") {
      // Franchise admin - must provide outletId
      if (!outletId) {
        return res.status(400).json({
          success: false,
          message: "outletId is required for franchise admin",
        });
      }
      if (!(await validateOutletAccess(req.user, outletId))) {
        return res
          .status(403)
          .json({ success: false, message: "Access denied to this kiosk" });
      }
      finalOutletId = outletId;
    } else if (req.user.role === "super_admin") {
      // Super admin - must provide outletId
      if (!outletId) {
        return res.status(400).json({
          success: false,
          message: "outletId is required for super admin",
        });
      }
      finalOutletId = outletId;
    }

    // Convert to base unit
    const qtyInBaseUnit = ingredient.convertToBaseUnit(qty, uom);

    // Return to inventory using weighted average
    const result = await WeightedAverageService.returnToInventory(
      ingredientId,
      qtyInBaseUnit,
      refType || "manual",
      refId || null,
      req.user._id,
      finalOutletId
    );

    // Create inventory transaction
    const transaction = new InventoryTransaction({
      ingredientId: ingredientId,
      type: "RETURN",
      qty: qty,
      uom: uom,
      qtyInBaseUnit: qtyInBaseUnit,
      originalTransactionId: originalTransactionId || null,
      refType: refType || "manual",
      refId: refId || null,
      date: new Date(),
      costAllocated: result.costAllocated,
      notes: notes || "",
      recordedBy: req.user._id,
      cartId: finalOutletId,
    });
    await transaction.save();

    res.json({ success: true, data: { ...result, transaction } });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

/**
 * @route   GET /api/costing-v2/inventory/transactions
 * @desc    Get inventory transactions
 */
exports.getInventoryTransactions = async (req, res) => {
  try {
    const { ingredientId, type, from, to, outletId } = req.query;
    const filter = {};

    if (ingredientId) filter.ingredientId = ingredientId;
    if (type) filter.type = type;
    if (from || to) {
      filter.date = {};
      if (from) filter.date.$gte = new Date(from);
      if (to) filter.date.$lte = new Date(to);
    }

    // Apply role-based filtering for cartId only (inventory transactions don't have franchiseId)
    if (req.user.role === "admin") {
      // Cart admin - only see their own kiosk's transactions
      filter.cartId = req.user._id;
    } else if (req.user.role === "franchise_admin") {
      // Franchise admin - can filter by specific outlet or see all their franchise outlets
      if (outletId) {
        // Validate outlet belongs to their franchise
        const outlet = await User.findById(outletId);
        if (
          !outlet ||
          outlet.franchiseId?.toString() !== req.user._id.toString()
        ) {
          return res.status(403).json({
            success: false,
            message: "Access denied: Kiosk does not belong to your franchise",
          });
        }
        filter.cartId = outletId;
      } else {
        // Get all kiosks under franchise
        const outlets = await User.find({
          role: "admin",
          franchiseId: req.user._id,
          isActive: true,
        }).select("_id");
        filter.cartId = { $in: outlets.map((o) => o._id) };
      }
    } else if (req.user.role === "super_admin") {
      // Super admin - can filter by outlet or see all
      if (outletId) {
        filter.cartId = outletId;
      }
      // If no outletId specified, show all transactions
    }

    const transactions = await InventoryTransaction.find(filter)
      .populate("ingredientId", "name uom category storageLocation")
      .populate("recordedBy", "name email")
      .populate("cartId", "name cafeName")
      .sort({ date: -1 })
      .limit(1000); // Pagination can be added later

    res.json({ success: true, data: transactions });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   GET /api/costing-v2/inventory
 * @desc    Get inventory items from costing-v2 ingredients for mobile app
 */
exports.getCostingInventory = async (req, res) => {
  try {
    const Employee = require("../../models/employeeModel");

    // Get cafeId for mobile users (waiter, cook, captain, manager)
    let outletId = null;
    if (["waiter", "cook", "captain", "manager"].includes(req.user?.role)) {
      // Mobile users - get cafeId from user or employee record
      if (req.user.cafeId) {
        outletId = req.user.cafeId;
      } else {
        // Fallback: find employee by email
        const employee = await Employee.findOne({
          email: req.user.email?.toLowerCase(),
        }).lean();
        if (employee && employee.cafeId) {
          outletId = employee.cafeId;
        }
      }

      if (!outletId) {
        return res.status(403).json({
          success: false,
          message: "No cafe associated with this user",
        });
      }
    } else if (req.user.role === "admin") {
      // Cart admin - use their own ID as outletId
      outletId = req.user._id;
    }

    // Build filter for ingredients
    const filter = { isActive: true };
    if (outletId) {
      filter.outletId = outletId;
    }

    // Apply role-based filtering
    const shouldSkipOutletFilter =
      (req.user.role === "franchise_admin" ||
        req.user.role === "super_admin") &&
      !outletId;
    const costingFilter = await buildCostingQuery(req.user, filter, {
      skipOutletFilter: shouldSkipOutletFilter,
    });

    // Get ingredients for this cart/cafe/kiosk
    const ingredients = await Ingredient.find(costingFilter)
      .select(
        "name category uom qtyOnHand reorderLevel currentCostPerBaseUnit storageLocation updatedAt"
      )
      .sort({ category: 1, name: 1 })
      .lean();

    // Format ingredients as inventory items for the app
    const inventoryItems = ingredients.map((ing) => ({
      _id: ing._id,
      name: ing.name,
      category: ing.category,
      quantity: ing.qtyOnHand || 0,
      unit: ing.uom,
      minStockLevel: ing.reorderLevel || 0,
      unitPrice: ing.currentCostPerBaseUnit || 0,
      location: ing.storageLocation || "Main Storage",
      updatedAt: ing.updatedAt
        ? ing.updatedAt.toISOString()
        : new Date().toISOString(),
      // Additional fields for compatibility
      minStock: ing.reorderLevel || 0,
      ingredientId: ing._id,
      // Add cafeId for filtering
      cafeId: outletId || ing.outletId,
    }));

    console.log(
      "[COSTING] getCostingInventory - Found items:",
      inventoryItems.length,
      "for outletId:",
      outletId
    );

    res.json({
      success: true,
      data: inventoryItems,
    });
  } catch (error) {
    console.error("[COSTING] Get inventory error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   GET /api/costing-v2/low-stock
 * @desc    Get ingredients below reorder level
 */
exports.getLowStock = async (req, res) => {
  try {
    // Apply role-based filtering
    // For cart admins, only show low stock items from their cart (filter by outletId)
    // For franchise/super admins, can see all low stock items or filter by outletId
    const shouldSkipOutletFilter =
      req.user.role === "franchise_admin" || req.user.role === "super_admin";
    const filter = await buildCostingQuery(
      req.user,
      { isActive: true },
      { skipOutletFilter: shouldSkipOutletFilter }
    );

    // Log filtering for debugging
    if (req.user.role === "admin") {
      console.log(
        "[GET_LOW_STOCK] Cart admin filter - outletId:",
        req.user._id.toString()
      );
    }

    const ingredients = await Ingredient.find(filter);
    const lowStock = ingredients.filter(
      (ing) => ing.qtyOnHand <= ing.reorderLevel
    );

    res.json({ success: true, data: lowStock });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ==================== WASTE ====================

/**
 * @route   POST /api/costing-v2/waste
 * @desc    Record waste
 */
exports.recordWaste = async (req, res) => {
  try {
    const { ingredientId, qty, uom, reason, reasonDetails, outletId } =
      req.body;

    const ingredient = await Ingredient.findById(ingredientId);
    if (!ingredient) {
      return res
        .status(404)
        .json({ success: false, message: "Ingredient not found" });
    }

    // For cart admin, always use their own outletId
    // For franchise admin and super admin, use provided outletId or validate
    let finalOutletId = outletId;
    if (req.user.role === "admin") {
      // Cart admin - always use their own kiosk
      finalOutletId = req.user._id;
    } else if (req.user.role === "franchise_admin") {
      // Franchise admin - must provide outletId
      if (!outletId) {
        return res.status(400).json({
          success: false,
          message: "outletId is required for franchise admin",
        });
      }
      if (!(await validateOutletAccess(req.user, outletId))) {
        return res
          .status(403)
          .json({ success: false, message: "Access denied to this kiosk" });
      }
      finalOutletId = outletId;
    } else if (req.user.role === "super_admin") {
      // Super admin - must provide outletId
      if (!outletId) {
        return res.status(400).json({
          success: false,
          message: "outletId is required for super admin",
        });
      }
      finalOutletId = outletId;
    }

    // Convert to base unit
    const qtyInBaseUnit = ingredient.convertToBaseUnit(qty, uom);

    // Consume using weighted average to get cost
    // Allow negative stock for waste tracking (waste can exceed available stock for accounting purposes)
    const consumeResult = await WeightedAverageService.consume(
      ingredientId,
      qtyInBaseUnit,
      "waste",
      null,
      req.user._id,
      finalOutletId,
      true // allowNegativeStock = true for waste
    );

    // Create inventory transaction for waste
    // This is critical for inventory tracking and cost calculations
    const transaction = new InventoryTransaction({
      ingredientId,
      type: "WASTE",
      qty: qty, // Original quantity
      uom: uom, // Original unit
      qtyInBaseUnit: qtyInBaseUnit, // Quantity in base unit
      refType: "waste",
      refId: null, // Will link to waste record after creation
      date: new Date(),
      costAllocated: consumeResult.costAllocated,
      recordedBy: req.user._id,
      cartId: finalOutletId || null, // Use cartId for consistency
    });
    await transaction.save();

    // Get franchiseId for waste record
    let franchiseId = null;
    if (finalOutletId) {
      const outlet = await User.findById(finalOutletId);
      if (outlet) franchiseId = outlet.franchiseId;
    } else if (req.user.role === "franchise_admin") {
      franchiseId = req.user._id;
    }

    // Create waste record
    const waste = new Waste({
      ingredientId,
      qty: qtyInBaseUnit,
      uom: ingredient.baseUnit,
      reason,
      reasonDetails: reasonDetails || "",
      date: new Date(),
      costAllocated: consumeResult.costAllocated,
      recordedBy: req.user._id,
      cartId: finalOutletId || null, // Use cartId for consistency
    });

    await waste.save();
    
    // Update transaction with waste record ID
    transaction.refId = waste._id;
    await transaction.save();

    await waste.populate("ingredientId", "name uom");

    res.status(201).json({ success: true, data: waste });
  } catch (error) {
    console.error("[WASTE] Error recording waste:", error);
    res.status(400).json({ success: false, message: error.message });
  }
};

/**
 * @route   GET /api/costing-v2/waste
 * @desc    Get waste records
 */
exports.getWaste = async (req, res) => {
  try {
    const { ingredientId, from, to, outletId } = req.query;
    const filter = {};

    if (ingredientId) filter.ingredientId = ingredientId;
    if (from || to) {
      filter.date = {};
      if (from) filter.date.$gte = new Date(from);
      if (to) filter.date.$lte = new Date(to);
    }

    // Apply role-based filtering for cartId
    if (req.user.role === "admin") {
      // Cart admin - only see their own kiosk's waste records
      filter.cartId = req.user._id;
    } else if (req.user.role === "franchise_admin") {
      // Franchise admin - can filter by specific outlet or see all their franchise outlets
      if (outletId) {
        // Validate outlet belongs to their franchise
        const outlet = await User.findById(outletId);
        if (
          !outlet ||
          outlet.franchiseId?.toString() !== req.user._id.toString()
        ) {
          return res.status(403).json({
            success: false,
            message: "Access denied: Kiosk does not belong to your franchise",
          });
        }
        filter.cartId = outletId;
      } else {
        // Get all kiosks under franchise
        const outlets = await User.find({
          role: "admin",
          franchiseId: req.user._id,
          isActive: true,
        }).select("_id");
        filter.cartId = { $in: outlets.map((o) => o._id) };
      }
    } else if (req.user.role === "super_admin") {
      // Super admin - can filter by outlet or see all
      if (outletId) {
        filter.cartId = outletId;
      }
      // If no outletId specified, show all waste records
    }

    const waste = await Waste.find(filter)
      .populate("ingredientId", "name uom")
      .populate("recordedBy", "name email")
      .populate("cartId", "name cafeName")
      .sort({ date: -1 });

    res.json({ success: true, data: waste });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ==================== RECIPES ====================

/**
 * @route   GET /api/costing-v2/recipes
 * @desc    Get all recipes
 */
exports.getRecipes = async (req, res) => {
  try {
    // #region agent log
    logDebug(
      "costingController.js:1176",
      "getRecipes called",
      { userId: req.user?._id, role: req.user?.role },
      "A"
    );
    // #endregion
    const { isActive, search, outletId } = req.query;
    const filter = {};

    if (isActive !== undefined) filter.isActive = isActive === "true";
    if (search) filter.name = { $regex: search, $options: "i" };
    if (outletId) filter.cartId = outletId;

    // Apply role-based filtering (recipes can be shared or cart-specific)
    // For cart admin: only show recipes for their own cart OR global recipes (cartId: null)
    // For franchise_admin: show recipes for their franchise carts OR global recipes
    // For super_admin: only show global BOMs (cartId: null) unless filtering by specific outletId
    let costingFilter = { ...filter };
    if (req.user.role === "admin") {
      // Cart admin: only their own cart's recipes OR global recipes (cartId: null)
      // Remove cartId from filter if it was set, as we'll use $or instead
      delete costingFilter.cartId;
      
      // Build $or conditions: cart-specific recipes OR global recipes
      const orConditions = [
        { cartId: req.user._id }, // Cart-specific recipes
        { cartId: null }, // Global recipes (super admin BOMs)
        { cartId: { $exists: false } }, // Legacy recipes without cartId
      ];
      
      // If cart admin has a franchiseId, we need to handle franchiseId filtering carefully:
      // - For cart-specific recipes (cartId: req.user._id), match franchiseId
      // - For global recipes (cartId: null), allow regardless of franchiseId
      if (req.user.franchiseId) {
        // Use $and with $or to handle both cart-specific and global recipes
        costingFilter.$and = [
          {
            $or: [
              // Cart-specific recipes: must match cartId AND franchiseId
              {
                $and: [
                  { cartId: req.user._id },
                  { franchiseId: req.user.franchiseId },
                ],
              },
              // Global recipes: cartId is null, franchiseId can be null or match
              {
                $and: [
                  { $or: [{ cartId: null }, { cartId: { $exists: false } }] },
                  {
                    $or: [
                      { franchiseId: null },
                      { franchiseId: { $exists: false } },
                      { franchiseId: req.user.franchiseId },
                    ],
                  },
                ],
              },
            ],
          },
        ];
      } else {
        // No franchiseId: simple $or for cartId
        costingFilter.$or = orConditions;
      }
    } else if (req.user.role === "franchise_admin") {
      // Franchise admin: recipes for their franchise carts OR global recipes
      const franchiseCarts = await User.find({
        role: "admin",
        franchiseId: req.user._id,
        isActive: true,
      }).select("_id");
      const cartIds = franchiseCarts.map((c) => c._id);
      // Remove cartId from filter if it was set, as we'll use $or instead
      delete costingFilter.cartId;
      costingFilter.$or = [
        { cartId: { $in: cartIds } },
        { cartId: null },
        { cartId: { $exists: false } },
      ];
      costingFilter.franchiseId = req.user._id;
    } else if (req.user.role === "super_admin") {
      // Super admin: only global BOMs (cartId: null) unless filtering by specific outlet
      if (!outletId) {
        costingFilter.cartId = null;
      } else {
        costingFilter.cartId = outletId;
      }
    }

    const recipes = await Recipe.find(costingFilter)
      .populate(
        "ingredients.ingredientId",
        "name uom baseUnit currentCostPerBaseUnit"
      )
      .populate("cartId", "name cafeName")
      .sort({ name: 1 });

    // For Cart Admin, recalculate costs dynamically using their outletId
    // This ensures costs are based on outlet-specific purchases, not cached global values
    if (req.user.role === "admin") {
      // #region agent log
      logDebug(
        "costingController.js:1200",
        "Cart Admin - recalculating BOM costs",
        { outletId: req.user._id, recipeCount: recipes.length },
        "A"
      );
      // #endregion
      for (const recipe of recipes) {
        // Recalculate cost using Cart Admin's outletId
        await recipe.calculateCost(req.user._id);
        // #region agent log
        logDebug(
          "costingController.js:1205",
          "BOM cost recalculated",
          {
            recipeId: recipe._id,
            recipeName: recipe.name,
            totalCost: recipe.totalCostCached,
            costPerPortion: recipe.costPerPortion,
            outletId: req.user._id,
          },
          "A"
        );
        // #endregion
        // Don't save - just recalculate for display (saves are done on explicit recalculate action)
      }
    }

    res.json({ success: true, data: recipes });
  } catch (error) {
    // #region agent log
    logDebug(
      "costingController.js:1212",
      "getRecipes error",
      { error: error.message },
      "A"
    );
    // #endregion
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   POST /api/costing-v2/recipes
 * @desc    Create recipe
 */
exports.createRecipe = async (req, res) => {
  try {
    // Set outlet context (recipes can be shared, so outletId is optional)
    const data = await setOutletContext(req.user, { ...req.body }, false);

    // Check for duplicate BOM name for the same cart before creating
    const existingRecipe = await Recipe.findOne({
      name: data.name.trim(),
      cartId: data.cartId || null,
    });

    if (existingRecipe) {
      const cartInfo = data.cartId ? " for this cart" : " (global BOM)";
      return res.status(400).json({
        success: false,
        message: `A BOM with the name "${data.name}" already exists${cartInfo}. Please use a different name or edit the existing BOM.`,
      });
    }

    const recipe = new Recipe(data);

    // Calculate cost - for Cart Admin, use their cartId to check cart-specific purchases
    const cartIdForCost =
      req.user.role === "admin" ? req.user._id : data.cartId || null;
    await recipe.calculateCost(cartIdForCost);
    await recipe.save();

    await recipe.populate(
      "ingredients.ingredientId",
      "name uom baseUnit currentCostPerBaseUnit"
    );
    await recipe.populate("cartId", "name cafeName");

    res.status(201).json({ success: true, data: recipe });
  } catch (error) {
    // Handle MongoDB duplicate key error with a user-friendly message
    if (error.code === 11000) {
      const duplicateField = Object.keys(error.keyPattern || {})[0];
      return res.status(400).json({
        success: false,
        message: `A BOM with this name already exists for this outlet. Please use a different name or edit the existing BOM.`,
      });
    }
    res.status(400).json({ success: false, message: error.message });
  }
};

/**
 * @route   PUT /api/costing-v2/recipes/:id
 * @desc    Update recipe
 */
exports.updateRecipe = async (req, res) => {
  try {
    const recipe = await Recipe.findById(req.params.id);
    if (!recipe) {
      return res
        .status(404)
        .json({ success: false, message: "Recipe not found" });
    }

    Object.assign(recipe, req.body);

    // Recalculate cost - for Cart Admin, use their cartId to check cart-specific purchases
    const cartIdForCost =
      req.user.role === "admin"
        ? req.user._id
        : recipe.cartId || req.body.cartId || null;
    await recipe.calculateCost(cartIdForCost);
    await recipe.save();

    await recipe.populate(
      "ingredients.ingredientId",
      "name uom baseUnit currentCostPerBaseUnit"
    );

    // Update linked menu items
    await MenuItem.updateMany(
      { recipeId: recipe._id },
      { $set: { lastCostUpdate: new Date() } }
    );

    res.json({ success: true, data: recipe });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

/**
 * @route   POST /api/costing-v2/recipes/:id/calculate-cost
 * @desc    Recalculate recipe cost
 */
exports.recalculateRecipeCost = async (req, res) => {
  try {
    const recipe = await Recipe.findById(req.params.id);
    if (!recipe) {
      return res
        .status(404)
        .json({ success: false, message: "Recipe not found" });
    }

    // Recalculate cost - for Cart Admin, use their cartId to check cart-specific purchases
    const cartIdForCost =
      req.user.role === "admin" ? req.user._id : recipe.cartId || null;
    await recipe.calculateCost(cartIdForCost);
    await recipe.save();

    // Update linked menu items
    const menuItems = await MenuItem.find({ recipeId: recipe._id });
    for (const menuItem of menuItems) {
      menuItem.calculateMetrics(recipe.costPerPortion);
      await menuItem.save();
    }

    await recipe.populate(
      "ingredients.ingredientId",
      "name uom baseUnit currentCostPerBaseUnit"
    );

    res.json({ success: true, data: recipe });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

/**
 * @route   DELETE /api/costing-v2/recipes/:id
 * @desc    Delete recipe
 */
exports.deleteRecipe = async (req, res) => {
  try {
    const recipe = await Recipe.findById(req.params.id);
    if (!recipe) {
      return res
        .status(404)
        .json({ success: false, message: "Recipe not found" });
    }

    // Access control: Cart admin can only delete their own cart's recipes
    if (req.user.role === "admin") {
      if (recipe.cartId && recipe.cartId.toString() !== req.user._id.toString()) {
        return res.status(403).json({
          success: false,
          message: "Access denied. You can only delete recipes belonging to your cart.",
        });
      }
    } else if (req.user.role === "franchise_admin") {
      // Franchise admin can only delete recipes from their franchise carts
      if (recipe.cartId) {
        const cart = await User.findById(recipe.cartId);
        if (!cart || cart.franchiseId?.toString() !== req.user._id.toString()) {
          return res.status(403).json({
            success: false,
            message: "Access denied. You can only delete recipes belonging to your franchise carts.",
          });
        }
      } else if (recipe.franchiseId && recipe.franchiseId.toString() !== req.user._id.toString()) {
        return res.status(403).json({
          success: false,
          message: "Access denied. You can only delete recipes belonging to your franchise.",
        });
      }
    }

    // Find all menu items linked to this recipe
    const linkedMenuItems = await MenuItem.find({ recipeId: recipe._id });

    // If there are linked menu items, unlink them (set recipeId to null and reset cost metrics)
    if (linkedMenuItems.length > 0) {
      for (const menuItem of linkedMenuItems) {
        menuItem.recipeId = null;
        menuItem.costPerPortion = 0;
        menuItem.foodCostPercent = 0;
        menuItem.contributionMargin = menuItem.sellingPrice; // Margin = selling price when no cost
        menuItem.lastCostUpdate = new Date();
        await menuItem.save();
      }
      console.log(
        `[RECIPE DELETE] Unlinked ${linkedMenuItems.length} menu item(s) from recipe ${recipe.name}`
      );
    }

    // Delete the recipe
    await Recipe.findByIdAndDelete(req.params.id);

    res.json({
      success: true,
      message:
        linkedMenuItems.length > 0
          ? `Recipe deleted successfully. ${linkedMenuItems.length} menu item(s) have been unlinked.`
          : "Recipe deleted successfully",
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ==================== MENU ITEMS ====================

/**
 * @route   GET /api/costing-v2/menu-items
 * @desc    Get all menu items
 */
exports.getMenuItems = async (req, res) => {
  try {
    const { category, isActive, search, outletId } = req.query;
    const filter = {};

    if (category) filter.category = category;
    if (isActive !== undefined) filter.isActive = isActive === "true";
    if (search) filter.name = { $regex: search, $options: "i" };
    if (outletId) filter.cartId = outletId;

    // Apply role-based filtering (menu items are kiosk-specific)
    const costingFilter = await buildCostingQuery(req.user, filter);

    const menuItems = await MenuItem.find(costingFilter)
      .populate("recipeId", "name costPerPortion portions")
      .populate("cartId", "name cafeName")
      .sort({ category: 1, name: 1 });

    res.json({ success: true, data: menuItems });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   POST /api/costing-v2/menu-items
 * @desc    Create menu item
 */
exports.createMenuItem = async (req, res) => {
  try {
    // Convert empty strings to null for optional ObjectId fields
    const menuItemData = { ...req.body };
    if (
      menuItemData.recipeId === "" ||
      menuItemData.recipeId === null ||
      menuItemData.recipeId === undefined
    ) {
      menuItemData.recipeId = null;
    }

    const { recipeId, sellingPrice } = menuItemData;

    // Recipe is optional - if provided, validate it exists
    if (recipeId) {
      const recipe = await Recipe.findById(recipeId);
      if (!recipe) {
        return res
          .status(404)
          .json({ success: false, message: "Recipe not found" });
      }
    }

    // Set outlet context (menu items are kiosk-specific, outletRequired = true)
    // This ensures cartId and franchiseId are properly set
    const data = await setOutletContext(req.user, menuItemData, true);

    const menuItem = new MenuItem(data);

    // Set defaultMenuPath if default menu fields are provided
    if (
      menuItemData.defaultMenuFranchiseId &&
      menuItemData.defaultMenuCategoryName &&
      menuItemData.defaultMenuItemName
    ) {
      menuItem.defaultMenuPath = `${menuItemData.defaultMenuFranchiseId}/${menuItemData.defaultMenuCategoryName}/${menuItemData.defaultMenuItemName}`;
    }

    // Calculate metrics if recipe is provided
    if (recipeId) {
      const recipe = await Recipe.findById(recipeId);
      if (recipe) {
        // IMPORTANT: Recalculate recipe cost with correct cartId before using it
        // This ensures the cost matches the cart's purchase prices
        const cartIdForCost = req.user.role === "admin" ? req.user._id : (data.cartId || null);
        await recipe.calculateCost(cartIdForCost);
        await recipe.save();
        
        // Now use the recalculated cost for menu item metrics
        menuItem.calculateMetrics(recipe.costPerPortion);
      }
    } else {
      // No recipe - set default values
      menuItem.costPerPortion = 0;
      menuItem.foodCostPercent = 0;
      menuItem.contributionMargin = sellingPrice || 0;
    }

    await menuItem.save();

    await menuItem.populate("recipeId", "name costPerPortion portions");
    await menuItem.populate("cartId", "name cafeName");

    res.status(201).json({ success: true, data: menuItem });
  } catch (error) {
    console.error("[CREATE_MENU_ITEM] Error:", error);
    // Provide more detailed error message
    if (error.message.includes("required")) {
      return res.status(400).json({ 
        success: false, 
        message: `Validation error: ${error.message}. Please ensure all required fields are provided.` 
      });
    }
    res.status(400).json({ success: false, message: error.message });
  }
};

/**
 * @route   PUT /api/costing-v2/menu-items/:id
 * @desc    Update menu item
 */
exports.updateMenuItem = async (req, res) => {
  try {
    const menuItem = await MenuItem.findById(req.params.id);
    if (!menuItem) {
      return res
        .status(404)
        .json({ success: false, message: "Menu item not found" });
    }

    // Convert empty strings to null for optional ObjectId fields
    const updateData = { ...req.body };
    if (updateData.recipeId === "" || updateData.recipeId === null) {
      updateData.recipeId = null;
    }

    // Use recipeId from request body if provided, otherwise use existing recipeId
    const recipeIdToUse =
      updateData.recipeId !== undefined
        ? updateData.recipeId
        : menuItem.recipeId;

    // Validate recipe if provided
    if (recipeIdToUse) {
      const recipe = await Recipe.findById(recipeIdToUse);
      if (!recipe) {
        return res
          .status(404)
          .json({ success: false, message: "Recipe not found" });
      }
    }

    Object.assign(menuItem, updateData);

    // Ensure recipeId is set (can be null to unlink)
    menuItem.recipeId = recipeIdToUse || null;

    // Update defaultMenuPath if default menu fields are provided
    if (
      updateData.defaultMenuFranchiseId ||
      updateData.defaultMenuCategoryName ||
      updateData.defaultMenuItemName
    ) {
      const franchiseId =
        updateData.defaultMenuFranchiseId || menuItem.defaultMenuFranchiseId;
      const categoryName =
        updateData.defaultMenuCategoryName || menuItem.defaultMenuCategoryName;
      const itemName =
        updateData.defaultMenuItemName || menuItem.defaultMenuItemName;
      if (franchiseId && categoryName && itemName) {
        menuItem.defaultMenuPath = `${franchiseId}/${categoryName}/${itemName}`;
      }
    }

    // Calculate metrics if recipe is provided
    if (recipeIdToUse) {
      const recipe = await Recipe.findById(recipeIdToUse);
      if (recipe) {
        // IMPORTANT: Recalculate recipe cost with correct cartId before using it
        // This ensures the cost matches the cart's purchase prices
        const cartIdForCost = req.user.role === "admin" ? req.user._id : (menuItem.cartId || null);
        await recipe.calculateCost(cartIdForCost);
        await recipe.save();
        
        // Now use the recalculated cost for menu item metrics
        menuItem.calculateMetrics(recipe.costPerPortion);
      }
    } else {
      // No recipe - reset cost metrics
      menuItem.costPerPortion = 0;
      menuItem.foodCostPercent = 0;
      menuItem.contributionMargin = menuItem.sellingPrice || 0;
      menuItem.lastCostUpdate = new Date();
    }

    await menuItem.save();

    await menuItem.populate("recipeId", "name costPerPortion portions");

    res.json({ success: true, data: menuItem });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

/**
 * @route   DELETE /api/costing-v2/menu-items/:id
 * @desc    Delete menu item (cart admin only)
 */
exports.deleteMenuItem = async (req, res) => {
  try {
    // Only allow cart admin (admin role) to delete menu items
    if (req.user.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "Access denied. Only cart admin can delete menu items.",
      });
    }

    const menuItem = await MenuItem.findById(req.params.id);
    if (!menuItem) {
      return res
        .status(404)
        .json({ success: false, message: "Menu item not found" });
    }

    // Verify that the menu item belongs to the cart admin's outlet
    if (
      menuItem.outletId &&
      menuItem.outletId.toString() !== req.user._id.toString()
    ) {
      return res.status(403).json({
        success: false,
        message: "Access denied. You can only delete your own menu items.",
      });
    }

    await MenuItem.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: "Menu item deleted successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   GET /api/costing-v2/default-menu-items
 * @desc    Get default menu items for selection/import
 *          - Super admin: gets global default menu
 *          - Franchise admin: gets their franchise default menu
 *          - Cart admin: gets their cart menu items
 */
exports.getDefaultMenuItems = async (req, res) => {
  try {
    // For cart admin, get menu items from their operational menu (MenuItem with cafeId)
    if (req.user.role === "admin") {
      const userId = req.user._id;
      const userIdStr = userId.toString();

      // Cart admins use MenuItem model with cafeId = their _id
      // Get menu items for this cart admin
      const operationalMenuItems = await OperationalMenuItem.find({
        cafeId: userId,
      })
        .populate("category", "name")
        .sort({ sortOrder: 1, name: 1 })
        .lean();

      console.log(
        `[getDefaultMenuItems] Found ${operationalMenuItems.length} operational menu items for cart admin ${userId}`
      );

      // Get all categories for this cart admin to map IDs to names
      const categories = await MenuCategory.find({ cafeId: userId })
        .select("_id name")
        .lean();
      const categoryMap = new Map();
      categories.forEach((cat) => {
        categoryMap.set(cat._id.toString(), cat.name);
      });

      // Format menu items to match default menu item structure
      const menuItems = operationalMenuItems.map((item) => {
        // Handle category - it might be populated (object) or just an ID
        let categoryName = "Uncategorized";
        if (item.category) {
          if (typeof item.category === "object" && item.category.name) {
            categoryName = item.category.name;
          } else {
            // Category is just an ID, look it up in the map
            const categoryId = item.category.toString();
            categoryName = categoryMap.get(categoryId) || categoryId;
          }
        }

        return {
          name: item.name,
          category: categoryName,
          price: item.price,
          description: item.description || "",
          image: item.image || "",
          franchiseId: req.user.franchiseId || null,
          defaultMenuPath: `cart/${userIdStr}/${categoryName}/${item.name}`,
        };
      });

      return res.json({ success: true, data: menuItems });
    }

    // For super admin and franchise admin, get from default menu
    // Get franchise ID based on user role
    let franchiseId = null;
    if (req.user.role === "franchise_admin") {
      franchiseId = req.user._id;
    } else if (req.user.role === "super_admin") {
      // Super admin can access global menu (franchiseId = null) or specific franchise menu
      franchiseId = req.query.franchiseId || null;
    } else if (req.query.franchiseId) {
      franchiseId = req.query.franchiseId;
    }

    const defaultMenu = await DefaultMenu.getDefaultMenu(franchiseId);

    if (!defaultMenu || !defaultMenu.categories) {
      return res.json({ success: true, data: [] });
    }

    // Flatten menu items with their category info
    const menuItems = [];
    defaultMenu.categories.forEach((category) => {
      if (category.items && category.items.length > 0) {
        category.items.forEach((item) => {
          const franchiseIdStr = franchiseId
            ? franchiseId.toString()
            : "global";
          menuItems.push({
            name: item.name,
            category: category.name,
            price: item.price,
            description: item.description || "",
            image: item.image || "",
            franchiseId: franchiseId,
            defaultMenuPath: `${franchiseIdStr}/${category.name}/${item.name}`,
          });
        });
      }
    });

    res.json({ success: true, data: menuItems });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   POST /api/costing-v2/menu-items/import-from-default
 * @desc    Import menu items from default menu to costing
 */
exports.importFromDefaultMenu = async (req, res) => {
  try {
    const { items, recipeId, outletId } = req.body; // items: array of {name, category, franchiseId}

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "Items array is required" });
    }

    // Set outlet context
    const outletData = await setOutletContext(req.user, { outletId });

    // Get default menu to fetch prices
    const franchiseId = items[0]?.franchiseId || null;
    const defaultMenu = await DefaultMenu.getDefaultMenu(franchiseId);

    const importedItems = [];
    const errors = [];

    for (const item of items) {
      try {
        // Find the item in default menu to get price
        let sellingPrice = item.price || 0;
        if (defaultMenu && defaultMenu.categories) {
          const category = defaultMenu.categories.find(
            (c) => c.name === item.category
          );
          if (category && category.items) {
            const defaultItem = category.items.find(
              (i) => i.name === item.name
            );
            if (defaultItem && defaultItem.price) {
              sellingPrice = defaultItem.price;
            }
          }
        }

        // Check if menu item already exists
        const existingItem = await MenuItem.findOne(
          recipeId
            ? {
                name: item.name,
                category: item.category,
                outletId: outletData.outletId,
                defaultMenuPath: item.defaultMenuPath,
              }
            : {
                name: item.name,
                category: item.category,
                outletId: outletData.outletId,
              }
        );

        if (existingItem) {
          errors.push({ item: item.name, error: "Already exists" });
          continue;
        }

        // Create new menu item
        // #region agent log
        fetch(
          "http://127.0.0.1:7242/ingest/660a5fbf-4359-420f-956f-3831103456fb",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sessionId: "debug-session",
              runId: "import-menu-pre",
              hypothesisId: "H1",
              location: "costingController.js:1680",
              message: "About to create menu item from default",
              data: {
                userRole: req.user.role,
                outletId: outletData.outletId,
                franchiseId: outletData.franchiseId,
                itemName: item.name,
                itemCategory: item.category,
                recipeId: recipeId || null,
              },
              timestamp: Date.now(),
            }),
          }
        ).catch(() => {});
        // #endregion agent log

        const menuItemData = {
          name: item.name,
          category: item.category,
          sellingPrice,
          outletId: outletData.outletId,
          franchiseId: outletData.franchiseId,
          defaultMenuFranchiseId: item.franchiseId || null,
          defaultMenuCategoryName: item.category,
          defaultMenuItemName: item.name,
          defaultMenuPath: item.defaultMenuPath,
        };

        if (recipeId) {
          menuItemData.recipeId = recipeId;
        }

        const menuItem = new MenuItem(menuItemData);

        // If a recipe is provided, use its costPerPortion for metrics.
        if (recipeId) {
          const recipe = await Recipe.findById(recipeId);
          if (recipe) {
            menuItem.calculateMetrics(recipe.costPerPortion);
          }
        }

        await menuItem.save();

        importedItems.push(menuItem);
      } catch (error) {
        errors.push({ item: item.name, error: error.message });
      }
    }

    res.json({
      success: true,
      data: {
        imported: importedItems.length,
        errors: errors.length,
        items: importedItems,
        errorDetails: errors,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   GET /api/costing-v2/outlets
 * @desc    Get available outlets/kiosks for the user
 */
exports.getOutlets = async (req, res) => {
  try {
    const outlets = await getAllowedOutlets(req.user);
    const outletDetails = await User.find({ _id: { $in: outlets } })
      .select("_id name cafeName email cartCode")
      .sort({ name: 1 });

    res.json({ success: true, data: outletDetails });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   GET /api/costing-v2/hierarchical-costing
 * @desc    Get hierarchical costing data (Franchise -> Kiosks) for super admin
 *          For franchise admin, returns their kiosks only
 */
exports.getHierarchicalCosting = async (req, res) => {
  try {
    // Super admin sees all franchises, franchise admin sees only their kiosks
    if (
      req.user.role !== "super_admin" &&
      req.user.role !== "franchise_admin"
    ) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    const { from, to } = req.query;
    // Note: dateFilter is not used directly - we apply date filters per data type
    // (transactions use 'date' field, orders use 'createdAt', labour/overhead use period ranges)

    let franchises = [];
    let kiosks = [];

    if (req.user.role === "super_admin") {
      // Super admin - get all franchises
      franchises = await User.find({ role: "franchise_admin", isActive: true })
        .select("_id name email franchiseCode")
        .sort({ name: 1 })
        .lean();

      // Get all kiosks
      kiosks = await User.find({ role: "admin", isActive: true })
        .select("_id name cafeName email franchiseId cartCode")
        .populate("franchiseId", "name")
        .sort({ cafeName: 1 })
        .lean();
    } else if (req.user.role === "franchise_admin") {
      // Franchise admin - only their own franchise
      const franchise = await User.findById(req.user._id)
        .select("_id name email franchiseCode")
        .lean();
      if (franchise) {
        franchises = [franchise];
      }

      // Get only kiosks under their franchise
      kiosks = await User.find({
        role: "admin",
        franchiseId: req.user._id,
        isActive: true,
      })
        .select("_id name cafeName email franchiseId cartCode")
        .populate("franchiseId", "name")
        .sort({ cafeName: 1 })
        .lean();
    }

    const hierarchicalData = [];

    for (const franchise of franchises) {
      const franchiseKiosks = kiosks.filter(
        (k) =>
          k.franchiseId &&
          k.franchiseId._id.toString() === franchise._id.toString()
      );

      const franchiseData = {
        franchiseId: franchise._id,
        franchiseName: franchise.name,
        franchiseCode: franchise.franchiseCode || "",
        kiosks: [],
        totals: {
          sales: 0,
          foodCost: 0,
          labourCost: 0,
          overheadCost: 0,
          expenseCost: 0,
          totalCost: 0,
          profit: 0,
          foodCostPercent: 0,
          profitMargin: 0,
        },
      };

      for (const kiosk of franchiseKiosks) {
        // Get P&L for this kiosk
        // Get food cost from inventory transactions
        // Use date field for transactions, ensure proper date filtering
        const transactionDateFilter = {};
        if (from || to) {
          transactionDateFilter.date = {};
          if (from) {
            const fromDate = new Date(from);
            fromDate.setHours(0, 0, 0, 0);
            transactionDateFilter.date.$gte = fromDate;
          }
          if (to) {
            const toDate = new Date(to);
            toDate.setHours(23, 59, 59, 999);
            transactionDateFilter.date.$lte = toDate;
          }
        }
        const consumptionTransactions = await InventoryTransaction.aggregate([
          {
            $match: {
              type: { $in: ["OUT", "WASTE"] },
              cartId: kiosk._id,
              ...transactionDateFilter,
            },
          },
          {
            $group: {
              _id: null,
              totalCost: { $sum: { $ifNull: ["$costAllocated", 0] } },
            },
          },
        ]);
        const foodCost = Number(
          (consumptionTransactions[0]?.totalCost || 0).toFixed(2)
        );

        // Get labour costs - filter by date range properly
        const labourFilter = { outletId: kiosk._id };
        if (from || to) {
          // Include labour costs that overlap with the date range
          const fromDate = from ? new Date(from) : new Date("1970-01-01");
          fromDate.setHours(0, 0, 0, 0);
          const toDate = to ? new Date(to) : new Date("2099-12-31");
          toDate.setHours(23, 59, 59, 999);
          labourFilter.$or = [
            {
              periodFrom: { $lte: toDate },
              periodTo: { $gte: fromDate },
            },
          ];
        }
        const labourCosts = await LabourCost.find(labourFilter).lean();
        const labourCost = Number(
          labourCosts
            .reduce((sum, l) => sum + (Number(l.amount) || 0), 0)
            .toFixed(2)
        );

        // Get overheads - same filter as labour
        const overheadFilter = { ...labourFilter };
        const overheads = await Overhead.find(overheadFilter).lean();
        const overheadCost = Number(
          overheads
            .reduce((sum, o) => sum + (Number(o.amount) || 0), 0)
            .toFixed(2)
        );

        // Get expenses for this kiosk in the date range
        const expenseFilter = { outletId: kiosk._id };
        if (from || to) {
          expenseFilter.expenseDate = {};
          if (from) {
            const fromDate = new Date(from);
            fromDate.setHours(0, 0, 0, 0);
            expenseFilter.expenseDate.$gte = fromDate;
          }
          if (to) {
            const toDate = new Date(to);
            toDate.setHours(23, 59, 59, 999);
            expenseFilter.expenseDate.$lte = toDate;
          }
        }
        const expenses = await CostingExpense.find(expenseFilter).lean();
        const expenseCost = Number(
          expenses
            .reduce((sum, e) => sum + (Number(e.amount) || 0), 0)
            .toFixed(2)
        );

        // Get sales from orders (use cartId, not cafeId)
        // Include "Exit" status for takeaway orders that are completed
        const orderFilter = {
          cartId: kiosk._id,
          status: { $in: ["Paid", "Finalized", "Exit"] },
        };
        if (from || to) {
          orderFilter.createdAt = {};
          if (from) {
            const fromDate = new Date(from);
            fromDate.setHours(0, 0, 0, 0);
            orderFilter.createdAt.$gte = fromDate;
          }
          if (to) {
            const toDate = new Date(to);
            toDate.setHours(23, 59, 59, 999);
            orderFilter.createdAt.$lte = toDate;
          }
        }
        // Use aggregation for accurate sales calculation
        const salesData = await Order.aggregate([
          { $match: orderFilter },
          {
            $unwind: {
              path: "$kotLines",
              preserveNullAndEmptyArrays: false, // Only include orders with kotLines
            },
          },
          {
            $group: {
              _id: null,
              totalSales: { $sum: { $ifNull: ["$kotLines.totalAmount", 0] } },
            },
          },
        ]);
        const sales = salesData[0]?.totalSales || 0;

        // Calculate totals with proper precision
        const totalCost = Number(
          (foodCost + labourCost + overheadCost + expenseCost).toFixed(2)
        );
        const profit = Number((sales - totalCost).toFixed(2));
        const foodCostPercent =
          sales > 0 ? Number(((foodCost / sales) * 100).toFixed(2)) : 0;
        const profitMargin =
          sales > 0 ? Number(((profit / sales) * 100).toFixed(2)) : 0;

        const kioskData = {
          kioskId: kiosk._id,
          kioskName: kiosk.cafeName || kiosk.name,
          kioskCode: kiosk.cartCode || kiosk._id.toString().slice(-8), // Use cartCode, fallback to last 8 chars of ID
          sales: Number(sales.toFixed(2)),
          foodCost: Number(foodCost.toFixed(2)),
          labourCost: Number(labourCost.toFixed(2)),
          overheadCost: Number(overheadCost.toFixed(2)),
          expenseCost: Number(expenseCost.toFixed(2)),
          totalCost: Number(totalCost.toFixed(2)),
          profit: Number(profit.toFixed(2)),
          foodCostPercent: Number(foodCostPercent.toFixed(2)),
          profitMargin: Number(profitMargin.toFixed(2)),
        };

        franchiseData.kiosks.push(kioskData);

        // Aggregate franchise totals with proper precision
        franchiseData.totals.sales = Number(
          (franchiseData.totals.sales + sales).toFixed(2)
        );
        franchiseData.totals.foodCost = Number(
          (franchiseData.totals.foodCost + foodCost).toFixed(2)
        );
        franchiseData.totals.labourCost = Number(
          (franchiseData.totals.labourCost + labourCost).toFixed(2)
        );
        franchiseData.totals.overheadCost = Number(
          (franchiseData.totals.overheadCost + overheadCost).toFixed(2)
        );
        franchiseData.totals.expenseCost = Number(
          ((franchiseData.totals.expenseCost || 0) + expenseCost).toFixed(2)
        );
        franchiseData.totals.totalCost = Number(
          (franchiseData.totals.totalCost + totalCost).toFixed(2)
        );
        franchiseData.totals.profit = Number(
          (franchiseData.totals.profit + profit).toFixed(2)
        );
      }

      // Calculate franchise-level percentages with proper precision
      if (franchiseData.totals.sales > 0) {
        franchiseData.totals.foodCostPercent = Number(
          (
            (franchiseData.totals.foodCost / franchiseData.totals.sales) *
            100
          ).toFixed(2)
        );
        franchiseData.totals.profitMargin = Number(
          (
            (franchiseData.totals.profit / franchiseData.totals.sales) *
            100
          ).toFixed(2)
        );
      }

      hierarchicalData.push(franchiseData);
    }

    // Calculate grand totals with proper precision
    const grandTotals = hierarchicalData.reduce(
      (acc, franchise) => ({
        sales: Number((acc.sales + franchise.totals.sales).toFixed(2)),
        foodCost: Number((acc.foodCost + franchise.totals.foodCost).toFixed(2)),
        labourCost: Number(
          (acc.labourCost + franchise.totals.labourCost).toFixed(2)
        ),
        overheadCost: Number(
          (acc.overheadCost + franchise.totals.overheadCost).toFixed(2)
        ),
        expenseCost: Number(
          (
            (acc.expenseCost || 0) + (franchise.totals.expenseCost || 0)
          ).toFixed(2)
        ),
        totalCost: Number(
          (acc.totalCost + franchise.totals.totalCost).toFixed(2)
        ),
        profit: Number((acc.profit + franchise.totals.profit).toFixed(2)),
      }),
      {
        sales: 0,
        foodCost: 0,
        labourCost: 0,
        overheadCost: 0,
        expenseCost: 0,
        totalCost: 0,
        profit: 0,
      }
    );

    if (grandTotals.sales > 0) {
      grandTotals.foodCostPercent = Number(
        ((grandTotals.foodCost / grandTotals.sales) * 100).toFixed(2)
      );
      grandTotals.profitMargin = Number(
        ((grandTotals.profit / grandTotals.sales) * 100).toFixed(2)
      );
    }

    res.json({
      success: true,
      data: {
        franchises: hierarchicalData,
        grandTotals,
        period: {
          from: from || null,
          to: to || null,
        },
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ==================== LABOUR & OVERHEAD ====================

/**
 * @route   GET /api/costing-v2/labour-costs
 * @desc    Get labour costs
 */
exports.getLabourCosts = async (req, res) => {
  try {
    const { from, to, outletId } = req.query;
    const filter = {};

    if (outletId) filter.outletId = outletId;
    if (from || to) {
      filter.$or = [
        {
          periodFrom: { $lte: new Date(to || "2099-12-31") },
          periodTo: { $gte: new Date(from || "1970-01-01") },
        },
      ];
    }

    // Apply role-based filtering
    const costingFilter = await buildCostingQuery(req.user, filter);

    const costs = await LabourCost.find(costingFilter)
      .populate("createdBy", "name email")
      .populate("cartId", "name cafeName")
      .sort({ periodFrom: -1 });

    res.json({ success: true, data: costs });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   POST /api/costing-v2/labour-costs
 * @desc    Create labour cost
 */
exports.createLabourCost = async (req, res) => {
  try {
    // Set outlet context
    const data = await setOutletContext(req.user, {
      ...req.body,
      createdBy: req.user._id,
    });
    const labourCost = new LabourCost(data);
    await labourCost.save();
    await labourCost.populate("cartId", "name cafeName");
    res.status(201).json({ success: true, data: labourCost });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

/**
 * @route   GET /api/costing-v2/overheads
 * @desc    Get overheads
 */
exports.getOverheads = async (req, res) => {
  try {
    const { from, to, outletId, category } = req.query;
    const filter = {};

    if (outletId) filter.outletId = outletId;
    if (category) filter.category = category;
    if (from || to) {
      filter.$or = [
        {
          periodFrom: { $lte: new Date(to || "2099-12-31") },
          periodTo: { $gte: new Date(from || "1970-01-01") },
        },
      ];
    }

    // Apply role-based filtering
    const costingFilter = await buildCostingQuery(req.user, filter);

    const overheads = await Overhead.find(costingFilter)
      .populate("createdBy", "name email")
      .populate("cartId", "name cafeName")
      .sort({ periodFrom: -1 });

    res.json({ success: true, data: overheads });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   POST /api/costing-v2/overheads
 * @desc    Create overhead
 */
exports.createOverhead = async (req, res) => {
  try {
    // Set outlet context
    const data = await setOutletContext(req.user, {
      ...req.body,
      createdBy: req.user._id,
    });
    const overhead = new Overhead(data);
    await overhead.save();
    await overhead.populate("cartId", "name cafeName");
    res.status(201).json({ success: true, data: overhead });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// ==================== REPORTS ====================

/**
 * @route   GET /api/costing-v2/reports/food-cost
 * @desc    Food Cost Report
 */
exports.getFoodCostReport = async (req, res) => {
  try {
    const { from, to, outletId } = req.query;

    // Log user info for debugging
    console.log("[FOOD_COST_REPORT] User:", {
      userId: req.user._id,
      role: req.user.role,
      email: req.user.email,
      name: req.user.name,
    });

    // Build date filter for transactions (use date field, not createdAt)
    const transactionDateFilter = {};
    if (from || to) {
      transactionDateFilter.date = {};
      if (from)
        transactionDateFilter.date.$gte = new Date(from + "T00:00:00.000Z");
      if (to) transactionDateFilter.date.$lte = new Date(to + "T23:59:59.999Z"); // Include full day
    }

    // Build outlet filter based on role
    let transactionOutletFilter = {};
    if (req.user.role === "admin") {
      // Cart admin - only their own kiosk
      transactionOutletFilter.cartId = req.user._id;
      console.log(
        "[FOOD_COST_REPORT] Cart admin filter - cartId:",
        req.user._id.toString()
      );
    } else if (req.user.role === "franchise_admin") {
      // Franchise admin - specific outlet or all their franchise outlets
      if (outletId) {
        const outlet = await User.findById(outletId);
        if (
          !outlet ||
          outlet.franchiseId?.toString() !== req.user._id.toString()
        ) {
          return res.status(403).json({
            success: false,
            message: "Access denied: Kiosk does not belong to your franchise",
          });
        }
        transactionOutletFilter.cartId = outletId;
      } else {
        const outlets = await User.find({
          role: "admin",
          franchiseId: req.user._id,
          isActive: true,
        }).select("_id");
        transactionOutletFilter.cartId = { $in: outlets.map((o) => o._id) };
      }
    } else if (req.user.role === "super_admin") {
      // Super admin - specific outlet or all
      if (outletId) {
        transactionOutletFilter.cartId = outletId;
      }
    }

    // Get total food cost (from consumption transactions)
    const consumptionTransactions = await InventoryTransaction.aggregate([
      {
        $match: {
          type: { $in: ["OUT", "WASTE"] },
          ...transactionDateFilter,
          ...transactionOutletFilter,
        },
      },
      {
        $group: {
          _id: null,
          totalFoodCost: { $sum: "$costAllocated" },
        },
      },
    ]);

    // Get total sales (from orders - calculate from kotLines)
    const orderFilter = {};
    if (from || to) {
      orderFilter.createdAt = {};
      if (from) orderFilter.createdAt.$gte = new Date(from + "T00:00:00.000Z");
      if (to) orderFilter.createdAt.$lte = new Date(to + "T23:59:59.999Z"); // Include full day
    }
    // Build order filter based on role
    if (req.user.role === "admin") {
      // Cart admin - only their own kiosk (use cartId)
      orderFilter.cartId = req.user._id;
    } else if (req.user.role === "franchise_admin") {
      // Franchise admin - specific outlet or all their franchise outlets
      if (outletId) {
        orderFilter.cartId = outletId;
      } else {
        const outlets = await User.find({
          role: "admin",
          franchiseId: req.user._id,
          isActive: true,
        }).select("_id");
        const outletIds = outlets.map((o) => o._id);
        orderFilter.cartId = { $in: outletIds };
      }
    } else if (req.user.role === "super_admin") {
      // Super admin - specific outlet or all
      if (outletId) {
        orderFilter.cartId = outletId;
      }
    }

    // Include "Exit" status for takeaway orders
    orderFilter.status = { $in: ["Paid", "Finalized", "Exit"] };

    // Calculate sales from kotLines (orders don't have top-level totalAmount)
    const salesData = await Order.aggregate([
      { $match: orderFilter },
      {
        $unwind: {
          path: "$kotLines",
          preserveNullAndEmptyArrays: false, // Only include orders with kotLines
        },
      },
      {
        $group: {
          _id: null,
          totalSales: { $sum: { $ifNull: ["$kotLines.totalAmount", 0] } },
        },
      },
    ]);

    const totalSales = Number((salesData[0]?.totalSales || 0).toFixed(2));
    const totalFoodCost = Number(
      (consumptionTransactions[0]?.totalFoodCost || 0).toFixed(2)
    );
    console.log(
      "[FOOD_COST_REPORT] Total sales:",
      totalSales,
      "Total food cost:",
      totalFoodCost,
      "Order filter:",
      JSON.stringify(orderFilter)
    );
    const foodCostPercent =
      totalSales > 0
        ? Number(((totalFoodCost / totalSales) * 100).toFixed(2))
        : 0;

    res.json({
      success: true,
      data: {
        period: { from, to },
        totalFoodCost: Number(totalFoodCost.toFixed(2)),
        totalSales: Number(totalSales.toFixed(2)),
        foodCostPercent: Number(foodCostPercent.toFixed(2)),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   GET /api/costing-v2/reports/menu-engineering
 * @desc    Menu Engineering Report
 */
exports.getMenuEngineeringReport = async (req, res) => {
  try {
    const { from, to, limit = 50, outletId } = req.query;
    const orderFilter = {};

    if (from || to) {
      orderFilter.createdAt = {};
      if (from) orderFilter.createdAt.$gte = new Date(from);
      if (to) orderFilter.createdAt.$lte = new Date(to);
    }
    orderFilter.status = { $in: ["Paid", "Finalized"] };

    // Build order filter based on role
    if (req.user.role === "admin") {
      // Cart admin - only their own kiosk (use cartId)
      orderFilter.cartId = req.user._id;
    } else if (req.user.role === "franchise_admin") {
      // Franchise admin - specific outlet or all their franchise outlets
      if (outletId) {
        orderFilter.cartId = outletId;
      } else {
        const outlets = await User.find({
          role: "admin",
          franchiseId: req.user._id,
          isActive: true,
        }).select("_id");
        const outletIds = outlets.map((o) => o._id);
        orderFilter.cartId = { $in: outletIds };
      }
    } else if (req.user.role === "super_admin") {
      // Super admin - specific outlet or all
      if (outletId) {
        orderFilter.cartId = outletId;
      }
    }

    // Build menu item filter based on role
    const menuItemFilter = { isActive: true };
    if (req.user.role === "admin") {
      // Cart admin - only their own kiosk's menu items
      menuItemFilter.outletId = req.user._id;
      console.log(
        "[MENU_ENGINEERING_REPORT] Cart admin filter - outletId:",
        req.user._id.toString()
      );
    } else if (req.user.role === "franchise_admin") {
      // Franchise admin - specific outlet or all their franchise outlets
      if (outletId) {
        const outlet = await User.findById(outletId);
        if (
          !outlet ||
          outlet.franchiseId?.toString() !== req.user._id.toString()
        ) {
          return res.status(403).json({
            success: false,
            message: "Access denied: Kiosk does not belong to your franchise",
          });
        }
        menuItemFilter.outletId = outletId;
      } else {
        const outlets = await User.find({
          role: "admin",
          franchiseId: req.user._id,
          isActive: true,
        }).select("_id");
        menuItemFilter.outletId = { $in: outlets.map((o) => o._id) };
      }
    } else if (req.user.role === "super_admin") {
      // Super admin - specific outlet or all
      if (outletId) {
        menuItemFilter.outletId = outletId;
      }
    }

    // Get menu items with sales data
    const menuItems = await MenuItem.find(menuItemFilter).populate(
      "recipeId",
      "name costPerPortion"
    );

    const menuEngineeringData = [];

    for (const menuItem of menuItems) {
      // Calculate revenue and quantity from kotLines.items
      const revenueData = await Order.aggregate([
        {
          $match: orderFilter,
        },
        {
          $unwind: "$kotLines",
        },
        {
          $unwind: "$kotLines.items",
        },
        {
          $match: {
            "kotLines.items.name": menuItem.name,
            "kotLines.items.returned": { $ne: true }, // Exclude returned items
          },
        },
        {
          $group: {
            _id: null,
            revenue: {
              $sum: {
                $multiply: [
                  "$kotLines.items.quantity",
                  "$kotLines.items.price",
                ],
              },
            },
            quantity: { $sum: "$kotLines.items.quantity" },
            orderCount: { $addToSet: "$_id" }, // Count unique orders
          },
        },
      ]);

      const revenue = revenueData[0]?.revenue || 0;
      const quantity = revenueData[0]?.quantity || 0;
      const salesCount = revenueData[0]?.orderCount?.length || 0; // Number of unique orders
      const cost = menuItem.costPerPortion * quantity;
      const margin = revenue - cost;
      const marginPercent = revenue > 0 ? (margin / revenue) * 100 : 0;

      menuEngineeringData.push({
        menuItemId: menuItem._id,
        name: menuItem.name,
        category: menuItem.category,
        sellingPrice: menuItem.sellingPrice,
        costPerPortion: menuItem.costPerPortion,
        quantitySold: quantity,
        revenue,
        cost,
        margin,
        marginPercent: Number(marginPercent.toFixed(2)),
        popularity: salesCount, // Number of orders containing this item
      });
    }

    // Sort by popularity (descending) and limit
    menuEngineeringData.sort((a, b) => b.popularity - a.popularity);
    const limited = menuEngineeringData.slice(0, parseInt(limit));

    res.json({ success: true, data: limited });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   GET /api/costing-v2/reports/supplier-price-history
 * @desc    Supplier Price History Report
 */
exports.getSupplierPriceHistory = async (req, res) => {
  try {
    const { supplierId, ingredientId, outletId } = req.query;
    const filter = { status: "received" };

    if (supplierId) filter.supplierId = supplierId;

    // Apply role-based outlet filtering
    if (req.user.role === "admin") {
      // Cart admin - only their own kiosk
      filter.outletId = req.user._id;
      console.log(
        "[SUPPLIER_PRICE_HISTORY] Cart admin filter - outletId:",
        req.user._id.toString()
      );
    } else if (req.user.role === "franchise_admin") {
      // Franchise admin - specific outlet or all their franchise outlets
      if (outletId) {
        const outlet = await User.findById(outletId);
        if (
          !outlet ||
          outlet.franchiseId?.toString() !== req.user._id.toString()
        ) {
          return res.status(403).json({
            success: false,
            message: "Access denied: Kiosk does not belong to your franchise",
          });
        }
        filter.outletId = outletId;
      } else {
        const outlets = await User.find({
          role: "admin",
          franchiseId: req.user._id,
          isActive: true,
        }).select("_id");
        filter.outletId = { $in: outlets.map((o) => o._id) };
      }
    } else if (req.user.role === "super_admin") {
      // Super admin - specific outlet or all
      if (outletId) {
        filter.outletId = outletId;
      }
    }

    const purchases = await Purchase.find(filter)
      .populate("supplierId", "name")
      .populate("items.ingredientId", "name uom")
      .sort({ date: -1 });

    const priceHistory = [];

    for (const purchase of purchases) {
      // Skip legacy or incomplete records without a supplier
      if (!purchase.supplierId) {
        console.warn(
          "[SUPPLIER_PRICE_HISTORY] Skipping purchase without supplierId:",
          purchase._id?.toString?.() || purchase._id
        );
        continue;
      }

      for (const item of purchase.items || []) {
        // Skip items without a linked ingredient (legacy/incomplete data)
        if (!item.ingredientId) {
          console.warn(
            "[SUPPLIER_PRICE_HISTORY] Skipping item without ingredientId in purchase:",
            purchase._id?.toString?.() || purchase._id
          );
          continue;
        }

        if (ingredientId && item.ingredientId.toString() !== ingredientId)
          continue;

        priceHistory.push({
          date: purchase.date,
          supplierId: purchase.supplierId._id,
          supplierName: purchase.supplierId.name,
          ingredientId: item.ingredientId._id,
          ingredientName: item.ingredientId.name,
          qty: item.qty,
          uom: item.uom,
          unitPrice: item.unitPrice,
          total: item.total,
        });
      }
    }

    res.json({ success: true, data: priceHistory });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   GET /api/costing-v2/reports/pnl
 * @desc    Profit & Loss Report
 */
exports.getPnLReport = async (req, res) => {
  try {
    const { from, to, outletId } = req.query;

    // Log user info for debugging
    console.log("[PNL_REPORT] User:", {
      userId: req.user._id,
      role: req.user.role,
      email: req.user.email,
      name: req.user.name,
    });

    // Build date filter for transactions (use date field, not createdAt)
    const transactionDateFilter = {};
    if (from || to) {
      transactionDateFilter.date = {};
      if (from)
        transactionDateFilter.date.$gte = new Date(from + "T00:00:00.000Z");
      if (to) transactionDateFilter.date.$lte = new Date(to + "T23:59:59.999Z"); // Include full day
    }

    // Build outlet filter based on role
    let transactionOutletFilter = {};
    if (req.user.role === "admin") {
      // Cart admin - only their own kiosk
      transactionOutletFilter.cartId = req.user._id;
      console.log(
        "[PNL_REPORT] Cart admin filter - cartId:",
        req.user._id.toString()
      );
    } else if (req.user.role === "franchise_admin") {
      // Franchise admin - specific outlet or all their franchise outlets
      if (outletId) {
        const outlet = await User.findById(outletId);
        if (
          !outlet ||
          outlet.franchiseId?.toString() !== req.user._id.toString()
        ) {
          return res.status(403).json({
            success: false,
            message: "Access denied: Kiosk does not belong to your franchise",
          });
        }
        transactionOutletFilter.cartId = outletId;
      } else {
        const outlets = await User.find({
          role: "admin",
          franchiseId: req.user._id,
          isActive: true,
        }).select("_id");
        transactionOutletFilter.cartId = { $in: outlets.map((o) => o._id) };
      }
    } else if (req.user.role === "super_admin") {
      // Super admin - specific outlet or all
      if (outletId) {
        transactionOutletFilter.cartId = outletId;
      }
    }

    // Get total food cost (from consumption transactions)
    const consumptionTransactions = await InventoryTransaction.aggregate([
      {
        $match: {
          type: { $in: ["OUT", "WASTE"] },
          ...transactionDateFilter,
          ...transactionOutletFilter,
        },
      },
      {
        $group: {
          _id: null,
          totalFoodCost: { $sum: "$costAllocated" },
        },
      },
    ]);

    const foodCost = Number(
      (consumptionTransactions[0]?.totalFoodCost || 0).toFixed(2)
    );
    console.log(
      "[PNL_REPORT] Total food cost:",
      foodCost,
      "Transaction filter:",
      JSON.stringify(transactionOutletFilter)
    );

    // Get total sales (from orders - calculate from kotLines)
    const orderFilter = {};
    if (from || to) {
      orderFilter.createdAt = {};
      if (from) orderFilter.createdAt.$gte = new Date(from + "T00:00:00.000Z");
      if (to) orderFilter.createdAt.$lte = new Date(to + "T23:59:59.999Z"); // Include full day
    }

    // Build order filter based on role
    if (req.user.role === "admin") {
      // Cart admin - only their own kiosk (use cartId)
      orderFilter.cartId = req.user._id;
    } else if (req.user.role === "franchise_admin") {
      // Franchise admin - specific outlet or all their franchise outlets
      if (outletId) {
        orderFilter.cartId = outletId;
      } else {
        const outlets = await User.find({
          role: "admin",
          franchiseId: req.user._id,
          isActive: true,
        }).select("_id");
        const outletIds = outlets.map((o) => o._id);
        orderFilter.cartId = { $in: outletIds };
      }
    } else if (req.user.role === "super_admin") {
      // Super admin - specific outlet or all
      if (outletId) {
        orderFilter.cartId = outletId;
      }
    }

    orderFilter.status = { $in: ["Paid", "Finalized"] };

    // Calculate sales from kotLines (orders don't have top-level totalAmount)
    // Include "Exit" status for takeaway orders
    orderFilter.status = { $in: ["Paid", "Finalized", "Exit"] };
    const salesData = await Order.aggregate([
      { $match: orderFilter },
      {
        $unwind: {
          path: "$kotLines",
          preserveNullAndEmptyArrays: false, // Only include orders with kotLines
        },
      },
      {
        $group: {
          _id: null,
          totalSales: { $sum: { $ifNull: ["$kotLines.totalAmount", 0] } },
        },
      },
    ]);

    const totalSales = Number((salesData[0]?.totalSales || 0).toFixed(2));
    console.log(
      "[PNL_REPORT] Total sales:",
      totalSales,
      "Order filter:",
      JSON.stringify(orderFilter)
    );

    // Get labour costs
    const labourFilter = {};
    if (req.user.role === "admin") {
      // Cart admin - only their own kiosk
      labourFilter.outletId = req.user._id;
      console.log(
        "[PNL_REPORT] Cart admin labour filter - outletId:",
        req.user._id.toString()
      );
    } else if (req.user.role === "franchise_admin") {
      // Franchise admin - specific outlet or all their franchise outlets
      if (outletId) {
        labourFilter.outletId = outletId;
      } else {
        const outlets = await User.find({
          role: "admin",
          franchiseId: req.user._id,
          isActive: true,
        }).select("_id");
        labourFilter.outletId = { $in: outlets.map((o) => o._id) };
      }
    } else if (req.user.role === "super_admin") {
      // Super admin - specific outlet or all
      if (outletId) {
        labourFilter.outletId = outletId;
      }
    }

    if (from || to) {
      labourFilter.$or = [
        {
          periodFrom: { $lte: new Date(to || "2099-12-31") },
          periodTo: { $gte: new Date(from || "1970-01-01") },
        },
      ];
    }

    const labourCosts = await LabourCost.find(labourFilter).lean();
    const totalLabour = Number(
      labourCosts
        .reduce((sum, l) => sum + (Number(l.amount) || 0), 0)
        .toFixed(2)
    );
    console.log(
      "[PNL_REPORT] Total labour:",
      totalLabour,
      "Labour filter:",
      JSON.stringify(labourFilter),
      "Count:",
      labourCosts.length
    );

    // Get overheads (same filter as labour)
    const overheads = await Overhead.find(labourFilter).lean();
    const totalOverhead = Number(
      overheads.reduce((sum, o) => sum + (Number(o.amount) || 0), 0).toFixed(2)
    );
    console.log(
      "[PNL_REPORT] Total overhead:",
      totalOverhead,
      "Overhead count:",
      overheads.length
    );

    // Get expenses
    const expenseFilter = {};
    if (req.user.role === "admin") {
      // Cart admin - only their own kiosk
      expenseFilter.outletId = req.user._id;
      console.log(
        "[PNL_REPORT] Cart admin expense filter - outletId:",
        req.user._id.toString()
      );
    } else if (req.user.role === "franchise_admin") {
      // Franchise admin - specific outlet or all their franchise outlets
      if (outletId) {
        expenseFilter.outletId = outletId;
      } else {
        const outlets = await User.find({
          role: "admin",
          franchiseId: req.user._id,
          isActive: true,
        }).select("_id");
        expenseFilter.outletId = { $in: outlets.map((o) => o._id) };
      }
    } else if (req.user.role === "super_admin") {
      // Super admin - specific outlet or all
      if (outletId) {
        expenseFilter.outletId = outletId;
      }
    }

    if (from || to) {
      expenseFilter.expenseDate = {};
      if (from) expenseFilter.expenseDate.$gte = new Date(from);
      if (to) {
        const toDate = new Date(to);
        toDate.setHours(23, 59, 59, 999);
        expenseFilter.expenseDate.$lte = toDate;
      }
    }

    const expenses = await CostingExpense.find(expenseFilter).lean();
    const totalExpenses = Number(
      expenses.reduce((sum, e) => sum + (Number(e.amount) || 0), 0).toFixed(2)
    );
    console.log(
      "[PNL_REPORT] Total expenses:",
      totalExpenses,
      "Expense filter:",
      JSON.stringify(expenseFilter),
      "Count:",
      expenses.length
    );

    // Calculate P&L with proper precision
    const totalCosts = Number(
      (foodCost + totalLabour + totalOverhead + totalExpenses).toFixed(2)
    );
    const profit = Number((totalSales - totalCosts).toFixed(2));
    const profitMargin =
      totalSales > 0 ? Number(((profit / totalSales) * 100).toFixed(2)) : 0;

    res.json({
      success: true,
      data: {
        period: { from, to },
        sales: Number(totalSales.toFixed(2)),
        costs: {
          foodCost: Number(foodCost.toFixed(2)),
          labour: Number(totalLabour.toFixed(2)),
          overhead: Number(totalOverhead.toFixed(2)),
          expenses: Number(totalExpenses.toFixed(2)),
          total: Number(totalCosts.toFixed(2)),
        },
        profit: Number(profit.toFixed(2)),
        profitMargin: Number(profitMargin.toFixed(2)),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ==================== EXPENSES ====================

/**
 * @route   GET /api/costing-v2/expenses
 * @desc    Get all expenses with filters
 */
exports.getExpenses = async (req, res) => {
  try {
    const { from, to, category, outletId, search } = req.query;
    const query = await buildCostingQuery(req.user, {});

    if (outletId) {
      const hasAccess = await validateOutletAccess(req.user, outletId);
      if (!hasAccess) {
        return res
          .status(403)
          .json({ success: false, message: "Access denied to this outlet" });
      }
      query.outletId = outletId;
    }

    if (from || to) {
      query.expenseDate = {};
      if (from) query.expenseDate.$gte = new Date(from);
      if (to) {
        const toDate = new Date(to);
        toDate.setHours(23, 59, 59, 999);
        query.expenseDate.$lte = toDate;
      }
    }

    if (category) query.category = category;
    if (search) {
      query.$or = [
        { description: { $regex: search, $options: "i" } },
        { vendor: { $regex: search, $options: "i" } },
        { invoiceNumber: { $regex: search, $options: "i" } },
      ];
    }

    const expenses = await CostingExpense.find(query)
      .sort({ expenseDate: -1 })
      .populate("createdBy", "name email")
      .lean();

    res.json({ success: true, data: expenses });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   POST /api/costing-v2/expenses
 * @desc    Create expense
 */
exports.createExpense = async (req, res) => {
  try {
    // setOutletContext is async, so we need to await it
    const expenseData = await setOutletContext(req.user, req.body, true);
    expenseData.createdBy = req.user._id;

    // Ensure expenseDate is a Date object
    if (!expenseData.expenseDate) {
      expenseData.expenseDate = new Date();
    } else if (typeof expenseData.expenseDate === "string") {
      expenseData.expenseDate = new Date(expenseData.expenseDate);
    }

    // Ensure amount is a number
    if (expenseData.amount) {
      expenseData.amount = Number(expenseData.amount);
    }

    // Ensure category is provided
    if (!expenseData.category) {
      return res.status(400).json({
        success: false,
        message: "Category is required",
      });
    }

    const expense = new CostingExpense(expenseData);
    await expense.save();

    res.status(201).json({ success: true, data: expense });
  } catch (error) {
    console.error("[COSTING] Create expense error:", error);
    res.status(400).json({ success: false, message: error.message });
  }
};

/**
 * @route   PUT /api/costing-v2/expenses/:id
 * @desc    Update expense
 */
exports.updateExpense = async (req, res) => {
  try {
    const expense = await CostingExpense.findById(req.params.id);
    if (!expense) {
      return res
        .status(404)
        .json({ success: false, message: "Expense not found" });
    }

    // Validate access (validateOutletAccess is async)
    const hasAccess = await validateOutletAccess(req.user, expense.outletId);
    if (!hasAccess) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    // Update fields with proper type conversion
    if (req.body.expenseDate && typeof req.body.expenseDate === "string") {
      req.body.expenseDate = new Date(req.body.expenseDate);
    }
    if (req.body.amount) {
      req.body.amount = Number(req.body.amount);
    }

    Object.assign(expense, req.body);
    await expense.save();

    res.json({ success: true, data: expense });
  } catch (error) {
    console.error("[COSTING] Update expense error:", error);
    res.status(400).json({ success: false, message: error.message });
  }
};

/**
 * @route   DELETE /api/costing-v2/expenses/:id
 * @desc    Delete expense
 */
exports.deleteExpense = async (req, res) => {
  try {
    const expense = await CostingExpense.findById(req.params.id);
    if (!expense) {
      return res
        .status(404)
        .json({ success: false, message: "Expense not found" });
    }

    // Validate access (validateOutletAccess is async)
    const hasAccess = await validateOutletAccess(req.user, expense.outletId);
    if (!hasAccess) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    await CostingExpense.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: "Expense deleted successfully" });
  } catch (error) {
    console.error("[COSTING] Delete expense error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   GET /api/costing-v2/expenses/summary
 * @desc    Get expense summary by category and period
 */
exports.getExpenseSummary = async (req, res) => {
  try {
    const { from, to, outletId } = req.query;
    const query = await buildCostingQuery(req.user, {});

    if (outletId) {
      const hasAccess = await validateOutletAccess(req.user, outletId);
      if (!hasAccess) {
        return res
          .status(403)
          .json({ success: false, message: "Access denied to this outlet" });
      }
      query.outletId = outletId;
    }

    if (from || to) {
      query.expenseDate = {};
      if (from) query.expenseDate.$gte = new Date(from);
      if (to) {
        const toDate = new Date(to);
        toDate.setHours(23, 59, 59, 999);
        query.expenseDate.$lte = toDate;
      }
    }

    const expenses = await CostingExpense.find(query).lean();

    // Group by category
    const categorySummary = {};
    let totalAmount = 0;

    expenses.forEach((expense) => {
      const cat = expense.category || "miscellaneous";
      if (!categorySummary[cat]) {
        categorySummary[cat] = {
          category: cat,
          count: 0,
          total: 0,
        };
      }
      categorySummary[cat].count += 1;
      categorySummary[cat].total += expense.amount || 0;
      totalAmount += expense.amount || 0;
    });

    // Convert to array and sort by total
    const summaryArray = Object.values(categorySummary).sort(
      (a, b) => b.total - a.total
    );

    res.json({
      success: true,
      data: {
        summary: summaryArray,
        total: totalAmount,
        count: expenses.length,
        period: { from, to },
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   GET /api/costing-v2/expense-categories
 * @desc    Get all expense categories
 */
exports.getExpenseCategories = async (req, res) => {
  try {
    const query = { isActive: true };
    const categories = await CostingExpenseCategory.find(query)
      .sort({ name: 1 })
      .lean();
    res.json({ success: true, data: categories });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   POST /api/costing-v2/expense-categories
 * @desc    Create expense category
 */
exports.createExpenseCategory = async (req, res) => {
  try {
    const categoryData = {
      ...req.body,
      createdBy: req.user._id,
    };

    if (!categoryData.code) {
      categoryData.code = categoryData.name.toUpperCase().replace(/\s+/g, "_");
    }

    const category = new CostingExpenseCategory(categoryData);
    await category.save();

    res.status(201).json({ success: true, data: category });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

/**
 * @route   POST /api/costing-v2/menu-items/sync-from-default
 * @desc    Sync costing menu items with default menu (update prices)
 */
exports.syncMenuItemsFromDefault = async (req, res) => {
  try {
    const { franchiseId, outletId } = req.body;
    const {
      syncDefaultMenuToCosting,
    } = require("../../services/costing-v2/syncDefaultMenuToCosting");

    // For cart admin, sync from their MenuItem collection (cart menu)
    let targetFranchiseId = franchiseId;
    let cartId = null;
    let targetOutletId = outletId;

    if (req.user.role === "admin") {
      // Cart admin: sync from MenuItem collection (cart menu)
      cartId = req.user._id;
      // If outletId not provided, use cart admin's own kiosk ID
      if (!targetOutletId) {
        targetOutletId = req.user._id;
      }
    } else if (req.user.role === "franchise_admin") {
      targetFranchiseId = req.user._id;
    } else if (req.user.role === "super_admin" && !franchiseId) {
      targetFranchiseId = null; // Global menu
    }

    const syncResult = await syncDefaultMenuToCosting(
      targetFranchiseId,
      cartId,
      targetOutletId
    );

    res.json({
      success: syncResult.success,
      data: {
        updated: syncResult.updated || 0,
        notFound: syncResult.notFound || 0,
        errors: syncResult.errors || [],
        message:
          syncResult.error ||
          `Successfully synced ${syncResult.updated || 0} menu items`,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   POST /api/costing-v2/push-to-cart-admins
 * @desc    Push super admin ingredients and BOMs to cart admins
 * @access  Super Admin only
 */
exports.pushToCartAdmins = async (req, res) => {
  try {
    // Only super admin can push
    if (req.user.role !== "super_admin") {
      return res.status(403).json({
        success: false,
        message:
          "Access denied. Only super admin can push data to cart admins.",
      });
    }

    const { outletId } = req.body; // Optional: push to specific cart admin, or all if not provided

    // Get all super admin ingredients (cartId: null)
    const superAdminIngredients = await Ingredient.find({
      cartId: null,
      isActive: true,
    }).lean();

    // Get all super admin recipes/BOMs (cartId: null)
    const superAdminRecipes = await Recipe.find({
      cartId: null,
      isActive: true,
    })
      .populate("ingredients.ingredientId", "name uom baseUnit")
      .lean();

    // Get target cart admins
    let cartAdmins = [];
    if (outletId) {
      // Push to specific cart admin
      const cartAdmin = await User.findById(outletId);
      if (!cartAdmin || cartAdmin.role !== "admin") {
        return res.status(404).json({
          success: false,
          message: "Cart admin not found",
        });
      }
      cartAdmins = [cartAdmin];
    } else {
      // Push to all cart admins
      cartAdmins = await User.find({ role: "admin", isActive: { $ne: false } });
    }

    const results = {
      ingredients: { created: 0, updated: 0, skipped: 0 },
      recipes: { created: 0, updated: 0, skipped: 0 },
      cartAdmins: [],
    };

    // Process each cart admin
    for (const cartAdmin of cartAdmins) {
      const cartAdminId = cartAdmin._id;
      const cartAdminFranchiseId = cartAdmin.franchiseId;
      const cartAdminResult = {
        cartAdminId: cartAdminId.toString(),
        cartAdminName: cartAdmin.name || cartAdmin.cartName || "Unknown",
        ingredients: { created: 0, updated: 0, skipped: 0 },
        recipes: { created: 0, updated: 0, skipped: 0 },
      };

      // Push ingredients
      for (const superIngredient of superAdminIngredients) {
        // Check if cart admin already has this ingredient (by name)
        const existingIngredient = await Ingredient.findOne({
          name: superIngredient.name,
          cartId: cartAdminId,
        });

        if (existingIngredient) {
          // Update existing ingredient with super admin data, but preserve cart admin's inventory data
          const updateData = {
            category: superIngredient.category,
            storageLocation: superIngredient.storageLocation,
            uom: superIngredient.uom,
            baseUnit: superIngredient.baseUnit,
            conversionFactors: superIngredient.conversionFactors,
            shelfTimeDays: superIngredient.shelfTimeDays,
            // Preserve cart admin's own data:
            // - qtyOnHand (keep existing)
            // - reorderLevel (keep existing)
            // - currentCostPerBaseUnit (keep existing - from their purchases)
            // - fifoLayers (keep existing)
            // - preferredSupplierId (keep existing)
            isActive: superIngredient.isActive,
          };

          await Ingredient.findByIdAndUpdate(
            existingIngredient._id,
            updateData,
            {
              runValidators: true,
            }
          );
          cartAdminResult.ingredients.updated++;
          results.ingredients.updated++;
        } else {
          // Create new ingredient for cart admin
          const newIngredient = new Ingredient({
            name: superIngredient.name,
            category: superIngredient.category,
            storageLocation: superIngredient.storageLocation,
            uom: superIngredient.uom,
            baseUnit: superIngredient.baseUnit,
            conversionFactors: superIngredient.conversionFactors,
            reorderLevel: superIngredient.reorderLevel || 0,
            shelfTimeDays: superIngredient.shelfTimeDays,
            currentCostPerBaseUnit: 0, // Will be set when cart admin makes purchases
            qtyOnHand: 0, // Cart admin starts with 0 inventory
            fifoLayers: [], // Empty FIFO layers
            isActive: superIngredient.isActive,
            cartId: cartAdminId,
            franchiseId: cartAdminFranchiseId,
          });

          await newIngredient.save();
          cartAdminResult.ingredients.created++;
          results.ingredients.created++;
        }
      }

      // Push recipes/BOMs
      for (const superRecipe of superAdminRecipes) {
        // Check if cart admin already has this recipe (by name)
        const existingRecipe = await Recipe.findOne({
          name: superRecipe.name,
          cartId: cartAdminId,
        });

        if (existingRecipe) {
          // Update existing recipe with super admin data
          // Map ingredient IDs from super admin to cart admin ingredients
          const mappedIngredients = [];
          for (const superIngredient of superRecipe.ingredients || []) {
            if (superIngredient.ingredientId) {
              // Get ingredient name - handle both populated and non-populated cases
              let ingredientName = null;
              if (
                typeof superIngredient.ingredientId === "object" &&
                superIngredient.ingredientId.name
              ) {
                // Populated ingredient
                ingredientName = superIngredient.ingredientId.name;
              } else {
                // Not populated - fetch the ingredient to get name
                const superIngredientDoc = await Ingredient.findById(
                  superIngredient.ingredientId
                );
                if (superIngredientDoc) {
                  ingredientName = superIngredientDoc.name;
                }
              }

              if (ingredientName) {
                // Find corresponding ingredient in cart admin's ingredients by name
                const cartAdminIngredient = await Ingredient.findOne({
                  name: ingredientName,
                  cartId: cartAdminId,
                });

                if (cartAdminIngredient) {
                  mappedIngredients.push({
                    ingredientId: cartAdminIngredient._id,
                    qty: superIngredient.qty,
                    uom: superIngredient.uom,
                  });
                }
              }
            }
          }

          const updateData = {
            yieldPercent: superRecipe.yieldPercent,
            portions: superRecipe.portions,
            instructions: superRecipe.instructions,
            ingredients: mappedIngredients,
            isActive: superRecipe.isActive,
          };

          await Recipe.findByIdAndUpdate(existingRecipe._id, updateData, {
            runValidators: true,
          });

          // Recalculate cost for updated recipe
          const updatedRecipe = await Recipe.findById(existingRecipe._id);
          if (updatedRecipe) {
            await updatedRecipe.calculateCost(cartAdminId.toString());
            await updatedRecipe.save();
          }

          cartAdminResult.recipes.updated++;
          results.recipes.updated++;
        } else {
          // Create new recipe for cart admin
          // Map ingredient IDs from super admin to cart admin ingredients
          const mappedIngredients = [];
          for (const superIngredient of superRecipe.ingredients || []) {
            if (superIngredient.ingredientId) {
              // Get ingredient name - handle both populated and non-populated cases
              let ingredientName = null;
              if (
                typeof superIngredient.ingredientId === "object" &&
                superIngredient.ingredientId.name
              ) {
                // Populated ingredient
                ingredientName = superIngredient.ingredientId.name;
              } else {
                // Not populated - fetch the ingredient to get name
                const superIngredientDoc = await Ingredient.findById(
                  superIngredient.ingredientId
                );
                if (superIngredientDoc) {
                  ingredientName = superIngredientDoc.name;
                }
              }

              if (ingredientName) {
                // Find corresponding ingredient in cart admin's ingredients by name
                const cartAdminIngredient = await Ingredient.findOne({
                  name: ingredientName,
                  cartId: cartAdminId,
                });

                if (cartAdminIngredient) {
                  mappedIngredients.push({
                    ingredientId: cartAdminIngredient._id,
                    qty: superIngredient.qty,
                    uom: superIngredient.uom,
                  });
                }
              }
            }
          }

          if (mappedIngredients.length > 0) {
            const newRecipe = new Recipe({
              name: superRecipe.name,
              yieldPercent: superRecipe.yieldPercent,
              portions: superRecipe.portions,
              instructions: superRecipe.instructions,
              ingredients: mappedIngredients,
              isActive: superRecipe.isActive,
              cartId: cartAdminId,
              franchiseId: cartAdminFranchiseId,
            });

            await newRecipe.save();

            // Calculate cost for new recipe
            await newRecipe.calculateCost(cartAdminId.toString());
            await newRecipe.save();

            cartAdminResult.recipes.created++;
            results.recipes.created++;
          } else {
            // Skip if no matching ingredients found
            cartAdminResult.recipes.skipped++;
            results.recipes.skipped++;
          }
        }
      }

      results.cartAdmins.push(cartAdminResult);
    }

    res.json({
      success: true,
      message: `Successfully pushed data to ${cartAdmins.length} cart admin(s)`,
      data: results,
    });
  } catch (error) {
    console.error("[PUSH_TO_CART_ADMINS] Error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to push data to cart admins",
    });
  }
};

