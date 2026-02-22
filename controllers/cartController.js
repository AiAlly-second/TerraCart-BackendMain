const Cart = require("../models/cartModel");
const User = require("../models/userModel");
const Franchise = require("../models/franchiseModel");
const mongoose = require("mongoose");
const { isWithinDeliveryRange, calculateDistance } = require("../utils/distanceCalculator");

function pickFirstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function resolveCartDisplayName(cart) {
  return (
    pickFirstNonEmptyString(
      cart?.cartAdminId?.cartName,
      cart?.name,
      cart?.cartAdminId?.cafeName,
      cart?.cartAdminId?.name
    ) || "Cart"
  );
}

function resolvePrimaryEmergencyContact(cartAdmin) {
  if (!Array.isArray(cartAdmin?.emergencyContacts)) return null;
  return (
    cartAdmin.emergencyContacts.find((entry) => entry?.isPrimary) ||
    cartAdmin.emergencyContacts[0] ||
    null
  );
}

function resolveHelplineNumber(cartAdmin) {
  const primaryContact = resolvePrimaryEmergencyContact(cartAdmin);
  return pickFirstNonEmptyString(
    cartAdmin?.managerHelplineNumber,
    cartAdmin?.phone,
    primaryContact?.phone
  );
}

/**
 * Get nearby carts based on customer location
 * @route GET /api/carts/nearby
 * @access Public (for customer frontend)
 */
exports.getNearbyCarts = async (req, res) => {
  try {
    const { latitude, longitude, orderType, pinCode } = req.query;

    // For DELIVERY, allow pin code as alternative to coordinates
    if (orderType === "DELIVERY" && pinCode) {
      // Filter carts by pin code match
      const trimmedPinCode = pinCode.trim();
      const carts = await Cart.find({
        $and: [
          {
            $or: [
              { isActive: true },
              { isActive: { $exists: false } }
            ]
          },
          {
            $or: [
              { pinCode: trimmedPinCode },
              { "address.zipCode": trimmedPinCode }
            ]
          }
        ]
      })
        .populate("cartAdminId", "name cartName cafeName email isActive phone managerHelplineNumber emergencyContacts")
        .populate("franchiseId", "name")
        .lean();

      const cartsWithActiveAdmin = carts.filter(
        (c) => c.cartAdminId && c.cartAdminId.isActive !== false
      );
      console.log(`[CART] Found ${cartsWithActiveAdmin.length} carts matching pin code: ${pinCode} (excluded deleted/inactive admin)`);

      const nearbyCarts = [];

      for (const cart of cartsWithActiveAdmin) {
        const pickupEnabled = cart.pickupEnabled !== undefined ? cart.pickupEnabled : true;
        const deliveryEnabled = cart.deliveryEnabled !== undefined ? cart.deliveryEnabled : false;
        const resolvedName = resolveCartDisplayName(cart);

        // Only include carts with delivery enabled
        if (deliveryEnabled) {
          const helplineNumber = resolveHelplineNumber(cart.cartAdminId);
          const primaryEmergencyContact = resolvePrimaryEmergencyContact(
            cart.cartAdminId
          );
          nearbyCarts.push({
            ...cart,
            name: resolvedName,
            helplineNumber,
            managerHelplineNumber:
              cart.cartAdminId?.managerHelplineNumber || helplineNumber || null,
            primaryEmergencyContact,
            distance: null, // Distance not calculated for pin code match
            canDeliver: true, // Assume can deliver if pin code matches
            canPickup: pickupEnabled,
            deliveryInfo: {
              distance: null,
              deliveryCharge: cart.deliveryCharge || 0,
              estimatedTime: null,
            },
            pickupEnabled: pickupEnabled,
            deliveryEnabled: deliveryEnabled,
            pinCodeMatch: true, // Flag to indicate this was matched by pin code
          });
        }
      }

      return res.json({
        success: true,
        data: nearbyCarts,
        count: nearbyCarts.length,
      });
    }

    // Validate coordinates for coordinate-based search
    if (!latitude || !longitude) {
      return res.status(400).json({
        success: false,
        message: "Latitude and longitude are required, or provide pin code for delivery",
      });
    }

    const customerLat = parseFloat(latitude);
    const customerLon = parseFloat(longitude);

    if (isNaN(customerLat) || isNaN(customerLon)) {
      return res.status(400).json({
        success: false,
        message: "Invalid coordinates",
      });
    }

    // Get all active carts (exclude deleted/inactive: cart isActive and cart admin user must be active)
    const carts = await Cart.find({
      $or: [
        { isActive: true },
        { isActive: { $exists: false } }
      ]
    })
      .populate("cartAdminId", "name cartName cafeName email isActive phone managerHelplineNumber emergencyContacts")
      .populate("franchiseId", "name")
      .lean();

    const cartsWithActiveAdmin = carts.filter(
      (c) => c.cartAdminId && c.cartAdminId.isActive !== false
    );
    console.log(`[CART] Found ${cartsWithActiveAdmin.length} active carts (${carts.length - cartsWithActiveAdmin.length} excluded: deleted/inactive admin)`);

    const nearbyCarts = [];

    for (const cart of cartsWithActiveAdmin) {
      const resolvedName = resolveCartDisplayName(cart);
      // Handle existing carts that don't have new fields - use defaults
      const pickupEnabled = cart.pickupEnabled !== undefined ? cart.pickupEnabled : true; // Default true for existing carts
      const deliveryEnabled = cart.deliveryEnabled !== undefined ? cart.deliveryEnabled : false; // Default false
      const deliveryRadius = cart.deliveryRadius || 5;
      const deliveryCharge = cart.deliveryCharge || 0;

      // Check if cart has coordinates
      if (!cart.coordinates?.latitude || !cart.coordinates?.longitude) {
        // If no coordinates, skip distance calculation but include if pickup is enabled
        if (orderType === "PICKUP" && pickupEnabled) {
          const helplineNumber = resolveHelplineNumber(cart.cartAdminId);
          const primaryEmergencyContact = resolvePrimaryEmergencyContact(
            cart.cartAdminId
          );
          nearbyCarts.push({
            ...cart,
            name: resolvedName,
            helplineNumber,
            managerHelplineNumber:
              cart.cartAdminId?.managerHelplineNumber || helplineNumber || null,
            primaryEmergencyContact,
            distance: null,
            canDeliver: false,
            canPickup: true,
            deliveryInfo: null,
            pickupEnabled: pickupEnabled,
            deliveryEnabled: deliveryEnabled,
          });
        }
        continue;
      }

      const cartLat = cart.coordinates.latitude;
      const cartLon = cart.coordinates.longitude;
      const distance = calculateDistance(customerLat, customerLon, cartLat, cartLon);

      // Check delivery eligibility
      let canDeliver = false;
      let deliveryInfo = null;

      if (orderType === "DELIVERY" && deliveryEnabled) {
        const rangeCheck = isWithinDeliveryRange(
          customerLat,
          customerLon,
          cartLat,
          cartLon,
          deliveryRadius
        );

        canDeliver = rangeCheck.isWithinRange;
        if (canDeliver) {
          deliveryInfo = {
            distance: rangeCheck.distance,
            deliveryCharge: deliveryCharge,
            estimatedTime: Math.ceil(rangeCheck.distance * 2), // Rough estimate: 2 min per km
          };
        }
      }

      // Pickup is always allowed if enabled (regardless of distance)
      const canPickup = pickupEnabled;

      // Include cart if:
      // - Pickup is requested and pickup is enabled
      // - Delivery is requested and delivery is enabled and within range
      if (
        (orderType === "PICKUP" && canPickup) ||
        (orderType === "DELIVERY" && canDeliver)
      ) {
        const helplineNumber = resolveHelplineNumber(cart.cartAdminId);
        const primaryEmergencyContact = resolvePrimaryEmergencyContact(
          cart.cartAdminId
        );
        nearbyCarts.push({
          ...cart,
          name: resolvedName,
          helplineNumber,
          managerHelplineNumber:
            cart.cartAdminId?.managerHelplineNumber || helplineNumber || null,
          primaryEmergencyContact,
          distance: distance,
          canDeliver,
          canPickup,
          deliveryInfo,
          pickupEnabled: pickupEnabled,
          deliveryEnabled: deliveryEnabled,
        });
      }
    }

    // Sort by distance (ascending)
    nearbyCarts.sort((a, b) => {
      if (a.distance === null) return 1;
      if (b.distance === null) return -1;
      return a.distance - b.distance;
    });

    res.json({
      success: true,
      data: nearbyCarts,
      count: nearbyCarts.length,
    });
  } catch (error) {
    console.error("[CART] Error getting nearby carts:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to get nearby carts",
    });
  }
};

/**
 * Get cart by ID with delivery/pickup info
 * @route GET /api/carts/:id
 * @access Public (for customer frontend)
 */
exports.getCartById = async (req, res) => {
  try {
    const { id } = req.params;
    const { latitude, longitude, orderType } = req.query;

    const cart = await Cart.findById(id)
      .populate("cartAdminId", "name cartName cafeName email isActive phone managerHelplineNumber emergencyContacts")
      .populate("franchiseId", "name")
      .lean();

    if (!cart) {
      return res.status(404).json({
        success: false,
        message: "Cart not found",
      });
    }

    if (!cart.cartAdminId || cart.cartAdminId.isActive === false) {
      return res.status(404).json({
        success: false,
        message: "Cart not found",
      });
    }

    let distance = null;
    let canDeliver = false;
    let deliveryInfo = null;

    // Calculate distance if coordinates provided
    if (
      latitude &&
      longitude &&
      cart.coordinates?.latitude &&
      cart.coordinates?.longitude
    ) {
      const customerLat = parseFloat(latitude);
      const customerLon = parseFloat(longitude);
      const cartLat = cart.coordinates.latitude;
      const cartLon = cart.coordinates.longitude;

      if (!isNaN(customerLat) && !isNaN(customerLon)) {
        distance = calculateDistance(customerLat, customerLon, cartLat, cartLon);

        // Check delivery eligibility
        if (orderType === "DELIVERY" && cart.deliveryEnabled) {
          const rangeCheck = isWithinDeliveryRange(
            customerLat,
            customerLon,
            cartLat,
            cartLon,
            cart.deliveryRadius || 5
          );

          canDeliver = rangeCheck.isWithinRange;
          if (canDeliver) {
            deliveryInfo = {
              distance: rangeCheck.distance,
              deliveryCharge: cart.deliveryCharge || 0,
              estimatedTime: Math.ceil(rangeCheck.distance * 2),
            };
          }
        }
      }
    }

    res.json({
      success: true,
      data: {
        ...cart,
        name: resolveCartDisplayName(cart),
        helplineNumber: resolveHelplineNumber(cart.cartAdminId),
        managerHelplineNumber:
          cart.cartAdminId?.managerHelplineNumber ||
          resolveHelplineNumber(cart.cartAdminId) ||
          null,
        primaryEmergencyContact: resolvePrimaryEmergencyContact(cart.cartAdminId),
        distance,
        canDeliver,
        canPickup: cart.pickupEnabled !== undefined ? cart.pickupEnabled : true,
        deliveryInfo,
      },
    });
  } catch (error) {
    console.error("[CART] Error getting cart:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to get cart",
    });
  }
};

/**
 * Update cart settings (pickup/delivery configuration)
 * @route PUT /api/carts/my-settings
 * @access Protected (cart admin can update their own cart)
 */
exports.updateCartSettings = async (req, res) => {
  try {
    if (req.user.role !== "admin" && req.user.role !== "cart_admin") {
      return res.status(403).json({
        success: false,
        message: "Only cart admins can update cart settings",
      });
    }

    const {
      pickupEnabled,
      deliveryEnabled,
      deliveryRadius,
      deliveryCharge,
      pinCode,
      address,
      coordinates,
      contactPhone,
      contactEmail,
    } = req.body;

    // Find cart by cartAdminId (cart admin can only update their own cart)
    let cart = await Cart.findOne({ cartAdminId: req.user._id });

    // If cart doesn't exist, create one
    if (!cart) {
      console.log(`[CART] Cart not found for user ${req.user._id}, creating new cart`);
      
      // Get user's franchiseId
      const User = require("../models/userModel");
      const user = await User.findById(req.user._id).lean();
      
      if (!user || !user.franchiseId) {
        return res.status(400).json({
          success: false,
          message: "User is not associated with a franchise. Please contact support.",
        });
      }

      // Create new cart
      const newCart = await Cart.create({
        name: user.cartName || user.name || "Cart",
        franchiseId: user.franchiseId,
        cartAdminId: req.user._id,
        location: user.location || "",
        pickupEnabled: true,
        deliveryEnabled: false,
        deliveryRadius: 5,
        deliveryCharge: 0,
        isActive: true,
      });

      cart = newCart;
    }

    // Update settings
    const updateData = {};
    if (pickupEnabled !== undefined) updateData.pickupEnabled = pickupEnabled;
    if (deliveryEnabled !== undefined) updateData.deliveryEnabled = deliveryEnabled;
    if (deliveryRadius !== undefined) updateData.deliveryRadius = deliveryRadius;
    if (deliveryCharge !== undefined) updateData.deliveryCharge = deliveryCharge;
    if (pinCode !== undefined) updateData.pinCode = pinCode;
    if (address !== undefined) updateData.address = address;
    if (coordinates !== undefined) updateData.coordinates = coordinates;
    if (contactPhone !== undefined) updateData.contactPhone = contactPhone ? String(contactPhone).trim() : null;
    if (contactEmail !== undefined) updateData.contactEmail = contactEmail ? String(contactEmail).trim() : null;

    await Cart.findByIdAndUpdate(cart._id, { $set: updateData }, { new: true });

    const updatedCart = await Cart.findById(cart._id)
      .populate("cartAdminId", "name cartName cafeName email phone managerHelplineNumber emergencyContacts")
      .populate("franchiseId", "name")
      .lean();

    if (updatedCart) {
      updatedCart.name = resolveCartDisplayName(updatedCart);
    }

    res.json({
      success: true,
      data: updatedCart,
      message: "Cart settings updated successfully",
    });
  } catch (error) {
    console.error("[CART] Error updating cart settings:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to update cart settings",
    });
  }
};

/**
 * Get all available carts (without location requirement)
 * @route GET /api/carts/available
 * @access Public (for customer frontend)
 */
exports.getAvailableCarts = async (req, res) => {
  try {
    const { orderType } = req.query;

    // Get all active carts (exclude deleted/inactive: cart admin user must exist and be active)
    const carts = await Cart.find({
      $or: [
        { isActive: true },
        { isActive: { $exists: false } }
      ]
    })
      .populate("cartAdminId", "name cartName cafeName email isActive phone managerHelplineNumber emergencyContacts")
      .populate("franchiseId", "name")
      .lean();

    const cartsWithActiveAdmin = carts.filter(
      (c) => c.cartAdminId && c.cartAdminId.isActive !== false
    );
    console.log(`[CART] Found ${cartsWithActiveAdmin.length} available carts (${carts.length - cartsWithActiveAdmin.length} excluded: deleted/inactive admin)`);

    const availableCarts = [];

    for (const cart of cartsWithActiveAdmin) {
      const resolvedName = resolveCartDisplayName(cart);
      // Handle existing carts that don't have new fields - use defaults
      const pickupEnabled = cart.pickupEnabled !== undefined ? cart.pickupEnabled : true;
      const deliveryEnabled = cart.deliveryEnabled !== undefined ? cart.deliveryEnabled : false;

      // Include cart if:
      // - Pickup is requested and pickup is enabled
      // - Delivery is requested and delivery is enabled
      if (
        (orderType === "PICKUP" && pickupEnabled) ||
        (orderType === "DELIVERY" && deliveryEnabled) ||
        !orderType // If no orderType specified, include all
      ) {
        const helplineNumber = resolveHelplineNumber(cart.cartAdminId);
        const primaryEmergencyContact = resolvePrimaryEmergencyContact(
          cart.cartAdminId
        );
        availableCarts.push({
          ...cart,
          name: resolvedName,
          helplineNumber,
          managerHelplineNumber:
            cart.cartAdminId?.managerHelplineNumber || helplineNumber || null,
          primaryEmergencyContact,
          distance: null, // Will be calculated when location is available
          canDeliver: deliveryEnabled,
          canPickup: pickupEnabled,
          deliveryInfo: null, // Will be calculated when location is available
          pickupEnabled: pickupEnabled,
          deliveryEnabled: deliveryEnabled,
        });
      }
    }

    res.json({
      success: true,
      data: availableCarts,
      count: availableCarts.length,
    });
  } catch (error) {
    console.error("[CART] Error getting available carts:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to get available carts",
    });
  }
};

/**
 * Get cart settings for current cart admin
 * @route GET /api/carts/my-settings
 * @access Protected (cart admin only)
 */
exports.getMyCartSettings = async (req, res) => {
  try {
    if (req.user.role !== "admin" && req.user.role !== "cart_admin") {
      return res.status(403).json({
        success: false,
        message: "Only cart admins can access this endpoint",
      });
    }

    // Find cart by cartAdminId
    let cart = await Cart.findOne({ cartAdminId: req.user._id })
      .populate("cartAdminId", "name cartName cafeName email phone managerHelplineNumber emergencyContacts")
      .populate("franchiseId", "name")
      .lean();

    // If cart doesn't exist, create one
    if (!cart) {
      console.log(`[CART] Cart not found for user ${req.user._id}, creating new cart`);
      
      // Get user's franchiseId
      const User = require("../models/userModel");
      const user = await User.findById(req.user._id).lean();
      
      if (!user || !user.franchiseId) {
        return res.status(400).json({
          success: false,
          message: "User is not associated with a franchise. Please contact support.",
        });
      }

      // Create new cart
      const newCart = await Cart.create({
        name: user.cartName || user.name || "Cart",
        franchiseId: user.franchiseId,
        cartAdminId: req.user._id,
        location: user.location || "",
        pickupEnabled: true,
        deliveryEnabled: false,
        deliveryRadius: 5,
        deliveryCharge: 0,
        isActive: true,
      });

      // Populate and return
      cart = await Cart.findById(newCart._id)
        .populate("cartAdminId", "name cartName cafeName email phone managerHelplineNumber emergencyContacts")
        .populate("franchiseId", "name")
        .lean();
    }

    if (cart) {
      cart.name = resolveCartDisplayName(cart);
    }

    res.json({
      success: true,
      data: cart,
    });
  } catch (error) {
    console.error("[CART] Error getting cart settings:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to get cart settings",
    });
  }
};

/**
 * Get cart by cart admin user ID (for invoice address etc.)
 * @route GET /api/carts/by-admin/:userId
 * @access Protected - cart admin (own cart), franchise admin (carts in franchise), super_admin (any)
 */
exports.getCartByAdminId = async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "User ID is required",
      });
    }

    const cart = await Cart.findOne({ cartAdminId: userId })
      .select("name location address coordinates pickupEnabled deliveryEnabled deliveryRadius deliveryCharge contactPhone contactEmail")
      .populate("cartAdminId", "name cartName cafeName email")
      .populate("franchiseId", "name")
      .lean();

    if (!cart) {
      return res.status(404).json({
        success: false,
        message: "Cart not found for this user",
      });
    }

    // Authorization: same user (cart admin), franchise admin of this cart, or super_admin
    const requestUserId = req.user?._id?.toString();
    const targetUserId = userId.toString?.() ? userId.toString() : String(userId);

    if (req.user?.role === "super_admin") {
      // allow
    } else if (req.user?.role === "franchise_admin") {
      const cartFranchiseId = cart.franchiseId?._id?.toString() || cart.franchiseId?.toString();
      if (!cartFranchiseId || cartFranchiseId !== requestUserId) {
        return res.status(403).json({
          success: false,
          message: "Access denied. Cart does not belong to your franchise.",
        });
      }
    } else if (req.user?.role === "admin" || req.user?.role === "cart_admin") {
      if (requestUserId !== targetUserId) {
        return res.status(403).json({
          success: false,
          message: "Access denied. You can only view your own cart.",
        });
      }
    } else {
      return res.status(403).json({
        success: false,
        message: "Access denied.",
      });
    }

    // Resolve display address from Cart (same as order invoice)
    const addressStr =
      (cart.address && (cart.address.fullAddress || [cart.address.street, cart.address.city, cart.address.state, cart.address.zipCode].filter(Boolean).join(", "))) ||
      cart.location ||
      null;

    res.json({
      success: true,
      data: {
        ...cart,
        name: resolveCartDisplayName(cart),
        address: addressStr || undefined,
        location: cart.location || undefined,
      },
    });
  } catch (error) {
    console.error("[CART] Error getting cart by admin id:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to get cart",
    });
  }
};

/**
 * Get cart contact info for customer (Contact us on menu page)
 * @route GET /api/carts/public-contact?cartId=...
 * @access Public - cartId can be cart document _id OR cart admin user _id
 */
exports.getCartContactPublic = async (req, res) => {
  try {
    const cartRef = typeof req.query.cartId === "string" ? req.query.cartId.trim() : "";
    if (!cartRef) {
      return res.json({ success: true, data: null });
    }

    if (!mongoose.Types.ObjectId.isValid(cartRef)) {
      return res.json({ success: true, data: null });
    }

    // Support both:
    // 1) cart document id
    // 2) cart admin user id (used by table/cart context in many customer flows)
    let cart = await Cart.findById(cartRef)
      .select("name contactPhone contactEmail cartAdminId")
      .lean();

    if (!cart) {
      cart = await Cart.findOne({ cartAdminId: cartRef })
        .select("name contactPhone contactEmail cartAdminId")
        .lean();
    }

    if (!cart) {
      return res.json({ success: true, data: null });
    }

    let fallbackUser = null;
    if (cart.cartAdminId) {
      fallbackUser = await User.findById(cart.cartAdminId)
        .select("name cartName phone email")
        .lean();
    }

    const name = resolveCartDisplayName({
      ...cart,
      cartAdminId: fallbackUser || cart.cartAdminId,
    });

    res.json({
      success: true,
      data: {
        name,
        contactPhone: cart.contactPhone || fallbackUser?.phone || null,
        contactEmail: cart.contactEmail || fallbackUser?.email || null,
      },
    });
  } catch (error) {
    console.error("[CART] Error getting public cart contact:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to get contact",
    });
  }
};
