const mongoose = require("mongoose");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const MenuCategory = require("../models/menuCategoryModel");
const { MenuItem, SPICE_LEVELS } = require("../models/menuItemModel");

const buildCategoryWithItems = (categories, itemsByCategory) =>
  categories.map((category) => ({
    ...category,
    items: itemsByCategory[category._id.toString()] || [],
  }));

exports.getPublicMenu = async (req, res) => {
  try {
    // Get cartId from query parameter (passed from frontend based on table)
    const { cartId } = req.query;

    // Build query - filter by cartId if provided
    const categoryQuery = { isActive: true };
    const itemQuery = { isAvailable: true };

    let targetCartId = null;

    // Priority 1: Use cartId from query parameter (for public access)
    if (cartId) {
      // Validate cartId format
      if (!mongoose.Types.ObjectId.isValid(cartId)) {
        return res.status(400).json({ message: "Invalid cart ID" });
      }
      
      // Check if cartId is a Cart document ID or cartAdminId (user ID)
      // Try to find Cart document first
      const Cart = require("../models/cartModel");
      const cart = await Cart.findById(cartId).lean();
      
      if (cart && cart.cartAdminId) {
        // It's a Cart document ID - use the cartAdminId
        targetCartId = cart.cartAdminId;
        console.log("[MENU] getPublicMenu - Found Cart document, using cartAdminId:", {
          cartId: cartId,
          cartAdminId: targetCartId,
          cartAdminIdType: typeof targetCartId
        });
      } else {
        // Assume it's already a cartAdminId (user ID) - backward compatibility
        // But also check if it's a table's cartId that might be a Cart document ID
        // Try one more time to see if it's a Cart document (in case of race condition)
        const cartCheck = await Cart.findOne({ cartAdminId: cartId }).lean();
        if (cartCheck) {
          // The cartId is actually a cartAdminId, use it directly
          targetCartId = cartId;
          console.log("[MENU] getPublicMenu - Using cartId as cartAdminId (verified):", targetCartId);
        } else {
          // Assume it's a cartAdminId (user ID) - backward compatibility
          targetCartId = cartId;
          console.log("[MENU] getPublicMenu - Using cartId as cartAdminId (backward compatibility):", targetCartId);
        }
      }
    }
    // Priority 2: For authenticated mobile users, get cartId from their Employee record
    else if (
      req.user &&
      ["waiter", "cook", "captain", "manager"].includes(req.user.role)
    ) {
      const Employee = require("../models/employeeModel");
      const employee = await Employee.findOne({
        email: req.user.email?.toLowerCase(),
      }).lean();
      // Employee model now uses cartId (changed from cafeId)
      if (employee && employee.cartId) {
        targetCartId = employee.cartId;
        console.log("[MENU] getPublicMenu - Mobile user cartId:", {
          userId: req.user._id,
          email: req.user.email,
          cartId: targetCartId,
        });
      }
    }
    // Priority 3: For admin users, use their _id as cartId
    else if (req.user && req.user.role === "admin") {
      targetCartId = req.user._id;
    }

    if (targetCartId) {
      // Ensure targetCartId is ObjectId for proper matching
      const targetCartIdObj = mongoose.Types.ObjectId.isValid(targetCartId)
        ? (typeof targetCartId === "string" ? new mongoose.Types.ObjectId(targetCartId) : targetCartId)
        : targetCartId;
      
      // Support both cartId (new) and cafeId (old) during migration transition
      // This ensures backward compatibility with existing data
      categoryQuery.$or = [
        { cartId: targetCartIdObj },
        { cafeId: targetCartIdObj } // Support old cafeId field during migration
      ];
      itemQuery.$or = [
        { cartId: targetCartIdObj },
        { cafeId: targetCartIdObj } // Support old cafeId field during migration
      ];
      console.log("[MENU] getPublicMenu - Filtering by cartId (with cafeId fallback):", {
        targetCartId: targetCartId.toString(),
        targetCartIdObj: targetCartIdObj.toString(),
        query: categoryQuery
      });
    } else {
      // Return empty menu if no cartId - prevents showing all carts' menus
      console.log(
        "[MENU] getPublicMenu - No cartId found, returning empty menu"
      );
      return res.json([]);
    }

    const categories = await MenuCategory.find(categoryQuery)
      .sort({ sortOrder: 1, name: 1 })
      .lean();

    console.log("[MENU] getPublicMenu - Categories found:", {
      count: categories.length,
      categoryIds: categories.map(c => c._id.toString()),
      sampleCategory: categories[0] ? {
        _id: categories[0]._id.toString(),
        name: categories[0].name,
        cartId: categories[0].cartId?.toString(),
        cafeId: categories[0].cafeId?.toString()
      } : null
    });

    const categoryIds = categories.map((cat) => cat._id);

    if (categoryIds.length > 0) {
      // Combine category filter with cartId/cafeId filter using $and
      // This ensures both filters are applied together
      itemQuery.$and = [
        { $or: itemQuery.$or }, // Keep the cartId/cafeId filter
        { category: { $in: categoryIds } } // Add category filter
      ];
      delete itemQuery.$or; // Remove $or from root level since it's now in $and
    } else {
      // No categories found for this cart
      console.log("[MENU] getPublicMenu - No categories found, query was:", JSON.stringify(categoryQuery, null, 2));
      return res.json([]);
    }

    const items = await MenuItem.find(itemQuery)
      .sort({ sortOrder: 1, name: 1 })
      .lean();

    console.log("[MENU] getPublicMenu - Items found:", {
      count: items.length,
      itemQuery: JSON.stringify(itemQuery, null, 2),
      sampleItem: items[0] ? {
        _id: items[0]._id.toString(),
        name: items[0].name,
        cartId: items[0].cartId?.toString(),
        cafeId: items[0].cafeId?.toString()
      } : null
    });

    // Helper function to decode HTML entities in image URLs
    const decodeImageUrl = (imageUrl) => {
      if (!imageUrl || typeof imageUrl !== "string") return "";
      return imageUrl
        .replace(/&amp;#x2F;/g, "/")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#x2F;/g, "/")
        .replace(/&#39;/g, "'")
        .trim();
    };

    // Decode image URLs in items
    items.forEach((item) => {
      if (item.image) {
        item.image = decodeImageUrl(item.image);
      }
    });

    const itemsByCategory = items.reduce((acc, item) => {
      const key = item.category.toString();
      if (!acc[key]) acc[key] = [];
      acc[key].push(item);
      return acc;
    }, {});

    return res.json(buildCategoryWithItems(categories, itemsByCategory));
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

exports.listMenu = async (req, res) => {
  try {
    // Filter by cartId if user is cart admin (changed from cafeId to cartId)
    const cartId = req.user && req.user.role === "admin" ? req.user._id : null;
    const categoryQuery = {};
    const itemQuery = {};

    if (cartId) {
      // Support both cartId (new) and cafeId (old) during migration transition
      categoryQuery.$or = [
        { cartId: cartId },
        { cafeId: cartId } // Support old cafeId field during migration
      ];
      itemQuery.$or = [
        { cartId: cartId },
        { cafeId: cartId } // Support old cafeId field during migration
      ];
    }

    const categories = await MenuCategory.find(categoryQuery)
      .sort({ sortOrder: 1, name: 1 })
      .lean();
    const categoryIds = categories.map((cat) => cat._id);

    if (categoryIds.length > 0) {
      // Combine category filter with cartId/cafeId filter using $and
      itemQuery.$and = [
        { $or: itemQuery.$or }, // Keep the cartId/cafeId filter
        { category: { $in: categoryIds } } // Add category filter
      ];
      delete itemQuery.$or; // Remove $or from root level since it's now in $and
    } else {
      itemQuery.category = { $in: [] }; // No categories, so no items
    }

    const items = await MenuItem.find(itemQuery)
      .sort({ sortOrder: 1, name: 1 })
      .lean();

    const itemsByCategory = items.reduce((acc, item) => {
      const key = item.category.toString();
      if (!acc[key]) acc[key] = [];
      acc[key].push(item);
      return acc;
    }, {});

    return res.json(buildCategoryWithItems(categories, itemsByCategory));
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

exports.createCategory = async (req, res) => {
  try {
    const {
      name,
      description,
      icon,
      sortOrder,
      isActive = true,
    } = req.body || {};
    if (!name) {
      return res.status(400).json({ message: "Category name is required" });
    }

    // Set cafeId if user is cafe admin
    const cafeId = req.user && req.user.role === "admin" ? req.user._id : null;

    const category = await MenuCategory.create({
      name,
      description,
      icon,
      sortOrder,
      isActive,
      cafeId: cafeId,
    });

    // Emit socket event to cafe room
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    if (cafeId) {
      emitToCafe(io, cafeId.toString(), "menu:updated", {
        type: "category_created",
        category,
      });
    }

    return res.status(201).json(category);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

exports.updateCategory = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid category id" });
    }

    const allowed = ["name", "description", "icon", "sortOrder", "isActive"];
    const updates = {};
    allowed.forEach((key) => {
      if (key in req.body) updates[key] = req.body[key];
    });

    const category = await MenuCategory.findByIdAndUpdate(id, updates, {
      new: true,
    }).lean();

    if (!category) {
      return res.status(404).json({ message: "Category not found" });
    }

    // Emit socket event to cafe room
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    if (category.cafeId) {
      emitToCafe(io, category.cafeId.toString(), "menu:updated", {
        type: "category_updated",
        category,
      });
    }

    return res.json(category);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

exports.deleteCategory = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid category id" });
    }

    // Find the category first to get cafeId for socket events
    const category = await MenuCategory.findById(id);
    if (!category) {
      return res.status(404).json({ message: "Category not found" });
    }

    // Delete all items in this category first (cascade delete)
    const itemsDeleted = await MenuItem.deleteMany({ category: id });
    console.log(
      `[Menu] Deleted ${itemsDeleted.deletedCount} item(s) from category ${id} before deleting category`
    );

    // Now delete the category
    await MenuCategory.findByIdAndDelete(id);

    // Emit socket event to cafe room
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    if (category.cafeId) {
      emitToCafe(io, category.cafeId.toString(), "menu:updated", {
        type: "category_deleted",
        categoryId: id,
        itemsDeleted: itemsDeleted.deletedCount,
      });
    }

    return res.json({
      message: "Category deleted successfully",
      itemsDeleted: itemsDeleted.deletedCount,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

exports.createItem = async (req, res) => {
  try {
    const {
      categoryId,
      name,
      description,
      price,
      image,
      isAvailable = true,
      isFeatured = false,
      spiceLevel = "NONE",
      sortOrder,
      tags,
      allergens,
      calories,
    } = req.body || {};

    if (!categoryId || !mongoose.Types.ObjectId.isValid(categoryId)) {
      return res.status(400).json({ message: "Valid categoryId is required" });
    }
    if (!name) {
      return res.status(400).json({ message: "Item name is required" });
    }
    if (price === undefined || price === null) {
      return res.status(400).json({ message: "Item price is required" });
    }
    if (!SPICE_LEVELS.includes(spiceLevel)) {
      return res
        .status(400)
        .json({
          message: `Spice level must be one of ${SPICE_LEVELS.join(", ")}`,
        });
    }

    const category = await MenuCategory.findById(categoryId);
    if (!category) {
      return res.status(404).json({ message: "Parent category not found" });
    }

    // Set cafeId if user is cafe admin, and verify category belongs to same cafe
    const cafeId = req.user && req.user.role === "admin" ? req.user._id : null;
    if (
      cafeId &&
      category.cafeId &&
      category.cafeId.toString() !== cafeId.toString()
    ) {
      return res
        .status(403)
        .json({ message: "Category does not belong to your cafe" });
    }
    const finalCafeId = cafeId || category.cafeId || null;

    const item = await MenuItem.create({
      category: categoryId,
      name,
      description,
      price,
      image,
      isAvailable,
      isFeatured,
      spiceLevel,
      sortOrder,
      tags,
      allergens,
      calories,
      cafeId: finalCafeId,
    });

    // Emit socket event to cafe room
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    if (finalCafeId) {
      emitToCafe(io, finalCafeId.toString(), "menu:updated", {
        type: "item_created",
        item,
      });
    }

    return res.status(201).json(item);
  } catch (err) {
    if (err.code === 11000) {
      return res
        .status(409)
        .json({ message: "Duplicate menu item name within category" });
    }
    return res.status(500).json({ message: err.message });
  }
};

exports.updateItem = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid item id" });
    }

    const allowed = [
      "name",
      "description",
      "price",
      "image",
      "isAvailable",
      "isFeatured",
      "spiceLevel",
      "sortOrder",
      "tags",
      "allergens",
      "calories",
      "categoryId",
    ];
    const updates = {};
    for (const key of allowed) {
      if (key in req.body) {
        if (key === "categoryId") {
          if (!mongoose.Types.ObjectId.isValid(req.body[key])) {
            return res.status(400).json({ message: "Invalid categoryId" });
          }
          updates.category = req.body[key];
        } else {
          updates[key] = req.body[key];
        }
      }
    }

    if (updates.spiceLevel && !SPICE_LEVELS.includes(updates.spiceLevel)) {
      return res
        .status(400)
        .json({
          message: `Spice level must be one of ${SPICE_LEVELS.join(", ")}`,
        });
    }

    const item = await MenuItem.findByIdAndUpdate(id, updates, {
      new: true,
      runValidators: true,
    }).lean();

    if (!item) {
      return res.status(404).json({ message: "Menu item not found" });
    }

    // Auto-sync to costing if price was updated and user is cart admin
    if (
      updates.price !== undefined &&
      req.user.role === "admin" &&
      item.cafeId
    ) {
      try {
        const {
          syncDefaultMenuToCosting,
        } = require("../services/costing-v2/syncDefaultMenuToCosting");
        // Sync only this specific cart's menu to costing
        await syncDefaultMenuToCosting(
          null,
          item.cafeId.toString(),
          item.cafeId.toString()
        );
        console.log(
          `[MENU CONTROLLER] Auto-synced menu item price to costing for cart: ${item.cafeId}`
        );
      } catch (syncError) {
        // Don't fail the request if sync fails - just log it
        console.error(
          `[MENU CONTROLLER] Failed to auto-sync to costing:`,
          syncError.message
        );
      }
    }

    // Emit socket event to cafe room
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    if (item.cafeId) {
      emitToCafe(io, item.cafeId.toString(), "menu:updated", {
        type: "item_updated",
        item,
      });
    }

    return res.json(item);
  } catch (err) {
    if (err.code === 11000) {
      return res
        .status(409)
        .json({ message: "Duplicate menu item name within category" });
    }
    return res.status(500).json({ message: err.message });
  }
};

exports.updateItemAvailability = async (req, res) => {
  try {
    const { id } = req.params;
    const { isAvailable } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid item id" });
    }
    if (typeof isAvailable !== "boolean") {
      return res
        .status(400)
        .json({ message: "isAvailable boolean is required" });
    }

    const item = await MenuItem.findByIdAndUpdate(
      id,
      { isAvailable },
      { new: true, runValidators: true }
    ).lean();

    if (!item) {
      return res.status(404).json({ message: "Menu item not found" });
    }

    // Emit socket event to cafe room
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    if (item.cafeId) {
      emitToCafe(io, item.cafeId.toString(), "menu:updated", {
        type: "item_availability_updated",
        item,
      });
    }

    return res.json(item);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

exports.deleteItem = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid item id" });
    }

    const item = await MenuItem.findById(id);
    if (!item) {
      return res.status(404).json({ message: "Menu item not found" });
    }

    const cafeId = item.cafeId;

    await MenuItem.findByIdAndDelete(id);

    // Emit socket event to cafe room
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    if (cafeId) {
      emitToCafe(io, cafeId.toString(), "menu:updated", {
        type: "item_deleted",
        itemId: id,
      });
    }

    return res.json({ message: "Menu item deleted" });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

exports.SPICE_LEVELS = SPICE_LEVELS;

const uploadsDir = path.join(__dirname, "..", "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const ext = path.extname(file.originalname) || ".jpg";
    cb(null, `${unique}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      cb(new Error("Only image uploads are allowed"));
    } else {
      cb(null, true);
    }
  },
});

exports.uploadMenuImage = [
  upload.single("image"),
  (req, res) => {
    if (!req.file) {
      return res.status(400).json({ message: "No image uploaded" });
    }
    // Return relative URL so it works across different domains/environments
    const fileUrl = `/uploads/${req.file.filename}`;
    return res.status(201).json({
      url: fileUrl,
      filename: req.file.filename,
      size: req.file.size,
    });
  },
];
