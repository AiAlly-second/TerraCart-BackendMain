const User = require("../models/userModel");
const jwt = require("jsonwebtoken");

// Generate JWT Token
const generateToken = (id, tokenVersion = 0) => {
  const secret = String(process.env.JWT_SECRET || "").trim();
  if (!secret) {
    throw new Error("JWT_SECRET is not configured");
  }
  if (secret === 'your-secret-key' || secret === 'sarva-cafe-secret-key-2025') {
    console.warn('[SECURITY] ⚠️ Using default JWT secret. Set JWT_SECRET in production!');
  }
  return jwt.sign({ id, tokenVersion }, secret, {
    expiresIn: "30d",
  });
};

// Admin Login
const adminLogin = async (req, res) => {
  try {
    const { email, password } = req.body;

    console.log(`[ADMIN_LOGIN] Login attempt - Email: ${email ? email.toLowerCase().trim() : 'missing'}`);

    // Validate input
    if (!email || !password) {
      console.log(`[ADMIN_LOGIN] ❌ Missing email or password`);
      return res.status(400).json({
        success: false,
        message: "Please provide email and password",
      });
    }

    // Normalize email
    const normalizedEmail = email.toLowerCase().trim();

    // Find user by email
    const user = await User.findOne({ email: normalizedEmail });

    // Use generic error to prevent user enumeration
    if (!user) {
      console.log(`[ADMIN_LOGIN] ❌ User not found: ${normalizedEmail}`);
      return res.status(401).json({
        success: false,
        message: "Invalid credentials",
      });
    }

    console.log(`[ADMIN_LOGIN] User found: ${user.name} (${user._id}), Role: ${user.role}, isActive: ${user.isActive}, isApproved: ${user.isApproved}`);

    // Check if user is an admin role
    if (!["super_admin", "franchise_admin", "admin"].includes(user.role)) {
      console.log(`[ADMIN_LOGIN] ❌ Invalid role: ${user.role} (not an admin role)`);
      return res.status(401).json({
        success: false,
        message: "Invalid credentials",
      });
    }

    // For franchise admins, check if they're active
    if (user.role === "franchise_admin" && user.isActive === false) {
      return res.status(403).json({
        success: false,
        message: "Your franchise account has been deactivated. Please contact super admin.",
        code: "ACCOUNT_DEACTIVATED"
      });
    }

    // For cafe admins, check if they're approved, active, and their franchise is active
    if (user.role === "admin") {
      if (!user.isApproved) {
        return res.status(403).json({
          success: false,
          message: "Your account is pending approval from franchise admin. Please wait for approval.",
          code: "PENDING_APPROVAL"
        });
      }
      
      if (user.isActive === false) {
        return res.status(403).json({
          success: false,
          message: "Your cafe account has been deactivated. Please contact franchise admin.",
          code: "ACCOUNT_DEACTIVATED"
        });
      }
      
      // Check if the franchise is active
      if (user.franchiseId) {
        const franchise = await User.findById(user.franchiseId).select('isActive');
        if (franchise && franchise.isActive === false) {
          return res.status(403).json({
            success: false,
            message: "Your franchise has been deactivated. Please contact super admin.",
            code: "FRANCHISE_DEACTIVATED"
          });
        }
      }
    }

    // Check password
    const isPasswordMatch = await user.matchPassword(password);
    if (!isPasswordMatch) {
      console.log(`[ADMIN_LOGIN] ❌ Password mismatch for user: ${user.email}`);
      return res.status(401).json({
        success: false,
        message: "Invalid credentials",
      });
    }

    console.log(`[ADMIN_LOGIN] ✅ Password verified for user: ${user.email}`);

    // Generate token with current tokenVersion
    const tokenVersion = user.tokenVersion || 0;
    const token = generateToken(user._id, tokenVersion);
    
    console.log(`[ADMIN_LOGIN] ✅ Login successful - User: ${user.name} (${user.role})`);

    // Build user response with role-specific fields
    const userResponse = {
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      cafeName: user.cafeName,
      cartName: user.cartName,
      location: user.location,
      isApproved: user.isApproved,
    };
    
    // Add franchise code for franchise admins
    if (user.role === "franchise_admin") {
      userResponse.franchiseCode = user.franchiseCode;
      userResponse.franchiseShortcut = user.franchiseShortcut;
    }
    
    // Add cart code for cart admins
    if (user.role === "admin") {
      userResponse.cartCode = user.cartCode;
    }

    res.json({
      success: true,
      token,
      user: userResponse,
    });
  } catch (error) {
    console.error("[LOGIN] Error:", error.message);
    res.status(500).json({
      success: false,
      message: "Server error during login",
    });
  }
};

// Verify Admin Token
const verifyAdminToken = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: "Not authenticated",
      });
    }

    const user = req.user;

    if (!["super_admin", "franchise_admin", "admin"].includes(user.role)) {
      return res.status(403).json({
        success: false,
        message: "Not authorized as admin",
      });
    }

    // Final check for deactivation
    if (user.role === "franchise_admin" && user.isActive === false) {
      return res.status(403).json({
        success: false,
        message: "Your franchise account has been deactivated. Please contact super admin.",
        code: "ACCOUNT_DEACTIVATED",
        deactivated: true,
      });
    }

    if (user.role === "admin") {
      if (!user.isApproved) {
        return res.status(403).json({
          success: false,
          message: "Your account is pending approval from franchise admin. Please wait for approval.",
          code: "ACCOUNT_PENDING_APPROVAL",
          pendingApproval: true,
        });
      }
      
      if (user.isActive === false) {
        return res.status(403).json({
          success: false,
          message: "Your cafe account has been deactivated. Please contact franchise admin.",
          code: "CAFE_DEACTIVATED",
          deactivated: true,
        });
      }
      
      // Check if franchise is active
      if (user.franchiseId) {
        const franchise = await User.findById(user.franchiseId).select('isActive');
        if (franchise && franchise.isActive === false) {
          return res.status(403).json({
            success: false,
            message: "Your franchise has been deactivated. Please contact super admin.",
            code: "FRANCHISE_DEACTIVATED",
            deactivated: true,
          });
        }
      }
    }

    // Build user response
    const userResponse = {
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      cafeName: user.cafeName,
      cartName: user.cartName,
      location: user.location,
      isApproved: user.isApproved,
    };
    
    if (user.role === "franchise_admin") {
      userResponse.franchiseCode = user.franchiseCode;
      userResponse.franchiseShortcut = user.franchiseShortcut;
    }
    
    if (user.role === "admin") {
      userResponse.cartCode = user.cartCode;
    }

    res.json({
      success: true,
      user: userResponse,
    });
  } catch (error) {
    console.error("[VERIFY] Error:", error.message);
    res.status(401).json({
      success: false,
      message: "Invalid token",
    });
  }
};

// Logout from all devices - increments tokenVersion to invalidate all tokens
const logoutFromAllDevices = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: "Not authenticated",
      });
    }

    const userId = req.user._id;

    // Increment tokenVersion to invalidate all existing tokens
    const user = await User.findByIdAndUpdate(
      userId,
      { $inc: { tokenVersion: 1 } },
      { new: true }
    ).select('-password');

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    console.log(`[LOGOUT_ALL] User ${user.email} logged out from all devices. New tokenVersion: ${user.tokenVersion}`);

    res.json({
      success: true,
      message: "Logged out from all devices successfully",
      tokenVersion: user.tokenVersion,
    });
  } catch (error) {
    console.error("[LOGOUT_ALL] Error:", error.message);
    res.status(500).json({
      success: false,
      message: "Server error during logout",
    });
  }
};

module.exports = {
  adminLogin,
  verifyAdminToken,
  logoutFromAllDevices,
};
