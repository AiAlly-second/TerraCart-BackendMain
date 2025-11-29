# Multi-Level Restaurant Menu System - Complete Architecture Design

## Overview

This document describes the complete backend architecture for a multi-level restaurant menu system with three tiers:
1. **Super Admin** → Global Default Menu
2. **Franchise Admin** → Franchise-Specific Menu (cloned from global)
3. **Cart Admin** → Cart-Specific Menu (cloned from franchise)

## Database Schema Design

### Collection Structure

```
Users (roles: super_admin, franchise_admin, admin/cart_admin)
  ├── GlobalMenu (super_admin only)
  ├── FranchiseMenu (one per franchise)
  └── CartMenu (one per cart)
```

### Key Principles

1. **Complete Isolation**: Each menu level has its own collection
2. **Cloning, Not Sharing**: Menus are cloned with new IDs, not referenced
3. **Unique Identifiers**: Each menu item has unique `_id` and references to parent
4. **No Data Leakage**: Queries are scoped by `franchiseId` and `cartId`

---

## 1. User Schema

```javascript
// backend/models/userModel.js
const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: {
      type: String,
      enum: ["super_admin", "franchise_admin", "admin"], // admin = cart_admin
      required: true,
    },
    // Franchise Admin fields
    franchiseName: { type: String },
    franchiseId: { type: mongoose.Schema.Types.ObjectId, ref: "Franchise" },
    // Cart Admin fields
    cartName: { type: String },
    cartId: { type: mongoose.Schema.Types.ObjectId, ref: "Cart" },
    // Status
    isActive: { type: Boolean, default: true },
    isApproved: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model("User", userSchema);
```

---

## 2. Franchise Schema

```javascript
// backend/models/franchiseModel.js
const mongoose = require("mongoose");

const franchiseSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true },
    franchiseAdminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    address: { type: String },
    phone: { type: String },
    email: { type: String },
    // Menu tracking
    menuInitialized: { type: Boolean, default: false },
    menuInitializedAt: { type: Date },
    // Status
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Franchise", franchiseSchema);
```

---

## 3. Cart Schema

```javascript
// backend/models/cartModel.js
const mongoose = require("mongoose");

const cartSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    franchiseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Franchise",
      required: true,
      index: true,
    },
    cartAdminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    location: { type: String },
    // Menu tracking
    menuInitialized: { type: Boolean, default: false },
    menuInitializedAt: { type: Date },
    // Status
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// Compound index for efficient queries
cartSchema.index({ franchiseId: 1, isActive: 1 });

module.exports = mongoose.model("Cart", cartSchema);
```

---

## 4. Global Menu Schema

```javascript
// backend/models/globalMenuModel.js
const mongoose = require("mongoose");

const globalMenuItemSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    description: { type: String, default: "" },
    category: { type: String, required: true, index: true },
    price: { type: Number, required: true, min: 0 },
    taxRate: { type: Number, default: 0, min: 0, max: 100 }, // Percentage
    isAvailable: { type: Boolean, default: true },
    image: { type: String },
    // Metadata
    tags: [{ type: String }],
    allergens: [{ type: String }],
    calories: { type: Number, min: 0 },
    spiceLevel: {
      type: String,
      enum: ["NONE", "MILD", "MEDIUM", "HOT", "EXTREME"],
      default: "NONE",
    },
    sortOrder: { type: Number, default: 0 },
    // Created by
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);

// Indexes for performance
globalMenuItemSchema.index({ category: 1, isAvailable: 1 });
globalMenuItemSchema.index({ createdBy: 1 });

module.exports = mongoose.model("GlobalMenuItem", globalMenuItemSchema);
```

---

## 5. Franchise Menu Schema

```javascript
// backend/models/franchiseMenuModel.js
const mongoose = require("mongoose");

const franchiseMenuItemSchema = new mongoose.Schema(
  {
    // Franchise reference
    franchiseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Franchise",
      required: true,
      index: true,
    },
    // Source tracking (for reference, not dependency)
    sourceGlobalMenuItemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "GlobalMenuItem",
    },
    // Item data (independent copy)
    name: { type: String, required: true },
    description: { type: String, default: "" },
    category: { type: String, required: true, index: true },
    price: { type: Number, required: true, min: 0 },
    taxRate: { type: Number, default: 0, min: 0, max: 100 },
    isAvailable: { type: Boolean, default: true },
    image: { type: String },
    // Metadata
    tags: [{ type: String }],
    allergens: [{ type: String }],
    calories: { type: Number, min: 0 },
    spiceLevel: {
      type: String,
      enum: ["NONE", "MILD", "MEDIUM", "HOT", "EXTREME"],
      default: "NONE",
    },
    sortOrder: { type: Number, default: 0 },
    // Custom flag (true if added by franchise admin, not from global)
    isCustom: { type: Boolean, default: false },
    // Updated by
    lastUpdatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true }
);

// Compound indexes for efficient queries
franchiseMenuItemSchema.index({ franchiseId: 1, category: 1 });
franchiseMenuItemSchema.index({ franchiseId: 1, isAvailable: 1 });
franchiseMenuItemSchema.index({ franchiseId: 1, isCustom: 1 });

module.exports = mongoose.model("FranchiseMenuItem", franchiseMenuItemSchema);
```

---

## 6. Cart Menu Schema

```javascript
// backend/models/cartMenuModel.js
const mongoose = require("mongoose");

const cartMenuItemSchema = new mongoose.Schema(
  {
    // Cart reference
    cartId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Cart",
      required: true,
      index: true,
    },
    // Franchise reference (for validation)
    franchiseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Franchise",
      required: true,
      index: true,
    },
    // Source tracking (for reference, not dependency)
    sourceFranchiseMenuItemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FranchiseMenuItem",
    },
    // Item data (independent copy)
    name: { type: String, required: true },
    description: { type: String, default: "" },
    category: { type: String, required: true, index: true },
    price: { type: Number, required: true, min: 0 },
    taxRate: { type: Number, default: 0, min: 0, max: 100 },
    isAvailable: { type: Boolean, default: true }, // Cart admin can toggle this
    image: { type: String },
    // Metadata
    tags: [{ type: String }],
    allergens: [{ type: String }],
    calories: { type: Number, min: 0 },
    spiceLevel: {
      type: String,
      enum: ["NONE", "MILD", "MEDIUM", "HOT", "EXTREME"],
      default: "NONE",
    },
    sortOrder: { type: Number, default: 0 },
    // Availability override (cart-specific)
    cartAvailabilityOverride: { type: Boolean }, // null = use franchise setting
  },
  { timestamps: true }
);

// Compound indexes for efficient queries
cartMenuItemSchema.index({ cartId: 1, category: 1 });
cartMenuItemSchema.index({ cartId: 1, isAvailable: 1 });
cartMenuItemSchema.index({ franchiseId: 1, cartId: 1 }); // For validation

module.exports = mongoose.model("CartMenuItem", cartMenuItemSchema);
```

---

## Core Cloning Functions

### 1. Clone Global Menu to Franchise

```javascript
// backend/utils/menuCloning.js

const GlobalMenuItem = require("../models/globalMenuModel");
const FranchiseMenuItem = require("../models/franchiseMenuModel");
const Franchise = require("../models/franchiseModel");

/**
 * Clone global menu items to create a franchise menu
 * @param {ObjectId} franchiseId - The franchise ID
 * @param {ObjectId} franchiseAdminId - The franchise admin user ID
 * @returns {Promise<Object>} Result with counts
 */
async function cloneGlobalMenuToFranchise(franchiseId, franchiseAdminId) {
  try {
    // Verify franchise exists
    const franchise = await Franchise.findById(franchiseId);
    if (!franchise) {
      throw new Error(`Franchise ${franchiseId} not found`);
    }

    // Check if menu already initialized
    if (franchise.menuInitialized) {
      console.log(`[MENU CLONE] Franchise ${franchiseId} menu already initialized`);
      return {
        success: false,
        message: "Franchise menu already initialized",
        itemsCloned: 0,
      };
    }

    // Get all global menu items
    const globalItems = await GlobalMenuItem.find({ isAvailable: true }).lean();
    
    if (globalItems.length === 0) {
      console.warn(`[MENU CLONE] No global menu items found`);
      return {
        success: false,
        message: "No global menu items available to clone",
        itemsCloned: 0,
      };
    }

    console.log(`[MENU CLONE] Cloning ${globalItems.length} items from global menu to franchise ${franchiseId}`);

    // Clone each item with new ID
    const franchiseItems = globalItems.map((item) => ({
      franchiseId: franchiseId,
      sourceGlobalMenuItemId: item._id, // Reference for tracking
      name: item.name,
      description: item.description,
      category: item.category,
      price: item.price,
      taxRate: item.taxRate,
      isAvailable: item.isAvailable,
      image: item.image,
      tags: item.tags || [],
      allergens: item.allergens || [],
      calories: item.calories,
      spiceLevel: item.spiceLevel,
      sortOrder: item.sortOrder,
      isCustom: false, // Cloned from global
      lastUpdatedBy: franchiseAdminId,
    }));

    // Insert all items
    const createdItems = await FranchiseMenuItem.insertMany(franchiseItems);

    // Update franchise menu initialization status
    await Franchise.findByIdAndUpdate(franchiseId, {
      menuInitialized: true,
      menuInitializedAt: new Date(),
    });

    console.log(`[MENU CLONE] ✅ Successfully cloned ${createdItems.length} items to franchise ${franchiseId}`);

    return {
      success: true,
      message: `Cloned ${createdItems.length} items from global menu`,
      itemsCloned: createdItems.length,
    };
  } catch (error) {
    console.error(`[MENU CLONE] ❌ Error cloning global menu to franchise:`, error);
    throw error;
  }
}

module.exports = { cloneGlobalMenuToFranchise };
```

### 2. Clone Franchise Menu to Cart

```javascript
// backend/utils/menuCloning.js (continued)

const CartMenuItem = require("../models/cartMenuModel");
const Cart = require("../models/cartModel");

/**
 * Clone franchise menu items to create a cart menu
 * CRITICAL: This ensures each cart has UNIQUE menu data
 * @param {ObjectId} cartId - The cart ID
 * @param {ObjectId} franchiseId - The franchise ID (for validation)
 * @returns {Promise<Object>} Result with counts
 */
async function cloneFranchiseMenuToCart(cartId, franchiseId) {
  try {
    // Verify cart exists and belongs to franchise
    const cart = await Cart.findOne({ _id: cartId, franchiseId: franchiseId });
    if (!cart) {
      throw new Error(`Cart ${cartId} not found or doesn't belong to franchise ${franchiseId}`);
    }

    // Check if menu already initialized
    if (cart.menuInitialized) {
      console.log(`[MENU CLONE] Cart ${cartId} menu already initialized`);
      return {
        success: false,
        message: "Cart menu already initialized",
        itemsCloned: 0,
      };
    }

    // CRITICAL: Delete ANY existing menu data for this cart first
    // This prevents old/duplicate data from appearing
    const existingItems = await CartMenuItem.find({ cartId: cartId }).lean();
    if (existingItems.length > 0) {
      console.log(`[MENU CLONE] ⚠️ Found ${existingItems.length} existing items for cart ${cartId}, deleting...`);
      await CartMenuItem.deleteMany({ cartId: cartId });
      console.log(`[MENU CLONE] ✅ Deleted ${existingItems.length} existing items`);
    }

    // Get all franchise menu items
    const FranchiseMenuItem = require("../models/franchiseMenuModel");
    const franchiseItems = await FranchiseMenuItem.find({
      franchiseId: franchiseId,
      isAvailable: true,
    }).lean();

    if (franchiseItems.length === 0) {
      console.warn(`[MENU CLONE] No franchise menu items found for franchise ${franchiseId}`);
      return {
        success: false,
        message: "No franchise menu items available to clone",
        itemsCloned: 0,
      };
    }

    console.log(`[MENU CLONE] Cloning ${franchiseItems.length} items from franchise ${franchiseId} to cart ${cartId}`);

    // Clone each item with new ID
    const cartItems = franchiseItems.map((item) => ({
      cartId: cartId,
      franchiseId: franchiseId, // For validation
      sourceFranchiseMenuItemId: item._id, // Reference for tracking
      name: item.name,
      description: item.description,
      category: item.category,
      price: item.price,
      taxRate: item.taxRate,
      isAvailable: item.isAvailable,
      image: item.image,
      tags: item.tags || [],
      allergens: item.allergens || [],
      calories: item.calories,
      spiceLevel: item.spiceLevel,
      sortOrder: item.sortOrder,
      cartAvailabilityOverride: null, // No override initially
    }));

    // Insert all items
    const createdItems = await CartMenuItem.insertMany(cartItems);

    // Update cart menu initialization status
    await Cart.findByIdAndUpdate(cartId, {
      menuInitialized: true,
      menuInitializedAt: new Date(),
    });

    console.log(`[MENU CLONE] ✅ Successfully cloned ${createdItems.length} items to cart ${cartId}`);
    console.log(`[MENU CLONE] ✅ Cart ${cartId} now has UNIQUE menu data (not shared with other carts)`);

    return {
      success: true,
      message: `Cloned ${createdItems.length} items from franchise menu`,
      itemsCloned: createdItems.length,
    };
  } catch (error) {
    console.error(`[MENU CLONE] ❌ Error cloning franchise menu to cart:`, error);
    throw error;
  }
}

module.exports = {
  cloneGlobalMenuToFranchise,
  cloneFranchiseMenuToCart,
};
```

---

## Express Routes & Controllers

### 1. Global Menu Controller

```javascript
// backend/controllers/globalMenuController.js

const GlobalMenuItem = require("../models/globalMenuModel");

// @desc    Get all global menu items
// @route   GET /api/global-menu
// @access  Super Admin only
exports.getGlobalMenu = async (req, res) => {
  try {
    if (req.user.role !== "super_admin") {
      return res.status(403).json({ message: "Access denied. Super Admin only." });
    }

    const items = await GlobalMenuItem.find()
      .sort({ category: 1, sortOrder: 1, name: 1 })
      .lean();

    // Group by category
    const menuByCategory = items.reduce((acc, item) => {
      if (!acc[item.category]) {
        acc[item.category] = [];
      }
      acc[item.category].push(item);
      return acc;
    }, {});

    res.json({
      success: true,
      items: items,
      menuByCategory: menuByCategory,
      totalItems: items.length,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Create global menu item
// @route   POST /api/global-menu
// @access  Super Admin only
exports.createGlobalMenuItem = async (req, res) => {
  try {
    if (req.user.role !== "super_admin") {
      return res.status(403).json({ message: "Access denied. Super Admin only." });
    }

    const item = await GlobalMenuItem.create({
      ...req.body,
      createdBy: req.user._id,
    });

    res.status(201).json({
      success: true,
      item: item,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Update global menu item
// @route   PUT /api/global-menu/:id
// @access  Super Admin only
exports.updateGlobalMenuItem = async (req, res) => {
  try {
    if (req.user.role !== "super_admin") {
      return res.status(403).json({ message: "Access denied. Super Admin only." });
    }

    const item = await GlobalMenuItem.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );

    if (!item) {
      return res.status(404).json({ message: "Menu item not found" });
    }

    res.json({
      success: true,
      item: item,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Delete global menu item
// @route   DELETE /api/global-menu/:id
// @access  Super Admin only
exports.deleteGlobalMenuItem = async (req, res) => {
  try {
    if (req.user.role !== "super_admin") {
      return res.status(403).json({ message: "Access denied. Super Admin only." });
    }

    const item = await GlobalMenuItem.findByIdAndDelete(req.params.id);

    if (!item) {
      return res.status(404).json({ message: "Menu item not found" });
    }

    res.json({
      success: true,
      message: "Menu item deleted",
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
```

### 2. Franchise Controller

```javascript
// backend/controllers/franchiseController.js

const Franchise = require("../models/franchiseModel");
const User = require("../models/userModel");
const { cloneGlobalMenuToFranchise } = require("../utils/menuCloning");

// @desc    Create franchise (auto-initializes menu from global)
// @route   POST /api/franchises
// @access  Super Admin only
exports.createFranchise = async (req, res) => {
  try {
    if (req.user.role !== "super_admin") {
      return res.status(403).json({ message: "Access denied. Super Admin only." });
    }

    const { name, franchiseAdminEmail, address, phone, email } = req.body;

    // Create or get franchise admin user
    let franchiseAdmin = await User.findOne({ email: franchiseAdminEmail });
    if (!franchiseAdmin) {
      // Create new franchise admin user
      franchiseAdmin = await User.create({
        name: `Franchise Admin - ${name}`,
        email: franchiseAdminEmail,
        password: "temp-password", // Should be set via separate flow
        role: "franchise_admin",
        isActive: true,
        isApproved: true,
      });
    } else {
      // Update existing user to franchise admin
      franchiseAdmin.role = "franchise_admin";
      franchiseAdmin.isActive = true;
      franchiseAdmin.isApproved = true;
      await franchiseAdmin.save();
    }

    // Create franchise
    const franchise = await Franchise.create({
      name,
      franchiseAdminId: franchiseAdmin._id,
      address,
      phone,
      email,
    });

    // CRITICAL: Auto-clone global menu to franchise
    try {
      const cloneResult = await cloneGlobalMenuToFranchise(
        franchise._id,
        franchiseAdmin._id
      );

      if (!cloneResult.success) {
        console.warn(`[FRANCHISE] Menu clone failed: ${cloneResult.message}`);
      }
    } catch (cloneError) {
      console.error(`[FRANCHISE] Error cloning menu:`, cloneError);
      // Don't fail franchise creation if menu clone fails
    }

    res.status(201).json({
      success: true,
      franchise: franchise,
      franchiseAdmin: {
        id: franchiseAdmin._id,
        email: franchiseAdmin.email,
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get franchise menu
// @route   GET /api/franchises/:id/menu
// @access  Franchise Admin (own franchise) or Super Admin
exports.getFranchiseMenu = async (req, res) => {
  try {
    const franchiseId = req.params.id;

    // Access control
    if (req.user.role === "franchise_admin") {
      // Franchise admin can only access their own franchise
      const franchise = await Franchise.findOne({
        _id: franchiseId,
        franchiseAdminId: req.user._id,
      });
      if (!franchise) {
        return res.status(403).json({ message: "Access denied" });
      }
    } else if (req.user.role !== "super_admin") {
      return res.status(403).json({ message: "Access denied" });
    }

    const FranchiseMenuItem = require("../models/franchiseMenuModel");
    const items = await FranchiseMenuItem.find({ franchiseId: franchiseId })
      .sort({ category: 1, sortOrder: 1, name: 1 })
      .lean();

    // Group by category
    const menuByCategory = items.reduce((acc, item) => {
      if (!acc[item.category]) {
        acc[item.category] = [];
      }
      acc[item.category].push(item);
      return acc;
    }, {});

    res.json({
      success: true,
      franchiseId: franchiseId,
      items: items,
      menuByCategory: menuByCategory,
      totalItems: items.length,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
```

### 3. Cart Controller

```javascript
// backend/controllers/cartController.js

const Cart = require("../models/cartModel");
const User = require("../models/userModel");
const Franchise = require("../models/franchiseModel");
const { cloneFranchiseMenuToCart } = require("../utils/menuCloning");

// @desc    Create cart (auto-initializes menu from franchise)
// @route   POST /api/carts
// @access  Franchise Admin (own franchise) or Super Admin
exports.createCart = async (req, res) => {
  try {
    const { name, franchiseId, cartAdminEmail, location } = req.body;

    // Access control
    if (req.user.role === "franchise_admin") {
      // Franchise admin can only create carts for their own franchise
      const franchise = await Franchise.findOne({
        _id: franchiseId,
        franchiseAdminId: req.user._id,
      });
      if (!franchise) {
        return res.status(403).json({ message: "Access denied" });
      }
    } else if (req.user.role !== "super_admin") {
      return res.status(403).json({ message: "Access denied" });
    }

    // Verify franchise exists
    const franchise = await Franchise.findById(franchiseId);
    if (!franchise) {
      return res.status(404).json({ message: "Franchise not found" });
    }

    // Create or get cart admin user
    let cartAdmin = await User.findOne({ email: cartAdminEmail });
    if (!cartAdmin) {
      cartAdmin = await User.create({
        name: `Cart Admin - ${name}`,
        email: cartAdminEmail,
        password: "temp-password", // Should be set via separate flow
        role: "admin", // Cart admin
        franchiseId: franchiseId,
        isActive: true,
        isApproved: true,
      });
    } else {
      cartAdmin.role = "admin";
      cartAdmin.franchiseId = franchiseId;
      cartAdmin.isActive = true;
      cartAdmin.isApproved = true;
      await cartAdmin.save();
    }

    // CRITICAL: Delete ANY existing menu data for this cart first
    // This prevents old/duplicate data from appearing
    const CartMenuItem = require("../models/cartMenuModel");
    const existingItems = await CartMenuItem.find({ cartId: null }).lean(); // Will be set after cart creation
    // We'll delete after cart is created

    // Create cart
    const cart = await Cart.create({
      name,
      franchiseId: franchiseId,
      cartAdminId: cartAdmin._id,
      location,
    });

    // Update cart admin with cartId
    cartAdmin.cartId = cart._id;
    await cartAdmin.save();

    // CRITICAL: Auto-clone franchise menu to cart
    // This ensures cart gets UNIQUE menu data
    try {
      const cloneResult = await cloneFranchiseMenuToCart(cart._id, franchiseId);

      if (!cloneResult.success) {
        console.warn(`[CART] Menu clone failed: ${cloneResult.message}`);
      }
    } catch (cloneError) {
      console.error(`[CART] Error cloning menu:`, cloneError);
      // Don't fail cart creation if menu clone fails
    }

    res.status(201).json({
      success: true,
      cart: cart,
      cartAdmin: {
        id: cartAdmin._id,
        email: cartAdmin.email,
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get cart menu
// @route   GET /api/carts/:id/menu
// @access  Cart Admin (own cart), Franchise Admin (own franchise), or Super Admin
exports.getCartMenu = async (req, res) => {
  try {
    const cartId = req.params.id;

    // Get cart
    const cart = await Cart.findById(cartId);
    if (!cart) {
      return res.status(404).json({ message: "Cart not found" });
    }

    // Access control
    if (req.user.role === "admin") {
      // Cart admin can only access their own cart
      if (cart.cartAdminId.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: "Access denied" });
      }
    } else if (req.user.role === "franchise_admin") {
      // Franchise admin can access carts in their franchise
      const franchise = await Franchise.findOne({
        _id: cart.franchiseId,
        franchiseAdminId: req.user._id,
      });
      if (!franchise) {
        return res.status(403).json({ message: "Access denied" });
      }
    } else if (req.user.role !== "super_admin") {
      return res.status(403).json({ message: "Access denied" });
    }

    const CartMenuItem = require("../models/cartMenuModel");
    const items = await CartMenuItem.find({ cartId: cartId })
      .sort({ category: 1, sortOrder: 1, name: 1 })
      .lean();

    // Group by category
    const menuByCategory = items.reduce((acc, item) => {
      if (!acc[item.category]) {
        acc[item.category] = [];
      }
      acc[item.category].push(item);
      return acc;
    }, {});

    res.json({
      success: true,
      cartId: cartId,
      franchiseId: cart.franchiseId,
      items: items,
      menuByCategory: menuByCategory,
      totalItems: items.length,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Update cart menu item availability (limited permission)
// @route   PATCH /api/carts/:cartId/menu/:itemId/availability
// @access  Cart Admin (own cart) or Franchise Admin (own franchise)
exports.updateCartMenuItemAvailability = async (req, res) => {
  try {
    const { cartId, itemId } = req.params;
    const { isAvailable } = req.body;

    // Get cart
    const cart = await Cart.findById(cartId);
    if (!cart) {
      return res.status(404).json({ message: "Cart not found" });
    }

    // Access control
    if (req.user.role === "admin") {
      // Cart admin can only update their own cart
      if (cart.cartAdminId.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: "Access denied" });
      }
    } else if (req.user.role === "franchise_admin") {
      // Franchise admin can update carts in their franchise
      const franchise = await Franchise.findOne({
        _id: cart.franchiseId,
        franchiseAdminId: req.user._id,
      });
      if (!franchise) {
        return res.status(403).json({ message: "Access denied" });
      }
    } else {
      return res.status(403).json({ message: "Access denied" });
    }

    const CartMenuItem = require("../models/cartMenuModel");
    const item = await CartMenuItem.findOneAndUpdate(
      { _id: itemId, cartId: cartId }, // CRITICAL: Ensure item belongs to this cart
      { isAvailable: isAvailable },
      { new: true }
    );

    if (!item) {
      return res.status(404).json({ message: "Menu item not found" });
    }

    res.json({
      success: true,
      item: item,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
```

---

## Routes Setup

```javascript
// backend/routes/globalMenuRoutes.js
const express = require("express");
const router = express.Router();
const {
  getGlobalMenu,
  createGlobalMenuItem,
  updateGlobalMenuItem,
  deleteGlobalMenuItem,
} = require("../controllers/globalMenuController");
const { protect } = require("../middleware/authMiddleware");

router.use(protect); // All routes require authentication

router
  .route("/")
  .get(getGlobalMenu)
  .post(createGlobalMenuItem);

router
  .route("/:id")
  .put(updateGlobalMenuItem)
  .delete(deleteGlobalMenuItem);

module.exports = router;
```

```javascript
// backend/routes/franchiseRoutes.js
const express = require("express");
const router = express.Router();
const {
  createFranchise,
  getFranchiseMenu,
} = require("../controllers/franchiseController");
const { protect } = require("../middleware/authMiddleware");

router.use(protect);

router.post("/", createFranchise);
router.get("/:id/menu", getFranchiseMenu);

module.exports = router;
```

```javascript
// backend/routes/cartRoutes.js
const express = require("express");
const router = express.Router();
const {
  createCart,
  getCartMenu,
  updateCartMenuItemAvailability,
} = require("../controllers/cartController");
const { protect } = require("../middleware/authMiddleware");

router.use(protect);

router.post("/", createCart);
router.get("/:id/menu", getCartMenu);
router.patch("/:cartId/menu/:itemId/availability", updateCartMenuItemAvailability);

module.exports = router;
```

---

## Key Design Decisions

### 1. **Complete Isolation**
- Each menu level has its own collection
- No shared references that could cause data leakage
- Queries are scoped by `franchiseId` and `cartId`

### 2. **Cloning, Not Sharing**
- Menus are cloned with new IDs
- Source IDs are stored for reference only (not dependencies)
- Changes to source menus don't affect cloned menus

### 3. **Preventing Data Leakage**
- Cleanup before cloning (deletes any existing menu data)
- Scoped queries (always filter by `cartId` or `franchiseId`)
- Validation in controllers (ensure items belong to correct cart/franchise)

### 4. **Performance Optimizations**
- Compound indexes on frequently queried fields
- Lean queries where possible
- Efficient grouping by category

---

## Testing Checklist

- [ ] Create franchise → Menu auto-cloned from global
- [ ] Create cart → Menu auto-cloned from franchise
- [ ] Verify cart menu is unique (not shared with other carts)
- [ ] Verify no old menu data appears in new carts
- [ ] Test role-based access control
- [ ] Test menu updates (franchise menu doesn't affect cart menu)
- [ ] Test cart admin can toggle availability
- [ ] Test franchise admin can update franchise menu

---

## Next Steps

1. Implement authentication middleware
2. Add validation middleware (e.g., express-validator)
3. Add error handling middleware
4. Add logging (e.g., Winston)
5. Add API documentation (e.g., Swagger)
6. Add unit tests
7. Add integration tests















