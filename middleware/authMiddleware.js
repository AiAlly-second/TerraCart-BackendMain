const jwt = require('jsonwebtoken');
const User = require('../models/userModel');
const Employee = require('../models/employeeModel');

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

      // For mobile app users, populate cafeId and employeeId if not already set
      if (["waiter", "cook", "captain", "manager", "employee"].includes(req.user.role)) {
        // If cafeId is not set, try to get it from employeeId or Employee lookup
        if (!req.user.cafeId || !req.user.employeeId) {
          let employee = null;
          
          // Try to find employee by userId first (new relationship)
          if (req.user.employeeId) {
            employee = await Employee.findById(req.user.employeeId).lean();
          } else {
            // Fallback: find by userId field in Employee model
            employee = await Employee.findOne({ userId: req.user._id }).lean();
            
            // If still not found, try email matching (legacy)
            if (!employee && req.user.email) {
              employee = await Employee.findOne({ email: req.user.email.toLowerCase() }).lean();
            }
          }
          
          if (employee) {
            // Populate cafeId and employeeId on req.user for use in controllers
            req.user.cafeId = req.user.cafeId || employee.cafeId;
            req.user.employeeId = req.user.employeeId || employee._id;
            
            // Update User model if fields are missing (one-time update)
            if (!req.user.cafeId || !req.user.employeeId) {
              const updateData = {};
              if (!req.user.cafeId && employee.cafeId) {
                updateData.cafeId = employee.cafeId;
              }
              if (!req.user.employeeId && employee._id) {
                updateData.employeeId = employee._id;
              }
              if (Object.keys(updateData).length > 0) {
                await User.findByIdAndUpdate(req.user._id, updateData);
                // Update req.user object
                req.user.cafeId = req.user.cafeId || employee.cafeId;
                req.user.employeeId = req.user.employeeId || employee._id;
              }
            }
          }
        }
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

exports.authorize = (allowedRoles = []) => async (req, res, next) => {
  if (!Array.isArray(allowedRoles) || allowedRoles.length === 0) {
    return next();
  }

  if (!req.user) {
    return res.status(401).json({ message: 'Not authorized' });
  }

  let userRole = req.user.role || 'user';
  
  // For mobile users with role "employee", look up Employee to get actual role
  if (userRole === 'employee') {
    try {
      const employee = await Employee.findOne({ userId: req.user._id }).lean();
      if (employee) {
        userRole = employee.employeeRole; // waiter, cook, captain, manager, etc.
      }
    } catch (error) {
      console.error('[AUTHORIZE] Error looking up employee:', error.message);
    }
  }
  
  // Check if user role is in allowed roles
  if (!allowedRoles.includes(userRole)) {
    return res.status(403).json({ 
      message: `Not authorized for this action. Required roles: ${allowedRoles.join(', ')}` 
    });
  }

  return next();
};

// Optional protect - authenticates if token is provided, but allows request to proceed without token
exports.optionalProtect = async (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) {
    try {
      const secret = process.env.JWT_SECRET || 'your-secret-key';
      const decoded = jwt.verify(token, secret);
      req.user = await User.findById(decoded.id).select('-password');
      // Continue even if user not found (for public access)
      if (req.user) {
        // For mobile app users, populate cafeId and employeeId if not already set
        if (["waiter", "cook", "captain", "manager", "employee"].includes(req.user.role)) {
          if (!req.user.cafeId || !req.user.employeeId) {
            let employee = null;
            
            if (req.user.employeeId) {
              employee = await Employee.findById(req.user.employeeId).lean();
            } else {
              employee = await Employee.findOne({ userId: req.user._id }).lean();
              if (!employee && req.user.email) {
                employee = await Employee.findOne({ email: req.user.email.toLowerCase() }).lean();
              }
            }
            
            if (employee) {
              req.user.cafeId = req.user.cafeId || employee.cafeId;
              req.user.employeeId = req.user.employeeId || employee._id;
            }
          }
        }
      }
    } catch (error) {
      // If token is invalid, just continue without req.user (for public access)
      console.log('[OPTIONAL_PROTECT] Token invalid or expired, continuing as public:', error.message);
    }
  }
  // Always continue to next middleware (with or without req.user)
  return next();
};
