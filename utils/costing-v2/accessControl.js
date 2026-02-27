/**
 * Access Control Utilities for Costing v2
 * Handles role-based filtering for kiosk-level costing
 */

const mongoose = require("mongoose");
const User = require("../../models/userModel");
const Employee = require("../../models/employeeModel");

const resolveManagerCartId = async (user) => {
  if (!user) return null;

  if (user.cartId) return user.cartId;
  if (user.cafeId) return user.cafeId;

  if (user.employeeId) {
    const employee = await Employee.findById(user.employeeId)
      .select("cartId cafeId")
      .lean();
    if (employee?.cartId || employee?.cafeId) {
      return employee.cartId || employee.cafeId;
    }
  }

  const employee = await Employee.findOne({
    $or: [{ userId: user._id }, { email: user.email?.toLowerCase() }],
  })
    .select("cartId cafeId")
    .lean();

  return employee?.cartId || employee?.cafeId || null;
};

/**
 * Build query filter based on user role for costing data
 * @param {Object} user - Authenticated user from req.user
 * @param {Object} additionalFilter - Additional filters to merge
 * @returns {Object} MongoDB query filter
 */
const buildCostingQuery = async (user, additionalFilter = {}, options = {}) => {
  // Create a clean filter without undefined/null values
  const filter = {};
  Object.keys(additionalFilter).forEach((key) => {
    if (additionalFilter[key] !== undefined && additionalFilter[key] !== null) {
      filter[key] = additionalFilter[key];
    }
  });

  // Options:
  // - skipOutletFilter: for shared resources like ingredients
  // - includeShared: for franchise_admin to also see global (franchiseId=null) records
  const skipOutletFilter = options.skipOutletFilter || false;
  const includeShared = options.includeShared || false;

  if (user.role === "admin" || user.role === "manager") {
    // Cart/Kiosk admin and manager (manager is scoped to one cart)
    const userCartId =
      user.role === "admin" ? user._id : await resolveManagerCartId(user);

    if (!userCartId) {
      throw new Error("No cart associated with manager");
    }

    // Normalize cartId for strict comparisons
    const normalizedUserCartId = mongoose.Types.ObjectId.isValid(userCartId)
      ? new mongoose.Types.ObjectId(userCartId)
      : userCartId;

    // When includeShared is true (for global masters like Ingredients / BOM),
    // show ingredients with cartId = their cart OR cartId = null (shared)
    // Otherwise, only see their own kiosk's data
    if (includeShared) {
      // For cart-level users with includeShared, show:
      // 1. Ingredients with cartId = their cart (pushed ingredients)
      // 2. Ingredients with cartId = null (shared ingredients)
      if (!skipOutletFilter) {
        // For cart-level users, always include shared ingredients regardless of filter.cartId
        // Extract other filters (isActive, category, etc.) to combine with cartId filter
        const otherFilters = {};
        Object.keys(filter).forEach(key => {
          if (key !== 'cartId' && key !== 'franchiseId' && key !== '$or' && key !== '$and') {
            otherFilters[key] = filter[key];
          }
        });
        
        const cartIdConditions = [
          { cartId: normalizedUserCartId }, // Their own cart's ingredients
          { cartId: null }, // Shared ingredients
          { cartId: { $exists: false } }, // Legacy: ingredients without cartId field
        ];
        
        // Clear the filter object and rebuild it properly
        const newFilter = {};
        
        // If there are other filters, combine them with $and
        if (Object.keys(otherFilters).length > 0) {
          newFilter.$and = [
            { $or: cartIdConditions },
            otherFilters,
          ];
        } else {
          // No other filters, just use $or
          newFilter.$or = cartIdConditions;
        }
        
        // CRITICAL: Ensure the filter is properly structured
        // Replace filter with newFilter completely
        Object.keys(filter).forEach(key => delete filter[key]);
        Object.assign(filter, newFilter);
        
        // Additional validation: ensure cartId conditions are always included
        // This prevents edge cases where the filter might not include shared ingredients
        if (!filter.$or && !filter.$and) {
          // Fallback: if somehow the filter is empty, set it to cartId conditions
          filter.$or = cartIdConditions;
        }
        
        // Debug logging with actual ObjectId values
        // console.log(`[buildCostingQuery] Cart admin (${user._id}) - userCartId:`, userCartId);
        // console.log(`[buildCostingQuery] Cart admin (${user._id}) - userCartId type:`, userCartId.constructor.name);
        // console.log(`[buildCostingQuery] Cart admin (${user._id}) - otherFilters:`, JSON.stringify(otherFilters, null, 2));
        // console.log(`[buildCostingQuery] Cart admin (${user._id}) - cartIdConditions:`, [
        //   { cartId: userCartId.toString() },
        //   { cartId: null },
        //   { cartId: { $exists: false } }
        // ]);
        // console.log(`[buildCostingQuery] Cart admin (${user._id}) - final filter:`, JSON.stringify(filter, null, 2));
        
        // Also log the actual filter object (not JSON) to see ObjectIds
        // console.log(`[buildCostingQuery] Cart admin (${user._id}) - final filter (raw):`, filter);
      } else {
        // skipOutletFilter is true - include shared ingredients based on franchiseId
        if (user.franchiseId) {
          filter.$or = [
            { franchiseId: user.franchiseId },
            { franchiseId: null },
            { franchiseId: { $exists: false } },
          ];
        } else {
          filter.$or = [
            { franchiseId: null },
            { franchiseId: { $exists: false } },
          ];
        }
      }
    } else {
      // Normal behavior: only see their own cart's data
      if (!skipOutletFilter) {
        if (!filter.cartId) {
          // No cartId specified - auto-set to their own cart
          filter.cartId = normalizedUserCartId;
        } else {
          // cartId is specified - validate it's their own
          const providedCartId = filter.cartId.toString();
          const currentUserCartId = normalizedUserCartId.toString();
          if (providedCartId !== currentUserCartId) {
            // If cartId is specified and it's not their own, deny access
            throw new Error(
              "Access denied: You can only access your own cart's data"
            );
          }
          // It's their own, so keep it
          filter.cartId = normalizedUserCartId;
        }
      }
      // Also filter by franchiseId for safety (for models that have it)
      if (user.franchiseId && !skipOutletFilter) {
        filter.franchiseId = user.franchiseId;
      }
    }
  } else if (user.role === "franchise_admin") {
    // Franchise admin
    // Normal behavior: see only records for their own franchiseId
    // When includeShared is true (for global masters like Ingredients / BOM),
    // also include records where franchiseId is null / not set (global data defined by super admin)
    if (includeShared) {
      filter.$or = [
        { franchiseId: user._id },
        { franchiseId: null },
        { franchiseId: { $exists: false } },
      ];
    } else {
      filter.franchiseId = user._id;
    }
    // If cartId is specified in query, validate it belongs to their franchise
    if (additionalFilter.cartId) {
      const cart = await User.findById(additionalFilter.cartId);
      if (!cart || cart.franchiseId?.toString() !== user._id.toString()) {
        throw new Error(
          "Access denied: Cart does not belong to your franchise"
        );
      }
    }
  }
  // super_admin - no filter (can see everything)

  return filter;
};

/**
 * Get allowed outlet IDs for the user
 * @param {Object} user - Authenticated user
 * @returns {Promise<Array>} Array of outlet IDs the user can access
 */
const getAllowedOutlets = async (user) => {
  if (user.role === "admin") {
    // Cart admin - only their own kiosk
    return [user._id];
  } else if (user.role === "manager") {
    const managerCartId = await resolveManagerCartId(user);
    return managerCartId ? [managerCartId] : [];
  } else if (user.role === "franchise_admin") {
    // Franchise admin - all kiosks under their franchise
    const outlets = await User.find({
      role: "admin",
      franchiseId: user._id,
      isActive: true,
    }).select("_id name cafeName");
    return outlets.map((outlet) => outlet._id);
  } else if (user.role === "super_admin") {
    // Super admin - all kiosks
    const outlets = await User.find({
      role: "admin",
      isActive: true,
    }).select("_id name cafeName");
    return outlets.map((outlet) => outlet._id);
  }
  return [];
};

/**
 * Validate cart access for a user
 * @param {Object} user - Authenticated user
 * @param {String|ObjectId} cartId - Cart ID to validate
 * @returns {Promise<Boolean>} True if user has access
 */
const validateOutletAccess = async (user, cartId) => {
  if (!cartId) return false;

  if (user.role === "admin") {
    return user._id.toString() === cartId.toString();
  } else if (user.role === "manager") {
    const managerCartId = await resolveManagerCartId(user);
    return (
      managerCartId != null &&
      managerCartId.toString() === cartId.toString()
    );
  } else if (user.role === "franchise_admin") {
    const cart = await User.findById(cartId);
    return cart && cart.franchiseId?.toString() === user._id.toString();
  } else if (user.role === "super_admin") {
    return true;
  }
  return false;
};

/**
 * Auto-set cartId and franchiseId based on user role
 * @param {Object} user - Authenticated user
 * @param {Object} data - Data object to update
 * @param {Boolean} outletRequired - Whether cartId is required (default: true)
 * @returns {Promise<Object>} Updated data with cartId and franchiseId
 */
const setOutletContext = async (user, data = {}, outletRequired = true) => {
  if (user.role === "admin") {
    // Cart admin - always use their own cart
    data.cartId = user._id;
    if (user.franchiseId) {
      data.franchiseId = user.franchiseId;
    }
  } else if (user.role === "manager") {
    // Manager - always scoped to their assigned cart
    let managerCartId = await resolveManagerCartId(user);
    if (!managerCartId && data.cartId) {
      managerCartId = data.cartId;
    }
    if (!managerCartId) {
      throw new Error("No cart associated with manager");
    }
    data.cartId = managerCartId;

    if (!data.franchiseId) {
      if (user.franchiseId) {
        data.franchiseId = user.franchiseId;
      } else {
        const cart = await User.findById(managerCartId).select("franchiseId");
        if (cart?.franchiseId) {
          data.franchiseId = cart.franchiseId;
        }
      }
    }
  } else if (user.role === "franchise_admin") {
    // Franchise admin - must specify cartId (unless outletRequired is false)
    if (outletRequired && !data.cartId) {
      throw new Error("cartId is required");
    }
    if (data.cartId) {
      const hasAccess = await validateOutletAccess(user, data.cartId);
      if (!hasAccess) {
        throw new Error("Access denied: Invalid cart selection");
      }
      const cart = await User.findById(data.cartId);
      if (cart && cart.franchiseId) {
        data.franchiseId = cart.franchiseId;
      } else {
        data.franchiseId = user._id;
      }
    } else {
      // Optional cart - set franchiseId from user
      data.franchiseId = user._id;
    }
  } else if (user.role === "super_admin") {
    // Super admin - cartId is optional unless required
    // CRITICAL: If cartId is not provided, explicitly set it to null for shared ingredients
    if (outletRequired && !data.cartId) {
      throw new Error("cartId is required");
    }
    if (!data.cartId) {
      // Super admin creating shared/global ingredient - explicitly set cartId to null
      data.cartId = null;
    }
    if (data.cartId) {
      const cart = await User.findById(data.cartId);
      if (cart && cart.franchiseId) {
        data.franchiseId = cart.franchiseId;
      }
    }
  }

  return data;
};

module.exports = {
  buildCostingQuery,
  getAllowedOutlets,
  validateOutletAccess,
  setOutletContext,
};
