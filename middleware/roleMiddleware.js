/**
 * Enhanced Role Middleware
 * Provides more granular role checks and permission-based access control
 */

const { authorize } = require("./authMiddleware");

/**
 * Map Flutter app roles to backend roles
 */
const ROLE_MAPPING = {
  staff: ["waiter", "cashier", "cleaner"],
  cook: ["chef", "cook"],
  manager: ["manager", "admin"],
};

/**
 * Check if user has any of the specified roles
 * @param {Array} allowedRoles - Array of allowed roles
 * @returns {Function} - Express middleware
 */
exports.hasAnyRole = (allowedRoles = []) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: "Not authenticated",
      });
    }

    const userRole = req.user.role;

    // Check direct role match
    if (allowedRoles.includes(userRole)) {
      return next();
    }

    // Check mapped roles (for Flutter app compatibility)
    for (const [flutterRole, backendRoles] of Object.entries(ROLE_MAPPING)) {
      if (allowedRoles.includes(flutterRole) && backendRoles.includes(userRole)) {
        return next();
      }
    }

    return res.status(403).json({
      success: false,
      message: `Access denied. Required roles: ${allowedRoles.join(", ")}`,
    });
  };
};

/**
 * Check if user has all of the specified roles (for future use)
 * @param {Array} requiredRoles - Array of required roles
 * @returns {Function} - Express middleware
 */
exports.hasAllRoles = (requiredRoles = []) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: "Not authenticated",
      });
    }

    const userRole = req.user.role;

    // For now, just check if user has one of the roles
    // This can be enhanced later for multi-role requirements
    if (requiredRoles.includes(userRole)) {
      return next();
    }

    return res.status(403).json({
      success: false,
      message: `Access denied. Required roles: ${requiredRoles.join(", ")}`,
    });
  };
};

/**
 * Permission-based access control
 * Maps permissions to roles
 */
const PERMISSIONS = {
  // Order permissions
  "orders:view": ["waiter", "cashier", "chef", "cook", "manager", "admin", "franchise_admin", "super_admin"],
  "orders:create": ["waiter", "cashier", "manager", "admin"],
  "orders:update": ["waiter", "cashier", "manager", "admin"],
  "orders:delete": ["manager", "admin", "franchise_admin", "super_admin"],
  "orders:finalize": ["manager", "admin"],

  // Table permissions
  "tables:view": ["waiter", "cashier", "manager", "admin"],
  "tables:create": ["manager", "admin"],
  "tables:update": ["waiter", "cashier", "manager", "admin"],
  "tables:delete": ["manager", "admin"],
  "tables:merge": ["manager", "admin"],

  // KOT permissions
  "kot:view": ["chef", "cook", "manager", "admin"],
  "kot:update": ["chef", "cook", "manager", "admin"],

  // Inventory permissions
  "inventory:view": ["chef", "cook", "manager", "admin"],
  "inventory:create": ["manager", "admin"],
  "inventory:update": ["manager", "admin"],
  "inventory:delete": ["manager", "admin"],

  // Task permissions
  "tasks:view": ["waiter", "cashier", "cleaner", "chef", "cook", "manager", "admin"],
  "tasks:create": ["manager", "admin"],
  "tasks:update": ["waiter", "cashier", "cleaner", "chef", "cook", "manager", "admin"],
  "tasks:delete": ["manager", "admin"],

  // Request permissions
  "requests:view": ["waiter", "cashier", "manager", "admin"],
  "requests:create": ["waiter", "cashier", "manager", "admin"],
  "requests:resolve": ["waiter", "cashier", "manager", "admin"],
  "requests:delete": ["manager", "admin"],

  // Compliance permissions
  "compliance:view": ["manager", "admin"],
  "compliance:create": ["manager", "admin"],
  "compliance:update": ["manager", "admin"],
  "compliance:delete": ["manager", "admin"],
};

/**
 * Check if user has specific permission
 * @param {String} permission - Permission to check
 * @returns {Function} - Express middleware
 */
exports.hasPermission = (permission) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: "Not authenticated",
      });
    }

    const userRole = req.user.role;
    const allowedRoles = PERMISSIONS[permission] || [];

    if (allowedRoles.includes(userRole)) {
      return next();
    }

    // Check mapped roles
    for (const [flutterRole, backendRoles] of Object.entries(ROLE_MAPPING)) {
      if (allowedRoles.includes(flutterRole) && backendRoles.includes(userRole)) {
        return next();
      }
    }

    return res.status(403).json({
      success: false,
      message: `Access denied. Required permission: ${permission}`,
    });
  };
};

module.exports = exports;

