const mongoose = require("mongoose");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const MenuCategory = require("../models/menuCategoryModel");
const { MenuItem, SPICE_LEVELS } = require("../models/menuItemModel");

const decodeHtmlEntities = (value) => {
  if (typeof value !== "string") return value;
  let decoded = value;
  for (let i = 0; i < 2; i += 1) {
    const next = decoded
      .replace(/&amp;#x2F;/gi, "/")
      .replace(/&#x2F;/gi, "/")
      .replace(/&#47;/g, "/")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/gi, "'")
      .replace(/&nbsp;/g, " ")
      .trim();
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
};

const decodeStringArray = (value) => {
  if (Array.isArray(value)) {
    return value
      .map((entry) => decodeHtmlEntities(String(entry || "")))
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => decodeHtmlEntities(entry))
      .filter(Boolean);
  }
  return [];
};

const decodeCategoryForResponse = (category = {}) => ({
  ...category,
  name: decodeHtmlEntities(category?.name || ""),
  description: decodeHtmlEntities(category?.description || ""),
  icon: decodeHtmlEntities(category?.icon || ""),
});

const decodeItemForResponse = (item = {}) => ({
  ...item,
  name: decodeHtmlEntities(item?.name || ""),
  description: decodeHtmlEntities(item?.description || ""),
  image: decodeHtmlEntities(item?.image || ""),
  tags: Array.isArray(item?.tags)
    ? item.tags.map((tag) => decodeHtmlEntities(String(tag || ""))).filter(Boolean)
    : item?.tags,
  allergens: Array.isArray(item?.allergens)
    ? item.allergens
        .map((allergen) => decodeHtmlEntities(String(allergen || "")))
        .filter(Boolean)
    : item?.allergens,
  extras: Array.isArray(item?.extras)
    ? item.extras.map((extra) => ({
        ...extra,
        name: decodeHtmlEntities(extra?.name || ""),
      }))
    : item?.extras,
});

const buildCategoryWithItems = (categories, itemsByCategory) =>
  categories.map((category) => ({
    ...decodeCategoryForResponse(category),
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
        console.log(
          "[MENU] getPublicMenu - Found Cart document, using cartAdminId:",
          {
            cartId: cartId,
            cartAdminId: targetCartId,
            cartAdminIdType: typeof targetCartId,
          },
        );
      } else {
        // Assume it's already a cartAdminId (user ID) - backward compatibility
        // But also check if it's a table's cartId that might be a Cart document ID
        // Try one more time to see if it's a Cart document (in case of race condition)
        const cartCheck = await Cart.findOne({ cartAdminId: cartId }).lean();
        if (cartCheck) {
          // The cartId is actually a cartAdminId, use it directly
          targetCartId = cartId;
          console.log(
            "[MENU] getPublicMenu - Using cartId as cartAdminId (verified):",
            targetCartId,
          );
        } else {
          // Assume it's a cartAdminId (user ID) - backward compatibility
          targetCartId = cartId;
          console.log(
            "[MENU] getPublicMenu - Using cartId as cartAdminId (backward compatibility):",
            targetCartId,
          );
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

    let targetCartIdObj = null;
    if (targetCartId) {
      // Ensure targetCartId is ObjectId for proper matching
      targetCartIdObj = mongoose.Types.ObjectId.isValid(targetCartId)
        ? typeof targetCartId === "string"
          ? new mongoose.Types.ObjectId(targetCartId)
          : targetCartId
        : targetCartId;

      // Support both cartId (new) and cafeId (old) during migration transition
      // This ensures backward compatibility with existing data
      categoryQuery.$or = [
        { cartId: targetCartIdObj },
        { cafeId: targetCartIdObj }, // Support old cafeId field during migration
      ];
      itemQuery.$or = [
        { cartId: targetCartIdObj },
        { cafeId: targetCartIdObj }, // Support old cafeId field during migration
      ];
      console.log(
        "[MENU] getPublicMenu - Filtering by cartId (with cafeId fallback):",
        {
          targetCartId: targetCartId.toString(),
          targetCartIdObj: targetCartIdObj.toString(),
          query: categoryQuery,
        },
      );
    } else {
      // Return empty menu if no cartId - prevents showing all carts' menus
      console.log(
        "[MENU] getPublicMenu - No cartId found, returning empty menu",
      );
      return res.json([]);
    }

    const categories = await MenuCategory.find(categoryQuery)
      .sort({ sortOrder: 1, name: 1 })
      .lean();

    console.log("[MENU] getPublicMenu - Categories found:", {
      count: categories.length,
      categoryIds: categories.map((c) => c._id.toString()),
      sampleCategory: categories[0]
        ? {
            _id: categories[0]._id.toString(),
            name: categories[0].name,
            cartId: categories[0].cartId?.toString(),
            cafeId: categories[0].cafeId?.toString(),
          }
        : null,
    });

    const categoryIds = categories.map((cat) => cat._id);

    if (categoryIds.length > 0) {
      // Combine category filter with cartId/cafeId filter using $and
      // This ensures both filters are applied together
      itemQuery.$and = [
        { $or: itemQuery.$or }, // Keep the cartId/cafeId filter
        { category: { $in: categoryIds } }, // Add category filter
      ];
      delete itemQuery.$or; // Remove $or from root level since it's now in $and
    } else {
      // No categories found for this cart
      console.log(
        "[MENU] getPublicMenu - No categories found, query was:",
        JSON.stringify(categoryQuery, null, 2),
      );
      return res.json([]);
    }

    const items = await MenuItem.find(itemQuery)
      .sort({ sortOrder: 1, name: 1 })
      .lean();

    // Calculate order counts for each menu item (most selling items)
    const Order = require("../models/orderModel");
    const itemOrderCounts = {};

    // Aggregate order counts from all completed/paid orders
    // Count items from kotLines where status is not Cancelled
    const orderQuery = {
      status: { $nin: ["Cancelled"] },
    };

    // Add cartId filter if targetCartIdObj exists
    if (targetCartIdObj) {
      orderQuery.cartId = targetCartIdObj;
    }

    const orders = await Order.find(orderQuery).select("kotLines").lean();

    // Count occurrences of each item name across all orders
    orders.forEach((order) => {
      if (order.kotLines && Array.isArray(order.kotLines)) {
        order.kotLines.forEach((kotLine) => {
          if (kotLine.items && Array.isArray(kotLine.items)) {
            kotLine.items.forEach((item) => {
              if (item.name && !item.returned) {
                // Count quantity, not just occurrences
                itemOrderCounts[item.name] =
                  (itemOrderCounts[item.name] || 0) + (item.quantity || 1);
              }
            });
          }
        });
      }
    });

    // Add orderCount to each item
    const itemsWithOrderCount = items.map((item) => ({
      ...item,
      orderCount: itemOrderCounts[item.name] || 0,
    }));

    console.log("[MENU] getPublicMenu - Items found:", {
      count: items.length,
      itemQuery: JSON.stringify(itemQuery, null, 2),
      sampleItem: items[0]
        ? {
            _id: items[0]._id.toString(),
            name: items[0].name,
            cartId: items[0].cartId?.toString(),
            cafeId: items[0].cafeId?.toString(),
          }
        : null,
    });

    const itemsByCategory = itemsWithOrderCount.reduce((acc, item) => {
      const key = item.category.toString();
      if (!acc[key]) acc[key] = [];
      acc[key].push(decodeItemForResponse(item));
      return acc;
    }, {});

    return res.json(buildCategoryWithItems(categories, itemsByCategory));
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

exports.listMenu = async (req, res) => {
  try {
    // Optional cartId from query (for franchise/super admin: load a specific outlet's menu, e.g. when editing that outlet's order)
    const queryCartId = req.query.cartId
      ? req.query.cartId.toString().trim()
      : null;
    const User = require("../models/userModel");

    let filterCartId = null;
    if (req.user.role === "admin") {
      filterCartId = req.user._id;
    } else if (queryCartId && mongoose.Types.ObjectId.isValid(queryCartId)) {
      const queryCartIdObj = new mongoose.Types.ObjectId(queryCartId);
      if (req.user.role === "franchise_admin") {
        const outlet = await User.findById(queryCartIdObj)
          .select("franchiseId")
          .lean();
        if (
          !outlet ||
          outlet.franchiseId?.toString() !== req.user._id.toString()
        ) {
          return res
            .status(403)
            .json({
              message:
                "Access denied: outlet does not belong to your franchise",
            });
        }
        filterCartId = queryCartIdObj;
      } else if (req.user.role === "super_admin") {
        filterCartId = queryCartIdObj;
      }
    }

    const categoryQuery = {};
    const itemQuery = {};

    if (filterCartId) {
      categoryQuery.$or = [{ cartId: filterCartId }, { cafeId: filterCartId }];
      itemQuery.$or = [{ cartId: filterCartId }, { cafeId: filterCartId }];
    }

    const categories = await MenuCategory.find(categoryQuery)
      .sort({ sortOrder: 1, name: 1 })
      .lean();
    const categoryIds = categories.map((cat) => cat._id);

    if (categoryIds.length > 0) {
      // Combine category filter with cartId/cafeId filter using $and
      // Only add $or filter if it exists (when cartId is set)
      if (itemQuery.$or) {
        itemQuery.$and = [
          { $or: itemQuery.$or }, // Keep the cartId/cafeId filter
          { category: { $in: categoryIds } }, // Add category filter
        ];
        delete itemQuery.$or; // Remove $or from root level since it's now in $and
      } else {
        // No cartId filter, just filter by category
        itemQuery.category = { $in: categoryIds };
      }
    } else {
      itemQuery.category = { $in: [] }; // No categories, so no items
    }

    const items = await MenuItem.find(itemQuery)
      .sort({ sortOrder: 1, name: 1 })
      .lean();

    const itemsByCategory = items.reduce((acc, item) => {
      const key = item.category.toString();
      if (!acc[key]) acc[key] = [];
      acc[key].push(decodeItemForResponse(item));
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
      name: rawName,
      description,
      icon,
      sortOrder,
      isActive = true,
    } = req.body || {};
    const name = decodeHtmlEntities(rawName || "");
    const decodedDescription = decodeHtmlEntities(description || "");
    const decodedIcon = decodeHtmlEntities(icon || "");
    if (!name) {
      return res.status(400).json({ message: "Category name is required" });
    }

    // Set cartId if user is cart admin
    const cartId = req.user && req.user.role === "admin" ? req.user._id : null;

    const category = await MenuCategory.create({
      name,
      description: decodedDescription,
      icon: decodedIcon,
      sortOrder,
      isActive,
      cartId: cartId, // Use cartId instead of cafeId
    });
    const categoryResponse = decodeCategoryForResponse(category.toObject());

    // Emit socket event to cart room
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    if (cartId) {
      emitToCafe(io, cartId.toString(), "menu:updated", {
        type: "category_created",
        category: categoryResponse,
      });
    }

    return res.status(201).json(categoryResponse);
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
      if (!(key in req.body)) return;
      if (key === "name" || key === "description" || key === "icon") {
        updates[key] = decodeHtmlEntities(req.body[key] || "");
      } else {
        updates[key] = req.body[key];
      }
    });

    const category = await MenuCategory.findByIdAndUpdate(id, updates, {
      new: true,
    }).lean();

    if (!category) {
      return res.status(404).json({ message: "Category not found" });
    }
    const categoryResponse = decodeCategoryForResponse(category);

    // Emit socket event to cart room
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    const categoryCartId = category.cartId || category.cafeId; // Support old cafeId field
    if (categoryCartId) {
      emitToCafe(io, categoryCartId.toString(), "menu:updated", {
        type: "category_updated",
        category: categoryResponse,
      });
    }

    return res.json(categoryResponse);
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

    // Find the category first to get cartId for socket events
    const category = await MenuCategory.findById(id);
    if (!category) {
      return res.status(404).json({ message: "Category not found" });
    }

    // Delete all items in this category first (cascade delete)
    const itemsDeleted = await MenuItem.deleteMany({ category: id });
    console.log(
      `[Menu] Deleted ${itemsDeleted.deletedCount} item(s) from category ${id} before deleting category`,
    );

    // Now delete the category
    await MenuCategory.findByIdAndDelete(id);

    // Emit socket event to cart room
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    const categoryCartId = category.cartId || category.cafeId; // Support old cafeId field
    if (categoryCartId) {
      emitToCafe(io, categoryCartId.toString(), "menu:updated", {
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
      name: rawName,
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
    const name = decodeHtmlEntities(rawName || "");
    const decodedDescription = decodeHtmlEntities(description || "");
    const decodedImage = decodeHtmlEntities(image || "");
    const decodedTags = decodeStringArray(tags) || [];
    const decodedAllergens = decodeStringArray(allergens) || [];

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
      return res.status(400).json({
        message: `Spice level must be one of ${SPICE_LEVELS.join(", ")}`,
      });
    }

    const category = await MenuCategory.findById(categoryId);
    if (!category) {
      return res.status(404).json({ message: "Parent category not found" });
    }

    // Set cartId if user is cart admin, and verify category belongs to same cart
    // Support both cartId (new) and cafeId (old) for backward compatibility
    const cartId = req.user && req.user.role === "admin" ? req.user._id : null;
    const categoryCartId = category.cartId || category.cafeId; // Support old cafeId field

    if (
      cartId &&
      categoryCartId &&
      categoryCartId.toString() !== cartId.toString()
    ) {
      return res
        .status(403)
        .json({ message: "Category does not belong to your cart" });
    }
    const finalCartId = cartId || categoryCartId || null;

    const item = await MenuItem.create({
      category: categoryId,
      name,
      description: decodedDescription,
      price,
      image: decodedImage,
      isAvailable,
      isFeatured,
      spiceLevel,
      sortOrder,
      tags: decodedTags,
      allergens: decodedAllergens,
      calories,
      cartId: finalCartId, // Use cartId instead of cafeId
    });
    const itemResponse = decodeItemForResponse(item.toObject());

    // Emit socket event to cart room
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    if (finalCartId) {
      emitToCafe(io, finalCartId.toString(), "menu:updated", {
        type: "item_created",
        item: itemResponse,
      });
    }

    return res.status(201).json(itemResponse);
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
        } else if (key === "name" || key === "description" || key === "image") {
          updates[key] = decodeHtmlEntities(req.body[key] || "");
        } else if (key === "tags" || key === "allergens") {
          updates[key] = decodeStringArray(req.body[key]) || [];
        } else {
          updates[key] = req.body[key];
        }
      }
    }

    if (updates.spiceLevel && !SPICE_LEVELS.includes(updates.spiceLevel)) {
      return res.status(400).json({
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
    const itemResponse = decodeItemForResponse(item);

    // Auto-sync to costing if price was updated and user is cart admin
    const itemCartId = item.cartId || item.cafeId; // Support old cafeId field
    if (
      updates.price !== undefined &&
      req.user.role === "admin" &&
      itemCartId
    ) {
      try {
        const {
          syncDefaultMenuToCosting,
        } = require("../services/costing-v2/syncDefaultMenuToCosting");
        // Sync only this specific cart's menu to costing
        await syncDefaultMenuToCosting(null, itemCartId.toString());
        console.log(
          `[MENU CONTROLLER] Auto-synced menu item price to costing for cart: ${itemCartId}`,
        );
      } catch (syncError) {
        // Don't fail the request if sync fails - just log it
        console.error(
          `[MENU CONTROLLER] Failed to auto-sync to costing:`,
          syncError.message,
        );
      }
    }

    // Emit socket event to cart room
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    if (itemCartId) {
      emitToCafe(io, itemCartId.toString(), "menu:updated", {
        type: "item_updated",
        item: itemResponse,
      });
    }

    return res.json(itemResponse);
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
      { new: true, runValidators: true },
    ).lean();

    if (!item) {
      return res.status(404).json({ message: "Menu item not found" });
    }
    const itemResponse = decodeItemForResponse(item);

    // Emit socket event to cart room
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    const itemCartId = item.cartId || item.cafeId; // Support old cafeId field
    if (itemCartId) {
      emitToCafe(io, itemCartId.toString(), "menu:updated", {
        type: "item_availability_updated",
        item: itemResponse,
      });
    }

    return res.json(itemResponse);
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

    const itemCartId = item.cartId || item.cafeId; // Support old cafeId field

    await MenuItem.findByIdAndDelete(id);

    // Emit socket event to cart room
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    if (itemCartId) {
      emitToCafe(io, itemCartId.toString(), "menu:updated", {
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

const { getStorageCallback, getFileUrl } = require("../config/uploadConfig");

const upload = multer({
  storage: getStorageCallback("menu"),
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
    // Use helper to get URL (handles S3 vs Local)
    // Pass "menu" as folderName to match storage configuration
    const fileUrl = getFileUrl(req, req.file, "menu");

    return res.status(201).json({
      url: fileUrl,
      filename: req.file.key || req.file.filename, // S3 uses 'key', local uses 'filename'
      size: req.file.size,
    });
  },
];
