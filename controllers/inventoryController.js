const InventoryItem = require("../models/inventoryModel");
const User = require("../models/userModel");

// Get all inventory items
exports.getAllInventory = async (req, res) => {
  try {
    const query = {};

    // Filter based on admin role
    if (req.user && req.user.role === "admin" && req.user._id) {
      query.cafeId = req.user._id;
    } else if (req.user && req.user.role === "franchise_admin" && req.user._id) {
      query.franchiseId = req.user._id;
    }

    const items = await InventoryItem.find(query)
      .sort({ category: 1, name: 1 })
      .lean();

    return res.json(items);
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

    // Set hierarchy relationships
    if (req.user && req.user.role === "admin" && req.user._id) {
      itemData.cafeId = req.user._id;
      // Get franchiseId from cafe admin
      const cafeAdmin = await User.findById(req.user._id);
      if (cafeAdmin && cafeAdmin.franchiseId) {
        itemData.franchiseId = cafeAdmin.franchiseId;
      }
    } else if (req.user && req.user.role === "franchise_admin" && req.user._id) {
      itemData.franchiseId = req.user._id;
    }

    const item = await InventoryItem.create(itemData);
    return res.status(201).json(item);
  } catch (err) {
    return res.status(500).json({ message: err.message });
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
    }

    Object.assign(item, req.body);
    await item.save();
    return res.json(item);
  } catch (err) {
    return res.status(500).json({ message: err.message });
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
    return res.status(500).json({ message: err.message });
  }
};

// Get inventory statistics
exports.getInventoryStats = async (req, res) => {
  try {
    const query = {};

    // Filter based on admin role
    if (req.user && req.user.role === "admin" && req.user._id) {
      query.cafeId = req.user._id;
    } else if (req.user && req.user.role === "franchise_admin" && req.user._id) {
      query.franchiseId = req.user._id;
    }

    const allItems = await InventoryItem.find(query).lean();

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

    return res.json(stats);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

