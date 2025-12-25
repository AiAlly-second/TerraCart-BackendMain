const Cart = require("../models/cartModel");
const User = require("../models/userModel");
const Franchise = require("../models/franchiseModel");
const { isWithinDeliveryRange, calculateDistance } = require("../utils/distanceCalculator");

/**
 * Get nearby carts based on customer location
 * @route GET /api/carts/nearby
 * @access Public (for customer frontend)
 */
exports.getNearbyCarts = async (req, res) => {
  try {
    const { latitude, longitude, orderType } = req.query;

    // Validate coordinates
    if (!latitude || !longitude) {
      return res.status(400).json({
        success: false,
        message: "Latitude and longitude are required",
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

    // Get all active carts
    // Also include carts where isActive is not set (for backward compatibility)
    const carts = await Cart.find({
      $or: [
        { isActive: true },
        { isActive: { $exists: false } } // Include carts without isActive field
      ]
    })
      .populate("cartAdminId", "name cafeName email")
      .populate("franchiseId", "name")
      .lean();

    console.log(`[CART] Found ${carts.length} active carts`);

    const nearbyCarts = [];

    for (const cart of carts) {
      // Handle existing carts that don't have new fields - use defaults
      const pickupEnabled = cart.pickupEnabled !== undefined ? cart.pickupEnabled : true; // Default true for existing carts
      const deliveryEnabled = cart.deliveryEnabled !== undefined ? cart.deliveryEnabled : false; // Default false
      const deliveryRadius = cart.deliveryRadius || 5;
      const deliveryCharge = cart.deliveryCharge || 0;

      // Check if cart has coordinates
      if (!cart.coordinates?.latitude || !cart.coordinates?.longitude) {
        // If no coordinates, skip distance calculation but include if pickup is enabled
        if (orderType === "PICKUP" && pickupEnabled) {
          nearbyCarts.push({
            ...cart,
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
        nearbyCarts.push({
          ...cart,
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
      .populate("cartAdminId", "name cafeName email")
      .populate("franchiseId", "name")
      .lean();

    if (!cart) {
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
        distance,
        canDeliver,
        canPickup: cart.pickupEnabled,
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
      address,
      coordinates,
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
    if (address !== undefined) updateData.address = address;
    if (coordinates !== undefined) updateData.coordinates = coordinates;

    await Cart.findByIdAndUpdate(cart._id, { $set: updateData }, { new: true });

    const updatedCart = await Cart.findById(cart._id)
      .populate("cartAdminId", "name cafeName email")
      .populate("franchiseId", "name")
      .lean();

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
      .populate("cartAdminId", "name cafeName email")
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
        .populate("cartAdminId", "name cafeName email")
        .populate("franchiseId", "name")
        .lean();
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

