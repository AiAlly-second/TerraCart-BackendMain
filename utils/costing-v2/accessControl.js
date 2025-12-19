/**
 * Access Control Utilities for Costing v2
 * Handles role-based filtering for kiosk-level costing
 */

const User = require("../../models/userModel");

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

  if (user.role === "admin") {
    // Cart/Kiosk admin
    // When includeShared is true (for global masters like Ingredients / BOM),
    // also include records where franchiseId is null / not set (global data defined by super admin)
    // Otherwise, only see their own kiosk's data
    if (includeShared) {
      // Include global (franchiseId=null) + their own franchise data
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
      // For outletId, allow null (global/franchise-level) or their own outlet
      if (!skipOutletFilter) {
        if (!filter.outletId) {
          // Build $and condition: (franchiseId conditions) AND (outletId conditions)
          const franchiseConditions = filter.$or;
          const outletConditions = [
            { outletId: user._id },
            { outletId: null },
            { outletId: { $exists: false } },
          ];
          filter.$and = [
            { $or: franchiseConditions },
            { $or: outletConditions },
          ];
          delete filter.$or;
        }
      }
    } else {
      // Normal behavior: only see their own kiosk's data
      if (!skipOutletFilter) {
        if (!filter.outletId) {
          // No outletId specified - auto-set to their own kiosk
          filter.outletId = user._id;
        } else {
          // outletId is specified - validate it's their own
          const providedOutletId = filter.outletId.toString();
          const userOutletId = user._id.toString();
          if (providedOutletId !== userOutletId) {
            // If outletId is specified and it's not their own, deny access
            throw new Error(
              "Access denied: You can only access your own kiosk's data"
            );
          }
          // It's their own, so keep it
          filter.outletId = user._id;
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
    // If outletId is specified in query, validate it belongs to their franchise
    if (additionalFilter.outletId) {
      const outlet = await User.findById(additionalFilter.outletId);
      if (!outlet || outlet.franchiseId?.toString() !== user._id.toString()) {
        throw new Error(
          "Access denied: Kiosk does not belong to your franchise"
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
 * Validate outlet access for a user
 * @param {Object} user - Authenticated user
 * @param {String|ObjectId} outletId - Outlet ID to validate
 * @returns {Promise<Boolean>} True if user has access
 */
const validateOutletAccess = async (user, outletId) => {
  if (!outletId) return false;

  if (user.role === "admin") {
    return user._id.toString() === outletId.toString();
  } else if (user.role === "franchise_admin") {
    const outlet = await User.findById(outletId);
    return outlet && outlet.franchiseId?.toString() === user._id.toString();
  } else if (user.role === "super_admin") {
    return true;
  }
  return false;
};

/**
 * Auto-set outletId and franchiseId based on user role
 * @param {Object} user - Authenticated user
 * @param {Object} data - Data object to update
 * @param {Boolean} outletRequired - Whether outletId is required (default: true)
 * @returns {Promise<Object>} Updated data with outletId and franchiseId
 */
const setOutletContext = async (user, data = {}, outletRequired = true) => {
  if (user.role === "admin") {
    // Cart admin - always use their own kiosk
    data.outletId = user._id;
    if (user.franchiseId) {
      data.franchiseId = user.franchiseId;
    }
  } else if (user.role === "franchise_admin") {
    // Franchise admin - must specify outletId (unless outletRequired is false)
    if (outletRequired && !data.outletId) {
      throw new Error("outletId is required");
    }
    if (data.outletId) {
      const hasAccess = await validateOutletAccess(user, data.outletId);
      if (!hasAccess) {
        throw new Error("Access denied: Invalid kiosk selection");
      }
      const outlet = await User.findById(data.outletId);
      if (outlet && outlet.franchiseId) {
        data.franchiseId = outlet.franchiseId;
      } else {
        data.franchiseId = user._id;
      }
    } else {
      // Optional outlet - set franchiseId from user
      data.franchiseId = user._id;
    }
  } else if (user.role === "super_admin") {
    // Super admin - outletId is optional unless required
    if (outletRequired && !data.outletId) {
      throw new Error("outletId is required");
    }
    if (data.outletId) {
      const outlet = await User.findById(data.outletId);
      if (outlet && outlet.franchiseId) {
        data.franchiseId = outlet.franchiseId;
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
