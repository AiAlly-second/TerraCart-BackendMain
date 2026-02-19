const Addon = require("../models/addonModel");
const User = require("../models/userModel");
const Cart = require("../models/cartModel");
const Table = require("../models/tableModel");
const mongoose = require("mongoose");

const toObjectId = (value) => {
  if (!value) return null;
  const id = String(value).trim();
  if (!id || !mongoose.Types.ObjectId.isValid(id)) return null;
  return new mongoose.Types.ObjectId(id);
};

const escapeRegex = (value = "") =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const sanitizeAddonName = (value) => {
  const normalized = String(value || "")
    .replace(/^\(\s*\+\s*\)\s*/u, "")
    .trim();
  return normalized || "Add-on";
};

const nullOrMissingCondition = (fieldName) => ({
  $or: [{ [fieldName]: null }, { [fieldName]: { $exists: false } }],
});

const buildScopeConditions = (addonData) => {
  const conditions = [];
  if (addonData?.cartId) {
    conditions.push({ cartId: addonData.cartId });
  } else {
    conditions.push(nullOrMissingCondition("cartId"));
  }

  if (addonData?.franchiseId) {
    conditions.push({ franchiseId: addonData.franchiseId });
  } else {
    conditions.push(nullOrMissingCondition("franchiseId"));
  }

  return conditions;
};

const findAddonByNameInSameScope = async ({
  name,
  cartId = null,
  franchiseId = null,
  excludeId = null,
}) => {
  const normalizedName = sanitizeAddonName(name);
  const query = {
    name: {
      $regex: `^${escapeRegex(normalizedName)}$`,
      $options: "i",
    },
    $and: buildScopeConditions({ cartId, franchiseId }),
  };

  if (excludeId) {
    query._id = { $ne: excludeId };
  }

  return Addon.findOne(query).select("_id name cartId franchiseId");
};

const resolveCartAdminFromRef = async (cartRef) => {
  const objectId = toObjectId(cartRef);
  if (!objectId) return null;

  // 1) cartRef is already cart-admin user id
  const cartAdmin = await User.findOne({ _id: objectId, role: "admin" })
    .select("_id franchiseId")
    .lean();
  if (cartAdmin) {
    return {
      cartAdminId: cartAdmin._id,
      franchiseId: cartAdmin.franchiseId || null,
    };
  }

  // 2) cartRef is Cart document id -> resolve to cartAdminId
  const cartDoc = await Cart.findById(objectId).select("_id cartAdminId franchiseId").lean();
  if (cartDoc && cartDoc.cartAdminId) {
    return {
      cartAdminId: cartDoc.cartAdminId,
      franchiseId: cartDoc.franchiseId || null,
      cartDocId: cartDoc._id,
    };
  }

  return null;
};

const ensureFranchiseOwnsCartAdmin = async (franchiseId, cartAdminId) => {
  const cartAdminObjectId = toObjectId(cartAdminId);
  if (!cartAdminObjectId) return null;

  const cartAdmin = await User.findOne({
    _id: cartAdminObjectId,
    role: "admin",
    franchiseId,
  })
    .select("_id franchiseId")
    .lean();

  return cartAdmin;
};

/**
 * Get add-ons for admin panel
 */
exports.getAddons = async (req, res) => {
  try {
    const { cartId, franchiseId } = req.query;
    const role = req.user?.role;
    let filter = {};

    if (role === "admin") {
      // Cart admin sees only their own cart add-ons
      filter.cartId = req.user._id;
    } else if (role === "franchise_admin") {
      if (cartId) {
        const cartAdmin = await ensureFranchiseOwnsCartAdmin(req.user._id, cartId);
        if (!cartAdmin) {
          return res.status(403).json({
            success: false,
            message: "Selected cart is not part of your franchise",
          });
        }
        filter = {
          cartId: cartAdmin._id,
          franchiseId: req.user._id,
        };
      } else {
        // Franchise-level management (all add-ons in this franchise)
        filter.franchiseId = req.user._id;
      }
    } else if (role === "super_admin") {
      const includeAllScopes =
        String(req.query.includeAllScopes || "")
          .trim()
          .toLowerCase() === "true";

      if (cartId) {
        const cartIdObj = toObjectId(cartId);
        filter.cartId = cartIdObj || cartId;
      }
      if (franchiseId) {
        const franchiseIdObj = toObjectId(franchiseId);
        filter.franchiseId = franchiseIdObj || franchiseId;
      }

      // Default super-admin view should show only global template add-ons.
      // Cart/franchise-scoped add-ons are returned only when explicitly filtered.
      if (!includeAllScopes && !cartId && !franchiseId) {
        filter = {
          $and: [
            nullOrMissingCondition("cartId"),
            nullOrMissingCondition("franchiseId"),
          ],
        };
      }
    }

    const addons = await Addon.find(filter).sort({ sortOrder: 1, name: 1 });
    const normalizedAddons = addons.map((addon) => {
      const data = addon.toObject ? addon.toObject() : addon;
      return {
        ...data,
        name: sanitizeAddonName(data?.name),
      };
    });

    res.json({
      success: true,
      data: normalizedAddons,
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
 * Accepts cartId OR tableId
 */
exports.getPublicAddons = async (req, res) => {
  try {
    let cartRef =
      typeof req.query.cartId === "string"
        ? req.query.cartId.trim()
        : req.query.cartId
          ? String(req.query.cartId).trim()
          : "";

    const tableId =
      typeof req.query.tableId === "string"
        ? req.query.tableId.trim()
        : req.query.tableId
          ? String(req.query.tableId).trim()
          : "";

    // Resolve tableId -> cart admin id
    if (!cartRef && tableId) {
      const tableObjectId = toObjectId(tableId);
      if (tableObjectId) {
        const table = await Table.findById(tableObjectId).select("cartId").lean();
        if (table && table.cartId) {
          cartRef = table.cartId.toString();
        }
      }
    }

    if (!cartRef) {
      return res.status(400).json({
        success: false,
        message: "cartId or tableId is required",
      });
    }

    const resolved = await resolveCartAdminFromRef(cartRef);
    if (!resolved || !resolved.cartAdminId) {
      return res.json({
        success: true,
        data: [],
      });
    }

    const idsToMatch = [];
    const cartAdminIdStr = resolved.cartAdminId.toString();
    idsToMatch.push(resolved.cartAdminId);

    // Legacy compatibility: some data may be stored with cart document id
    const cartDoc = await Cart.findOne({ cartAdminId: resolved.cartAdminId }).select("_id").lean();
    if (cartDoc && cartDoc._id.toString() !== cartAdminIdStr) {
      idsToMatch.push(cartDoc._id);
    }

    // Also include original query id (if different) to handle mixed historical data
    const originalCartRefObj = toObjectId(cartRef);
    if (
      originalCartRefObj &&
      !idsToMatch.some((id) => id.toString() === originalCartRefObj.toString())
    ) {
      idsToMatch.push(originalCartRefObj);
    }

    // 1) Strict cart-level add-ons first (cart-specific hide/show)
    let addons = await Addon.find({
      cartId: idsToMatch.length === 1 ? idsToMatch[0] : { $in: idsToMatch },
      isAvailable: { $ne: false },
    })
      .sort({ sortOrder: 1, name: 1 })
      .lean();

    // 2) If none configured for this cart, fallback to franchise defaults only
    if (addons.length === 0 && resolved.franchiseId) {
      addons = await Addon.find({
        franchiseId: resolved.franchiseId,
        $or: [{ cartId: null }, { cartId: { $exists: false } }],
        isAvailable: { $ne: false },
      })
        .sort({ sortOrder: 1, name: 1 })
        .lean();
    }

    const normalizedAddons = (addons || []).map((addon) => ({
      ...addon,
      name: sanitizeAddonName(addon?.name),
    }));
    res.json({
      success: true,
      data: normalizedAddons,
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
    const { name, description, price, icon, sortOrder, cartId } = req.body;

    if (!name || name.trim() === "") {
      return res.status(400).json({
        success: false,
        message: "Add-on name is required",
      });
    }

    const addonData = {
      name: sanitizeAddonName(name),
      description: description || "",
      price: Number(price) || 0,
      icon: icon || "",
      sortOrder: Number(sortOrder) || 0,
      isAvailable: true,
    };

    if (req.user.role === "admin") {
      return res.status(403).json({
        success: false,
        message: "Cart admins can only hide/show add-ons. Please ask franchise admin to create add-ons.",
      });
    }

    if (req.user.role === "franchise_admin") {
      if (!cartId) {
        return res.status(400).json({
          success: false,
          message: "Please select a cart before creating an add-on",
        });
      }

      const cartAdmin = await ensureFranchiseOwnsCartAdmin(req.user._id, cartId);
      if (!cartAdmin) {
        return res.status(403).json({
          success: false,
          message: "Selected cart is not part of your franchise",
        });
      }

      addonData.cartId = cartAdmin._id;
      addonData.franchiseId = req.user._id;
    }

    if (req.user.role === "super_admin") {
      if (cartId) {
        const cartIdObj = toObjectId(cartId);
        addonData.cartId = cartIdObj || cartId;

        // Derive franchise if not sent explicitly
        if (req.body.franchiseId) {
          addonData.franchiseId = toObjectId(req.body.franchiseId) || req.body.franchiseId;
        } else if (cartIdObj) {
          const cartAdmin = await User.findOne({ _id: cartIdObj, role: "admin" })
            .select("franchiseId")
            .lean();
          if (cartAdmin?.franchiseId) {
            addonData.franchiseId = cartAdmin.franchiseId;
          }
        }
      } else if (req.body.franchiseId) {
        addonData.franchiseId = toObjectId(req.body.franchiseId) || req.body.franchiseId;
      }

      if (req.body.isAvailable !== undefined) {
        addonData.isAvailable = Boolean(req.body.isAvailable);
      }
    }

    const duplicateAddon = await findAddonByNameInSameScope({
      name: addonData.name,
      cartId: addonData.cartId || null,
      franchiseId: addonData.franchiseId || null,
    });
    if (duplicateAddon) {
      return res.status(409).json({
        success: false,
        message: "Add-on with this name already exists in this scope",
      });
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

    // Permissions
    if (req.user.role === "admin") {
      if (!addon.cartId || addon.cartId.toString() !== req.user._id.toString()) {
        return res.status(403).json({
          success: false,
          message: "Not authorized to update this add-on",
        });
      }

      // Cart admin gets limited permission: hide/show only
      const changedKeys = Object.keys(req.body || {}).filter(
        (key) => req.body[key] !== undefined
      );
      const disallowedChanges = changedKeys.filter((key) => key !== "isAvailable");
      if (disallowedChanges.length > 0) {
        return res.status(403).json({
          success: false,
          message: "Cart admins can only hide/show add-ons",
        });
      }
    }

    if (req.user.role === "franchise_admin") {
      if (
        !addon.franchiseId ||
        addon.franchiseId.toString() !== req.user._id.toString()
      ) {
        return res.status(403).json({
          success: false,
          message: "Not authorized to update this add-on",
        });
      }
    }

    if (req.user.role !== "admin" && name !== undefined) {
      const normalizedName = sanitizeAddonName(name);
      const duplicateAddon = await findAddonByNameInSameScope({
        name: normalizedName,
        cartId: addon.cartId || null,
        franchiseId: addon.franchiseId || null,
        excludeId: addon._id,
      });
      if (duplicateAddon) {
        return res.status(409).json({
          success: false,
          message: "Add-on with this name already exists in this scope",
        });
      }
      addon.name = normalizedName;
    }

    // Apply updates
    if (req.user.role === "admin") {
      if (isAvailable !== undefined) addon.isAvailable = Boolean(isAvailable);
    } else {
      if (description !== undefined) addon.description = description;
      if (price !== undefined) addon.price = Number(price);
      if (icon !== undefined) addon.icon = icon;
      if (sortOrder !== undefined) addon.sortOrder = Number(sortOrder);
      if (isAvailable !== undefined) addon.isAvailable = Boolean(isAvailable);
    }

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

    if (req.user.role === "admin") {
      return res.status(403).json({
        success: false,
        message: "Cart admins can only hide/show add-ons",
      });
    }

    if (req.user.role === "franchise_admin") {
      if (
        !addon.franchiseId ||
        addon.franchiseId.toString() !== req.user._id.toString()
      ) {
        return res.status(403).json({
          success: false,
          message: "Not authorized to delete this add-on",
        });
      }
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
