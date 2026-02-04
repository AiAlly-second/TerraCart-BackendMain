const Addon = require("../models/addonModel");

/**
 * Get all add-ons for a cart/franchise
 */
exports.getAddons = async (req, res) => {
  try {
    const { cartId } = req.query;

    // Build filter based on user role
    let filter = {};

    if (req.user.role === "admin") {
      // Cart admin - only their add-ons
      filter.cartId = req.user._id;
    } else if (req.user.role === "franchise_admin") {
      // Franchise admin - specific cart or all their franchise add-ons
      if (cartId) {
        filter.cartId = cartId;
      } else {
        filter.franchiseId = req.user._id;
      }
    } else if (req.user.role === "super_admin") {
      // Super admin - specific cart or all
      if (cartId) {
        filter.cartId = cartId;
      }
    }

    const addons = await Addon.find(filter).sort({ sortOrder: 1, name: 1 });

    res.json({
      success: true,
      data: addons,
    });
  } catch (error) {
    console.error("Error fetching add-ons:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch add-ons",
      error: error.message,
    });
  }
};

/**
 * Get public add-ons for customer frontend
 */
exports.getPublicAddons = async (req, res) => {
  try {
    const { cartId } = req.query;

    if (!cartId) {
      return res.status(400).json({
        success: false,
        message: "cartId is required",
      });
    }

    const addons = await Addon.find({
      cartId: cartId,
      isAvailable: true,
    }).sort({ sortOrder: 1, name: 1 });

    res.json({
      success: true,
      data: addons,
    });
  } catch (error) {
    console.error("Error fetching public add-ons:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch add-ons",
      error: error.message,
    });
  }
};

/**
 * Create a new add-on
 */
exports.createAddon = async (req, res) => {
  try {
    const { name, description, price, icon, sortOrder } = req.body;

    if (!name || name.trim() === "") {
      return res.status(400).json({
        success: false,
        message: "Add-on name is required",
      });
    }

    // Set cartId and franchiseId based on user role
    let addonData = {
      name: name.trim(),
      description: description || "",
      price: Number(price) || 0,
      icon: icon || "➕",
      sortOrder: Number(sortOrder) || 0,
      isAvailable: true,
    };

    if (req.user.role === "admin") {
      addonData.cartId = req.user._id;
      // Get franchiseId from user
      const User = require("../models/userModel");
      const cartAdmin = await User.findById(req.user._id);
      if (cartAdmin && cartAdmin.franchiseId) {
        addonData.franchiseId = cartAdmin.franchiseId;
      }
    } else if (req.user.role === "franchise_admin") {
      addonData.franchiseId = req.user._id;
      // If cartId provided, use it
      if (req.body.cartId) {
        addonData.cartId = req.body.cartId;
      }
    } else if (req.user.role === "super_admin") {
      // Super admin can create for any cart/franchise
      if (req.body.cartId) {
        addonData.cartId = req.body.cartId;
      }
      if (req.body.franchiseId) {
        addonData.franchiseId = req.body.franchiseId;
      }
    }

    const addon = await Addon.create(addonData);

    res.status(201).json({
      success: true,
      data: addon,
    });
  } catch (error) {
    console.error("Error creating add-on:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create add-on",
      error: error.message,
    });
  }
};

/**
 * Update an add-on
 */
exports.updateAddon = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, price, icon, sortOrder, isAvailable } = req.body;

    const addon = await Addon.findById(id);

    if (!addon) {
      return res.status(404).json({
        success: false,
        message: "Add-on not found",
      });
    }

    // Check permissions
    if (req.user.role === "admin" && addon.cartId.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: "Not authorized to update this add-on",
      });
    }

    // Update fields
    if (name !== undefined) addon.name = name.trim();
    if (description !== undefined) addon.description = description;
    if (price !== undefined) addon.price = Number(price);
    if (icon !== undefined) addon.icon = icon;
    if (sortOrder !== undefined) addon.sortOrder = Number(sortOrder);
    if (isAvailable !== undefined) addon.isAvailable = isAvailable;

    await addon.save();

    res.json({
      success: true,
      data: addon,
    });
  } catch (error) {
    console.error("Error updating add-on:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update add-on",
      error: error.message,
    });
  }
};

/**
 * Delete an add-on
 */
exports.deleteAddon = async (req, res) => {
  try {
    const { id } = req.params;

    const addon = await Addon.findById(id);

    if (!addon) {
      return res.status(404).json({
        success: false,
        message: "Add-on not found",
      });
    }

    // Check permissions
    if (req.user.role === "admin" && addon.cartId.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: "Not authorized to delete this add-on",
      });
    }

    await Addon.findByIdAndDelete(id);

    res.json({
      success: true,
      message: "Add-on deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting add-on:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete add-on",
      error: error.message,
    });
  }
};

