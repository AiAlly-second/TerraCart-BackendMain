/**
 * Costing Permission Middleware
 * Checks if costing feature is enabled and user has permission
 */

exports.checkCostingPermission = (req, res, next) => {
  // Check if costing feature is enabled
  const featureEnabled = process.env.FEATURE_COSTING_ENABLED === 'true';
  
  if (!featureEnabled) {
    return res.status(403).json({
      success: false,
      message: 'Costing feature is not enabled',
      code: 'FEATURE_DISABLED'
    });
  }

  // Check if user has permission (super_admin or view_costing permission)
  if (!req.user) {
    return res.status(401).json({
      success: false,
      message: 'Not authenticated',
      code: 'NOT_AUTHENTICATED'
    });
  }

  // Super admin, Franchise Admin, and Cart Admin have access
  if (['super_admin', 'franchise_admin', 'admin', 'cart_admin'].includes(req.user.role)) {
    return next();
  }

  // Check for view_costing permission (if permissions system exists)
  if (req.user.permissions && req.user.permissions.includes('view_costing')) {
    return next();
  }

  return res.status(403).json({
    success: false,
    message: 'Not authorized to access costing features',
    code: 'INSUFFICIENT_PERMISSIONS'
  });
};

















