const User = require("../models/userModel");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { generateFranchiseCode, generateCartCode } = require("../utils/codeGenerator");
const { addSignedUrlsToUser } = require("../utils/signedUrl");

// Configure multer for franchise document uploads
const franchiseDocsDir = path.join(__dirname, "..", "uploads", "franchise-docs");
if (!fs.existsSync(franchiseDocsDir)) {
  fs.mkdirSync(franchiseDocsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, franchiseDocsDir);
  },
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const ext = path.extname(file.originalname) || ".pdf";
    cb(null, `${unique}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (_req, file, cb) => {
    // Allow PDFs and images
    const allowedMimes = [
      "application/pdf",
      "image/jpeg",
      "image/jpg",
      "image/png",
      "image/webp",
    ];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only PDF and image files are allowed"));
    }
  },
});

// Multer middleware for multiple file uploads (for franchise documents)
const multerFranchiseDocs = upload.fields([
  { name: "udyamCertificate", maxCount: 1 },
  { name: "aadharCard", maxCount: 1 },
  { name: "panCard", maxCount: 1 },
]);

// Wrapper middleware that makes multer optional for JSON requests
exports.uploadFranchiseDocs = (req, res, next) => {
  // Only use multer if content-type is multipart/form-data
  if (req.is('multipart/form-data')) {
    return multerFranchiseDocs(req, res, next);
  }
  // For JSON requests, just pass through (files are optional)
  next();
};

// Multer middleware for multiple file uploads (for cafe admin documents)
const multerCafeAdminDocs = upload.fields([
  { name: "aadharCard", maxCount: 1 },
  { name: "panCard", maxCount: 1 },
  { name: "gstCertificate", maxCount: 1 },
  { name: "shopActLicense", maxCount: 1 },
  { name: "fssaiLicense", maxCount: 1 },
  { name: "electricityBill", maxCount: 1 },
  { name: "rentAgreement", maxCount: 1 },
]);

// Wrapper middleware that makes multer optional for JSON requests
exports.uploadCafeAdminDocs = (req, res, next) => {
  // Only use multer if content-type is multipart/form-data
  if (req.is('multipart/form-data')) {
    return multerCafeAdminDocs(req, res, next);
  }
  // For JSON requests, just pass through (files are optional)
  next();
};

const generateToken = (id) => {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret === 'sarva-cafe-secret-key-2025') {
    console.warn('[SECURITY] ⚠️ Using default JWT secret. Set JWT_SECRET in production!');
  }
  return jwt.sign({ id }, secret || 'sarva-cafe-secret-key-2025', {
    expiresIn: '30d',
  });
};

// @desc    Login user
// @route   POST /api/users/login
// @note    Mobile app login: requires x-app-login: mobile header, allows only cook, waiter, captain, manager
// @note    Web login: allows admin roles (super_admin, franchise_admin, admin/cart_admin)
exports.loginUser = async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validate email and password are provided
    if (!email || !password) {
      return res.status(400).json({ message: "Please provide email and password" });
    }

    // Find user by email (case-insensitive)
    const user = await User.findOne({ email: email.toLowerCase().trim() });
    
    // Use generic error message to prevent user enumeration
    if (!user) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    const isMatch = await user.matchPassword(password);
    
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    // Check if this is a mobile app login
    const isMobileLogin = req.headers['x-app-login'] === 'mobile';

    if (isMobileLogin) {
      // Mobile app login: only allow cook, waiter, captain, manager
      const allowedMobileRoles = ["cook", "waiter", "captain", "manager"];
      if (!allowedMobileRoles.includes(user.role)) {
        return res.status(403).json({ 
          message: "Access denied. Mobile app login is only available for cook, waiter, captain, and manager roles.",
          code: "MOBILE_LOGIN_RESTRICTED"
        });
      }
    } else {
      // Web login: allow admin roles (backward compatible with existing 'admin' role)
      const allowedWebRoles = ["super_admin", "franchise_admin", "admin", "cart_admin"];
      if (!allowedWebRoles.includes(user.role)) {
        return res.status(403).json({ message: "Access denied. Admin access only." });
      }
    }

    // Create token and send response
    const token = generateToken(user._id);
    
    // For mobile users, try to get cafeId from Employee model
    let cafeId = user.cafeId || (user.role === 'admin' ? user._id : null);
    let franchiseId = user.franchiseId;
    let employeeId = null;
    
    if (isMobileLogin && ["waiter", "cook", "captain", "manager"].includes(user.role)) {
      // Try to get cafeId from Employee model by matching email or name
      const Employee = require("../models/employeeModel");
      const employee = await Employee.findOne({ 
        name: user.name
      }).select('_id cafeId franchiseId').lean();
      
      if (employee) {
        employeeId = employee._id;
        cafeId = employee.cafeId;
        if (!franchiseId && employee.franchiseId) {
          franchiseId = employee.franchiseId;
        }

        // Auto-create attendance if none exists for today
        const EmployeeAttendance = require("../models/employeeAttendanceModel");
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        const existingAttendance = await EmployeeAttendance.findOne({
          employeeId: employee._id,
          date: { $gte: today, $lt: tomorrow },
        });

        if (!existingAttendance) {
          // Create new attendance record with checkIn
          await EmployeeAttendance.create({
            employeeId: employee._id,
            date: today,
            checkIn: {
              time: new Date(),
              location: "",
              notes: "Auto-checked in on mobile login",
            },
            status: "present",
            cafeId: employee.cafeId,
            franchiseId: employee.franchiseId,
          });
        }
      }
    }
    
    res.json({
      success: true,
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      token: token,
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        cafeId: cafeId,
        franchiseId: franchiseId,
        franchiseCode: user.franchiseCode || null,
        cartCode: user.cartCode || null,
        employeeId: employeeId?.toString(),
      }
    });
  } catch (error) {
    console.error('[LOGIN] Error:', error.message);
    res.status(500).json({ message: "Server error during login" });
  }
};

// @desc    Get cart/cafe statistics
// @route   GET /api/users/stats/carts
exports.getCartStatistics = async (req, res) => {
  try {
    let query = { role: "admin" };
    
    // Franchise admin: only see carts under their franchise
    if (req.user && req.user.role === "franchise_admin" && req.user._id) {
      query.franchiseId = req.user._id;
    }
    // Super admin: see all carts (no franchiseId filter)
    
    const allCarts = await User.find(query).select('-password').lean();
    
    // Calculate statistics
    const totalCarts = allCarts.length;
    const activeCarts = allCarts.filter(cart => cart.isActive !== false && cart.isApproved === true).length;
    const inactiveCarts = allCarts.filter(cart => cart.isActive === false || cart.isApproved === false).length;
    const pendingApproval = allCarts.filter(cart => cart.isApproved === false).length;
    
    // For super admin, also group by franchise
    let franchiseStats = null;
    if (req.user && req.user.role === "super_admin") {
      const franchises = await User.find({ role: "franchise_admin" }).select('_id name isActive').lean();
      
      franchiseStats = franchises.map(franchise => {
        const franchiseCarts = allCarts.filter(cart => 
          cart.franchiseId && cart.franchiseId.toString() === franchise._id.toString()
        );
        
        // Cart is only active if: cart is approved, cart isActive is true, AND franchise is active
        const activeCartsCount = franchiseCarts.filter(c => 
          c.isActive !== false && 
          c.isApproved === true && 
          franchise.isActive !== false
        ).length;
        
        return {
          franchiseId: franchise._id,
          franchiseName: franchise.name,
          totalCarts: franchiseCarts.length,
          activeCarts: activeCartsCount,
          inactiveCarts: franchiseCarts.length - activeCartsCount,
          pendingApproval: franchiseCarts.filter(c => c.isApproved === false).length,
        };
      });
    }
    
    res.json({
      totalCarts,
      activeCarts,
      inactiveCarts,
      pendingApproval,
      franchiseStats, // Only for super admin
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
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
    
    const users = await User.find(query).select('-password').lean();
    
    // Add signed URLs for documents
    const usersWithSignedUrls = users.map(user => addSignedUrlsToUser(user));
    
    // For super admin, add effective status for cart admins based on their franchise status
    if (req.user && req.user.role === "super_admin") {
      // Get all franchise statuses
      const franchises = await User.find({ role: "franchise_admin" }).select('_id isActive').lean();
      const franchiseStatusMap = {};
      franchises.forEach(f => {
        franchiseStatusMap[f._id.toString()] = f.isActive !== false;
      });
      
      // Add effectiveStatus and franchiseActive fields to each user
      const usersWithStatus = usersWithSignedUrls.map(user => {
        if (user.role === "admin" && user.franchiseId) {
          const franchiseActive = franchiseStatusMap[user.franchiseId.toString()];
          // Cart is only effectively active if BOTH cart AND franchise are active
          const effectivelyActive = (user.isActive !== false) && franchiseActive;
          return {
            ...user,
            franchiseActive: franchiseActive,
            effectivelyActive: effectivelyActive
          };
        }
        return {
          ...user,
          effectivelyActive: user.isActive !== false
        };
      });
      
      return res.json(usersWithStatus);
    }
    
    res.json(usersWithSignedUrls);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Create a new user (super admin only)
// @route   POST /api/users
exports.createUser = async (req, res) => {
  try {
    const { name, email, password, role, mobile, gstNumber } = req.body;

    // Validate required fields
    if (!name || !email || !password || !role) {
      return res.status(400).json({ message: "Please provide name, email, password, and role" });
    }

    // Check if email already exists
    const existingUser = await User.findOne({ email: email.toLowerCase().trim() });
    if (existingUser) {
      return res.status(400).json({ message: "Email already registered" });
    }

    // Validate role - expanded to include new employee roles
    const validRoles = ["super_admin", "franchise_admin", "admin", "cart_admin", "manager", "captain", "waiter", "cook", "employee", "customer"];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ message: `Invalid role. Must be one of: ${validRoles.join(", ")}` });
    }

    // Handle file uploads for franchise admin
    let filePaths = {};
    if (req.files) {
      // Process uploaded files
      if (req.files.udyamCertificate && req.files.udyamCertificate[0]) {
        filePaths.udyamCertificate = `/uploads/franchise-docs/${req.files.udyamCertificate[0].filename}`;
      }
      if (req.files.aadharCard && req.files.aadharCard[0]) {
        filePaths.aadharCard = `/uploads/franchise-docs/${req.files.aadharCard[0].filename}`;
      }
      if (req.files.panCard && req.files.panCard[0]) {
        filePaths.panCard = `/uploads/franchise-docs/${req.files.panCard[0].filename}`;
      }
    }

    const userData = { 
      name, 
      email: email.toLowerCase().trim(), 
      password, 
      role 
    };

    // Add franchise admin specific fields
    if (role === "franchise_admin") {
      if (mobile) userData.mobile = mobile;
      if (gstNumber) userData.gstNumber = gstNumber;
      if (filePaths.udyamCertificate) userData.udyamCertificate = filePaths.udyamCertificate;
      if (filePaths.aadharCard) userData.aadharCard = filePaths.aadharCard;
      if (filePaths.panCard) userData.panCard = filePaths.panCard;
      
      // Generate unique Franchise Code (e.g., MAH001, ABC002) - REQUIRED
      // This is mandatory for all new franchises
      const franchiseCodeData = await generateFranchiseCode(name);
      if (!franchiseCodeData || !franchiseCodeData.franchiseCode) {
        return res.status(500).json({ message: "Failed to generate franchise code. Please try again." });
      }
      userData.franchiseShortcut = franchiseCodeData.franchiseShortcut;
      userData.franchiseSequence = franchiseCodeData.franchiseSequence;
      userData.franchiseCode = franchiseCodeData.franchiseCode;
      console.log(`[FRANCHISE CODE] ✅ Generated: ${franchiseCodeData.franchiseCode} for "${name}"`);
    }

    // Set hierarchy relationships for employee roles (manager, captain, waiter, cook)
    const employeeRoles = ["manager", "captain", "waiter", "cook"];
    if (employeeRoles.includes(role)) {
      // Set cafeId/franchiseId based on who is creating the user
      if (req.user) {
        if (req.user.role === "admin") {
          // Cart admin creating employee - link to their cart
          userData.cafeId = req.user._id;
          if (req.user.franchiseId) {
            userData.franchiseId = req.user.franchiseId;
          }
        } else if (req.user.role === "franchise_admin") {
          // Franchise admin creating employee - link to franchise
          userData.franchiseId = req.user._id;
          // If cafeId is provided in request, validate it belongs to this franchise
          if (req.body.cafeId) {
            const cafe = await User.findById(req.body.cafeId);
            if (!cafe || cafe.franchiseId?.toString() !== req.user._id.toString()) {
              return res.status(403).json({ message: "Invalid cafe selection" });
            }
            userData.cafeId = req.body.cafeId;
          }
        } else if (req.user.role === "super_admin") {
          // Super admin can specify cafeId/franchiseId
          if (req.body.cafeId) userData.cafeId = req.body.cafeId;
          if (req.body.franchiseId) userData.franchiseId = req.body.franchiseId;
        }
      }
    }

    const user = await User.create(userData);
    
    // If creating an employee role, also create Employee document
    if (employeeRoles.includes(role)) {
      try {
        const Employee = require("../models/employeeModel");
        const employeeData = {
          name: user.name,
          dateOfBirth: req.body.dateOfBirth ? new Date(req.body.dateOfBirth) : new Date(),
          mobile: req.body.mobile || req.body.phone || '',
          employeeRole: role, // Map user role to employeeRole
          cafeId: user.cafeId,
          franchiseId: user.franchiseId,
          kycVerified: req.body.kycVerified || false,
          isActive: req.body.isActive !== false,
        };
        
        // Add optional employee fields
        if (req.body.disability) employeeData.disability = req.body.disability;
        if (req.body.deviceIssued) employeeData.deviceIssued = req.body.deviceIssued;
        if (req.body.imei) employeeData.imei = req.body.imei;
        if (req.body.documents) employeeData.documents = req.body.documents;
        
        const employee = await Employee.create(employeeData);
        console.log(`[USER CREATION] ✅ Created User and Employee for ${role}: ${user.name} (User ID: ${user._id}, Employee ID: ${employee._id})`);
      } catch (err) {
        console.error("[USER CREATION] ❌ Failed to create Employee document:", err);
        // Don't fail user creation if employee creation fails - user can still login
      }
    }
    
    // CRITICAL: When a new franchise is created, automatically clone the global default menu
    // This gives the franchise its own default menu template (independent from global)
    // The franchise admin can then customize this menu, and it will be used for all carts
    if (role === "franchise_admin") {
      try {
        console.log(`[DEFAULT MENU] ========================================`);
        console.log(`[DEFAULT MENU] 🆕 NEW FRANCHISE CREATED: ${user.name} (ID: ${user._id})`);
        console.log(`[DEFAULT MENU] Automatically cloning global default menu to franchise...`);
        
        const { cloneGlobalDefaultMenuToFranchise } = require("../utils/cloneDefaultMenuToFranchise");
        const result = await cloneGlobalDefaultMenuToFranchise(user._id);
        
        if (result.success) {
          console.log(`[DEFAULT MENU] ✅ Successfully cloned global menu to franchise ${user.name}`);
          console.log(`[DEFAULT MENU] Franchise now has ${result.categoryCount} categories with ${result.itemCount} items`);
          console.log(`[DEFAULT MENU] Franchise can now customize this menu, and all carts will use it`);
        } else {
          console.warn(`[DEFAULT MENU] ⚠️ ${result.message}`);
          if (result.message.includes("No global default menu")) {
            console.warn(`[DEFAULT MENU] Super admin must create a global default menu first.`);
            console.warn(`[DEFAULT MENU] Once created, franchise can customize their menu.`);
          }
        }
        console.log(`[DEFAULT MENU] ========================================`);
      } catch (err) {
        console.error("[DEFAULT MENU] ❌ Failed to clone menu to franchise:", err);
        console.error("[DEFAULT MENU] Error details:", err.message);
        // Don't fail user creation if menu clone fails - franchise can create menu manually later
      }
    }
    
    // Don't send password in response
    const userResponse = user.toObject();
    delete userResponse.password;
    
    res.status(201).json(userResponse);
  } catch (error) {
    // Clean up uploaded files if user creation fails
    if (req.files) {
      Object.values(req.files).forEach(fileArray => {
        if (fileArray && fileArray[0]) {
          const filePath = path.join(franchiseDocsDir, fileArray[0].filename);
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
        }
      });
    }
    res.status(400).json({ message: error.message });
  }
};

// @desc    Register new cafe admin (franchise admin endpoint)
// @route   POST /api/users/register-cafe-admin
exports.registerCafeAdmin = async (req, res) => {
  try {
    const { name, email, password, cartName, location, phone, address } = req.body;

    // Validate required fields
    if (!name || !email || !password || !cartName || !location) {
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
    // Or from request body if super admin is creating or public signup
    let franchiseId = null;
    if (req.user && req.user.role === "franchise_admin") {
      franchiseId = req.user._id;
    } else if (req.body.franchiseId) {
      // Super admin can specify franchiseId, or public signup provides it
      const franchise = await User.findById(req.body.franchiseId);
      if (!franchise || franchise.role !== "franchise_admin") {
        return res.status(400).json({ message: "Invalid franchise ID" });
      }
      franchiseId = req.body.franchiseId;
    } else if (!req.user) {
      // Public signup requires franchiseId
      return res.status(400).json({ message: "Franchise ID is required for registration" });
    }

    // Handle file uploads for cafe admin documents
    let filePaths = {};
    if (req.files) {
      // Process uploaded files
      if (req.files.aadharCard && req.files.aadharCard[0]) {
        filePaths.aadharCard = `/uploads/franchise-docs/${req.files.aadharCard[0].filename}`;
      }
      if (req.files.panCard && req.files.panCard[0]) {
        filePaths.panCard = `/uploads/franchise-docs/${req.files.panCard[0].filename}`;
      }
      if (req.files.gstCertificate && req.files.gstCertificate[0]) {
        filePaths.gstCertificate = `/uploads/franchise-docs/${req.files.gstCertificate[0].filename}`;
      }
      if (req.files.shopActLicense && req.files.shopActLicense[0]) {
        filePaths.shopActLicense = `/uploads/franchise-docs/${req.files.shopActLicense[0].filename}`;
      }
      if (req.files.fssaiLicense && req.files.fssaiLicense[0]) {
        filePaths.fssaiLicense = `/uploads/franchise-docs/${req.files.fssaiLicense[0].filename}`;
      }
      if (req.files.electricityBill && req.files.electricityBill[0]) {
        filePaths.electricityBill = `/uploads/franchise-docs/${req.files.electricityBill[0].filename}`;
      }
      if (req.files.rentAgreement && req.files.rentAgreement[0]) {
        filePaths.rentAgreement = `/uploads/franchise-docs/${req.files.rentAgreement[0].filename}`;
      }
    }

    // Parse expiry dates from request body (only for documents that can expire)
    const {
      gstCertificateExpiry,
      shopActLicenseExpiry,
      fssaiLicenseExpiry,
    } = req.body;

    // Create cafe admin user (not approved yet)
    const userData = {
      name,
      email: email.toLowerCase().trim(),
      password,
      role: "admin",
      cartName,
      location,
      phone: phone || undefined,
      address: address || undefined,
      isApproved: false, // Requires franchise admin approval
      franchiseId: franchiseId, // Link to franchise
    };

    // Generate unique Cart Code (e.g., MAH001, MAH002 - based on franchise shortcut) - REQUIRED
    if (franchiseId) {
      const cartCodeData = await generateCartCode(franchiseId);
      if (!cartCodeData || !cartCodeData.cartCode) {
        return res.status(500).json({ message: "Failed to generate cart code. Please try again." });
      }
      userData.cartSequence = cartCodeData.cartSequence;
      userData.cartCode = cartCodeData.cartCode;
      console.log(`[CART CODE] ✅ Generated: ${cartCodeData.cartCode} for cart "${cartName}"`);
    }

    // Add document file paths if uploaded
    if (filePaths.aadharCard) userData.aadharCard = filePaths.aadharCard;
    if (filePaths.panCard) userData.panCard = filePaths.panCard;
    if (filePaths.gstCertificate) userData.gstCertificate = filePaths.gstCertificate;
    if (filePaths.shopActLicense) userData.shopActLicense = filePaths.shopActLicense;
    if (filePaths.fssaiLicense) userData.fssaiLicense = filePaths.fssaiLicense;
    if (filePaths.electricityBill) userData.electricityBill = filePaths.electricityBill;
    if (filePaths.rentAgreement) userData.rentAgreement = filePaths.rentAgreement;

    // Add document expiry dates if provided (only for documents that can expire)
    if (gstCertificateExpiry) userData.gstCertificateExpiry = new Date(gstCertificateExpiry);
    if (shopActLicenseExpiry) userData.shopActLicenseExpiry = new Date(shopActLicenseExpiry);
    if (fssaiLicenseExpiry) userData.fssaiLicenseExpiry = new Date(fssaiLicenseExpiry);

    const user = await User.create(userData);

    // CRITICAL: Push franchise's UNIQUE default menu to new cart
    // Each franchise has ONE unique menu, and cart gets EXACTLY that menu
    try {
      const { pushDefaultMenuToCafe } = require("./defaultMenuController");
      // Use the saved user's franchiseId (which should be set from franchiseId variable)
      const menuFranchiseId = user.franchiseId ? user.franchiseId.toString() : null;
      
      console.log(`[DEFAULT MENU] ========================================`);
      console.log(`[DEFAULT MENU] 🆕 NEW CART CREATED: ${user.cartName} (ID: ${user._id})`);
      console.log(`[DEFAULT MENU] Franchise ID: ${menuFranchiseId}`);
      console.log(`[DEFAULT MENU] Logic: Cart belongs to franchise → Cart gets franchise's UNIQUE menu`);
      
      if (!menuFranchiseId) {
        console.error(`[DEFAULT MENU] ❌ ERROR: No franchiseId for cart ${user.cartName}. Cart must belong to a franchise to get menu.`);
        console.error(`[DEFAULT MENU] Cart data: franchiseId=${user.franchiseId}, role=${user.role}, cartName=${user.cartName}`);
      } else {
        // CRITICAL: Get franchise's UNIQUE menu and sync EXACTLY that to the cart
        // This ensures cart gets exactly what franchise admin defined
        console.log(`[DEFAULT MENU] 🔄 Syncing franchise ${menuFranchiseId}'s UNIQUE menu to NEW cart ${user.cartName}`);
        console.log(`[DEFAULT MENU] Cart will get EXACTLY what franchise admin defined in their default menu`);
        console.log(`[DEFAULT MENU] This is a clean sync - all old menu data will be deleted first`);
        
        const result = await pushDefaultMenuToCafe(user._id, menuFranchiseId, true); // true = replace mode (clean sync)
        
        if (result.success) {
          console.log(`[DEFAULT MENU] ✅ Cart ${user.cartName} now has franchise ${menuFranchiseId}'s EXACT menu`);
          console.log(`[DEFAULT MENU] Created: ${result.categoriesCreated} categories, ${result.itemsCreated} items`);
          console.log(`[DEFAULT MENU] Final: ${result.finalCategoryCount} categories, ${result.finalItemCount} items`);
          console.log(`[DEFAULT MENU] Cart menu matches franchise menu: ✅`);
        } else {
          console.warn(`[DEFAULT MENU] ⚠️ Push to cart ${user.cartName} returned: ${result.message}`);
          console.warn(`[DEFAULT MENU] Franchise ${menuFranchiseId} may not have a default menu created yet.`);
          console.warn(`[DEFAULT MENU] Franchise admin should create a default menu first.`);
          // If push failed because menu is empty, that's okay - menu will sync when cart admin opens it
        }
      }
      console.log(`[DEFAULT MENU] ========================================`);
    } catch (err) {
      console.error("[DEFAULT MENU] ❌ Failed to push menu to new cart:", err);
      console.error("[DEFAULT MENU] Error details:", err.message);
      // Don't fail user creation if menu push fails - menu will sync when cart admin opens it
    }

    // Don't send password in response
    const userResponse = user.toObject();
    delete userResponse.password;

    res.status(201).json({
      message: "Cafe admin registration successful. Waiting for franchise admin approval.",
      user: userResponse,
    });
  } catch (error) {
    // Clean up uploaded files if user creation fails
    if (req.files) {
      Object.values(req.files).forEach(fileArray => {
        if (fileArray && fileArray[0]) {
          const filePath = path.join(franchiseDocsDir, fileArray[0].filename);
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
        }
      });
    }
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

    // Push default menu to cafe when approved
    // CRITICAL: Always use replaceMode to ensure clean menu, even if menu exists
    try {
      const { pushDefaultMenuToCafe } = require("./defaultMenuController");
      // Ensure we use the franchiseId from the saved user object
      const menuFranchiseId = user.franchiseId ? user.franchiseId.toString() : null;
      
      if (!menuFranchiseId) {
        console.error(`[DEFAULT MENU] ERROR: Approved cafe ${user.cartName} has no franchiseId. Cannot sync menu.`);
      } else {
        console.log(`[DEFAULT MENU] 🔄 Syncing menu to approved cafe ${user.cartName} (ID: ${user._id})`);
        console.log(`[DEFAULT MENU] Using franchise menu: ${menuFranchiseId}, replaceMode: true (clean sync)`);
        
        // CRITICAL: Always use replaceMode: true to prevent duplicates and ensure clean menu
        const result = await pushDefaultMenuToCafe(user._id, menuFranchiseId, true);
        if (result.success) {
          console.log(`[DEFAULT MENU] ✅ Successfully synced menu to approved cafe ${user.cartName}`);
          console.log(`[DEFAULT MENU] Created: ${result.categoriesCreated} categories, ${result.itemsCreated} items`);
          console.log(`[DEFAULT MENU] Final: ${result.finalCategoryCount} categories, ${result.finalItemCount} items`);
        } else {
          console.warn(`[DEFAULT MENU] ⚠️ Push to approved cafe ${user.cartName} returned: ${result.message}`);
        }
      }
    } catch (err) {
      console.error("[DEFAULT MENU] ❌ Failed to push to approved cafe:", err);
      console.error("[DEFAULT MENU] Error details:", err.message);
      // Don't fail approval if menu push fails
    }

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

// @desc    Toggle cafe admin active/inactive status (franchise admin or super admin)
// @route   PATCH /api/users/:id/toggle-cafe-status
exports.toggleCafeStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user._id;
    const userRole = req.user.role;

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ message: "Cafe admin not found" });
    }

    if (user.role !== "admin") {
      return res.status(400).json({ message: "User is not a cafe admin" });
    }

    // For franchise admin: verify the cafe belongs to their franchise
    // For super admin: allow toggling any cart
    if (userRole === "franchise_admin") {
      if (user.franchiseId?.toString() !== userId.toString()) {
        return res.status(403).json({ message: "Access denied. This cafe does not belong to your franchise." });
      }
      
      // For franchise admin: check if cafe is approved first
      if (!user.isApproved) {
        return res.status(400).json({ message: "Cannot activate/deactivate an unapproved cafe. Please approve the cafe first." });
      }
    }
    
    // Super admin can toggle any cart, even if not approved
    // If cart is not approved and super admin is toggling, approve it first
    const wasNotApproved = !user.isApproved;
    if (userRole === "super_admin" && wasNotApproved) {
      user.isApproved = true;
      user.approvedBy = userId;
      user.approvedAt = new Date();
    }

    // Toggle isActive status (default to true if not set)
    const oldStatus = user.isActive !== false; // Treat undefined/null as true
    
    // Check if trying to activate: prevent activation if franchise is inactive
    if (!oldStatus && user.franchiseId) {
      const franchise = await User.findById(user.franchiseId).select('isActive role');
      if (franchise && franchise.role === "franchise_admin" && franchise.isActive === false) {
        return res.status(400).json({ 
          message: "Cannot activate cart. The franchise is currently deactivated. Please activate the franchise first." 
        });
      }
    }
    
    user.isActive = !oldStatus;
    await user.save();

    const userResponse = user.toObject();
    delete userResponse.password;

    let message = `Cafe ${user.isActive ? 'activated' : 'deactivated'} successfully`;
    if (userRole === "super_admin" && wasNotApproved) {
      message = `Cafe approved and ${user.isActive ? 'activated' : 'deactivated'} successfully`;
    }

    res.json({
      success: true,
      message: message,
      user: userResponse,
    });
  } catch (error) {
    console.error('[TOGGLE CAFE] Error:', error);
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get current user (mobile app)
// @route   GET /api/users/me
exports.getCurrentUser = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    
    const user = await User.findById(req.user._id).select('-password');
    if (!user) return res.status(404).json({ message: "User not found" });
    
    // For mobile users, try to get cafeId from Employee model
    let cafeId = user.cafeId || (user.role === 'admin' ? user._id : null);
    let franchiseId = user.franchiseId;
    
    if (["waiter", "cook", "captain", "manager"].includes(user.role) && !cafeId) {
      // Try to get cafeId from Employee model by matching name
      const Employee = require("../models/employeeModel");
      const employee = await Employee.findOne({ 
        name: user.name
      }).select('cafeId franchiseId').lean();
      
      if (employee) {
        cafeId = employee.cafeId;
        if (!franchiseId && employee.franchiseId) {
          franchiseId = employee.franchiseId;
        }
      }
    }
    
    const userResponse = {
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      cafeId: cafeId,
      franchiseId: franchiseId,
      // Short codes generated when franchise/cart are created
      franchiseCode: user.franchiseCode || null,
      cartCode: user.cartCode || null,
      emergencyContacts: user.emergencyContacts || [], // Include emergency contacts
    };
    
    res.json({
      success: true,
      data: userResponse, // Changed from 'user' to 'data' for consistency
      user: userResponse, // Keep 'user' for backward compatibility
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get single user
// @route   GET /api/users/:id
exports.getUserById = async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password');
    if (!user) return res.status(404).json({ message: "User not found" });

    // Authorization checks:
    // - Super admin: can view any user
    // - Franchise admin: can only view cafe admins under their franchise
    // - Cafe admin: can only view themselves
    if (req.user.role === "franchise_admin") {
      // Franchise admin can only view cafe admins (role: "admin") under their franchise
      if (user.role !== "admin") {
        return res.status(403).json({ message: "Access denied. You can only view cafe admins under your franchise." });
      }
      if (!user.franchiseId || user.franchiseId.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: "Access denied. This cafe does not belong to your franchise." });
      }
    } else if (req.user.role === "admin") {
      // Cafe admin can only view themselves
      if (user._id.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: "Access denied. You can only view your own profile." });
      }
    }
    // Super admin can view anyone (no additional check needed)

    // Add signed URLs for documents
    const userWithSignedUrls = addSignedUrlsToUser(user);

    res.json(userWithSignedUrls);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Update user
// @route   PUT /api/users/:id
// @desc    Update emergency contacts for current user (mobile roles)
// @route   PATCH /api/users/me/emergency-contacts
exports.updateEmergencyContacts = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const { emergencyContacts } = req.body;
    
    if (!Array.isArray(emergencyContacts)) {
      return res.status(400).json({ message: "Emergency contacts must be an array" });
    }

    // Validate each contact
    for (const contact of emergencyContacts) {
      if (!contact.name || !contact.phone) {
        return res.status(400).json({ message: "Each contact must have name and phone" });
      }
    }

    // Update emergency contacts
    user.emergencyContacts = emergencyContacts.map(contact => {
      const now = new Date();
      return {
        name: contact.name?.trim() || '',
        phone: contact.phone?.trim() || '',
        email: contact.email?.trim() || '',
        relationship: contact.relationship?.trim() || '',
        isPrimary: contact.isPrimary === true || contact.isPrimary === 'true',
        createdAt: contact.createdAt ? new Date(contact.createdAt) : now,
        updatedAt: now,
      };
    });

    await user.save();

    // Convert to plain objects for JSON response
    const savedContacts = user.emergencyContacts.map(contact => ({
      name: contact.name,
      phone: contact.phone,
      email: contact.email || '',
      relationship: contact.relationship || '',
      isPrimary: contact.isPrimary || false,
      createdAt: contact.createdAt,
      updatedAt: contact.updatedAt,
    }));

    res.json({
      success: true,
      message: "Emergency contacts updated successfully",
      data: savedContacts,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.updateUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Authorization checks:
    // - Super admin: can update any user
    // - Franchise admin: can only update cafe admins under their franchise (cannot change role)
    // - Cafe admin: can only update themselves (cannot change role)
    // - Mobile roles: can only update themselves (for emergency contacts)
    const allowedMobileRoles = ["waiter", "cook", "captain", "manager"];
    if (allowedMobileRoles.includes(req.user.role)) {
      // Mobile users can only update themselves
      if (user._id.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: "Access denied. You can only update your own profile." });
      }
      // Mobile users can only update emergency contacts
      if (req.body.emergencyContacts) {
        user.emergencyContacts = req.body.emergencyContacts.map(contact => ({
          name: contact.name,
          phone: contact.phone,
          email: contact.email || '',
          relationship: contact.relationship || '',
          isPrimary: contact.isPrimary || false,
          updatedAt: new Date(),
        }));
        await user.save();
        return res.json({
          success: true,
          message: "Emergency contacts updated successfully",
          data: user,
        });
      }
      return res.status(403).json({ message: "Access denied. You can only update emergency contacts." });
    } else if (req.user.role === "franchise_admin") {
      // Franchise admin can only update cafe admins (role: "admin") under their franchise
      if (user.role !== "admin") {
        return res.status(403).json({ message: "Access denied. You can only update cafe admins under your franchise." });
      }
      if (!user.franchiseId || user.franchiseId.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: "Access denied. This cafe does not belong to your franchise." });
      }
      // Franchise admin cannot change role
      if (req.body.role !== undefined && req.body.role !== user.role) {
        return res.status(403).json({ message: "Access denied. You cannot change user roles." });
      }
    } else if (req.user.role === "admin") {
      // Cafe admin can only update themselves
      if (user._id.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: "Access denied. You can only update your own profile." });
      }
      // Cafe admin cannot change role
      if (req.body.role !== undefined && req.body.role !== user.role) {
        return res.status(403).json({ message: "Access denied. You cannot change your role." });
      }
    }
    // Super admin can update anyone (no additional check needed)

    // Update fields - handle both JSON and FormData
    const { name, email, password, role, cartName, location, phone, address, ...otherFields } = req.body;
    
    if (name !== undefined) user.name = name;
    if (email !== undefined) user.email = email.toLowerCase().trim();
    if (password !== undefined && password.trim() !== "") {
      // Password will be hashed by pre-save hook
      user.password = password;
    }
    if (role !== undefined) {
      // Validate role (only super admin can change roles)
      const validRoles = ["super_admin", "franchise_admin", "admin", "employee", "customer"];
      if (!validRoles.includes(role)) {
        return res.status(400).json({ message: `Invalid role. Must be one of: ${validRoles.join(", ")}` });
      }
      // Only super admin can change roles (checked above)
      user.role = role;
    }
    
    // Update other standard fields
    if (cartName !== undefined) user.cartName = cartName;
    if (location !== undefined) user.location = location;
    if (phone !== undefined) user.phone = phone;
    if (address !== undefined) user.address = address;
    
    // Handle file uploads for cafe admin documents
    let filePaths = {};
    if (req.files) {
      // Delete old files if new ones are being uploaded
      const fs = require("fs");
      const path = require("path");
      const franchiseDocsDir = path.join(__dirname, "..", "uploads", "franchise-docs");
      
      // Process uploaded files
      if (req.files.aadharCard && req.files.aadharCard[0]) {
        // Delete old file if exists
        if (user.aadharCard) {
          const oldFilePath = path.join(__dirname, "..", user.aadharCard);
          if (fs.existsSync(oldFilePath)) {
            try { fs.unlinkSync(oldFilePath); } catch (err) { console.error("Error deleting old aadharCard:", err); }
          }
        }
        filePaths.aadharCard = `/uploads/franchise-docs/${req.files.aadharCard[0].filename}`;
      }
      if (req.files.panCard && req.files.panCard[0]) {
        if (user.panCard) {
          const oldFilePath = path.join(__dirname, "..", user.panCard);
          if (fs.existsSync(oldFilePath)) {
            try { fs.unlinkSync(oldFilePath); } catch (err) { console.error("Error deleting old panCard:", err); }
          }
        }
        filePaths.panCard = `/uploads/franchise-docs/${req.files.panCard[0].filename}`;
      }
      if (req.files.gstCertificate && req.files.gstCertificate[0]) {
        if (user.gstCertificate) {
          const oldFilePath = path.join(__dirname, "..", user.gstCertificate);
          if (fs.existsSync(oldFilePath)) {
            try { fs.unlinkSync(oldFilePath); } catch (err) { console.error("Error deleting old gstCertificate:", err); }
          }
        }
        filePaths.gstCertificate = `/uploads/franchise-docs/${req.files.gstCertificate[0].filename}`;
      }
      if (req.files.shopActLicense && req.files.shopActLicense[0]) {
        if (user.shopActLicense) {
          const oldFilePath = path.join(__dirname, "..", user.shopActLicense);
          if (fs.existsSync(oldFilePath)) {
            try { fs.unlinkSync(oldFilePath); } catch (err) { console.error("Error deleting old shopActLicense:", err); }
          }
        }
        filePaths.shopActLicense = `/uploads/franchise-docs/${req.files.shopActLicense[0].filename}`;
      }
      if (req.files.fssaiLicense && req.files.fssaiLicense[0]) {
        if (user.fssaiLicense) {
          const oldFilePath = path.join(__dirname, "..", user.fssaiLicense);
          if (fs.existsSync(oldFilePath)) {
            try { fs.unlinkSync(oldFilePath); } catch (err) { console.error("Error deleting old fssaiLicense:", err); }
          }
        }
        filePaths.fssaiLicense = `/uploads/franchise-docs/${req.files.fssaiLicense[0].filename}`;
      }
      if (req.files.electricityBill && req.files.electricityBill[0]) {
        if (user.electricityBill) {
          const oldFilePath = path.join(__dirname, "..", user.electricityBill);
          if (fs.existsSync(oldFilePath)) {
            try { fs.unlinkSync(oldFilePath); } catch (err) { console.error("Error deleting old electricityBill:", err); }
          }
        }
        filePaths.electricityBill = `/uploads/franchise-docs/${req.files.electricityBill[0].filename}`;
      }
      if (req.files.rentAgreement && req.files.rentAgreement[0]) {
        if (user.rentAgreement) {
          const oldFilePath = path.join(__dirname, "..", user.rentAgreement);
          if (fs.existsSync(oldFilePath)) {
            try { fs.unlinkSync(oldFilePath); } catch (err) { console.error("Error deleting old rentAgreement:", err); }
          }
        }
        filePaths.rentAgreement = `/uploads/franchise-docs/${req.files.rentAgreement[0].filename}`;
      }
    }

    // Update other fields (cartName, location, phone, address, etc.)
    Object.keys(otherFields).forEach(key => {
      if (otherFields[key] !== undefined) {
        // Prevent franchise admin from changing franchiseId
        if (key === "franchiseId" && req.user.role === "franchise_admin") {
          return; // Skip this field
        }
        // Skip document fields if they're coming from req.body (should come from req.files)
        if (['aadharCard', 'panCard', 'gstCertificate', 'shopActLicense', 'fssaiLicense', 'electricityBill', 'rentAgreement'].includes(key)) {
          return; // Skip these - they're handled via file uploads
        }
        // Skip expiry date fields - they're handled separately (only for documents that can expire)
        if (['gstCertificateExpiry', 'shopActLicenseExpiry', 'fssaiLicenseExpiry'].includes(key)) {
          return; // Skip these - they're handled separately
        }
        user[key] = otherFields[key];
      }
    });

    // Update document file paths if new files were uploaded
    if (filePaths.aadharCard) user.aadharCard = filePaths.aadharCard;
    if (filePaths.panCard) user.panCard = filePaths.panCard;
    if (filePaths.gstCertificate) user.gstCertificate = filePaths.gstCertificate;
    if (filePaths.shopActLicense) user.shopActLicense = filePaths.shopActLicense;
    if (filePaths.fssaiLicense) user.fssaiLicense = filePaths.fssaiLicense;
    if (filePaths.electricityBill) user.electricityBill = filePaths.electricityBill;
    if (filePaths.rentAgreement) user.rentAgreement = filePaths.rentAgreement;

    // Update document expiry dates if provided (only for documents that can expire)
    const {
      gstCertificateExpiry,
      shopActLicenseExpiry,
      fssaiLicenseExpiry,
    } = req.body;

    // Skip document expiry fields if they're coming from req.body (should be handled separately)
    if (gstCertificateExpiry !== undefined) {
      user.gstCertificateExpiry = gstCertificateExpiry ? new Date(gstCertificateExpiry) : null;
    }
    if (shopActLicenseExpiry !== undefined) {
      user.shopActLicenseExpiry = shopActLicenseExpiry ? new Date(shopActLicenseExpiry) : null;
    }
    if (fssaiLicenseExpiry !== undefined) {
      user.fssaiLicenseExpiry = fssaiLicenseExpiry ? new Date(fssaiLicenseExpiry) : null;
    }

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
    const user = await User.findById(req.params.id);
    
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    
    if (user.role !== "franchise_admin") {
      return res.status(400).json({ message: "Only franchise admins can have their status toggled" });
    }
    
    user.isActive = user.isActive === false ? true : false;
    await user.save();
    
    // Automatically toggle all carts under this franchise
    const franchiseId = user._id;
    const carts = await User.find({
      role: "admin",
      franchiseId: franchiseId
    });
    
    if (carts.length > 0) {
      await User.updateMany(
        { role: "admin", franchiseId: franchiseId },
        { $set: { isActive: user.isActive } }
      );
    }
    
    res.json({
      success: true,
      message: `Franchise ${user.isActive ? 'activated' : 'deactivated'} successfully. ${carts.length} cart(s) under this franchise have been ${user.isActive ? 'activated' : 'deactivated'}.`,
      data: {
        _id: user._id,
        name: user.name,
        email: user.email,
        isActive: user.isActive,
        cartsUpdated: carts.length
      }
    });
  } catch (error) {
    console.error('[TOGGLE] Error:', error);
    res.status(500).json({ message: error.message });
  }
};

// @desc    Generate franchise code for current user (franchise admin only)
// @route   POST /api/users/generate-franchise-code
exports.generateMyFranchiseCode = async (req, res) => {
  try {
    const userId = req.user._id;
    
    // Get the current user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    
    if (user.role !== "franchise_admin") {
      return res.status(403).json({ message: "Only franchise admins can generate franchise codes" });
    }
    
    // Check if code already exists
    if (user.franchiseCode) {
      return res.json({
        message: "Franchise code already exists",
        franchiseCode: user.franchiseCode,
        franchiseShortcut: user.franchiseShortcut
      });
    }
    
    // Generate new franchise code
    const { generateFranchiseCode } = require("../utils/codeGenerator");
    const codeData = await generateFranchiseCode(user.name);
    
    // Update user with the new code
    user.franchiseShortcut = codeData.franchiseShortcut;
    user.franchiseSequence = codeData.franchiseSequence;
    user.franchiseCode = codeData.franchiseCode;
    await user.save();
    
    console.log(`[FRANCHISE CODE] Generated: ${codeData.franchiseCode} for franchise "${user.name}" (${userId})`);
    
    res.json({
      success: true,
      message: "Franchise code generated successfully",
      franchiseCode: codeData.franchiseCode,
      franchiseShortcut: codeData.franchiseShortcut
    });
  } catch (error) {
    console.error("Error generating franchise code:", error);
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
    
    // For franchise admins, check if requester is super_admin
    // Super admin can permanently delete, others can only deactivate
    if (userToDelete.role === "franchise_admin") {
      // If requester is NOT super_admin, only deactivate
      if (req.user.role !== "super_admin") {
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
      // Super admin can proceed with actual deletion below
    }
    
    // For franchise admins (super admin only) and cafe admins, proceed with actual deletion
    // Import Order model for order operations
    const Order = require("../models/orderModel");

    // If deleting a franchise admin (super admin only), clean up all franchise data
    if (userToDelete.role === "franchise_admin") {
      // Find all cafes (admin users) under this franchise
      const cafes = await User.find({ 
        role: "admin", 
        franchiseId: userToDelete._id 
      });
      
      // Delete all cafes under this franchise
      const cartIds = cafes.map(cafe => cafe._id);
      
      // Import models for cleanup
      const { Table } = require("../models/tableModel");
      const { Payment } = require("../models/paymentModel");
      const { MenuItem } = require("../models/menuItemModel");
      const MenuCategory = require("../models/menuCategoryModel");
      const Waitlist = require("../models/waitlistModel");
      const Employee = require("../models/employeeModel");
      
      if (cartIds.length > 0) {
        // CRITICAL: Protect paid orders - they contain revenue data and must NEVER be deleted
        // Only delete non-paid orders (Pending, Confirmed, Preparing, Ready, Served, Cancelled, Returned)
        const nonPaidStatuses = ["Pending", "Confirmed", "Preparing", "Ready", "Served", "Cancelled", "Returned"];
        
        // Get all orders (both paid and non-paid) for reporting
        const allOrders = await Order.find({ 
          $or: [
            { cartId: { $in: cartIds } },
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
            { cartId: { $in: cartIds } },
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
        
        // Delete employees belonging to these cafes or franchise
        await Employee.deleteMany({ 
          $or: [
            { cartId: { $in: cartIds } },
            { franchiseId: userToDelete._id }
          ]
        });
        
        // Delete menu items belonging to these cafes
        await MenuItem.deleteMany({ cartId: { $in: cartIds } });
        
        // Delete menu categories belonging to these cafes
        await MenuCategory.deleteMany({ cartId: { $in: cartIds } });
        
        // Delete tables belonging to these cafes
        await Table.deleteMany({ cartId: { $in: cartIds } });
        
        // Delete ONLY non-paid orders - paid orders are preserved for revenue tracking
        if (nonPaidOrderIds.length > 0) {
          await Order.deleteMany({ 
            _id: { $in: nonPaidOrderIds }
          });
        }
        
        // Delete cafes (this removes all cafe login credentials and data)
        await User.deleteMany({ _id: { $in: cartIds } });
        
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
        // No cafes, but still clean up any tables/orders/employees directly linked to franchise
        // CRITICAL: Protect paid orders - they contain revenue data
        const nonPaidStatuses = ["Pending", "Confirmed", "Preparing", "Ready", "Served", "Cancelled", "Returned"];
        
        const { Table } = require("../models/tableModel");
        const { Payment } = require("../models/paymentModel");
        const Waitlist = require("../models/waitlistModel");
        const Employee = require("../models/employeeModel");
        
        // Delete franchise-level employees
        await Employee.deleteMany({ franchiseId: userToDelete._id });
        
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

    // If deleting a cafe admin, clean up their data
    if (userToDelete.role === "admin") {
      // Find all cafes (admin users) under this franchise
      const cafes = await User.find({ 
        role: "admin", 
        franchiseId: userToDelete._id 
      });
      
      // Delete all cafes under this franchise
      const cartIds = cafes.map(cafe => cafe._id);
      
      // Import models for cleanup (Order already imported above)
      const { Table } = require("../models/tableModel");
      const { Payment } = require("../models/paymentModel");
      const { MenuItem } = require("../models/menuItemModel");
      const MenuCategory = require("../models/menuCategoryModel");
      const Waitlist = require("../models/waitlistModel");
      
      if (cartIds.length > 0) {
        // CRITICAL: Protect paid orders - they contain revenue data and must NEVER be deleted
        // Only delete non-paid orders (Pending, Confirmed, Preparing, Ready, Served, Cancelled, Returned)
        const nonPaidStatuses = ["Pending", "Confirmed", "Preparing", "Ready", "Served", "Cancelled", "Returned"];
        
        // Get all orders (both paid and non-paid) for reporting
        const allOrders = await Order.find({ 
          $or: [
            { cartId: { $in: cartIds } },
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
            { cartId: { $in: cartIds } },
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
        await MenuItem.deleteMany({ cartId: { $in: cartIds } });
        
        // Delete menu categories belonging to these cafes
        await MenuCategory.deleteMany({ cartId: { $in: cartIds } });
        
        // Delete tables belonging to these cafes
        await Table.deleteMany({ cartId: { $in: cartIds } });
        
        // Delete ONLY non-paid orders - paid orders are preserved for revenue tracking
        if (nonPaidOrderIds.length > 0) {
          await Order.deleteMany({ 
            _id: { $in: nonPaidOrderIds }
          });
        }
        
        // Delete cafes (this removes all cafe login credentials and data)
        await User.deleteMany({ _id: { $in: cartIds } });
        
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
      const allCafeOrders = await Order.find({ cartId: userToDelete._id }).select('_id status').lean();
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
        cartId: userToDelete._id,
        status: "Paid"
      }).countDocuments();
      preservedPaidOrdersCount = preservedOrders;
    }
    
    let message = "User removed";
    if (userToDelete.role === "franchise_admin") {
      message = `Franchise permanently deleted. All associated cafes, employees, and data removed. ${preservedPaidOrdersCount} paid orders preserved for revenue tracking.`;
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
