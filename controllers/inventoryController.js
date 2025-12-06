const InventoryItem = require("../models/inventoryModel");
const User = require("../models/userModel");
const Employee = require("../models/employeeModel");
const IngredientV2 = require("../models/costing-v2/ingredientModel");
const { buildCostingQuery } = require("../utils/costing-v2/accessControl");

// Helper to get cafeId based on user role
const getCafeId = async (user) => {
  if (user.role === "admin") {
    return user._id;
  } else if (["waiter", "cook", "captain", "manager"].includes(user.role)) {
    // Mobile users - these are direct User records with cafeId set during login
    // First check if User has cafeId directly
    if (user.cafeId) {
      return user.cafeId;
    }
    // Fallback: try to find Employee record by email (since Employee doesn't have userId)
    const employee = await Employee.findOne({ email: user.email?.toLowerCase() }).lean();
    return employee?.cafeId;
  } else if (user.role === "employee") {
    // Legacy employee role - look up Employee by email
    const employee = await Employee.findOne({ email: user.email?.toLowerCase() }).lean();
    return employee?.cafeId;
  } else if (user.role === "franchise_admin") {
    return null; // Franchise admin doesn't have a specific cafeId
  }
  return null;
};

// Get all inventory items
exports.getAllInventory = async (req, res) => {
  try {
    const query = {};

    // Filter based on user role
    if (req.user && req.user.role === "admin" && req.user._id) {
      query.cafeId = req.user._id;
    } else if (req.user && req.user.role === "franchise_admin" && req.user._id) {
      query.franchiseId = req.user._id;
    } else if (["waiter", "cook", "captain", "manager"].includes(req.user?.role)) {
      // Mobile users - get cafeId from employee record
      const cafeId = await getCafeId(req.user);
      if (cafeId) {
        query.cafeId = cafeId;
      }
    } else if (req.user?.role === "employee") {
      const cafeId = await getCafeId(req.user);
      if (cafeId) {
        query.cafeId = cafeId;
      }
    }

    const items = await InventoryItem.find(query)
      .sort({ category: 1, name: 1 })
      .lean();
    
    console.log('[INVENTORY] getAllInventory - Found items:', items.length);

    // Return in consistent format for both admin app and admin site
    return res.json({
      success: true,
      data: items,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Get single inventory item
exports.getInventoryItem = async (req, res) => {
  try {
    const item = await InventoryItem.findById(req.params.id).lean();
    if (!item) {
      return res.status(404).json({ message: "Inventory item not found" });
    }

    // Check access permissions
    if (req.user && req.user.role === "admin" && req.user._id) {
      if (!item.cafeId || item.cafeId.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: "Item does not belong to your cafe" });
      }
    } else if (req.user && req.user.role === "franchise_admin" && req.user._id) {
      if (!item.franchiseId || item.franchiseId.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: "Item does not belong to your franchise" });
      }
    } else if (["waiter", "cook", "captain", "manager"].includes(req.user?.role)) {
      // Mobile users - check if item belongs to their cafe
      const cafeId = await getCafeId(req.user);
      if (!cafeId || !item.cafeId || item.cafeId.toString() !== cafeId.toString()) {
        return res.status(403).json({ message: "Item does not belong to your cafe" });
      }
    } else if (req.user?.role === "employee") {
      const cafeId = await getCafeId(req.user);
      if (!cafeId || !item.cafeId || item.cafeId.toString() !== cafeId.toString()) {
        return res.status(403).json({ message: "Item does not belong to your cafe" });
      }
    }

    return res.json(item);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Create inventory item
exports.createInventoryItem = async (req, res) => {
  try {
    const itemData = { ...req.body };

    // Ensure required fields have defaults
    if (itemData.unitPrice === undefined || itemData.unitPrice === null) {
      itemData.unitPrice = 0;
    }
    if (itemData.quantity === undefined || itemData.quantity === null) {
      itemData.quantity = 0;
    }
    if (itemData.minStockLevel === undefined || itemData.minStockLevel === null) {
      itemData.minStockLevel = 0;
    }
    if (!itemData.unit) {
      itemData.unit = 'piece';
    }

    // If ingredientId is provided, fetch ingredient data and sync
    if (itemData.ingredientId) {
      const ingredient = await IngredientV2.findById(itemData.ingredientId);
      if (!ingredient) {
        return res.status(404).json({ message: "Ingredient not found" });
      }
      
      // Sync data from ingredient
      if (!itemData.name) itemData.name = ingredient.name;
      if (!itemData.category) itemData.category = ingredient.category;
      if (!itemData.unit) {
        // Map costing-v2 uom to inventory unit
        const unitMap = {
          'kg': 'kg', 'g': 'g', 'l': 'L', 'ml': 'mL',
          'pcs': 'piece', 'pack': 'pack', 'box': 'box',
          'bottle': 'bottle', 'dozen': 'dozen'
        };
        itemData.unit = unitMap[ingredient.uom] || 'piece';
      }
      if (itemData.quantity === undefined || itemData.quantity === null) {
        itemData.quantity = ingredient.qtyOnHand || 0;
      }
      if (itemData.minStockLevel === undefined || itemData.minStockLevel === null) {
        itemData.minStockLevel = ingredient.reorderLevel || 0;
      }
      if (itemData.unitPrice === undefined || itemData.unitPrice === null) {
        itemData.unitPrice = ingredient.currentCostPerBaseUnit || 0;
      }
      if (!itemData.location) {
        itemData.location = ingredient.storageLocation || "Main Storage";
      }
      
      // Set outlet context from ingredient
      if (ingredient.outletId) {
        itemData.cafeId = ingredient.outletId;
      }
      if (ingredient.franchiseId) {
        itemData.franchiseId = ingredient.franchiseId;
      }
    }

    // Set hierarchy relationships (only if not set from ingredient)
    if (!itemData.cafeId) {
      if (req.user && req.user.role === "admin" && req.user._id) {
        itemData.cafeId = req.user._id;
        // Get franchiseId from cafe admin
        const cafeAdmin = await User.findById(req.user._id);
        if (cafeAdmin && cafeAdmin.franchiseId) {
          itemData.franchiseId = cafeAdmin.franchiseId;
        }
      } else if (req.user && req.user.role === "franchise_admin" && req.user._id) {
        itemData.franchiseId = req.user._id;
      } else if (["waiter", "cook", "captain", "manager"].includes(req.user?.role)) {
        // Mobile users - get cafeId from employee record
        const cafeId = await getCafeId(req.user);
        if (!cafeId) {
          return res.status(403).json({ message: "No cafe associated with this user" });
        }
        itemData.cafeId = cafeId;
        // Get franchiseId from employee
        const employee = await Employee.findOne({ email: req.user.email?.toLowerCase() }).lean();
        if (employee && employee.franchiseId) {
          itemData.franchiseId = employee.franchiseId;
        }
      } else if (req.user?.role === "employee") {
        const cafeId = await getCafeId(req.user);
        if (!cafeId) {
          return res.status(403).json({ message: "No cafe associated with this user" });
        }
        itemData.cafeId = cafeId;
        const employee = await Employee.findOne({ email: req.user.email?.toLowerCase() }).lean();
        if (employee && employee.franchiseId) {
          itemData.franchiseId = employee.franchiseId;
        }
      }
    }

    const item = await InventoryItem.create(itemData);
    
    // Emit socket event to cafe room
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    if (item.cafeId) {
      emitToCafe(io, item.cafeId.toString(), "inventory:created", item);
      emitToCafe(io, item.cafeId.toString(), "inventory:updated", item);
    }
    
    return res.status(201).json(item);
  } catch (err) {
    console.error('[INVENTORY] Create error:', err);
    return res.status(500).json({ message: err.message || 'Failed to create inventory item' });
  }
};

// Update inventory item
exports.updateInventoryItem = async (req, res) => {
  try {
    const item = await InventoryItem.findById(req.params.id);
    if (!item) {
      return res.status(404).json({ message: "Inventory item not found" });
    }

    // Check access permissions
    if (req.user && req.user.role === "admin" && req.user._id) {
      if (!item.cafeId || item.cafeId.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: "Item does not belong to your cafe" });
      }
    } else if (req.user && req.user.role === "franchise_admin" && req.user._id) {
      if (!item.franchiseId || item.franchiseId.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: "Item does not belong to your franchise" });
      }
    } else if (["waiter", "cook", "captain", "manager"].includes(req.user?.role)) {
      // Mobile users - check if item belongs to their cafe
      const cafeId = await getCafeId(req.user);
      if (!cafeId || !item.cafeId || item.cafeId.toString() !== cafeId.toString()) {
        return res.status(403).json({ message: "Item does not belong to your cafe" });
      }
    } else if (req.user?.role === "employee") {
      const cafeId = await getCafeId(req.user);
      if (!cafeId || !item.cafeId || item.cafeId.toString() !== cafeId.toString()) {
        return res.status(403).json({ message: "Item does not belong to your cafe" });
      }
    }

    Object.assign(item, req.body);
    await item.save();
    
    // Emit socket event to cafe room
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    if (item.cafeId) {
      emitToCafe(io, item.cafeId.toString(), "inventory:updated", item);
    }
    
    return res.json(item);
  } catch (err) {
    console.error('[INVENTORY] Update error:', err);
    return res.status(500).json({ message: err.message || 'Failed to update inventory item' });
  }
};

// Delete inventory item
exports.deleteInventoryItem = async (req, res) => {
  try {
    const item = await InventoryItem.findById(req.params.id);
    if (!item) {
      return res.status(404).json({ message: "Inventory item not found" });
    }

    // Check access permissions
    if (req.user && req.user.role === "admin" && req.user._id) {
      if (!item.cafeId || item.cafeId.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: "Item does not belong to your cafe" });
      }
    } else if (req.user && req.user.role === "franchise_admin" && req.user._id) {
      if (!item.franchiseId || item.franchiseId.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: "Item does not belong to your franchise" });
      }
    } else if (["waiter", "cook", "captain", "manager"].includes(req.user?.role)) {
      // Mobile users - check if item belongs to their cafe
      const cafeId = await getCafeId(req.user);
      if (!cafeId || !item.cafeId || item.cafeId.toString() !== cafeId.toString()) {
        return res.status(403).json({ message: "Item does not belong to your cafe" });
      }
    } else if (req.user?.role === "employee") {
      const cafeId = await getCafeId(req.user);
      if (!cafeId || !item.cafeId || item.cafeId.toString() !== cafeId.toString()) {
        return res.status(403).json({ message: "Item does not belong to your cafe" });
      }
    }

    // Emit socket event before deletion
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    if (item.cafeId) {
      emitToCafe(io, item.cafeId.toString(), "inventory:deleted", { id: req.params.id });
    }
    
    await InventoryItem.findByIdAndDelete(req.params.id);
    return res.json({ message: "Inventory item deleted successfully" });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Update stock quantity
exports.updateStock = async (req, res) => {
  try {
    const { quantity, operation } = req.body; // operation: 'add', 'subtract', 'set'
    const item = await InventoryItem.findById(req.params.id);
    if (!item) {
      return res.status(404).json({ message: "Inventory item not found" });
    }

    // Check access permissions
    if (req.user && req.user.role === "admin" && req.user._id) {
      if (!item.cafeId || item.cafeId.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: "Item does not belong to your cafe" });
      }
    } else if (req.user && req.user.role === "franchise_admin" && req.user._id) {
      if (!item.franchiseId || item.franchiseId.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: "Item does not belong to your franchise" });
      }
    } else if (["waiter", "cook", "captain", "manager"].includes(req.user?.role)) {
      // Mobile users - check if item belongs to their cafe
      const cafeId = await getCafeId(req.user);
      if (!cafeId || !item.cafeId || item.cafeId.toString() !== cafeId.toString()) {
        return res.status(403).json({ message: "Item does not belong to your cafe" });
      }
    } else if (req.user?.role === "employee") {
      const cafeId = await getCafeId(req.user);
      if (!cafeId || !item.cafeId || item.cafeId.toString() !== cafeId.toString()) {
        return res.status(403).json({ message: "Item does not belong to your cafe" });
      }
    }

    if (operation === "add") {
      item.quantity += Number(quantity) || 0;
    } else if (operation === "subtract") {
      item.quantity = Math.max(0, item.quantity - (Number(quantity) || 0));
    } else if (operation === "set") {
      item.quantity = Math.max(0, Number(quantity) || 0);
    } else {
      return res.status(400).json({ message: "Invalid operation. Use 'add', 'subtract', or 'set'" });
    }

    await item.save();
    return res.json(item);
  } catch (err) {
    console.error('[INVENTORY] Update error:', err);
    return res.status(500).json({ message: err.message || 'Failed to update inventory item' });
  }
};

// Get available ingredients from costing-v2 for managers to add to inventory
exports.getAvailableIngredients = async (req, res) => {
  try {
    // Get cafeId for the manager/mobile user
    const cafeId = await getCafeId(req.user);
    if (!cafeId) {
      return res.status(403).json({ 
        success: false,
        message: "No cafe associated with this user" 
      });
    }

    console.log('[INVENTORY] getAvailableIngredients - cafeId:', cafeId, 'for user:', req.user._id, 'role:', req.user.role);

    // Build query to get ingredients for this cart/cafe/kiosk
    // For mobile users (manager, waiter, cook, captain), explicitly set outletId
    const filter = { isActive: true };
    
    // For mobile roles, explicitly set outletId to their cafeId
    if (["waiter", "cook", "captain", "manager"].includes(req.user?.role)) {
      filter.outletId = cafeId;
      console.log('[INVENTORY] getAvailableIngredients - Mobile user, setting outletId:', cafeId);
    }
    
    // Build costing query (will handle admin, franchise_admin, super_admin)
    const costingFilter = await buildCostingQuery(req.user, filter, { skipOutletFilter: false });
    
    console.log('[INVENTORY] getAvailableIngredients - Final filter:', JSON.stringify(costingFilter));
    
    // Get ingredients that are not already in inventory
    const ingredients = await IngredientV2.find(costingFilter)
      .select("name category uom qtyOnHand reorderLevel currentCostPerBaseUnit storageLocation outletId")
      .sort({ category: 1, name: 1 })
      .lean();
    
    console.log('[INVENTORY] getAvailableIngredients - Found ingredients:', ingredients.length);

    // Get existing inventory items linked to ingredients
    const existingInventory = await InventoryItem.find({ 
      cafeId: cafeId,
      ingredientId: { $ne: null }
    }).select("ingredientId").lean();
    
    const existingIngredientIds = new Set(
      existingInventory.map(inv => inv.ingredientId?.toString()).filter(Boolean)
    );

    // Filter out ingredients that are already in inventory
    // Also ensure ingredients belong to the correct outlet (for mobile users)
    const availableIngredients = ingredients.filter(ing => {
      // Check if already in inventory
      if (existingIngredientIds.has(ing._id.toString())) {
        return false;
      }
      
      // For mobile users, ensure ingredient belongs to their cafe
      if (["waiter", "cook", "captain", "manager"].includes(req.user?.role)) {
        // Ingredient should have outletId matching the manager's cafeId
        if (ing.outletId) {
          const ingredientOutletId = ing.outletId.toString();
          const userCafeId = cafeId.toString();
          if (ingredientOutletId !== userCafeId) {
            console.log('[INVENTORY] Filtering out ingredient - outletId mismatch:', {
              ingredientId: ing._id,
              ingredientOutletId,
              userCafeId
            });
            return false;
          }
        }
        // If outletId is null/undefined, it might be a shared ingredient
        // We'll include it, but you can exclude shared ingredients if needed
      }
      
      return true;
    });

    console.log('[INVENTORY] getAvailableIngredients - Available ingredients after filtering:', availableIngredients.length);

    res.json({ 
      success: true, 
      data: availableIngredients 
    });
  } catch (err) {
    console.error('[INVENTORY] Get available ingredients error:', err);
    return res.status(500).json({ 
      success: false,
      message: err.message || 'Failed to get available ingredients' 
    });
  }
};

// Get inventory statistics
exports.getInventoryStats = async (req, res) => {
  try {
    const query = {};

    // Filter based on user role
    if (req.user && req.user.role === "admin" && req.user._id) {
      query.cafeId = req.user._id;
    } else if (req.user && req.user.role === "franchise_admin" && req.user._id) {
      query.franchiseId = req.user._id;
    } else if (["waiter", "cook", "captain", "manager"].includes(req.user?.role)) {
      // Mobile users - get cafeId from employee record
      const cafeId = await getCafeId(req.user);
      if (cafeId) {
        query.cafeId = cafeId;
        console.log('[INVENTORY] getInventoryStats - Mobile user cafeId:', cafeId);
      } else {
        console.log('[INVENTORY] getInventoryStats - No cafeId found for mobile user:', req.user._id);
        // Return empty stats if no cafeId
        return res.json({
          success: true,
          data: {
            totalItems: 0,
            lowStockItems: 0,
            outOfStockItems: 0,
            totalValue: 0,
            categories: {},
          },
        });
      }
    } else if (req.user?.role === "employee") {
      const cafeId = await getCafeId(req.user);
      if (cafeId) {
        query.cafeId = cafeId;
      } else {
        return res.json({
          success: true,
          data: {
            totalItems: 0,
            lowStockItems: 0,
            outOfStockItems: 0,
            totalValue: 0,
            categories: {},
          },
        });
      }
    }
    
    console.log('[INVENTORY] getInventoryStats - Query:', JSON.stringify(query, null, 2));

    const allItems = await InventoryItem.find(query).lean();
    
    console.log('[INVENTORY] getInventoryStats - Found items:', allItems.length);

    const stats = {
      totalItems: allItems.length,
      lowStockItems: allItems.filter(
        (item) => item.quantity > 0 && item.quantity <= item.minStockLevel
      ).length,
      outOfStockItems: allItems.filter((item) => item.quantity === 0).length,
      totalValue: allItems.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0),
      categories: {},
    };

    // Group by category
    allItems.forEach((item) => {
      if (!stats.categories[item.category]) {
        stats.categories[item.category] = {
          count: 0,
          lowStock: 0,
          outOfStock: 0,
        };
      }
      stats.categories[item.category].count++;
      if (item.quantity === 0) {
        stats.categories[item.category].outOfStock++;
      } else if (item.quantity <= item.minStockLevel) {
        stats.categories[item.category].lowStock++;
      }
    });

    // Return in consistent format for both admin app and admin site
    return res.json({
      success: true,
      data: stats,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

