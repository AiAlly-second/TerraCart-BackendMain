const jwt = require('jsonwebtoken');
const User = require('../models/userModel');

exports.protect = async (req, res, next) => {
  let token;

  console.log('[AUTH] Request to:', req.method, req.path);
  console.log('[AUTH] Authorization header:', req.headers.authorization ? 'Present' : 'Missing');

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    try {
      // Get token from header
      token = req.headers.authorization.split(' ')[1];
      console.log('[AUTH] Token extracted:', token ? `${token.substring(0, 20)}...` : 'Empty');

      // Verify token
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
      console.log('[AUTH] Token decoded, user ID:', decoded.id);

      // Get user from token
      req.user = await User.findById(decoded.id).select('-password');

      if (!req.user) {
        console.error('[AUTH] User not found for ID:', decoded.id);
        return res.status(401).json({ message: 'Not authorized, user not found' });
      }

      console.log('[AUTH] User authenticated:', req.user.email, 'Role:', req.user.role);
      return next();
    } catch (error) {
      console.error('[AUTH] Token verification error:', error.message);
      return res.status(401).json({ message: 'Not authorized, token failed: ' + error.message });
    }
  }

  // No token provided
  console.error('[AUTH] No token provided in request');
  return res.status(401).json({ message: 'Not authorized, no token' });
};

exports.admin = async (req, res, next) => {
  console.log('[AUTH] admin middleware - req.user:', req.user ? req.user.email : 'null', 'role:', req.user?.role);
  if (req.user && ["super_admin", "franchise_admin", "admin"].includes(req.user.role)) {
    // For cafe admins, check if they're approved
    if (req.user.role === "admin" && !req.user.isApproved) {
      console.log('[AUTH] Cafe admin not approved:', req.user.email);
      return res.status(403).json({ message: 'Cafe admin account pending approval' });
    }
    console.log('[AUTH] Admin access granted');
    return next();
  } else {
    console.error('[AUTH] Not authorized as admin - user:', req.user ? req.user.role : 'no user');
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
  console.log('[AUTH] authorize middleware - allowedRoles:', allowedRoles, 'user role:', req.user?.role);
  
  if (!Array.isArray(allowedRoles) || allowedRoles.length === 0) {
    console.log('[AUTH] No role restrictions, allowing access');
    return next();
  }

  if (!req.user) {
    console.error('[AUTH] No user in request');
    return res.status(401).json({ message: 'Not authorized' });
  }

  const userRole = req.user.role || 'user';
  console.log('[AUTH] Checking role:', userRole, 'against allowed:', allowedRoles);
  
  if (!allowedRoles.includes(userRole)) {
    console.error('[AUTH] Role not allowed:', userRole);
    return res.status(403).json({ message: `Not authorized for this action. Required roles: ${allowedRoles.join(', ')}` });
  }

  console.log('[AUTH] Role authorized, allowing access');
  return next();
};