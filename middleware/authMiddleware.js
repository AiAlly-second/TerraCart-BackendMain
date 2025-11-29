const jwt = require('jsonwebtoken');
const User = require('../models/userModel');

exports.protect = async (req, res, next) => {
  let token;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    try {
      // Get token from header
      token = req.headers.authorization.split(' ')[1];

      // Verify token
      const secret = process.env.JWT_SECRET || 'your-secret-key';
      const decoded = jwt.verify(token, secret);

      // Get user from token (always fetch fresh from DB to check current status)
      req.user = await User.findById(decoded.id).select('-password');

      if (!req.user) {
        return res.status(401).json({ 
          message: 'Not authorized, user not found',
          code: 'USER_NOT_FOUND'
        });
      }

      // Check if franchise admin is active
      if (req.user.role === "franchise_admin" && req.user.isActive === false) {
        return res.status(403).json({ 
          message: 'Your franchise account has been deactivated. Please contact TerraCart Support.',
          code: 'ACCOUNT_DEACTIVATED',
          deactivated: true
        });
      }

      // Check if cafe admin is approved and franchise is active
      if (req.user.role === "admin") {
        if (!req.user.isApproved) {
          return res.status(403).json({ 
            message: 'Your account is pending approval from franchise admin. Please wait for approval.',
            code: 'ACCOUNT_PENDING_APPROVAL',
            pendingApproval: true
          });
        }
        
        // Check if cafe is active
        if (req.user.isActive === false) {
          return res.status(403).json({ 
            message: 'Your cafe account has been deactivated. Please contact franchise admin.',
            code: 'CAFE_DEACTIVATED',
            deactivated: true
          });
        }
        
        // Check if the franchise is active
        if (req.user.franchiseId) {
          const franchise = await User.findById(req.user.franchiseId).select('isActive');
          if (franchise && franchise.isActive === false) {
            return res.status(403).json({ 
              message: 'Your franchise has been deactivated. Please contact super admin.',
              code: 'FRANCHISE_DEACTIVATED',
              deactivated: true
            });
          }
        }
      }

      return next();
    } catch (error) {
      // Handle specific JWT errors
      if (error.name === 'TokenExpiredError') {
        return res.status(401).json({ 
          message: 'Session expired. Please login again.',
          code: 'TOKEN_EXPIRED'
        });
      }
      if (error.name === 'JsonWebTokenError') {
        return res.status(401).json({ 
          message: 'Invalid token',
          code: 'TOKEN_INVALID'
        });
      }
      
      console.error('[AUTH] Token error:', error.message);
      return res.status(401).json({ 
        message: 'Not authorized',
        code: 'AUTH_ERROR'
      });
    }
  }

  // No token provided
  return res.status(401).json({ 
    message: 'Not authorized, no token',
    code: 'NO_TOKEN'
  });
};

exports.admin = async (req, res, next) => {
  if (req.user && ["super_admin", "franchise_admin", "admin"].includes(req.user.role)) {
    // For cafe admins, check if they're approved
    if (req.user.role === "admin" && !req.user.isApproved) {
      return res.status(403).json({ message: 'Cafe admin account pending approval' });
    }
    return next();
  } else {
    return res.status(403).json({ message: 'Not authorized as an admin' });
  }
};

exports.franchiseAdmin = async (req, res, next) => {
  if (req.user && ["super_admin", "franchise_admin"].includes(req.user.role)) {
    next();
  } else {
    res.status(403).json({ message: 'Not authorized as franchise admin' });
  }
};

exports.authorize = (allowedRoles = []) => (req, res, next) => {
  if (!Array.isArray(allowedRoles) || allowedRoles.length === 0) {
    return next();
  }

  if (!req.user) {
    return res.status(401).json({ message: 'Not authorized' });
  }

  const userRole = req.user.role || 'user';
  
  if (!allowedRoles.includes(userRole)) {
    return res.status(403).json({ 
      message: `Not authorized for this action. Required roles: ${allowedRoles.join(', ')}` 
    });
  }

  return next();
};
