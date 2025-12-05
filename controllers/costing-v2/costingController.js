const Supplier = require("../../models/costing-v2/supplierModel");
const Ingredient = require("../../models/costing-v2/ingredientModel");
const Purchase = require("../../models/costing-v2/purchaseModel");
const InventoryTransaction = require("../../models/costing-v2/inventoryTransactionModel");
const Recipe = require("../../models/costing-v2/recipeModel");
const MenuItem = require("../../models/costing-v2/menuItemModel");
const Waste = require("../../models/costing-v2/wasteModel");
const LabourCost = require("../../models/costing-v2/labourCostModel");
const Overhead = require("../../models/costing-v2/overheadModel");
const CostingExpense = require("../../models/costing-v2/expenseModel");
const CostingExpenseCategory = require("../../models/costing-v2/expenseCategoryModel");
const Order = require("../../models/orderModel");
const DefaultMenu = require("../../models/defaultMenuModel");
const User = require("../../models/userModel");
const FIFOService = require("../../services/costing-v2/fifoService");
const { convertUnit } = require("../../utils/costing-v2/unitConverter");
const {
  buildCostingQuery,
  getAllowedOutlets,
  validateOutletAccess,
  setOutletContext,
} = require("../../utils/costing-v2/accessControl");

// ==================== SUPPLIERS ====================

/**
 * @route   GET /api/costing-v2/suppliers
 * @desc    Get all suppliers
 */
exports.getSuppliers = async (req, res) => {
  try {
    const { isActive, search } = req.query;
    const filter = {};
    
    if (isActive !== undefined) filter.isActive = isActive === "true";
    if (search) filter.name = { $regex: search, $options: "i" };

    const suppliers = await Supplier.find(filter).sort({ name: 1 });
    res.json({ success: true, data: suppliers });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   POST /api/costing-v2/suppliers
 * @desc    Create supplier
 */
exports.createSupplier = async (req, res) => {
  try {
    const supplier = new Supplier(req.body);
    await supplier.save();
    res.status(201).json({ success: true, data: supplier });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

/**
 * @route   PUT /api/costing-v2/suppliers/:id
 * @desc    Update supplier
 */
exports.updateSupplier = async (req, res) => {
  try {
    const supplier = await Supplier.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );
    if (!supplier) {
      return res.status(404).json({ success: false, message: "Supplier not found" });
    }
    res.json({ success: true, data: supplier });
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
    const supplier = await Supplier.findByIdAndDelete(req.params.id);
    if (!supplier) {
      return res.status(404).json({ success: false, message: "Supplier not found" });
    }
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
    const { uom, lowStock, search, isActive, outletId, category, storageLocation } = req.query;
    const filter = {};

    if (uom) filter.uom = uom;
    if (isActive !== undefined) filter.isActive = isActive === "true";
    if (search) filter.name = { $regex: search, $options: "i" };
    if (outletId) filter.outletId = outletId;
    if (category) filter.category = category;
    if (storageLocation) filter.storageLocation = storageLocation;

    // Apply role-based filtering (ingredients can be shared, but if outletId is specified, filter by it)
    const costingFilter = await buildCostingQuery(req.user, filter, { skipOutletFilter: !outletId });

    let ingredients = await Ingredient.find(costingFilter)
      .populate("preferredSupplierId", "name")
      .populate("outletId", "name cafeName")
      .sort({ category: 1, name: 1 }); // Sort by category first, then name

    // Filter low stock after fetching (needs qtyOnHand comparison)
    if (lowStock === "true") {
      ingredients = ingredients.filter(ing => ing.qtyOnHand <= ing.reorderLevel);
    }

    res.json({ success: true, data: ingredients });
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
    // Ingredients can be shared (outletId optional) or kiosk-specific
    const data = await setOutletContext(req.user, { ...req.body }, false);
    const ingredient = new Ingredient(data);
    await ingredient.save();
    await ingredient.populate("outletId", "name cafeName");
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
    const ingredient = await Ingredient.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );
    if (!ingredient) {
      return res.status(404).json({ success: false, message: "Ingredient not found" });
    }
    res.json({ success: true, data: ingredient });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

/**
 * @route   DELETE /api/costing-v2/ingredients/:id
 * @desc    Delete ingredient
 */
exports.deleteIngredient = async (req, res) => {
  try {
    const ingredient = await Ingredient.findByIdAndDelete(req.params.id);
    if (!ingredient) {
      return res.status(404).json({ success: false, message: "Ingredient not found" });
    }
    res.json({ success: true, message: "Ingredient deleted" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   GET /api/costing-v2/ingredients/:id/fifo-layers
 * @desc    Get FIFO layers for ingredient
 */
exports.getFIFOLayers = async (req, res) => {
  try {
    const layers = await FIFOService.getLayers(req.params.id);
    res.json({ success: true, data: layers });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
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
    if (outletId) filter.outletId = outletId;
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
      .populate("outletId", "name cafeName")
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
    await purchase.populate("outletId", "name cafeName");

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
      return res.status(404).json({ success: false, message: "Purchase not found" });
    }

    // Validate outlet access
    if (!(await validateOutletAccess(req.user, purchase.outletId))) {
      return res.status(403).json({ success: false, message: "Access denied to this purchase" });
    }

    if (purchase.status === "received") {
      return res.status(400).json({ success: false, message: "Purchase already received" });
    }

    // Process each item: add FIFO layer and update inventory
    for (const item of purchase.items) {
      const ingredient = await Ingredient.findById(item.ingredientId);
      if (!ingredient) continue;

      // Convert to base unit
      const qtyInBaseUnit = ingredient.convertToBaseUnit(item.qty, item.uom);
      const unitCostInBaseUnit = item.unitPrice / ingredient.convertToBaseUnit(1, item.uom);

      // Add FIFO layer
      await FIFOService.addLayer(
        item.ingredientId,
        qtyInBaseUnit,
        unitCostInBaseUnit,
        purchase._id
      );

      // Create inventory transaction
      const transaction = new InventoryTransaction({
        ingredientId: item.ingredientId,
        type: "IN",
        qty: qtyInBaseUnit,
        uom: ingredient.baseUnit,
        refType: "purchase",
        refId: purchase._id,
        date: new Date(),
        costAllocated: qtyInBaseUnit * unitCostInBaseUnit,
        recordedBy: req.user._id,
        outletId: purchase.outletId || null,
      });
      await transaction.save();
    }

    // Update purchase status
    purchase.status = "received";
    purchase.receivedDate = new Date();
    purchase.receivedBy = req.user._id;
    await purchase.save();

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
      return res.status(404).json({ success: false, message: "Ingredient not found" });
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
        return res.status(400).json({ success: false, message: "outletId is required for franchise admin" });
      }
      if (!(await validateOutletAccess(req.user, outletId))) {
        return res.status(403).json({ success: false, message: "Access denied to this kiosk" });
      }
      finalOutletId = outletId;
    } else if (req.user.role === "super_admin") {
      // Super admin - must provide outletId
      if (!outletId) {
        return res.status(400).json({ success: false, message: "outletId is required for super admin" });
      }
      finalOutletId = outletId;
    }

    // Convert to base unit
    const qtyInBaseUnit = ingredient.convertToBaseUnit(qty, uom);

    // Consume using FIFO
    const result = await FIFOService.consume(
      ingredientId,
      qtyInBaseUnit,
      refType || "manual",
      refId || null,
      req.user._id,
      finalOutletId
    );

    res.json({ success: true, data: result });
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

    // Apply role-based filtering for outletId only (inventory transactions don't have franchiseId)
    if (req.user.role === "admin") {
      // Cart admin - only see their own kiosk's transactions
      filter.outletId = req.user._id;
    } else if (req.user.role === "franchise_admin") {
      // Franchise admin - can filter by specific outlet or see all their franchise outlets
      if (outletId) {
        // Validate outlet belongs to their franchise
        const outlet = await User.findById(outletId);
        if (!outlet || outlet.franchiseId?.toString() !== req.user._id.toString()) {
          return res.status(403).json({ success: false, message: "Access denied: Kiosk does not belong to your franchise" });
        }
        filter.outletId = outletId;
      } else {
        // Get all kiosks under franchise
        const outlets = await User.find({ role: "admin", franchiseId: req.user._id, isActive: true }).select("_id");
        filter.outletId = { $in: outlets.map(o => o._id) };
      }
    } else if (req.user.role === "super_admin") {
      // Super admin - can filter by outlet or see all
      if (outletId) {
        filter.outletId = outletId;
      }
      // If no outletId specified, show all transactions
    }

    const transactions = await InventoryTransaction.find(filter)
      .populate("ingredientId", "name uom category storageLocation")
      .populate("recordedBy", "name email")
      .populate("outletId", "name cafeName")
      .sort({ date: -1 })
      .limit(1000); // Pagination can be added later

    res.json({ success: true, data: transactions });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   GET /api/costing-v2/low-stock
 * @desc    Get ingredients below reorder level
 */
exports.getLowStock = async (req, res) => {
  try {
    // Apply role-based filtering (ingredients can be shared, so skip outletId filter)
    const filter = await buildCostingQuery(req.user, { isActive: true }, { skipOutletFilter: true });
    const ingredients = await Ingredient.find(filter);
    const lowStock = ingredients.filter(
      ing => ing.qtyOnHand <= ing.reorderLevel
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
    const { ingredientId, qty, uom, reason, reasonDetails, outletId } = req.body;

    const ingredient = await Ingredient.findById(ingredientId);
    if (!ingredient) {
      return res.status(404).json({ success: false, message: "Ingredient not found" });
    }

    // Validate and set outlet context
    const finalOutletId = outletId || (req.user.role === "admin" ? req.user._id : null);
    if (finalOutletId && !(await validateOutletAccess(req.user, finalOutletId))) {
      return res.status(403).json({ success: false, message: "Access denied to this kiosk" });
    }

    // Convert to base unit
    const qtyInBaseUnit = ingredient.convertToBaseUnit(qty, uom);

    // Consume using FIFO to get cost
    const consumeResult = await FIFOService.consume(
      ingredientId,
      qtyInBaseUnit,
      "waste",
      null,
      req.user._id,
      finalOutletId
    );

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
      outletId: finalOutletId,
    });

    await waste.save();
    await waste.populate("ingredientId", "name uom");

    res.status(201).json({ success: true, data: waste });
  } catch (error) {
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

    // Apply role-based filtering for outletId (waste model doesn't have franchiseId)
    if (req.user.role === "admin") {
      // Cart admin - only see their own kiosk's waste records
      filter.outletId = req.user._id;
    } else if (req.user.role === "franchise_admin") {
      // Franchise admin - can filter by specific outlet or see all their franchise outlets
      if (outletId) {
        // Validate outlet belongs to their franchise
        const outlet = await User.findById(outletId);
        if (!outlet || outlet.franchiseId?.toString() !== req.user._id.toString()) {
          return res.status(403).json({ success: false, message: "Access denied: Kiosk does not belong to your franchise" });
        }
        filter.outletId = outletId;
      } else {
        // Get all kiosks under franchise
        const outlets = await User.find({ role: "admin", franchiseId: req.user._id, isActive: true }).select("_id");
        filter.outletId = { $in: outlets.map(o => o._id) };
      }
    } else if (req.user.role === "super_admin") {
      // Super admin - can filter by outlet or see all
      if (outletId) {
        filter.outletId = outletId;
      }
      // If no outletId specified, show all waste records
    }

    const waste = await Waste.find(filter)
      .populate("ingredientId", "name uom")
      .populate("recordedBy", "name email")
      .populate("outletId", "name cafeName")
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
    const { isActive, search, outletId } = req.query;
    const filter = {};

    if (isActive !== undefined) filter.isActive = isActive === "true";
    if (search) filter.name = { $regex: search, $options: "i" };
    if (outletId) filter.outletId = outletId;

    // Apply role-based filtering (recipes can be shared or kiosk-specific)
    const costingFilter = await buildCostingQuery(req.user, filter);

    const recipes = await Recipe.find(costingFilter)
      .populate("ingredients.ingredientId", "name uom baseUnit currentCostPerBaseUnit")
      .populate("outletId", "name cafeName")
      .sort({ name: 1 });

    res.json({ success: true, data: recipes });
  } catch (error) {
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
    const recipe = new Recipe(data);
    
    // Calculate cost
    await recipe.calculateCost();
    await recipe.save();
    
    await recipe.populate("ingredients.ingredientId", "name uom baseUnit currentCostPerBaseUnit");
    await recipe.populate("outletId", "name cafeName");

    res.status(201).json({ success: true, data: recipe });
  } catch (error) {
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
      return res.status(404).json({ success: false, message: "Recipe not found" });
    }

    Object.assign(recipe, req.body);
    
    // Recalculate cost
    await recipe.calculateCost();
    await recipe.save();
    
    await recipe.populate("ingredients.ingredientId", "name uom baseUnit currentCostPerBaseUnit");

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
      return res.status(404).json({ success: false, message: "Recipe not found" });
    }

    await recipe.calculateCost();
    await recipe.save();

    // Update linked menu items
    const menuItems = await MenuItem.find({ recipeId: recipe._id });
    for (const menuItem of menuItems) {
      menuItem.calculateMetrics(recipe.costPerPortion);
      await menuItem.save();
    }

    await recipe.populate("ingredients.ingredientId", "name uom baseUnit currentCostPerBaseUnit");

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
      return res.status(404).json({ success: false, message: "Recipe not found" });
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
      console.log(`[RECIPE DELETE] Unlinked ${linkedMenuItems.length} menu item(s) from recipe ${recipe.name}`);
    }

    // Delete the recipe
    await Recipe.findByIdAndDelete(req.params.id);
    
    res.json({ 
      success: true, 
      message: linkedMenuItems.length > 0 
        ? `Recipe deleted successfully. ${linkedMenuItems.length} menu item(s) have been unlinked.`
        : "Recipe deleted successfully"
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
    if (outletId) filter.outletId = outletId;

    // Apply role-based filtering (menu items are kiosk-specific)
    const costingFilter = await buildCostingQuery(req.user, filter);

    const menuItems = await MenuItem.find(costingFilter)
      .populate("recipeId", "name costPerPortion portions")
      .populate("outletId", "name cafeName")
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
    const { recipeId, sellingPrice } = req.body;

    // Recipe is optional - if provided, validate it exists
    if (recipeId) {
      const recipe = await Recipe.findById(recipeId);
      if (!recipe) {
        return res.status(404).json({ success: false, message: "Recipe not found" });
      }
    }

    // Set outlet context (menu items are kiosk-specific)
    const data = await setOutletContext(req.user, { ...req.body });

    const menuItem = new MenuItem(data);
    
    // Set defaultMenuPath if default menu fields are provided
    if (req.body.defaultMenuFranchiseId && req.body.defaultMenuCategoryName && req.body.defaultMenuItemName) {
      menuItem.defaultMenuPath = `${req.body.defaultMenuFranchiseId}/${req.body.defaultMenuCategoryName}/${req.body.defaultMenuItemName}`;
    }
    
    // Calculate metrics if recipe is provided
    if (recipeId) {
      const recipe = await Recipe.findById(recipeId);
      if (recipe) {
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
    await menuItem.populate("outletId", "name cafeName");

    res.status(201).json({ success: true, data: menuItem });
  } catch (error) {
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
      return res.status(404).json({ success: false, message: "Menu item not found" });
    }

    // Use recipeId from request body if provided, otherwise use existing recipeId
    const recipeIdToUse = req.body.recipeId !== undefined ? req.body.recipeId : menuItem.recipeId;
    
    // Validate recipe if provided
    if (recipeIdToUse) {
      const recipe = await Recipe.findById(recipeIdToUse);
      if (!recipe) {
        return res.status(404).json({ success: false, message: "Recipe not found" });
      }
    }

    Object.assign(menuItem, req.body);
    
    // Ensure recipeId is set (can be null to unlink)
    menuItem.recipeId = recipeIdToUse || null;
    
    // Update defaultMenuPath if default menu fields are provided
    if (req.body.defaultMenuFranchiseId || req.body.defaultMenuCategoryName || req.body.defaultMenuItemName) {
      const franchiseId = req.body.defaultMenuFranchiseId || menuItem.defaultMenuFranchiseId;
      const categoryName = req.body.defaultMenuCategoryName || menuItem.defaultMenuCategoryName;
      const itemName = req.body.defaultMenuItemName || menuItem.defaultMenuItemName;
      if (franchiseId && categoryName && itemName) {
        menuItem.defaultMenuPath = `${franchiseId}/${categoryName}/${itemName}`;
      }
    }
    
    // Calculate metrics if recipe is provided
    if (recipeIdToUse) {
      const recipe = await Recipe.findById(recipeIdToUse);
      if (recipe) {
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
        message: "Access denied. Only cart admin can delete menu items." 
      });
    }

    const menuItem = await MenuItem.findById(req.params.id);
    if (!menuItem) {
      return res.status(404).json({ success: false, message: "Menu item not found" });
    }

    // Verify that the menu item belongs to the cart admin's outlet
    if (menuItem.outletId && menuItem.outletId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ 
        success: false, 
        message: "Access denied. You can only delete your own menu items." 
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
 */
exports.getDefaultMenuItems = async (req, res) => {
  try {
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
          const franchiseIdStr = franchiseId ? franchiseId.toString() : "global";
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
      return res.status(400).json({ success: false, message: "Items array is required" });
    }

    if (!recipeId) {
      return res.status(400).json({ success: false, message: "Recipe ID is required" });
    }

    const recipe = await Recipe.findById(recipeId);
    if (!recipe) {
      return res.status(404).json({ success: false, message: "Recipe not found" });
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
          const category = defaultMenu.categories.find(c => c.name === item.category);
          if (category && category.items) {
            const defaultItem = category.items.find(i => i.name === item.name);
            if (defaultItem && defaultItem.price) {
              sellingPrice = defaultItem.price;
            }
          }
        }

        // Check if menu item already exists
        const existingItem = await MenuItem.findOne({
          name: item.name,
          category: item.category,
          outletId: outletData.outletId,
          defaultMenuPath: item.defaultMenuPath,
        });

        if (existingItem) {
          errors.push({ item: item.name, error: "Already exists" });
          continue;
        }

        // Create new menu item
        const menuItem = new MenuItem({
          name: item.name,
          category: item.category,
          sellingPrice,
          recipeId,
          outletId: outletData.outletId,
          franchiseId: outletData.franchiseId,
          defaultMenuFranchiseId: item.franchiseId || null,
          defaultMenuCategoryName: item.category,
          defaultMenuItemName: item.name,
          defaultMenuPath: item.defaultMenuPath,
        });

        menuItem.calculateMetrics(recipe.costPerPortion);
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
    if (req.user.role !== "super_admin" && req.user.role !== "franchise_admin") {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    const { from, to } = req.query;
    const dateFilter = {};
    if (from || to) {
      dateFilter.date = {};
      if (from) dateFilter.date.$gte = new Date(from);
      if (to) dateFilter.date.$lte = new Date(to);
    }

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
        isActive: true 
      })
        .select("_id name cafeName email franchiseId cartCode")
        .populate("franchiseId", "name")
        .sort({ cafeName: 1 })
        .lean();
    }

    const hierarchicalData = [];

    for (const franchise of franchises) {
      const franchiseKiosks = kiosks.filter(
        k => k.franchiseId && k.franchiseId._id.toString() === franchise._id.toString()
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
          totalCost: 0,
          profit: 0,
          foodCostPercent: 0,
          profitMargin: 0,
        },
      };

      for (const kiosk of franchiseKiosks) {
        // Get P&L for this kiosk
        const kioskDateFilter = { ...dateFilter, outletId: kiosk._id };
        const kioskCostingFilter = await buildCostingQuery(
          { ...req.user, _id: kiosk._id, role: "admin" },
          kioskDateFilter
        );

        // Get food cost from inventory transactions
        const consumptionTransactions = await InventoryTransaction.aggregate([
          {
            $match: {
              type: { $in: ["OUT", "WASTE"] },
              ...kioskCostingFilter,
            },
          },
          {
            $group: {
              _id: null,
              totalCost: { $sum: "$costAllocated" },
            },
          },
        ]);
        const foodCost = consumptionTransactions[0]?.totalCost || 0;

        // Get labour costs
        const labourFilter = { outletId: kiosk._id };
        if (from || to) {
          labourFilter.$or = [
            { periodFrom: { $lte: new Date(to || "2099-12-31") }, periodTo: { $gte: new Date(from || "1970-01-01") } }
          ];
        }
        const labourCosts = await LabourCost.find(labourFilter);
        const labourCost = labourCosts.reduce((sum, l) => sum + l.amount, 0);

        // Get overheads
        const overheadFilter = { ...labourFilter };
        const overheads = await Overhead.find(overheadFilter);
        const overheadCost = overheads.reduce((sum, o) => sum + o.amount, 0);

        // Get sales from orders (use cartId, not cafeId)
        const orderFilter = { cartId: kiosk._id, status: { $in: ["Paid", "Finalized"] } };
        if (from || to) {
          orderFilter.createdAt = {};
          if (from) orderFilter.createdAt.$gte = new Date(from);
          if (to) orderFilter.createdAt.$lte = new Date(to);
        }
        const orders = await Order.find(orderFilter).lean();
        const sales = orders.reduce((sum, order) => {
          const orderTotal = order.kotLines?.reduce((s, kot) => s + Number(kot.totalAmount || 0), 0) || 0;
          return sum + orderTotal;
        }, 0);

        const totalCost = foodCost + labourCost + overheadCost;
        const profit = sales - totalCost;
        const foodCostPercent = sales > 0 ? (foodCost / sales) * 100 : 0;
        const profitMargin = sales > 0 ? (profit / sales) * 100 : 0;

        const kioskData = {
          kioskId: kiosk._id,
          kioskName: kiosk.cafeName || kiosk.name,
          kioskCode: kiosk.cartCode || kiosk._id.toString().slice(-8), // Use cartCode, fallback to last 8 chars of ID
          sales,
          foodCost,
          labourCost,
          overheadCost,
          totalCost,
          profit,
          foodCostPercent,
          profitMargin,
        };

        franchiseData.kiosks.push(kioskData);

        // Aggregate franchise totals
        franchiseData.totals.sales += sales;
        franchiseData.totals.foodCost += foodCost;
        franchiseData.totals.labourCost += labourCost;
        franchiseData.totals.overheadCost += overheadCost;
        franchiseData.totals.totalCost += totalCost;
        franchiseData.totals.profit += profit;
      }

      // Calculate franchise-level percentages
      if (franchiseData.totals.sales > 0) {
        franchiseData.totals.foodCostPercent = (franchiseData.totals.foodCost / franchiseData.totals.sales) * 100;
        franchiseData.totals.profitMargin = (franchiseData.totals.profit / franchiseData.totals.sales) * 100;
      }

      hierarchicalData.push(franchiseData);
    }

    // Calculate grand totals
    const grandTotals = hierarchicalData.reduce(
      (acc, franchise) => ({
        sales: acc.sales + franchise.totals.sales,
        foodCost: acc.foodCost + franchise.totals.foodCost,
        labourCost: acc.labourCost + franchise.totals.labourCost,
        overheadCost: acc.overheadCost + franchise.totals.overheadCost,
        totalCost: acc.totalCost + franchise.totals.totalCost,
        profit: acc.profit + franchise.totals.profit,
      }),
      { sales: 0, foodCost: 0, labourCost: 0, overheadCost: 0, totalCost: 0, profit: 0 }
    );

    if (grandTotals.sales > 0) {
      grandTotals.foodCostPercent = (grandTotals.foodCost / grandTotals.sales) * 100;
      grandTotals.profitMargin = (grandTotals.profit / grandTotals.sales) * 100;
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
        { periodFrom: { $lte: new Date(to || "2099-12-31") }, periodTo: { $gte: new Date(from || "1970-01-01") } }
      ];
    }

    // Apply role-based filtering
    const costingFilter = await buildCostingQuery(req.user, filter);

    const costs = await LabourCost.find(costingFilter)
      .populate("createdBy", "name email")
      .populate("outletId", "name cafeName")
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
    await labourCost.populate("outletId", "name cafeName");
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
        { periodFrom: { $lte: new Date(to || "2099-12-31") }, periodTo: { $gte: new Date(from || "1970-01-01") } }
      ];
    }

    // Apply role-based filtering
    const costingFilter = await buildCostingQuery(req.user, filter);

    const overheads = await Overhead.find(costingFilter)
      .populate("createdBy", "name email")
      .populate("outletId", "name cafeName")
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
    await overhead.populate("outletId", "name cafeName");
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
    
    // Build date filter for transactions (use date field, not createdAt)
    const transactionDateFilter = {};
    if (from || to) {
      transactionDateFilter.date = {};
      if (from) transactionDateFilter.date.$gte = new Date(from + "T00:00:00.000Z");
      if (to) transactionDateFilter.date.$lte = new Date(to + "T23:59:59.999Z"); // Include full day
    }

    // Build outlet filter based on role
    let transactionOutletFilter = {};
    if (req.user.role === "admin") {
      // Cart admin - only their own kiosk
      transactionOutletFilter.outletId = req.user._id;
    } else if (req.user.role === "franchise_admin") {
      // Franchise admin - specific outlet or all their franchise outlets
      if (outletId) {
        const outlet = await User.findById(outletId);
        if (!outlet || outlet.franchiseId?.toString() !== req.user._id.toString()) {
          return res.status(403).json({ success: false, message: "Access denied: Kiosk does not belong to your franchise" });
        }
        transactionOutletFilter.outletId = outletId;
      } else {
        const outlets = await User.find({ role: "admin", franchiseId: req.user._id, isActive: true }).select("_id");
        transactionOutletFilter.outletId = { $in: outlets.map(o => o._id) };
      }
    } else if (req.user.role === "super_admin") {
      // Super admin - specific outlet or all
      if (outletId) {
        transactionOutletFilter.outletId = outletId;
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

    const totalFoodCost = consumptionTransactions[0]?.totalFoodCost || 0;

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
        const outlets = await User.find({ role: "admin", franchiseId: req.user._id, isActive: true }).select("_id");
        const outletIds = outlets.map(o => o._id);
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
          totalSales: { $sum: "$kotLines.totalAmount" },
        },
      },
    ]);

    const totalSales = salesData[0]?.totalSales || 0;
    const foodCostPercent = totalSales > 0 ? (totalFoodCost / totalSales) * 100 : 0;

    res.json({
      success: true,
      data: {
        period: { from, to },
        totalFoodCost,
        totalSales,
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
        const outlets = await User.find({ role: "admin", franchiseId: req.user._id, isActive: true }).select("_id");
        const outletIds = outlets.map(o => o._id);
        orderFilter.cartId = { $in: outletIds };
      }
    } else if (req.user.role === "super_admin") {
      // Super admin - specific outlet or all
      if (outletId) {
        orderFilter.cartId = outletId;
      }
    }

    // Get menu items with sales data
    const menuItems = await MenuItem.find({ isActive: true })
      .populate("recipeId", "name costPerPortion");

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
            revenue: { $sum: { $multiply: ["$kotLines.items.quantity", "$kotLines.items.price"] } },
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
    const { supplierId, ingredientId } = req.query;
    const filter = { status: "received" };

    if (supplierId) filter.supplierId = supplierId;

    const purchases = await Purchase.find(filter)
      .populate("supplierId", "name")
      .populate("items.ingredientId", "name uom")
      .sort({ date: -1 });

    const priceHistory = [];

    for (const purchase of purchases) {
      for (const item of purchase.items) {
        if (ingredientId && item.ingredientId.toString() !== ingredientId) continue;

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
    
    // Build date filter for transactions (use date field, not createdAt)
    const transactionDateFilter = {};
    if (from || to) {
      transactionDateFilter.date = {};
      if (from) transactionDateFilter.date.$gte = new Date(from + "T00:00:00.000Z");
      if (to) transactionDateFilter.date.$lte = new Date(to + "T23:59:59.999Z"); // Include full day
    }

    // Build outlet filter based on role
    let transactionOutletFilter = {};
    if (req.user.role === "admin") {
      // Cart admin - only their own kiosk
      transactionOutletFilter.outletId = req.user._id;
    } else if (req.user.role === "franchise_admin") {
      // Franchise admin - specific outlet or all their franchise outlets
      if (outletId) {
        const outlet = await User.findById(outletId);
        if (!outlet || outlet.franchiseId?.toString() !== req.user._id.toString()) {
          return res.status(403).json({ success: false, message: "Access denied: Kiosk does not belong to your franchise" });
        }
        transactionOutletFilter.outletId = outletId;
      } else {
        const outlets = await User.find({ role: "admin", franchiseId: req.user._id, isActive: true }).select("_id");
        transactionOutletFilter.outletId = { $in: outlets.map(o => o._id) };
      }
    } else if (req.user.role === "super_admin") {
      // Super admin - specific outlet or all
      if (outletId) {
        transactionOutletFilter.outletId = outletId;
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

    const foodCost = consumptionTransactions[0]?.totalFoodCost || 0;

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
        const outlets = await User.find({ role: "admin", franchiseId: req.user._id, isActive: true }).select("_id");
        const outletIds = outlets.map(o => o._id);
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
          totalSales: { $sum: "$kotLines.totalAmount" },
        },
      },
    ]);

    const totalSales = salesData[0]?.totalSales || 0;

    // Get labour costs
    const labourFilter = {};
    if (req.user.role === "admin") {
      // Cart admin - only their own kiosk
      labourFilter.outletId = req.user._id;
    } else if (req.user.role === "franchise_admin") {
      // Franchise admin - specific outlet or all their franchise outlets
      if (outletId) {
        labourFilter.outletId = outletId;
      } else {
        const outlets = await User.find({ role: "admin", franchiseId: req.user._id, isActive: true }).select("_id");
        labourFilter.outletId = { $in: outlets.map(o => o._id) };
      }
    } else if (req.user.role === "super_admin") {
      // Super admin - specific outlet or all
      if (outletId) {
        labourFilter.outletId = outletId;
      }
    }
    
    if (from || to) {
      labourFilter.$or = [
        { periodFrom: { $lte: new Date(to || "2099-12-31") }, periodTo: { $gte: new Date(from || "1970-01-01") } }
      ];
    }

    const labourCosts = await LabourCost.find(labourFilter);
    const totalLabour = labourCosts.reduce((sum, l) => sum + l.amount, 0);

    // Get overheads (same filter as labour)
    const overheads = await Overhead.find(labourFilter);
    const totalOverhead = overheads.reduce((sum, o) => sum + o.amount, 0);

    // Get expenses
    const expenseFilter = {};
    if (req.user.role === "admin") {
      // Cart admin - only their own kiosk
      expenseFilter.outletId = req.user._id;
    } else if (req.user.role === "franchise_admin") {
      // Franchise admin - specific outlet or all their franchise outlets
      if (outletId) {
        expenseFilter.outletId = outletId;
      } else {
        const outlets = await User.find({ role: "admin", franchiseId: req.user._id, isActive: true }).select("_id");
        expenseFilter.outletId = { $in: outlets.map(o => o._id) };
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

    const expenses = await CostingExpense.find(expenseFilter);
    const totalExpenses = expenses.reduce((sum, e) => sum + (e.amount || 0), 0);

    // Calculate P&L
    const totalCosts = foodCost + totalLabour + totalOverhead + totalExpenses;
    const profit = totalSales - totalCosts;
    const profitMargin = totalSales > 0 ? (profit / totalSales) * 100 : 0;

    res.json({
      success: true,
      data: {
        period: { from, to },
        sales: totalSales,
        costs: {
          foodCost,
          labour: totalLabour,
          overhead: totalOverhead,
          expenses: totalExpenses,
          total: totalCosts,
        },
        profit,
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
      validateOutletAccess(req.user, outletId);
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
    const expenseData = setOutletContext(req.user, req.body, true);
    expenseData.createdBy = req.user._id;
    
    if (!expenseData.expenseDate) {
      expenseData.expenseDate = new Date();
    }
    
    const expense = new CostingExpense(expenseData);
    await expense.save();
    
    res.status(201).json({ success: true, data: expense });
  } catch (error) {
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
      return res.status(404).json({ success: false, message: "Expense not found" });
    }
    
    validateOutletAccess(req.user, expense.outletId);
    
    Object.assign(expense, req.body);
    await expense.save();
    
    res.json({ success: true, data: expense });
  } catch (error) {
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
      return res.status(404).json({ success: false, message: "Expense not found" });
    }
    
    validateOutletAccess(req.user, expense.outletId);
    
    await CostingExpense.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: "Expense deleted successfully" });
  } catch (error) {
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
      validateOutletAccess(req.user, outletId);
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
    const summaryArray = Object.values(categorySummary).sort((a, b) => b.total - a.total);
    
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
    const categories = await CostingExpenseCategory.find(query).sort({ name: 1 }).lean();
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
    const { syncDefaultMenuToCosting } = require("../../services/costing-v2/syncDefaultMenuToCosting");
    
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

    const syncResult = await syncDefaultMenuToCosting(targetFranchiseId, cartId, targetOutletId);
    
    res.json({
      success: syncResult.success,
      data: {
        updated: syncResult.updated || 0,
        notFound: syncResult.notFound || 0,
        errors: syncResult.errors || [],
        message: syncResult.error || `Successfully synced ${syncResult.updated || 0} menu items`,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

