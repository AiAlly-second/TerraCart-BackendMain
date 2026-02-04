const mongoose = require("mongoose");
const InventoryItem = require("../models/inventoryModel");
const User = require("../models/userModel");
const Employee = require("../models/employeeModel");
const IngredientV2 = require("../models/costing-v2/ingredientModel");
const { buildCostingQuery } = require("../utils/costing-v2/accessControl");

// Helper to get cartId based on user role
// Note: Returns cartId for Inventory model (which uses cartId, not cafeId)
const getCafeId = async (user) => {
  if (user.role === "admin") {
    return user._id; // Cart admin's _id is the cartId
  } else if (["waiter", "cook", "captain", "manager"].includes(user.role)) {
    // Mobile users - prioritize cartId, fallback to cafeId for backward compatibility
    if (user.cartId) {
      return user.cartId;
    }
    if (user.cafeId) {
      // Fallback for backward compatibility
      return user.cafeId;
    }
    // Fallback: try to find Employee record by email or userId
    const employee = await Employee.findOne({
      $or: [
        { email: user.email?.toLowerCase() },
        { userId: user._id }
      ]
    }).lean();
    if (employee?.cartId) {
      return employee.cartId;
    }
    // Last fallback: try cafeId from employee
    return employee?.cafeId;
  } else if (user.role === "employee") {
    // Legacy employee role - look up Employee by email
    const employee = await Employee.findOne({ email: user.email?.toLowerCase() }).lean();
    return employee?.cartId || employee?.cafeId; // Employee model uses cartId, fallback to cafeId
  } else if (user.role === "franchise_admin") {
    return null; // Franchise admin doesn't have a specific cartId
  }
  return null;
};

// Get all inventory items
exports.getAllInventory = async (req, res) => {
  try {
    const query = {};

    // Filter based on user role
    // Inventory model uses cartId, not cafeId
    if (req.user && req.user.role === "admin" && req.user._id) {
      query.cartId = req.user._id; // Inventory model uses cartId, not cafeId
    } else if (req.user && req.user.role === "franchise_admin" && req.user._id) {
      query.franchiseId = req.user._id;
    } else if (["waiter", "cook", "captain", "manager"].includes(req.user?.role)) {
      // Mobile users - get cartId from employee record (Employee uses cartId)
      let cartId = await getCafeId(req.user);
      const franchiseId = req.user?.franchiseId || (await Employee.findOne({
        $or: [{ email: req.user?.email?.toLowerCase() }, { userId: req.user?._id }]
      }).lean())?.franchiseId;

      console.log('[INVENTORY] getAllInventory - Mobile user:', req.user?.role, 'userId:', req.user?._id, 'cartId:', cartId?.toString(), 'franchiseId:', franchiseId?.toString());

      if (cartId) {
        // Ensure ObjectId for query (handles string/ObjectId mismatch)
        query.cartId = mongoose.Types.ObjectId.isValid(cartId)
          ? (cartId instanceof mongoose.Types.ObjectId ? cartId : new mongoose.Types.ObjectId(cartId.toString()))
          : cartId;
      } else {
        console.log('[INVENTORY] getAllInventory - No cartId for mobile user, returning empty.');
        return res.json({ success: true, data: [] });
      }
    } else if (req.user?.role === "employee") {
      const cartId = await getCafeId(req.user);
      if (cartId) {
        query.cartId = mongoose.Types.ObjectId.isValid(cartId)
          ? (cartId instanceof mongoose.Types.ObjectId ? cartId : new mongoose.Types.ObjectId(cartId.toString()))
          : cartId;
      }
    }

    let items = await InventoryItem.find(query)
      .sort({ category: 1, name: 1 })
      .lean();

    console.log('[INVENTORY] getAllInventory - Query:', JSON.stringify(query), 'Found items:', items.length);

    // Fallback for mobile users: if 0 items by cartId, try franchiseId (items may have wrong cartId)
    if (items.length === 0 && query.cartId && ["waiter", "cook", "captain", "manager"].includes(req.user?.role)) {
      const franchiseId = req.user?.franchiseId || (await Employee.findOne({
        $or: [{ email: req.user?.email?.toLowerCase() }, { userId: req.user?._id }]
      }).lean())?.franchiseId;

      if (franchiseId) {
        const franchiseQuery = { franchiseId: mongoose.Types.ObjectId.isValid(franchiseId) ? (franchiseId instanceof mongoose.Types.ObjectId ? franchiseId : new mongoose.Types.ObjectId(franchiseId.toString())) : franchiseId };
        items = await InventoryItem.find(franchiseQuery)
          .sort({ category: 1, name: 1 })
          .lean();
        console.log('[INVENTORY] getAllInventory - Fallback by franchiseId:', franchiseId.toString(), 'Found items:', items.length);
        if (items.length > 0) {
          console.log('[INVENTORY] getAllInventory - Items have wrong cartId. Run: node scripts/fix-inventory-cartid.js', query.cartId.toString(), 'to fix.');
        }
      }
    }

    if (items.length === 0 && query.cartId) {
      const totalInDb = await InventoryItem.countDocuments({});
      const forThisCart = await InventoryItem.countDocuments({ cartId: query.cartId });
      const distinctCartIds = await InventoryItem.distinct('cartId');
      console.log('[INVENTORY] getAllInventory - DB has', totalInDb, 'total items,', forThisCart, 'for cartId', query.cartId.toString(), '| Item cartIds in DB:', distinctCartIds.map((id) => id?.toString()).filter(Boolean));
    }

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
      const itemCartId = item.cartId || item.cafeId; // Support old cafeId field for backward compatibility
      if (!itemCartId || itemCartId.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: "Item does not belong to your cart" });
      }
    } else if (req.user && req.user.role === "franchise_admin" && req.user._id) {
      if (!item.franchiseId || item.franchiseId.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: "Item does not belong to your franchise" });
      }
    } else if (["waiter", "cook", "captain", "manager"].includes(req.user?.role)) {
      // Mobile users - check if item belongs to their cart
      const cartId = await getCafeId(req.user); // Function returns cartId value
      const itemCartId = item.cartId || item.cafeId; // Support old cafeId field for backward compatibility
      if (!cartId || !itemCartId || itemCartId.toString() !== cartId.toString()) {
        return res.status(403).json({ message: "Item does not belong to your cart" });
      }
    } else if (req.user?.role === "employee") {
      const cartId = await getCafeId(req.user); // Function returns cartId value
      const itemCartId = item.cartId || item.cafeId; // Support old cafeId field for backward compatibility
      if (!cartId || !itemCartId || itemCartId.toString() !== cartId.toString()) {
        return res.status(403).json({ message: "Item does not belong to your cart" });
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
      
      // Set cart context from ingredient
      if (ingredient.cartId) {
        itemData.cartId = ingredient.cartId; // Inventory model uses cartId
      }
      if (ingredient.franchiseId) {
        itemData.franchiseId = ingredient.franchiseId;
      }
    }

    // Set hierarchy relationships (only if not set from ingredient)
    // Inventory model uses cartId, not cafeId
    if (!itemData.cartId) {
      if (req.user && req.user.role === "admin" && req.user._id) {
        itemData.cartId = req.user._id; // Inventory model uses cartId, not cafeId
        // Get franchiseId from cart admin
        const cartAdmin = await User.findById(req.user._id);
        if (cartAdmin && cartAdmin.franchiseId) {
          itemData.franchiseId = cartAdmin.franchiseId;
        }
      } else if (req.user && req.user.role === "franchise_admin" && req.user._id) {
        itemData.franchiseId = req.user._id;
      } else if (["waiter", "cook", "captain", "manager"].includes(req.user?.role)) {
        // Mobile users - get cartId from employee record
        const cartId = await getCafeId(req.user); // Function returns cartId value
        if (!cartId) {
          return res.status(403).json({ message: "No cart associated with this user" });
        }
        itemData.cartId = cartId; // Inventory model uses cartId, not cafeId
        // Get franchiseId from employee
        const employee = await Employee.findOne({ email: req.user.email?.toLowerCase() }).lean();
        if (employee && employee.franchiseId) {
          itemData.franchiseId = employee.franchiseId;
        }
      } else if (req.user?.role === "employee") {
        const cartId = await getCafeId(req.user); // Function returns cartId value
        if (!cartId) {
          return res.status(403).json({ message: "No cart associated with this user" });
        }
        itemData.cartId = cartId; // Inventory model uses cartId, not cafeId
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
    const itemCartId = item.cartId || item.cafeId; // Support old cafeId field for backward compatibility
    if (itemCartId) {
      emitToCafe(io, itemCartId.toString(), "inventory:created", item);
      emitToCafe(io, itemCartId.toString(), "inventory:updated", item);
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
      const itemCartId = item.cartId || item.cafeId; // Support old cafeId field for backward compatibility
      if (!itemCartId || itemCartId.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: "Item does not belong to your cart" });
      }
    } else if (req.user && req.user.role === "franchise_admin" && req.user._id) {
      if (!item.franchiseId || item.franchiseId.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: "Item does not belong to your franchise" });
      }
    } else if (["waiter", "cook", "captain", "manager"].includes(req.user?.role)) {
      // Mobile users - check if item belongs to their cart
      const cartId = await getCafeId(req.user); // Function returns cartId value
      const itemCartId = item.cartId || item.cafeId; // Support old cafeId field for backward compatibility
      if (!cartId || !itemCartId || itemCartId.toString() !== cartId.toString()) {
        return res.status(403).json({ message: "Item does not belong to your cart" });
      }
    } else if (req.user?.role === "employee") {
      const cartId = await getCafeId(req.user); // Function returns cartId value
      const itemCartId = item.cartId || item.cafeId; // Support old cafeId field for backward compatibility
      if (!cartId || !itemCartId || itemCartId.toString() !== cartId.toString()) {
        return res.status(403).json({ message: "Item does not belong to your cart" });
      }
    }

    Object.assign(item, req.body);
    await item.save();
    
    // Emit socket event to cafe room
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    const itemCartId = item.cartId || item.cafeId; // Support old cafeId field for backward compatibility
    if (itemCartId) {
      emitToCafe(io, itemCartId.toString(), "inventory:updated", item);
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
      const itemCartId = item.cartId || item.cafeId; // Support old cafeId field for backward compatibility
      if (!itemCartId || itemCartId.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: "Item does not belong to your cart" });
      }
    } else if (req.user && req.user.role === "franchise_admin" && req.user._id) {
      if (!item.franchiseId || item.franchiseId.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: "Item does not belong to your franchise" });
      }
    } else if (["waiter", "cook", "captain", "manager"].includes(req.user?.role)) {
      // Mobile users - check if item belongs to their cart
      const cartId = await getCafeId(req.user); // Function returns cartId value
      const itemCartId = item.cartId || item.cafeId; // Support old cafeId field for backward compatibility
      if (!cartId || !itemCartId || itemCartId.toString() !== cartId.toString()) {
        return res.status(403).json({ message: "Item does not belong to your cart" });
      }
    } else if (req.user?.role === "employee") {
      const cartId = await getCafeId(req.user); // Function returns cartId value
      const itemCartId = item.cartId || item.cafeId; // Support old cafeId field for backward compatibility
      if (!cartId || !itemCartId || itemCartId.toString() !== cartId.toString()) {
        return res.status(403).json({ message: "Item does not belong to your cart" });
      }
    }

    // Emit socket event before deletion
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    const itemCartId = item.cartId || item.cafeId; // Support old cafeId field for backward compatibility
    if (itemCartId) {
      emitToCafe(io, itemCartId.toString(), "inventory:deleted", { id: req.params.id });
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
      const itemCartId = item.cartId || item.cafeId; // Support old cafeId field for backward compatibility
      if (!itemCartId || itemCartId.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: "Item does not belong to your cart" });
      }
    } else if (req.user && req.user.role === "franchise_admin" && req.user._id) {
      if (!item.franchiseId || item.franchiseId.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: "Item does not belong to your franchise" });
      }
    } else if (["waiter", "cook", "captain", "manager"].includes(req.user?.role)) {
      // Mobile users - check if item belongs to their cart
      const cartId = await getCafeId(req.user); // Function returns cartId value
      const itemCartId = item.cartId || item.cafeId; // Support old cafeId field for backward compatibility
      if (!cartId || !itemCartId || itemCartId.toString() !== cartId.toString()) {
        return res.status(403).json({ message: "Item does not belong to your cart" });
      }
    } else if (req.user?.role === "employee") {
      const cartId = await getCafeId(req.user); // Function returns cartId value
      const itemCartId = item.cartId || item.cafeId; // Support old cafeId field for backward compatibility
      if (!cartId || !itemCartId || itemCartId.toString() !== cartId.toString()) {
        return res.status(403).json({ message: "Item does not belong to your cart" });
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
    
    // Emit socket event for real-time updates
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    const itemCartId = item.cartId || item.cafeId; // Support old cafeId field for backward compatibility
    if (itemCartId) {
      emitToCafe(io, itemCartId.toString(), "inventory:stock_updated", item);
      emitToCafe(io, itemCartId.toString(), "inventory:updated", item);
    }
    
    return res.json(item);
  } catch (err) {
    console.error('[INVENTORY] Update error:', err);
    return res.status(500).json({ message: err.message || 'Failed to update inventory item' });
  }
};

// Get available ingredients from costing-v2 for managers to add to inventory
exports.getAvailableIngredients = async (req, res) => {
  try {
    // Get cartId for the manager/mobile user (getCafeId returns cartId)
    const cartId = await getCafeId(req.user);
    if (!cartId) {
      return res.status(403).json({ 
        success: false,
        message: "No cart associated with this user" 
      });
    }

    console.log('[INVENTORY] getAvailableIngredients - cartId:', cartId, 'for user:', req.user._id, 'role:', req.user.role);

    // Build query to get ingredients for this cart/cafe/kiosk
    // For mobile users (manager, waiter, cook, captain), explicitly set cartId
    const filter = { isActive: true };
    
    // For mobile roles, explicitly set cartId
    if (["waiter", "cook", "captain", "manager"].includes(req.user?.role)) {
      filter.cartId = cartId;
      console.log('[INVENTORY] getAvailableIngredients - Mobile user, setting cartId:', cartId);
    }
    
    // Build costing query (will handle admin, franchise_admin, super_admin)
    const costingFilter = await buildCostingQuery(req.user, filter, { skipOutletFilter: false });
    
    console.log('[INVENTORY] getAvailableIngredients - Final filter:', JSON.stringify(costingFilter));

    // Get ingredients that are not already in inventory
    const ingredients = await IngredientV2.find(costingFilter)
      .select("name category uom qtyOnHand reorderLevel currentCostPerBaseUnit storageLocation cartId franchiseId _id")
      .sort({ category: 1, name: 1 })
      .lean();
    
    console.log('[INVENTORY] getAvailableIngredients - Found ingredients:', ingredients.length);

    // Get existing inventory items linked to ingredients (use cartId, not cafeId)
    const existingInventory = await InventoryItem.find({ 
      $or: [
        { cartId: cartId }, // Use cartId (primary)
        { cafeId: cartId }  // Fallback for backward compatibility
      ],
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
      
      // For mobile users, ensure ingredient belongs to their cart
      if (["waiter", "cook", "captain", "manager"].includes(req.user?.role)) {
        // Ingredient should have cartId matching the user's cartId
        if (ing.cartId) {
          const ingredientCartId = ing.cartId.toString();
          const userCartId = cartId.toString();
          if (ingredientCartId !== userCartId) {
            console.log('[INVENTORY] Filtering out ingredient - cartId mismatch:', {
              ingredientId: ing._id,
              ingredientCartId,
              userCartId
            });
            return false;
          }
        }
        // If cartId is null/undefined, it might be a shared ingredient
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
    // Inventory model uses cartId, not cafeId
    if (req.user && req.user.role === "admin" && req.user._id) {
      query.cartId = req.user._id; // Inventory model uses cartId, not cafeId
    } else if (req.user && req.user.role === "franchise_admin" && req.user._id) {
      query.franchiseId = req.user._id;
    } else if (["waiter", "cook", "captain", "manager"].includes(req.user?.role)) {
      // Mobile users - get cartId from employee record
      const cartId = await getCafeId(req.user); // Function returns cartId value
      if (cartId) {
        query.cartId = cartId; // Inventory model uses cartId, not cafeId
        console.log('[INVENTORY] getInventoryStats - Mobile user cartId:', cartId);
      } else {
        console.log('[INVENTORY] getInventoryStats - No cartId found for mobile user:', req.user._id);
        // Return empty stats if no cartId
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
      const cartId = await getCafeId(req.user); // Function returns cartId value
      if (cartId) {
        query.cartId = cartId; // Inventory model uses cartId, not cafeId
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

