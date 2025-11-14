const User = require("../models/userModel");
const jwt = require("jsonwebtoken");

const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET || 'sarva-cafe-secret-key-2025', {
    expiresIn: '30d',
  });
};

// @desc    Login user
// @route   POST /api/users/login
exports.loginUser = async (req, res) => {
  try {
    const { email, password } = req.body;
    
    console.log('Login attempt:', { email, password });

    // Validate email and password are provided
    if (!email || !password) {
      console.log('Missing email or password');
      return res.status(400).json({ message: "Please provide email and password" });
    }

    // Find user by email
    const user = await User.findOne({ email });
    console.log('User found:', user ? 'Yes' : 'No');
    
    // Check if user exists and password matches
    if (!user) {
      console.log('User not found');
      return res.status(401).json({ message: "Invalid email or password" });
    }

    const isMatch = await user.matchPassword(password);
    console.log('Password match:', isMatch ? 'Yes' : 'No');
    
    if (!isMatch) {
      console.log('Password does not match');
      return res.status(401).json({ message: "Invalid email or password" });
    }

    // Check if user is admin
    console.log('User role:', user.role);
    if (user.role !== 'admin') {
      console.log('Not an admin user');
      return res.status(403).json({ message: "Access denied. Admin only." });
    }

    // Create token and send response
    const token = generateToken(user._id);
    res.json({
      token,
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role
    });
    
    res.json({
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      token: token,
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: "Server error during login" });
  }
};

// @desc    Get all users
// @route   GET /api/users
exports.getUsers = async (req, res) => {
  try {
    const query = {};
    
    // Filter users based on admin role:
    // - Cafe admin: only see themselves (not applicable here, but for consistency)
    // - Franchise admin: only see cafe admins under their franchise
    // - Super admin: see all users
    if (req.user && req.user.role === "franchise_admin" && req.user._id) {
      // Franchise admin - only see cafe admins (role: "admin") under their franchise
      query.role = "admin";
      query.franchiseId = req.user._id;
    } else if (req.user && req.user.role === "admin" && req.user._id) {
      // Cafe admin - only see themselves (if needed)
      query._id = req.user._id;
    }
    // For super_admin, no filter (see all users)
    
    const users = await User.find(query).select('-password');
    res.json(users);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Create a new user (super admin only)
// @route   POST /api/users
exports.createUser = async (req, res) => {
  try {
    const { name, email, password, role } = req.body;

    // Validate required fields
    if (!name || !email || !password || !role) {
      return res.status(400).json({ message: "Please provide name, email, password, and role" });
    }

    // Check if email already exists
    const existingUser = await User.findOne({ email: email.toLowerCase().trim() });
    if (existingUser) {
      return res.status(400).json({ message: "Email already registered" });
    }

    // Validate role
    const validRoles = ["super_admin", "franchise_admin", "admin", "employee", "customer"];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ message: `Invalid role. Must be one of: ${validRoles.join(", ")}` });
    }

    const user = await User.create({ 
      name, 
      email: email.toLowerCase().trim(), 
      password, 
      role 
    });
    
    // Don't send password in response
    const userResponse = user.toObject();
    delete userResponse.password;
    
    res.status(201).json(userResponse);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// @desc    Register new cafe admin (franchise admin endpoint)
// @route   POST /api/users/register-cafe-admin
exports.registerCafeAdmin = async (req, res) => {
  try {
    const { name, email, password, cafeName, location, phone, address } = req.body;

    // Validate required fields
    if (!name || !email || !password || !cafeName || !location) {
      return res.status(400).json({ 
        message: "Please provide name, email, password, cafe name, and location" 
      });
    }

    // Check if email already exists
    const existingUser = await User.findOne({ email: email.toLowerCase().trim() });
    if (existingUser) {
      return res.status(400).json({ message: "Email already registered" });
    }

    // Get franchise admin ID from authenticated user (if franchise admin is creating)
    // Or from request body if super admin is creating
    let franchiseId = null;
    if (req.user && req.user.role === "franchise_admin") {
      franchiseId = req.user._id;
    } else if (req.body.franchiseId) {
      // Super admin can specify franchiseId
      const franchise = await User.findById(req.body.franchiseId);
      if (!franchise || franchise.role !== "franchise_admin") {
        return res.status(400).json({ message: "Invalid franchise ID" });
      }
      franchiseId = req.body.franchiseId;
    }

    // Create cafe admin user (not approved yet)
    const user = await User.create({
      name,
      email: email.toLowerCase().trim(),
      password,
      role: "admin",
      cafeName,
      location,
      phone: phone || undefined,
      address: address || undefined,
      isApproved: false, // Requires franchise admin approval
      franchiseId: franchiseId, // Link to franchise
    });

    // Don't send password in response
    const userResponse = user.toObject();
    delete userResponse.password;

    res.status(201).json({
      message: "Cafe admin registration successful. Waiting for franchise admin approval.",
      user: userResponse,
    });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// @desc    Approve cafe admin (franchise admin only)
// @route   PATCH /api/users/:id/approve
exports.approveCafeAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    const franchiseAdminId = req.user._id; // From auth middleware

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (user.role !== "admin") {
      return res.status(400).json({ message: "User is not a cafe admin" });
    }

    if (user.isApproved) {
      return res.status(400).json({ message: "Cafe admin is already approved" });
    }

    user.isApproved = true;
    user.approvedBy = franchiseAdminId;
    user.approvedAt = new Date();
    // Ensure franchiseId is set (link cafe to franchise)
    if (!user.franchiseId) {
      user.franchiseId = franchiseAdminId;
    }
    await user.save();

    const userResponse = user.toObject();
    delete userResponse.password;

    res.json({
      message: "Cafe admin approved successfully",
      user: userResponse,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Reject cafe admin (franchise admin only)
// @route   PATCH /api/users/:id/reject
exports.rejectCafeAdmin = async (req, res) => {
  try {
    const { id } = req.params;

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (user.role !== "admin") {
      return res.status(400).json({ message: "User is not a cafe admin" });
    }

    // Delete the user (rejection means removal)
    await User.findByIdAndDelete(id);

    res.json({ message: "Cafe admin registration rejected and removed" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get single user
// @route   GET /api/users/:id
exports.getUserById = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json(user);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Update user
// @route   PUT /api/users/:id
exports.updateUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Update fields
    const { name, email, password, role, ...otherFields } = req.body;
    
    if (name !== undefined) user.name = name;
    if (email !== undefined) user.email = email.toLowerCase().trim();
    if (password !== undefined) {
      // Password will be hashed by pre-save hook
      user.password = password;
    }
    if (role !== undefined) {
      // Validate role
      const validRoles = ["super_admin", "franchise_admin", "admin", "employee", "customer"];
      if (!validRoles.includes(role)) {
        return res.status(400).json({ message: `Invalid role. Must be one of: ${validRoles.join(", ")}` });
      }
      user.role = role;
    }
    
    // Update other fields
    Object.keys(otherFields).forEach(key => {
      if (otherFields[key] !== undefined) {
        user[key] = otherFields[key];
      }
    });

    // Save the user (this will trigger password hashing if password was changed)
    await user.save();

    // Don't send password in response
    const userResponse = user.toObject();
    delete userResponse.password;
    
    res.json(userResponse);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// @desc    Toggle franchise active/inactive status
// @route   PATCH /api/users/:id/toggle-status
exports.toggleFranchiseStatus = async (req, res) => {
  try {
    console.log('[TOGGLE] Request received:', {
      id: req.params.id,
      userRole: req.user?.role,
      userId: req.user?._id
    });
    
    const user = await User.findById(req.params.id);
    
    if (!user) {
      console.log('[TOGGLE] User not found:', req.params.id);
      return res.status(404).json({ message: "User not found" });
    }
    
    console.log('[TOGGLE] User found:', {
      id: user._id,
      name: user.name,
      role: user.role,
      currentStatus: user.isActive
    });
    
    if (user.role !== "franchise_admin") {
      console.log('[TOGGLE] Invalid role:', user.role);
      return res.status(400).json({ message: "Only franchise admins can have their status toggled" });
    }
    
    const oldStatus = user.isActive;
    user.isActive = user.isActive === false ? true : false; // Explicit toggle
    await user.save();
    
    console.log('[TOGGLE] Status changed:', {
      from: oldStatus,
      to: user.isActive
    });
    
    res.json({
      success: true,
      message: `Franchise ${user.isActive ? 'activated' : 'deactivated'} successfully`,
      data: {
        _id: user._id,
        name: user.name,
        email: user.email,
        isActive: user.isActive
      }
    });
  } catch (error) {
    console.error('[TOGGLE] Error:', error);
    res.status(500).json({ message: error.message });
  }
};

// @desc    Delete user
// @route   DELETE /api/users/:id
// IMPORTANT: For franchise admins, this sets isActive=false instead of deleting
// This preserves all data and allows reactivation later
// Paid orders (status: "Paid") are NEVER deleted, even when admins are removed
// Only non-paid orders (Pending, Confirmed, Preparing, Ready, Served, Cancelled, Returned) are deleted
// Revenue calculations continue to work even after admin accounts are deactivated
exports.deleteUser = async (req, res) => {
  try {
    const userToDelete = await User.findById(req.params.id);
    
    if (!userToDelete) {
      return res.status(404).json({ message: "User not found" });
    }
    
    // For franchise admins, set isActive=false instead of deleting
    // This preserves all data and allows reactivation
    if (userToDelete.role === "franchise_admin") {
      userToDelete.isActive = false;
      await userToDelete.save();
      
      return res.json({
        success: true,
        message: "Franchise deactivated successfully. All data is preserved and can be reactivated later.",
        data: {
          _id: userToDelete._id,
          name: userToDelete.name,
          email: userToDelete.email,
          isActive: false,
          note: "Franchise is deactivated. Use toggle-status endpoint to reactivate."
        }
      });
    }
    
    // For cafe admins and other users, proceed with actual deletion
    // Import Order model for order operations
    const Order = require("../models/orderModel");

    // If deleting a cafe admin, clean up their data
    if (userToDelete.role === "admin") {
      // Find all cafes (admin users) under this franchise
      const cafes = await User.find({ 
        role: "admin", 
        franchiseId: userToDelete._id 
      });
      
      // Delete all cafes under this franchise
      const cafeIds = cafes.map(cafe => cafe._id);
      
      // Import models for cleanup (Order already imported above)
      const { Table } = require("../models/tableModel");
      const { Payment } = require("../models/paymentModel");
      const { MenuItem } = require("../models/menuItemModel");
      const MenuCategory = require("../models/menuCategoryModel");
      const Waitlist = require("../models/waitlistModel");
      
      if (cafeIds.length > 0) {
        // CRITICAL: Protect paid orders - they contain revenue data and must NEVER be deleted
        // Only delete non-paid orders (Pending, Confirmed, Preparing, Ready, Served, Cancelled, Returned)
        const nonPaidStatuses = ["Pending", "Confirmed", "Preparing", "Ready", "Served", "Cancelled", "Returned"];
        
        // Get all orders (both paid and non-paid) for reporting
        const allOrders = await Order.find({ 
          $or: [
            { cafeId: { $in: cafeIds } },
            { franchiseId: userToDelete._id }
          ]
        }).select('_id status').lean();
        
        // Separate paid and non-paid orders
        const paidOrders = allOrders.filter(o => o.status === "Paid");
        const nonPaidOrders = allOrders.filter(o => nonPaidStatuses.includes(o.status));
        const nonPaidOrderIds = nonPaidOrders.map(o => o._id);
        
        // Get all table IDs from these cafes before deleting tables
        const tablesToDelete = await Table.find({ 
          $or: [
            { cafeId: { $in: cafeIds } },
            { franchiseId: userToDelete._id }
          ]
        }).select('_id').lean();
        const tableIds = tablesToDelete.map(t => t._id);
        
        // Delete payments associated with NON-PAID orders only
        // Paid orders' payments must be preserved for revenue tracking
        if (nonPaidOrderIds.length > 0) {
          await Payment.deleteMany({ 
            orderId: { $in: nonPaidOrderIds },
            status: { $ne: "PAID" } // Extra safety - don't delete PAID payments
          });
        }
        
        // Delete waitlist entries for these tables
        if (tableIds.length > 0) {
          await Waitlist.deleteMany({ table: { $in: tableIds } });
        }
        
        // Delete menu items belonging to these cafes
        await MenuItem.deleteMany({ cafeId: { $in: cafeIds } });
        
        // Delete menu categories belonging to these cafes
        await MenuCategory.deleteMany({ cafeId: { $in: cafeIds } });
        
        // Delete tables belonging to these cafes
        await Table.deleteMany({ cafeId: { $in: cafeIds } });
        
        // Delete ONLY non-paid orders - paid orders are preserved for revenue tracking
        if (nonPaidOrderIds.length > 0) {
          await Order.deleteMany({ 
            _id: { $in: nonPaidOrderIds }
          });
        }
        
        // Delete cafes (this removes all cafe login credentials and data)
        await User.deleteMany({ _id: { $in: cafeIds } });
        
        // Also delete tables and NON-PAID orders directly linked to franchise
        const franchiseAllOrders = await Order.find({ franchiseId: userToDelete._id }).select('_id status').lean();
        const franchisePaidOrders = franchiseAllOrders.filter(o => o.status === "Paid");
        const franchiseNonPaidOrders = franchiseAllOrders.filter(o => nonPaidStatuses.includes(o.status));
        const franchiseNonPaidOrderIds = franchiseNonPaidOrders.map(o => o._id);
        
        if (franchiseNonPaidOrderIds.length > 0) {
          await Payment.deleteMany({ 
            orderId: { $in: franchiseNonPaidOrderIds },
            status: { $ne: "PAID" }
          });
        }
        
        const franchiseTables = await Table.find({ franchiseId: userToDelete._id }).select('_id').lean();
        const franchiseTableIds = franchiseTables.map(t => t._id);
        if (franchiseTableIds.length > 0) {
          await Waitlist.deleteMany({ table: { $in: franchiseTableIds } });
        }
        
        await Table.deleteMany({ franchiseId: userToDelete._id });
        
        // Delete ONLY non-paid orders directly linked to franchise
        if (franchiseNonPaidOrderIds.length > 0) {
          await Order.deleteMany({ 
            _id: { $in: franchiseNonPaidOrderIds }
          });
        }
      } else {
        // No cafes, but still clean up any tables/orders directly linked to franchise
        // CRITICAL: Protect paid orders - they contain revenue data
        const nonPaidStatuses = ["Pending", "Confirmed", "Preparing", "Ready", "Served", "Cancelled", "Returned"];
        
        const franchiseAllOrders = await Order.find({ franchiseId: userToDelete._id }).select('_id status').lean();
        const franchisePaidOrders = franchiseAllOrders.filter(o => o.status === "Paid");
        const franchiseNonPaidOrders = franchiseAllOrders.filter(o => nonPaidStatuses.includes(o.status));
        const franchiseNonPaidOrderIds = franchiseNonPaidOrders.map(o => o._id);
        
        if (franchiseNonPaidOrderIds.length > 0) {
          await Payment.deleteMany({ 
            orderId: { $in: franchiseNonPaidOrderIds },
            status: { $ne: "PAID" }
          });
        }
        
        const franchiseTables = await Table.find({ franchiseId: userToDelete._id }).select('_id').lean();
        const franchiseTableIds = franchiseTables.map(t => t._id);
        if (franchiseTableIds.length > 0) {
          await Waitlist.deleteMany({ table: { $in: franchiseTableIds } });
        }
        
        await Table.deleteMany({ franchiseId: userToDelete._id });
        
        // Delete ONLY non-paid orders
        if (franchiseNonPaidOrderIds.length > 0) {
          await Order.deleteMany({ 
            _id: { $in: franchiseNonPaidOrderIds }
          });
        }
      }
    }

    // If deleting a cafe admin (not franchise admin), protect their paid orders too
    if (userToDelete.role === "admin") {
      const { Payment } = require("../models/paymentModel");
      
      // Get all orders for this cafe admin
      const allCafeOrders = await Order.find({ cafeId: userToDelete._id }).select('_id status').lean();
      const nonPaidStatuses = ["Pending", "Confirmed", "Preparing", "Ready", "Served", "Cancelled", "Returned"];
      
      // Separate paid and non-paid orders
      const cafePaidOrders = allCafeOrders.filter(o => o.status === "Paid");
      const cafeNonPaidOrders = allCafeOrders.filter(o => nonPaidStatuses.includes(o.status));
      const cafeNonPaidOrderIds = cafeNonPaidOrders.map(o => o._id);
      
      // Delete only non-paid orders and their payments
      if (cafeNonPaidOrderIds.length > 0) {
        await Payment.deleteMany({ 
          orderId: { $in: cafeNonPaidOrderIds },
          status: { $ne: "PAID" }
        });
        await Order.deleteMany({ _id: { $in: cafeNonPaidOrderIds } });
      }
      
      // Paid orders are preserved automatically (not deleted)
    }

    // Delete the user (franchise admin, cafe admin, or regular user)
    await User.findByIdAndDelete(req.params.id);
    
    // Count preserved paid orders for reporting
    let preservedPaidOrdersCount = 0;
    if (userToDelete.role === "franchise_admin") {
      const preservedOrders = await Order.find({ 
        franchiseId: userToDelete._id,
        status: "Paid"
      }).countDocuments();
      preservedPaidOrdersCount = preservedOrders;
    } else if (userToDelete.role === "admin") {
      const preservedOrders = await Order.find({ 
        cafeId: userToDelete._id,
        status: "Paid"
      }).countDocuments();
      preservedPaidOrdersCount = preservedOrders;
    }
    
    let message = "User removed";
    if (userToDelete.role === "franchise_admin") {
      message = `Franchise and all associated cafes removed. ${preservedPaidOrdersCount} paid orders preserved for revenue tracking.`;
    } else if (userToDelete.role === "admin") {
      message = `Cafe admin removed. ${preservedPaidOrdersCount} paid orders preserved for revenue tracking.`;
    }
    
    res.json({ 
      message,
      preservedPaidOrders: preservedPaidOrdersCount,
      warning: preservedPaidOrdersCount > 0 
        ? "Paid orders and revenue data have been preserved in the database for financial records. Revenue calculations will continue to work."
        : null
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
