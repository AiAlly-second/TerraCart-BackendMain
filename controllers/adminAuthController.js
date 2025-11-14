const User = require("../models/userModel");
const jwt = require("jsonwebtoken");

// Generate JWT Token
const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET || 'your-secret-key', {
    expiresIn: "30d",
  });
};

// Admin Login
const adminLogin = async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validate input
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Please provide email and password",
      });
    }

    // Normalize email
    const normalizedEmail = email.toLowerCase().trim();
    console.log('Login attempt for email:', normalizedEmail);

    // Find user by email (case-insensitive using regex)
    const user = await User.findOne({ 
      email: { $regex: new RegExp(`^${normalizedEmail}$`, 'i') }
    });

    if (!user) {
      console.log('User not found for email:', normalizedEmail);
      return res.status(401).json({
        success: false,
        message: "Invalid credentials or not authorized",
      });
    }

    console.log('User found:', user.email, 'Role:', user.role);

    // Check if user exists and is an admin (super_admin, franchise_admin, or admin)
    if (!["super_admin", "franchise_admin", "admin"].includes(user.role)) {
      console.log('User role not authorized:', user.role);
      return res.status(401).json({
        success: false,
        message: "Invalid credentials or not authorized",
      });
    }

    // For franchise admins, check if they're active
    if (user.role === "franchise_admin" && user.isActive === false) {
      console.log('Franchise admin is inactive:', user.email);
      return res.status(403).json({
        success: false,
        message: "Your franchise account has been deactivated. Please contact super admin.",
      });
    }

    // For cafe admins, check if they're approved and their franchise is active
    if (user.role === "admin") {
      if (!user.isApproved) {
        console.log('Cafe admin not approved:', user.email);
        return res.status(403).json({
          success: false,
          message: "Your account is pending approval from franchise admin. Please wait for approval.",
        });
      }
      
      // Check if the franchise is active
      if (user.franchiseId) {
        const franchise = await User.findById(user.franchiseId);
        if (franchise && franchise.isActive === false) {
          console.log('Cafe admin\'s franchise is inactive:', user.email);
          return res.status(403).json({
            success: false,
            message: "Your franchise has been deactivated. Please contact super admin.",
          });
        }
      }
    }

    // Check password
    const isPasswordMatch = await user.matchPassword(password);
    console.log('Password match:', isPasswordMatch);
    if (!isPasswordMatch) {
      console.log('Password does not match for user:', user.email);
      return res.status(401).json({
        success: false,
        message: "Invalid credentials",
      });
    }

    console.log('Login successful for user:', user.email, 'Role:', user.role);

    // Generate token
    const token = generateToken(user._id);

    res.json({
      success: true,
      token,
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        cafeName: user.cafeName,
        location: user.location,
        isApproved: user.isApproved,
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({
      success: false,
      message: "Server error during login",
    });
  }
};

// Verify Admin Token
// Note: protect middleware runs before this, so req.user should already be set
const verifyAdminToken = async (req, res) => {
  try {
    // req.user should already be set by protect middleware
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

    res.json({
      success: true,
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        cafeName: user.cafeName,
        location: user.location,
        isApproved: user.isApproved,
      },
    });
  } catch (error) {
    console.error("Token verification error:", error);
    res.status(401).json({
      success: false,
      message: "Invalid token",
    });
  }
};

module.exports = {
  adminLogin,
  verifyAdminToken,
};