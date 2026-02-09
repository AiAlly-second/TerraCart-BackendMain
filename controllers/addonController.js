const Addon = require("../models/addonModel");
const mongoose = require("mongoose");

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
        // Convert cartId string to ObjectId for proper matching
        filter.cartId = mongoose.Types.ObjectId.isValid(cartId) 
          ? new mongoose.Types.ObjectId(cartId) 
          : cartId;
      } else {
        filter.franchiseId = req.user._id;
      }
    } else if (req.user.role === "super_admin") {
      // Super admin - specific cart or all
      if (cartId) {
        // Convert cartId string to ObjectId for proper matching
        filter.cartId = mongoose.Types.ObjectId.isValid(cartId) 
          ? new mongoose.Types.ObjectId(cartId) 
          : cartId;
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
 * Accepts cartId OR tableId (when cart page is opened with ?table=xxx we resolve table -> cartId)
 */
exports.getPublicAddons = async (req, res) => {
  try {
    let cartId = typeof req.query.cartId === "string" ? req.query.cartId.trim() : (req.query.cartId && String(req.query.cartId).trim()) || "";
    const tableId = typeof req.query.tableId === "string" ? req.query.tableId.trim() : (req.query.tableId && String(req.query.tableId).trim()) || "";

    if (!cartId && tableId && mongoose.Types.ObjectId.isValid(tableId)) {
      try {
        const Table = require("../models/tableModel");
        const table = await Table.findById(tableId).select("cartId").lean();
        if (table && table.cartId) {
          cartId = table.cartId.toString();
          console.log("[ADDON_PUBLIC] Resolved tableId to cartId:", { tableId, cartId });
        }
      } catch (err) {
        console.warn("[ADDON_PUBLIC] Failed to resolve tableId:", err.message);
      }
    }

    if (!cartId) {
      return res.status(400).json({
        success: false,
        message: "cartId or tableId is required",
      });
    }

    let targetCartId = cartId; // Default to the query param
    const isValidObjectId = mongoose.Types.ObjectId.isValid(cartId);

    // STEP 0: Resolve cartId if it's a Cart Document ID (similar to menuController logic)
    if (isValidObjectId) {
      try {
        const Cart = require("../models/cartModel");
        // Try to find if this is a Cart document
        const cart = await Cart.findById(cartId).select("cartAdminId").lean();
        
        if (cart && cart.cartAdminId) {
          console.log("[ADDON_PUBLIC] Resolved cartId (Cart Document) to cartAdminId (User):", {
            originalParam: cartId,
            resolvedAdminId: cart.cartAdminId
          });
          targetCartId = cart.cartAdminId.toString();
        }
      } catch (err) {
        console.warn("[ADDON_PUBLIC] Warning: Failed to check Cart model:", err.message);
      }
    }

    // Convert resolved ID to ObjectId for proper matching
    let cartIdObj = null;
    let isValidTargetId = false;
    if (mongoose.Types.ObjectId.isValid(targetCartId)) {
      cartIdObj = new mongoose.Types.ObjectId(targetCartId);
      isValidTargetId = true;
    } else {
      console.warn("[ADDON_PUBLIC] Invalid ObjectId format for targetCartId:", targetCartId);
    }

    console.log("[ADDON_PUBLIC] ========================================");
    console.log("[ADDON_PUBLIC] Fetching addons for targetCartId:", targetCartId);
    console.log("[ADDON_PUBLIC] Original param cartId:", cartId);
    console.log("[ADDON_PUBLIC] ========================================");

    let addons = [];
    const User = require("../models/userModel");
    const Cart = require("../models/cartModel");

    // Build list of IDs to match: cart admin User _id + original cartId + Cart document _id (add-ons may be stored with any of these)
    const originalCartIdObj = mongoose.Types.ObjectId.isValid(cartId) ? new mongoose.Types.ObjectId(cartId) : null;
    const idsToMatch = [];
    if (cartIdObj) idsToMatch.push(cartIdObj);
    if (originalCartIdObj && (!cartIdObj || originalCartIdObj.toString() !== cartIdObj.toString())) {
      idsToMatch.push(originalCartIdObj);
    }
    // Include Cart document _id: table.cartId is User _id; Cart has cartAdminId = User _id; add-ons might be stored with Cart._id
    if (cartIdObj) {
      try {
        const cartDoc = await Cart.findOne({ cartAdminId: cartIdObj }).select("_id").lean();
        if (cartDoc && cartDoc._id) {
          const cartDocIdStr = cartDoc._id.toString();
          if (!idsToMatch.some((id) => id.toString() === cartDocIdStr)) {
            idsToMatch.push(cartDoc._id);
          }
        }
      } catch (_) {}
    }
    if (idsToMatch.length === 0 && originalCartIdObj) idsToMatch.push(originalCartIdObj);

    // STEP 1: Match add-ons by cartId = any of the ids we collected (User _id or Cart _id)
    if (idsToMatch.length > 0) {
      console.log("[ADDON_PUBLIC] STEP 1: Matching addons by cartId in:", idsToMatch.map((id) => id.toString()));
      addons = await Addon.find({
        cartId: idsToMatch.length === 1 ? idsToMatch[0] : { $in: idsToMatch },
        $or: [{ isAvailable: true }, { isAvailable: { $exists: false } }],
      }).sort({ sortOrder: 1, name: 1 }).lean();
      addons = addons.filter((a) => a.isAvailable !== false);
      console.log("[ADDON_PUBLIC] STEP 1 Result:", addons.length, "addons found");
    }

    // STEP 2: If no match, try with original cartId (string) - Mongoose may cast to ObjectId
    if (addons.length === 0 && cartId && mongoose.Types.ObjectId.isValid(cartId)) {
      const flexibleMatchAddons = await Addon.find({
        cartId: cartId,
        isAvailable: true,
      }).sort({ sortOrder: 1, name: 1 }).lean();
      if (flexibleMatchAddons.length > 0) {
        addons = flexibleMatchAddons;
        console.log("[ADDON_PUBLIC] STEP 2 Result:", addons.length, "addons found (by raw cartId)");
      }
    }

    // STEP 3: Fallback - find by cartId only (no isAvailable filter), then filter in code
    if (addons.length === 0 && idsToMatch.length > 0) {
      const anyMatch = await Addon.find({
        cartId: idsToMatch.length === 1 ? idsToMatch[0] : { $in: idsToMatch },
      }).sort({ sortOrder: 1, name: 1 }).lean();
      if (anyMatch.length > 0) {
        addons = anyMatch.filter((a) => a.isAvailable !== false);
        console.log("[ADDON_PUBLIC] STEP 3 Result:", addons.length, "addons (matched without isAvailable filter)");
      }
    }

    // STEP 3.5: FRANCHISE-LEVEL FALLBACK
    // If no cart-specific add-ons found, check if this cart belongs to a franchise
    // and fetch add-ons from all carts in the same franchise
    if (addons.length === 0 && cartIdObj) {
      try {
        console.log("[ADDON_PUBLIC] STEP 3.5: Checking for franchise-level add-ons...");
        
        // Get the cart admin's franchise ID
        const cartAdmin = await User.findById(cartIdObj).select("franchiseId").lean();
        
        if (cartAdmin && cartAdmin.franchiseId) {
          console.log("[ADDON_PUBLIC] Cart belongs to franchise:", cartAdmin.franchiseId.toString());
          
          // Find all cart admins in this franchise
          const franchiseAdmins = await User.find({
            franchiseId: cartAdmin.franchiseId,
            role: "admin"
          }).select("_id").lean();
          
          const franchiseAdminIds = franchiseAdmins.map(admin => admin._id);
          console.log("[ADDON_PUBLIC] Found", franchiseAdminIds.length, "cart admins in franchise");
          
          // Fetch add-ons from ANY cart in this franchise
          const franchiseAddons = await Addon.find({
            franchiseId: cartAdmin.franchiseId,
            $or: [{ isAvailable: true }, { isAvailable: { $exists: false } }],
          }).sort({ sortOrder: 1, name: 1 }).lean();
          
          if (franchiseAddons.length > 0) {
            addons = franchiseAddons.filter((a) => a.isAvailable !== false);
            console.log("[ADDON_PUBLIC] STEP 3.5 Result: Found", addons.length, "franchise-level add-ons");
          } else {
            console.log("[ADDON_PUBLIC] STEP 3.5 Result: No franchise-level add-ons found");
          }
        } else {
          console.log("[ADDON_PUBLIC] STEP 3.5: Cart admin has no franchise - skipping franchise lookup");
        }
      } catch (err) {
        console.warn("[ADDON_PUBLIC] STEP 3.5 Error:", err.message);
      }
    }


    // STEP 4: Comprehensive debugging - check what addons exist
    console.log("[ADDON_PUBLIC] STEP 4: Diagnostic check...");
    if (isValidTargetId) {
      const allAddonsForCart = await Addon.find({ cartId: cartIdObj });
      console.log("[ADDON_PUBLIC] Total addons with exact targetCartId (including unavailable):", allAddonsForCart.length);
      
      if (allAddonsForCart.length > 0) {
        console.log("[ADDON_PUBLIC] All addons for this cartId:", allAddonsForCart.map(a => ({
          name: a.name,
          isAvailable: a.isAvailable,
          cartId: a.cartId?.toString(),
          cartIdType: a.cartId?.constructor?.name,
          franchiseId: a.franchiseId?.toString(),
        })));
      }
    }

    // Check unavailable matches
    if (isValidTargetId) {
      const unavailableMatches = await Addon.find({
        cartId: cartIdObj,
        isAvailable: false,
      });
      if (unavailableMatches.length > 0) {
        console.log("[ADDON_PUBLIC] ⚠️ Found", unavailableMatches.length, "addons with matching cartId but isAvailable=false:", unavailableMatches.map(a => a.name));
      }
    }
    
    // STEP 5: Final diagnostic - if still no addons, show what exists in DB
    if (addons.length === 0) {
      console.log("[ADDON_PUBLIC] STEP 5: No addons found. Checking all addons in database...");
      const totalAddons = await Addon.countDocuments({});
      console.log("[ADDON_PUBLIC] Total addons in entire system:", totalAddons);
      
      if (totalAddons > 0 && totalAddons < 100) { // Limit logging if too many
        const sampleAddons = await Addon.find({}).limit(20).select("name cartId franchiseId isAvailable");
        console.log("[ADDON_PUBLIC] Sample of ALL addons in database:");
        sampleAddons.forEach((a, idx) => {
          const cartIdStr = a.cartId?.toString() || "null";
          const matches = cartIdStr === targetCartId || (cartIdObj && cartIdStr === cartIdObj.toString());
          console.log(`[ADDON_PUBLIC]   [${idx + 1}] "${a.name}" - cartId: ${cartIdStr}, franchiseId: ${a.franchiseId?.toString() || "null"}, available: ${a.isAvailable}, MATCHES: ${matches}`);
        });
      }
    }
    
    console.log("[ADDON_PUBLIC] ========================================");
    console.log("[ADDON_PUBLIC] FINAL RESULT: Returning", addons.length, "addons");
    if (addons.length > 0) {
      console.log("[ADDON_PUBLIC] Addons being returned:", addons.map(a => ({
        name: a.name,
        price: a.price,
        cartId: a.cartId?.toString(),
        franchiseId: a.franchiseId?.toString(),
      })));
    }
    console.log("[ADDON_PUBLIC] ========================================");

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
      console.log("[ADDON_CREATE] Cart admin creating addon with cartId:", req.user._id.toString(), "for addon:", name.trim());
      // Get franchiseId from user
      const User = require("../models/userModel");
      const cartAdmin = await User.findById(req.user._id);
      if (cartAdmin && cartAdmin.franchiseId) {
        addonData.franchiseId = cartAdmin.franchiseId;
        console.log("[ADDON_CREATE] Set franchiseId:", cartAdmin.franchiseId.toString());
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
