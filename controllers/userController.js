const User = require("../models/userModel");
const Employee = require("../models/employeeModel");
const Cart = require("../models/cartModel");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const {
  generateFranchiseCode,
  generateCartCode,
} = require("../utils/codeGenerator");
const { addSignedUrlsToUser } = require("../utils/signedUrl");

const { getStorageCallback, getFileUrl } = require("../config/uploadConfig");
const franchiseDocsDir = path.join(__dirname, "..", "uploads", "franchise-docs");

const escapeRegex = (value = "") =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const normalizeEmail = (email = "") => String(email).trim().toLowerCase();

const findUserByEmailInsensitive = async (email, excludeUserId = null) => {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;

  const query = {
    email: {
      $regex: `^${escapeRegex(normalizedEmail)}$`,
      $options: "i",
    },
  };

  if (excludeUserId) {
    query._id = { $ne: excludeUserId };
  }

  return User.findOne(query).select("_id email role");
};

const isDuplicateEmailError = (error) =>
  Boolean(error?.code === 11000 && error?.keyPattern?.email);

// Configure multer for franchise document uploads
const uploadFranchise = multer({
  storage: getStorageCallback("franchise-docs"),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
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
const multerFranchiseDocs = uploadFranchise.fields([
  { name: "udyamCertificate", maxCount: 1 },
  { name: "aadharCard", maxCount: 1 },
  { name: "panCard", maxCount: 1 },
]);

// Wrapper middleware that makes multer optional for JSON requests
exports.uploadFranchiseDocs = (req, res, next) => {
  // Only use multer if content-type is multipart/form-data
  if (req.is("multipart/form-data")) {
    return multerFranchiseDocs(req, res, next);
  }
  // For JSON requests, just pass through (files are optional)
  next();
};

// Multer middleware for multiple file uploads (for cafe admin documents)
const multerCafeAdminDocs = uploadFranchise.fields([
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
  if (req.is("multipart/form-data")) {
    return multerCafeAdminDocs(req, res, next);
  }
  // For JSON requests, just pass through (files are optional)
  next();
};

const generateToken = (id) => {
  const secret = String(process.env.JWT_SECRET || "").trim();
  if (!secret) {
    throw new Error("JWT_SECRET is not configured");
  }
  if (secret === "sarva-cafe-secret-key-2025") {
    console.warn(
      "[SECURITY] ⚠️ Using default JWT secret. Set JWT_SECRET in production!"
    );
  }
  return jwt.sign({ id }, secret, {
    expiresIn: "30d",
  });
};

const MOBILE_ROLES = ["waiter", "cook", "captain", "manager", "employee"];

const resolveEmergencyContactOwnerId = async (user) => {
  if (!user) return null;

  if (["admin", "franchise_admin", "super_admin"].includes(user.role)) {
    return user._id;
  }

  if (MOBILE_ROLES.includes(user.role)) {
    if (user.cartId) return user.cartId;
    if (user.cafeId) return user.cafeId;

    const employee = await Employee.findOne({
      $or: [{ userId: user._id }, { email: user.email?.toLowerCase() }],
    })
      .select("cartId cafeId")
      .lean();
    if (employee?.cartId) return employee.cartId;
    if (employee?.cafeId) return employee.cafeId;
  }

  return user._id;
};

const sanitizeEmergencyContacts = (contacts) => {
  if (!Array.isArray(contacts)) return [];

  const cleaned = contacts
    .map((entry) => ({
      name: typeof entry?.name === "string" ? entry.name.trim() : "",
      phone: typeof entry?.phone === "string" ? entry.phone.trim() : "",
      relation:
        typeof entry?.relation === "string" ? entry.relation.trim() : "",
      notes: typeof entry?.notes === "string" ? entry.notes.trim() : "",
      isPrimary: entry?.isPrimary === true,
    }))
    .filter((entry) => entry.phone);

  const firstPrimaryIndex = cleaned.findIndex((entry) => entry.isPrimary);
  return cleaned.map((entry, index) => ({
    ...entry,
    isPrimary:
      firstPrimaryIndex === -1
        ? index === 0
        : index === firstPrimaryIndex,
  }));
};

// @desc    Get emergency contacts for current user's cart/profile
// @route   GET /api/users/emergency-contacts
exports.getEmergencyContacts = async (req, res) => {
  try {
    const ownerId = await resolveEmergencyContactOwnerId(req.user);
    if (!ownerId) {
      return res
        .status(404)
        .json({ message: "No associated cart/profile found for this user" });
    }

    const owner = await User.findById(ownerId)
      .select("managerHelplineNumber phone emergencyContacts")
      .lean();

    if (!owner) {
      return res.status(404).json({ message: "User profile not found" });
    }

    const emergencyContacts = Array.isArray(owner.emergencyContacts)
      ? owner.emergencyContacts
      : [];
    const primaryContact =
      emergencyContacts.find((entry) => entry?.isPrimary) ||
      emergencyContacts[0] ||
      null;

    return res.json({
      success: true,
      data: {
        managerHelplineNumber:
          owner.managerHelplineNumber || owner.phone || primaryContact?.phone || null,
        emergencyContacts,
      },
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Update emergency contacts for current user's cart/profile
// @route   PUT /api/users/emergency-contacts
exports.updateEmergencyContacts = async (req, res) => {
  try {
    if (
      !["admin", "franchise_admin", "super_admin", "manager"].includes(
        req.user.role
      )
    ) {
      return res.status(403).json({
        message: "Access denied. You are not allowed to update emergency contacts.",
      });
    }

    const ownerId = await resolveEmergencyContactOwnerId(req.user);
    if (!ownerId) {
      return res
        .status(404)
        .json({ message: "No associated cart/profile found for this user" });
    }

    const owner = await User.findById(ownerId);
    if (!owner) {
      return res.status(404).json({ message: "User profile not found" });
    }

    if (req.body.managerHelplineNumber !== undefined) {
      owner.managerHelplineNumber =
        typeof req.body.managerHelplineNumber === "string"
          ? req.body.managerHelplineNumber.trim()
          : "";
    }

    if (req.body.emergencyContacts !== undefined) {
      owner.emergencyContacts = sanitizeEmergencyContacts(
        req.body.emergencyContacts
      );
    }

    await owner.save();

    return res.json({
      success: true,
      data: {
        managerHelplineNumber: owner.managerHelplineNumber || owner.phone || null,
        emergencyContacts: owner.emergencyContacts || [],
      },
      message: "Emergency contacts updated successfully",
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Login user
// @route   POST /api/users/login
exports.loginUser = async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validate email and password are provided
    if (!email || !password) {
      return res
        .status(400)
        .json({ message: "Please provide email and password" });
    }

    // Find user by email (case-insensitive)
    const normalizedEmail = normalizeEmail(email);
    let user = await User.findOne({ email: normalizedEmail });

    // Check if this is a mobile app login
    const isMobileLogin = req.headers["x-app-login"] === "mobile";

    // For mobile app login, also check Employee model if User not found
    if (isMobileLogin && !user) {
      const employee = await Employee.findOne({
        email: normalizedEmail,
      }).lean();
      if (employee) {
        // If employee has a userId, get the User account
        if (employee.userId) {
          user = await User.findById(employee.userId);
        }
      }
    }

    // Use generic error message to prevent user enumeration
    if (!user) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    const isMatch = await user.matchPassword(password);

    if (!isMatch) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    // For mobile app login, handle employee roles
    if (isMobileLogin) {
      const allowedMobileRoles = ["waiter", "cook", "captain", "manager"];
      let actualRole = user.role;
      let cafeId = null;
      let franchiseId = null;

      // For all mobile users, look up Employee record to get cafeId
      // Employee model uses email to link to User (no userId field)
      const employee = await Employee.findOne({
        email: normalizedEmail,
      }).lean();

      if (employee) {
        // Check if employee is active
        if (employee.isActive === false) {
          return res.status(403).json({
            message:
              "Your account has been deactivated. Please contact your administrator.",
          });
        }

        // Use employee role if user role is "employee", otherwise use user role
        if (
          user.role === "employee" &&
          allowedMobileRoles.includes(employee.employeeRole)
        ) {
          actualRole = employee.employeeRole;
        }

        // Employee model uses cartId, but User model uses cafeId for backward compatibility
        cafeId = employee.cartId || employee.cafeId; // Support both for backward compatibility
        franchiseId = employee.franchiseId;

        // Ensure bidirectional linking: userId in Employee, cafeId/employeeId in User
        const updatePromises = [];

        // Link userId in Employee if missing
        if (
          !employee.userId ||
          employee.userId.toString() !== user._id.toString()
        ) {
          employee.userId = user._id;
          updatePromises.push(
            Employee.findByIdAndUpdate(employee._id, { userId: user._id })
          );
        }

        // Update User with cafeId and employeeId if missing
        if (!user.cafeId || user.cafeId.toString() !== cafeId?.toString()) {
          updatePromises.push(
            User.findByIdAndUpdate(user._id, {
              cafeId: cafeId,
              employeeId: employee._id,
              franchiseId: franchiseId || user.franchiseId,
            })
          );
          user.cafeId = cafeId;
          user.employeeId = employee._id;
        } else if (
          !user.employeeId ||
          user.employeeId.toString() !== employee._id.toString()
        ) {
          updatePromises.push(
            User.findByIdAndUpdate(user._id, { employeeId: employee._id })
          );
          user.employeeId = employee._id;
        }

        // Execute updates
        if (updatePromises.length > 0) {
          await Promise.all(updatePromises);
          console.log("[LOGIN] Updated Employee-User linking");
        }

        console.log("[LOGIN] Mobile user employee found:", {
          userId: user._id,
          email: normalizedEmail,
          employeeId: employee._id,
          employeeRole: employee.employeeRole,
          actualRole: actualRole,
          cafeId: cafeId,
          franchiseId: franchiseId,
        });
      } else {
        console.log("[LOGIN] No employee record found for mobile user:", {
          userId: user._id,
          email: normalizedEmail,
          userRole: user.role,
        });
      }

      // Check if role is one of the allowed mobile roles
      if (allowedMobileRoles.includes(actualRole)) {
        // Ensure we have cafeId from employee record
        if (!cafeId) {
          return res.status(403).json({
            message:
              "No cafe associated with this account. Please contact your administrator.",
          });
        }
        // Check if user is active
        if (user.isActive === false) {
          return res.status(403).json({
            message:
              "Your account has been deactivated. Please contact your administrator.",
          });
        }

        // Create token and send response for mobile users
        const token = generateToken(user._id);
        return res.json({
          success: true,
          token: token,
          user: {
            _id: user._id,
            name: user.name,
            email: user.email,
            role: actualRole, // Use the actual role (waiter, cook, captain, manager)
            cafeId: cafeId || user.cafeId,
            cartId: cafeId || user.cafeId || user.cartId, // Mobile app uses cartId for socket/inventory
            employeeId: user.employeeId,
            franchiseId: franchiseId || user.franchiseId,
            franchiseCode: user.franchiseCode,
            cartCode: user.cartCode,
          },
        });
      }

      // If not an allowed role, deny access
      return res.status(403).json({
        message:
          "Access denied. Mobile app login is only available for waiter, cook, captain, and manager roles.",
      });
    }

    // For web/admin login, allow admin, franchise_admin, and super_admin roles
    if (!["admin", "super_admin", "franchise_admin"].includes(user.role)) {
      return res.status(403).json({ message: "Access denied. Admin only." });
    }

    // Create token and send response
    const token = generateToken(user._id);
    res.json({
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      token: token,
    });
  } catch (error) {
    console.error("[LOGIN] Error:", error.message);
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

    const allCarts = await User.find(query).select("-password").lean();

    // Calculate statistics
    const totalCarts = allCarts.length;
    const activeCarts = allCarts.filter(
      (cart) => cart.isActive !== false && cart.isApproved === true
    ).length;
    const inactiveCarts = allCarts.filter(
      (cart) => cart.isActive === false || cart.isApproved === false
    ).length;
    const pendingApproval = allCarts.filter(
      (cart) => cart.isApproved === false
    ).length;

    // For super admin, also group by franchise
    let franchiseStats = null;
    if (req.user && req.user.role === "super_admin") {
      const franchises = await User.find({ role: "franchise_admin" })
        .select("_id name isActive")
        .lean();

      franchiseStats = franchises.map((franchise) => {
        const franchiseCarts = allCarts.filter(
          (cart) =>
            cart.franchiseId &&
            cart.franchiseId.toString() === franchise._id.toString()
        );

        // Cart is only active if: cart is approved, cart isActive is true, AND franchise is active
        const activeCartsCount = franchiseCarts.filter(
          (c) =>
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
          pendingApproval: franchiseCarts.filter((c) => c.isApproved === false)
            .length,
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

    const users = await User.find(query).select("-password").lean();

    // Add signed URLs for documents
    const usersWithSignedUrls = await Promise.all(users.map((user) => addSignedUrlsToUser(user)));

    // For super admin, add effective status for cart admins based on their franchise status
    if (req.user && req.user.role === "super_admin") {
      // Get all franchise statuses
      const franchises = await User.find({ role: "franchise_admin" })
        .select("_id isActive")
        .lean();
      const franchiseStatusMap = {};
      franchises.forEach((f) => {
        franchiseStatusMap[f._id.toString()] = f.isActive !== false;
      });

      // Add effectiveStatus and franchiseActive fields to each user
      const usersWithStatus = usersWithSignedUrls.map((user) => {
        if (user.role === "admin" && user.franchiseId) {
          const franchiseActive =
            franchiseStatusMap[user.franchiseId.toString()];
          // Cart is only effectively active if BOTH cart AND franchise are active
          const effectivelyActive = user.isActive !== false && franchiseActive;
          return {
            ...user,
            franchiseActive: franchiseActive,
            effectivelyActive: effectivelyActive,
          };
        }
        return {
          ...user,
          effectivelyActive: user.isActive !== false,
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
      return res
        .status(400)
        .json({ message: "Please provide name, email, password, and role" });
    }

    // Check if email already exists
    const normalizedEmail = normalizeEmail(email);
    const existingUser = await findUserByEmailInsensitive(normalizedEmail);
    if (existingUser) {
      return res.status(409).json({ message: "Email already registered" });
    }

    // Validate role
    const validRoles = [
      "super_admin",
      "franchise_admin",
      "admin",
      "employee",
      "customer",
    ];
    if (!validRoles.includes(role)) {
      return res.status(400).json({
        message: `Invalid role. Must be one of: ${validRoles.join(", ")}`,
      });
    }

    // Handle file uploads for franchise admin
    let filePaths = {};
    if (req.files) {
      // Process uploaded files
      if (req.files.udyamCertificate && req.files.udyamCertificate[0]) {
        filePaths.udyamCertificate = getFileUrl(req, req.files.udyamCertificate[0], "franchise-docs");
      }
      if (req.files.aadharCard && req.files.aadharCard[0]) {
        filePaths.aadharCard = getFileUrl(req, req.files.aadharCard[0], "franchise-docs");
      }
      if (req.files.panCard && req.files.panCard[0]) {
        filePaths.panCard = getFileUrl(req, req.files.panCard[0], "franchise-docs");
      }
    }

    const userData = {
      name,
      email: normalizedEmail,
      password,
      role,
    };

    // CRITICAL: For cart admin (role: "admin"), set directly approved and active
    if (role === "admin") {
      userData.isApproved = true; // Directly approved when cart is created
      userData.isActive = true; // Directly active when cart is created
      userData.approvedBy = req.user?._id || null; // Set approved by if user is creating
      userData.approvedAt = new Date(); // Set approval timestamp
      console.log(`[CREATE_USER] ✅ Cart admin created with isApproved: true, isActive: true`);
    }

    // Add franchise admin specific fields
    if (role === "franchise_admin") {
      if (mobile) userData.mobile = mobile;
      if (gstNumber) userData.fssaiNumber = gstNumber; // Allow 'gstNumber' from body but save as fssaiNumber if migration is needed, or just rename var.
      // Better:
      if (req.body.fssaiNumber) userData.fssaiNumber = req.body.fssaiNumber;
      if (req.body.gstNumber && !userData.fssaiNumber) userData.fssaiNumber = req.body.gstNumber; // Fallback

      if (filePaths.udyamCertificate)
        userData.udyamCertificate = filePaths.udyamCertificate;
      if (filePaths.aadharCard) userData.aadharCard = filePaths.aadharCard;
      if (filePaths.panCard) userData.panCard = filePaths.panCard;

      // Generate unique Franchise Code (e.g., MAH001, ABC002) - REQUIRED
      // This is mandatory for all new franchises
      const franchiseCodeData = await generateFranchiseCode(name);
      if (!franchiseCodeData || !franchiseCodeData.franchiseCode) {
        return res.status(500).json({
          message: "Failed to generate franchise code. Please try again.",
        });
      }
      userData.franchiseShortcut = franchiseCodeData.franchiseShortcut;
      userData.franchiseSequence = franchiseCodeData.franchiseSequence;
      userData.franchiseCode = franchiseCodeData.franchiseCode;
      console.log(
        `[FRANCHISE CODE] ✅ Generated: ${franchiseCodeData.franchiseCode} for "${name}"`
      );
    }

    const user = await User.create(userData);

    // CRITICAL: When a new franchise is created, automatically clone the global default menu
    // This gives the franchise its own default menu template (independent from global)
    // The franchise admin can then customize this menu, and it will be used for all carts
    if (role === "franchise_admin") {
      try {
        console.log(`[DEFAULT MENU] ========================================`);
        console.log(
          `[DEFAULT MENU] 🆕 NEW FRANCHISE CREATED: ${user.name} (ID: ${user._id})`
        );
        console.log(
          `[DEFAULT MENU] Automatically cloning global default menu to franchise...`
        );

        const {
          cloneGlobalDefaultMenuToFranchise,
        } = require("../utils/cloneDefaultMenuToFranchise");
        const result = await cloneGlobalDefaultMenuToFranchise(user._id);

        if (result.success) {
          console.log(
            `[DEFAULT MENU] ✅ Successfully cloned global menu to franchise ${user.name}`
          );
          console.log(
            `[DEFAULT MENU] Franchise now has ${result.categoryCount} categories with ${result.itemCount} items`
          );
          console.log(
            `[DEFAULT MENU] Franchise can now customize this menu, and all carts will use it`
          );
        } else {
          console.warn(`[DEFAULT MENU] ⚠️ ${result.message}`);
          if (result.message.includes("No global default menu")) {
            console.warn(
              `[DEFAULT MENU] Super admin must create a global default menu first.`
            );
            console.warn(
              `[DEFAULT MENU] Once created, franchise can customize their menu.`
            );
          }
        }
        console.log(`[DEFAULT MENU] ========================================`);
      } catch (err) {
        console.error(
          "[DEFAULT MENU] ❌ Failed to clone menu to franchise:",
          err
        );
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
      Object.values(req.files).forEach((fileArray) => {
        if (fileArray && fileArray[0]) {
          const filePath = path.join(franchiseDocsDir, fileArray[0].filename);
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
        }
      });
    }
    if (isDuplicateEmailError(error)) {
      return res.status(409).json({ message: "Email already registered" });
    }
    res.status(400).json({ message: error.message });
  }
};

// @desc    Register new cafe admin (franchise admin endpoint)
// @route   POST /api/users/register-cafe-admin
exports.registerCafeAdmin = async (req, res) => {
  try {
    const { name, email, password, cartName, location, phone, address } =
      req.body;

    // Validate required fields
    if (!name || !email || !password || !cartName || !location) {
      return res.status(400).json({
        message:
          "Please provide name, email, password, cafe name, and location",
      });
    }

    // Check if email already exists
    const normalizedEmail = normalizeEmail(email);
    const existingUser = await findUserByEmailInsensitive(normalizedEmail);
    if (existingUser) {
      return res.status(409).json({ message: "Email already registered" });
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
      return res
        .status(400)
        .json({ message: "Franchise ID is required for registration" });
    }

    // Look up franchise FSSAI number so new carts can inherit it by default
    let franchiseFssaiNumber = null;
    if (franchiseId) {
      const franchiseUser = await User.findById(franchiseId).select(
        "fssaiNumber gstNumber"
      );
      if (franchiseUser) {
        franchiseFssaiNumber = franchiseUser.fssaiNumber || franchiseUser.gstNumber;
      }
    }

    // Handle file uploads for cafe admin documents
    let filePaths = {};
    if (req.files) {
      // Process uploaded files
      if (req.files.aadharCard && req.files.aadharCard[0]) {
        filePaths.aadharCard = getFileUrl(req, req.files.aadharCard[0], "franchise-docs");
      }
      if (req.files.panCard && req.files.panCard[0]) {
        filePaths.panCard = getFileUrl(req, req.files.panCard[0], "franchise-docs");
      }
      if (req.files.gstCertificate && req.files.gstCertificate[0]) {
        filePaths.gstCertificate = getFileUrl(req, req.files.gstCertificate[0], "franchise-docs");
      }
      if (req.files.shopActLicense && req.files.shopActLicense[0]) {
        filePaths.shopActLicense = getFileUrl(req, req.files.shopActLicense[0], "franchise-docs");
      }
      if (req.files.fssaiLicense && req.files.fssaiLicense[0]) {
        filePaths.fssaiLicense = getFileUrl(req, req.files.fssaiLicense[0], "franchise-docs");
      }
      if (req.files.electricityBill && req.files.electricityBill[0]) {
        filePaths.electricityBill = getFileUrl(req, req.files.electricityBill[0], "franchise-docs");
      }
      if (req.files.rentAgreement && req.files.rentAgreement[0]) {
        filePaths.rentAgreement = getFileUrl(req, req.files.rentAgreement[0], "franchise-docs");
      }
    }

    // Parse expiry dates from request body (only for documents that can expire)
    const { gstCertificateExpiry, shopActLicenseExpiry, fssaiLicenseExpiry } =
      req.body;

    // Create cafe admin user - directly approved and active
    const userData = {
      name,
      email: normalizedEmail,
      password,
      role: "admin",
      cartName,
      location,
      phone: phone || undefined,
      address: address || undefined,
      isApproved: true, // Directly approved when cart is created
      isActive: true, // Directly active when cart is created
      approvedBy: req.user?._id || null, // Set approved by if user is creating
      approvedAt: new Date(), // Set approval timestamp
      franchiseId: franchiseId, // Link to franchise
    };

    // If FSSAI number is provided explicitly for the cart, keep it.
    // Otherwise, inherit from the parent franchise.
    if (req.body.fssaiNumber) {
        userData.fssaiNumber = req.body.fssaiNumber;
    } else if (req.body.gstNumber) {
        userData.fssaiNumber = req.body.gstNumber; // Fallback
    } else if (franchiseFssaiNumber) {
        userData.fssaiNumber = franchiseFssaiNumber;
    }

    // Agent log removed for stability

    // Generate unique Cart Code (e.g., MAH001, MAH002 - based on franchise shortcut) - REQUIRED
    if (franchiseId) {
      const cartCodeData = await generateCartCode(franchiseId);
      if (!cartCodeData || !cartCodeData.cartCode) {
        return res
          .status(500)
          .json({ message: "Failed to generate cart code. Please try again." });
      }
      userData.cartSequence = cartCodeData.cartSequence;
      userData.cartCode = cartCodeData.cartCode;
      console.log(
        `[CART CODE] ✅ Generated: ${cartCodeData.cartCode} for cart "${cartName}"`
      );
    }

    // Add document file paths if uploaded
    if (filePaths.aadharCard) userData.aadharCard = filePaths.aadharCard;
    if (filePaths.panCard) userData.panCard = filePaths.panCard;
    if (filePaths.gstCertificate)
      userData.gstCertificate = filePaths.gstCertificate;
    if (filePaths.shopActLicense)
      userData.shopActLicense = filePaths.shopActLicense;
    if (filePaths.fssaiLicense) userData.fssaiLicense = filePaths.fssaiLicense;
    if (filePaths.electricityBill)
      userData.electricityBill = filePaths.electricityBill;
    if (filePaths.rentAgreement)
      userData.rentAgreement = filePaths.rentAgreement;

    // Add document expiry dates if provided (only for documents that can expire)
    if (gstCertificateExpiry)
      userData.gstCertificateExpiry = new Date(gstCertificateExpiry);
    if (shopActLicenseExpiry)
      userData.shopActLicenseExpiry = new Date(shopActLicenseExpiry);
    if (fssaiLicenseExpiry)
      userData.fssaiLicenseExpiry = new Date(fssaiLicenseExpiry);

    const user = await User.create(userData);

    // CRITICAL: Initialize new cart with EMPTY operational data
    // This ensures the cart starts fresh with no orders, tables, or dashboard data
    try {
      const { initializeNewCart } = require("../utils/initializeNewCart");
      const cartFranchiseId = user.franchiseId
        ? user.franchiseId.toString()
        : null;

      if (cartFranchiseId) {
        await initializeNewCart(user._id, cartFranchiseId);
      } else {
        console.warn(
          `[CART INIT] ⚠️ No franchiseId for cart ${user.cartName} - skipping initialization`
        );
      }
    } catch (err) {
      console.error("[CART INIT] ❌ Failed to initialize new cart:", err);
      console.error("[CART INIT] Error details:", err.message);
      // Don't fail user creation if initialization fails - cart will still work
    }

    // CRITICAL: Push franchise's UNIQUE default menu to new cart
    // Each franchise has ONE unique menu, and cart gets EXACTLY that menu
    // NOTE: Menu structure is copied (configuration), but NO operational data is copied
    try {
      const { pushDefaultMenuToCafe } = require("./defaultMenuController");
      // Use the saved user's franchiseId (which should be set from franchiseId variable)
      const menuFranchiseId = user.franchiseId
        ? user.franchiseId.toString()
        : null;

      console.log(`[DEFAULT MENU] ========================================`);
      console.log(
        `[DEFAULT MENU] 🆕 NEW CART CREATED: ${user.cartName} (ID: ${user._id})`
      );
      console.log(`[DEFAULT MENU] Franchise ID: ${menuFranchiseId}`);
      console.log(
        `[DEFAULT MENU] Logic: Cart belongs to franchise → Cart gets franchise's UNIQUE menu`
      );
      console.log(
        `[DEFAULT MENU] IMPORTANT: Only menu STRUCTURE is copied (configuration), NOT operational data`
      );

      if (!menuFranchiseId) {
        console.error(
          `[DEFAULT MENU] ❌ ERROR: No franchiseId for cart ${user.cartName}. Cart must belong to a franchise to get menu.`
        );
        console.error(
          `[DEFAULT MENU] Cart data: franchiseId=${user.franchiseId}, role=${user.role}, cartName=${user.cartName}`
        );
      } else {
        // CRITICAL: Get franchise's UNIQUE menu and sync EXACTLY that to the cart
        // This ensures cart gets exactly what franchise admin defined
        console.log(
          `[DEFAULT MENU] 🔄 Syncing franchise ${menuFranchiseId}'s UNIQUE menu to NEW cart ${user.cartName}`
        );
        console.log(
          `[DEFAULT MENU] Cart will get EXACTLY what franchise admin defined in their default menu`
        );
        console.log(
          `[DEFAULT MENU] This is a clean sync - all old menu data will be deleted first`
        );
        console.log(
          `[DEFAULT MENU] Operational data (orders, tables, dashboard) remains EMPTY - not copied`
        );

        const result = await pushDefaultMenuToCafe(
          user._id,
          menuFranchiseId,
          true
        ); // true = replace mode (clean sync)

        if (result.success) {
          console.log(
            `[DEFAULT MENU] ✅ Cart ${user.cartName} now has franchise ${menuFranchiseId}'s EXACT menu`
          );
          console.log(
            `[DEFAULT MENU] Created: ${result.categoriesCreated} categories, ${result.itemsCreated} items`
          );
          console.log(
            `[DEFAULT MENU] Final: ${result.finalCategoryCount} categories, ${result.finalItemCount} items`
          );
          console.log(`[DEFAULT MENU] Cart menu matches franchise menu: ✅`);
          console.log(
            `[DEFAULT MENU] Cart operational data (orders, tables, etc.) remains EMPTY: ✅`
          );
        } else {
          console.warn(
            `[DEFAULT MENU] ⚠️ Push to cart ${user.cartName} returned: ${result.message}`
          );
          console.warn(
            `[DEFAULT MENU] Franchise ${menuFranchiseId} may not have a default menu created yet.`
          );
          console.warn(
            `[DEFAULT MENU] Franchise admin should create a default menu first.`
          );
          // If push failed because menu is empty, that's okay - menu will sync when cart admin opens it
        }
      }
      console.log(`[DEFAULT MENU] ========================================`);
    } catch (err) {
      console.error("[DEFAULT MENU] ❌ Failed to push menu to new cart:", err);
      console.error("[DEFAULT MENU] Error details:", err.message);
      // Don't fail user creation if menu push fails - menu will sync when cart admin opens it
    }

    // CRITICAL: Automatically push super admin ingredients and BOMs to new cart admin
    // ⚠️⚠️⚠️ DISABLED: This was creating DUPLICATE cart-specific BOMs for each new cart
    // NEW APPROACH: All ingredients and BOMs are SHARED (cartId: null) by default
    // Cart admins can see all shared ingredients/BOMs without needing cart-specific copies
    // This prevents duplicates and ensures consistency across all carts
    /* DISABLED - Causing duplicate BOMs
    try {
      const { pushToCartAdminsInternal } = require("./costing-v2/costingController");
      console.log(`[COSTING PUSH] ========================================`);
      console.log(
        `[COSTING PUSH] 🆕 NEW CART ADMIN CREATED: ${user.cartName} (ID: ${user._id})`
      );
      console.log(
        `[COSTING PUSH] Automatically pushing super admin ingredients and BOMs to cart admin...`
      );

      const result = await pushToCartAdminsInternal(user._id.toString());
      
      if (result.success) {
        console.log(
          `[COSTING PUSH] ✅ Successfully pushed ingredients and BOMs to cart ${user.cartName}`
        );
        console.log(
          `[COSTING PUSH] Ingredients: ${result.data.ingredients.created} created, ${result.data.ingredients.updated} updated`
        );
        console.log(
          `[COSTING PUSH] BOMs: ${result.data.recipes.created} created, ${result.data.recipes.updated} updated`
        );
      } else {
        console.warn(`[COSTING PUSH] ⚠️ ${result.message}`);
      }
      console.log(`[COSTING PUSH] ========================================`);
    } catch (err) {
      console.error("[COSTING PUSH] ❌ Failed to push ingredients/BOMs to new cart:", err);
      console.error("[COSTING PUSH] Error details:", err.message);
      // Don't fail user creation if push fails - super admin can push manually later
    }
    */
    
    console.log(`[COSTING] ========================================`);
    console.log(`[COSTING] 🆕 NEW CART CREATED: ${user.cartName} (ID: ${user._id})`);
    console.log(`[COSTING] Cart will automatically see all SHARED ingredients and BOMs`);
    console.log(`[COSTING] NO cart-specific copies created (prevents duplicates)`);
    console.log(`[COSTING] ========================================`);

    // Don't send password in response
    const userResponse = user.toObject();
    delete userResponse.password;

    res.status(201).json({
      message:
        "Cafe admin registration successful. Waiting for franchise admin approval.",
      user: userResponse,
    });
  } catch (error) {
    // Clean up uploaded files if user creation fails
    if (req.files) {
      Object.values(req.files).forEach((fileArray) => {
        if (fileArray && fileArray[0]) {
          const filePath = path.join(franchiseDocsDir, fileArray[0].filename);
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
        }
      });
    }
    if (isDuplicateEmailError(error)) {
      return res.status(409).json({ message: "Email already registered" });
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
      return res
        .status(400)
        .json({ message: "Cafe admin is already approved" });
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
      const menuFranchiseId = user.franchiseId
        ? user.franchiseId.toString()
        : null;

      if (!menuFranchiseId) {
        console.error(
          `[DEFAULT MENU] ERROR: Approved cafe ${user.cartName} has no franchiseId. Cannot sync menu.`
        );
      } else {
        console.log(
          `[DEFAULT MENU] 🔄 Syncing menu to approved cafe ${user.cartName} (ID: ${user._id})`
        );
        console.log(
          `[DEFAULT MENU] Using franchise menu: ${menuFranchiseId}, replaceMode: true (clean sync)`
        );

        // CRITICAL: Always use replaceMode: true to prevent duplicates and ensure clean menu
        const result = await pushDefaultMenuToCafe(
          user._id,
          menuFranchiseId,
          true
        );
        if (result.success) {
          console.log(
            `[DEFAULT MENU] ✅ Successfully synced menu to approved cafe ${user.cartName}`
          );
          console.log(
            `[DEFAULT MENU] Created: ${result.categoriesCreated} categories, ${result.itemsCreated} items`
          );
          console.log(
            `[DEFAULT MENU] Final: ${result.finalCategoryCount} categories, ${result.finalItemCount} items`
          );
        } else {
          console.warn(
            `[DEFAULT MENU] ⚠️ Push to approved cafe ${user.cartName} returned: ${result.message}`
          );
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

// @desc    Toggle cart admin active/inactive status (franchise admin or super admin)
// @route   PATCH /api/users/:id/toggle-cafe-status
exports.toggleCafeStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user._id;
    const userRole = req.user.role;

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ message: "Cart admin not found" });
    }

    if (user.role !== "admin") {
      return res.status(400).json({ message: "User is not a cart admin" });
    }

    // For franchise admin: verify the cart belongs to their franchise
    // For super admin: allow toggling any cart
    if (userRole === "franchise_admin") {
      if (user.franchiseId?.toString() !== userId.toString()) {
        return res.status(403).json({
          message:
            "Access denied. This cart does not belong to your franchise.",
        });
      }

      // For franchise admin: check if cart is approved first
      if (!user.isApproved) {
        return res.status(400).json({
          message:
            "Cannot activate/deactivate an unapproved cart. Please approve the cart first.",
        });
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
      const franchise = await User.findById(user.franchiseId).select(
        "isActive role"
      );
      if (
        franchise &&
        franchise.role === "franchise_admin" &&
        franchise.isActive === false
      ) {
        return res.status(400).json({
          message:
            "Cannot activate cart. The franchise is currently deactivated. Please activate the franchise first.",
        });
      }
    }

    user.isActive = !oldStatus;
    await user.save();

    const userResponse = user.toObject();
    delete userResponse.password;

    let message = `Cart ${
      user.isActive ? "activated" : "deactivated"
    } successfully`;
    if (userRole === "super_admin" && wasNotApproved) {
      message = `Cart approved and ${
        user.isActive ? "activated" : "deactivated"
      } successfully`;
    }

    res.json({
      success: true,
      message: message,
      user: userResponse,
    });
  } catch (error) {
    console.error("[TOGGLE CART] Error:", error);
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get single user
// @route   GET /api/users/:id
// @desc    Get current user (me)
// @route   GET /api/users/me
exports.getMe = async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ message: "Not authorized" });
    }

    // For mobile users with role "employee", get the actual employee role
    let userResponse = {
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      cafeId: user.cafeId || user.cartId,
      cartId: user.cartId || user.cafeId, // Mobile app uses cartId for socket/inventory
      franchiseId: user.franchiseId,
      franchiseCode: user.franchiseCode,
      cartCode: user.cartCode,
      isActive: user.isActive,
      // Include GST number so franchise admins can inherit it for new carts
      gstNumber: user.gstNumber,
      // Printer settings for local agent
      printerSettings: user.printerSettings,
    };

    if (user.role === "employee") {
      const employee =
        (await Employee.findOne({ userId: user._id }).lean()) ||
        (user.email
          ? await Employee.findOne({
              email: String(user.email).toLowerCase(),
            }).lean()
          : null);
      if (employee) {
        userResponse.role = employee.employeeRole; // waiter, cook, captain, manager
        userResponse.cafeId = employee.cartId || employee.cafeId;
        userResponse.cartId = employee.cartId || employee.cafeId;
        userResponse.franchiseId = employee.franchiseId;
        userResponse.employeeId = employee._id;
      }
    }

    // Fetch franchise name if franchiseId exists
    if (userResponse.franchiseId) {
      try {
        const franchise = await User.findById(userResponse.franchiseId)
          .select("name")
          .lean();
        if (franchise) {
          userResponse.franchiseName = franchise.name;
        }
      } catch (err) {
        console.error("[GET_ME] Error fetching franchise name:", err.message);
      }
    }

    // Fetch cart name if cafeId exists
    if (userResponse.cafeId) {
      try {
        const cart = await User.findById(userResponse.cafeId)
          .select("cartName name")
          .lean();
        if (cart) {
          userResponse.cartName = cart.cartName || cart.name;
        }
      } catch (err) {
        console.error("[GET_ME] Error fetching cart name:", err.message);
      }
    }

    res.json({
      success: true,
      user: userResponse,
    });
  } catch (error) {
    console.error("[GET_ME] Error:", error.message);
    res.status(500).json({ message: "Server error" });
  }
};

// @desc    Logout user
// @route   POST /api/users/logout
exports.logoutUser = async (req, res) => {
  try {
    // Logout is handled client-side by clearing the token
    // This endpoint just confirms the logout
    res.json({
      success: true,
      message: "Logged out successfully",
    });
  } catch (error) {
    console.error("[LOGOUT] Error:", error.message);
    res.status(500).json({ message: "Server error" });
  }
};

exports.getUserById = async (req, res) => {
  try {
    // Validate ObjectId format to prevent CastError
    const { ObjectId } = require("mongoose").Types;
    if (!ObjectId.isValid(req.params.id)) {
      console.warn(`[GET_USER_BY_ID] Invalid ID format: ${req.params.id}`);
      return res.status(400).json({ message: "Invalid user ID format" });
    }

    const user = await User.findById(req.params.id).select("-password");
    if (!user) {
      console.warn(`[GET_USER_BY_ID] User not found for ID: ${req.params.id}`);
      return res.status(404).json({ message: "User not found" });
    }

    console.log(
      `[GET_USER_BY_ID] Requested user ID: ${req.params.id}, Role: ${user.role}`
    );
    console.log(
      `[GET_USER_BY_ID] Requesting user role: ${req.user.role}, ID: ${req.user._id}`
    );
    console.log(
      `[GET_USER_BY_ID] Requested user address: ${user.address}, location: ${user.location}`
    );

    // Authorization checks:
    // - Super admin: can view any user
    // - Franchise admin: can only view cafe admins under their franchise
    // - Cafe admin: can view themselves OR their franchise admin (for invoice purposes)
    // - Mobile app users (waiter, cook, captain, manager): can view their associated cart/cafe
    if (req.user.role === "franchise_admin") {
      // Franchise admin can view:
      // 1. Cafe admins (role: "admin") under their franchise
      // 2. Employee users (waiter, cook, captain, manager) that belong to their franchise
      if (user.role === "admin") {
        // For cafe admins, check franchise ownership
        if (
          !user.franchiseId ||
          user.franchiseId.toString() !== req.user._id.toString()
        ) {
          return res.status(403).json({
            message:
              "Access denied. This cafe does not belong to your franchise.",
          });
        }
      } else if (["waiter", "cook", "captain", "manager"].includes(user.role)) {
        // For employee users, check if they belong to this franchise
        // Check via employeeId -> Employee -> franchiseId
        if (user.employeeId) {
          const Employee = require("../models/employeeModel");
          const employee = await Employee.findById(user.employeeId)
            .select("franchiseId")
            .lean();
          if (
            !employee ||
            !employee.franchiseId ||
            employee.franchiseId.toString() !== req.user._id.toString()
          ) {
            return res.status(403).json({
              message:
                "Access denied. This employee does not belong to your franchise.",
            });
          }
        } else if (
          user.franchiseId &&
          user.franchiseId.toString() !== req.user._id.toString()
        ) {
          return res.status(403).json({
            message:
              "Access denied. This employee does not belong to your franchise.",
          });
        } else if (!user.franchiseId) {
          // If no franchiseId, deny access (employee must belong to a franchise)
          return res.status(403).json({
            message:
              "Access denied. This employee does not belong to your franchise.",
          });
        }
      } else {
        // For other roles, deny access
        return res.status(403).json({
          message:
            "Access denied. You can only view cafe admins and employees under your franchise.",
        });
      }
    } else if (req.user.role === "admin") {
      // Cafe admin can view themselves OR their franchise admin (for invoice/billing purposes)
      const isSelf = user._id.toString() === req.user._id.toString();
      const isFranchiseAdmin =
        user.role === "franchise_admin" &&
        req.user.franchiseId &&
        user._id.toString() === req.user.franchiseId.toString();

      if (!isSelf && !isFranchiseAdmin) {
        return res.status(403).json({
          message:
            "Access denied. You can only view your own profile or your franchise admin's profile.",
        });
      }
    } else if (
      ["waiter", "cook", "captain", "manager"].includes(req.user.role)
    ) {
      // Mobile app users can view their associated cart/cafe (the cart they work at)
      const isAssociatedCart =
        user.role === "admin" &&
        req.user.cafeId &&
        user._id.toString() === req.user.cafeId.toString();

      // Also allow viewing their own profile
      const isSelf = user._id.toString() === req.user._id.toString();

      if (!isSelf && !isAssociatedCart) {
        console.log(
          `[GET_USER_BY_ID] Access denied for mobile user. isSelf: ${isSelf}, isAssociatedCart: ${isAssociatedCart}`
        );
        console.log(
          `[GET_USER_BY_ID] User cafeId: ${req.user.cafeId}, Requested user ID: ${user._id}`
        );
        return res.status(403).json({
          message:
            "Access denied. You can only view your own profile or your associated cart/cafe.",
        });
      }

      console.log(
        `[GET_USER_BY_ID] Access granted for mobile user to view cart/cafe`
      );
    }
    // Super admin can view anyone (no additional check needed)

    // Add signed URLs for documents
    const userWithSignedUrls = await addSignedUrlsToUser(user);

    console.log(
      `[GET_USER_BY_ID] Returning user data with address: ${userWithSignedUrls.address}, location: ${userWithSignedUrls.location}`
    );
    res.json(userWithSignedUrls);
  } catch (error) {
    console.error(`[GET_USER_BY_ID] Error: ${error.message}`);
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

    // Authorization checks:
    // - Super admin: can update any user
    // - Franchise admin: can only update cafe admins under their franchise (cannot change role)
    // - Cafe admin: can only update themselves (cannot change role)
    if (req.user.role === "franchise_admin") {
      // Allow self-update
      if (user._id.toString() === req.user._id.toString()) {
        // Proceed (self update)
      } else {
        // Franchise admin can only update cafe admins (role: "admin") under their franchise
        if (user.role !== "admin") {
          return res.status(403).json({
            message:
              "Access denied. You can only update cafe admins under your franchise.",
          });
        }
        if (
          !user.franchiseId ||
          user.franchiseId.toString() !== req.user._id.toString()
        ) {
          return res.status(403).json({
            message:
              "Access denied. This cafe does not belong to your franchise.",
          });
        }
      }
      // Franchise admin cannot change role
      if (req.body.role !== undefined && req.body.role !== user.role) {
        return res
          .status(403)
          .json({ message: "Access denied. You cannot change user roles." });
      }
    } else if (req.user.role === "admin") {
      // Cafe admin can only update themselves
      if (user._id.toString() !== req.user._id.toString()) {
        return res.status(403).json({
          message: "Access denied. You can only update your own profile.",
        });
      }
      // Cafe admin cannot change role
      if (req.body.role !== undefined && req.body.role !== user.role) {
        return res
          .status(403)
          .json({ message: "Access denied. You cannot change your role." });
      }
    }
    // Super admin can update anyone (no additional check needed)

    // Update fields - handle both JSON and FormData
    const {
      name,
      email,
      password,
      role,
      cartName,
      location,
      phone,
      address,
      gstNumber,
      fssaiNumber,
      printerSettings,
      ...otherFields
    } = req.body;

    console.log(`[UPDATE_USER] Request body keys: ${Object.keys(req.body).join(", ")}`);
    console.log(`[UPDATE_USER] Extracted name: ${name}`);

    if (name !== undefined) user.name = name;
    if (email !== undefined) {
      const normalizedEmail = normalizeEmail(email);
      if (!normalizedEmail) {
        return res.status(400).json({ message: "Email cannot be empty" });
      }

      const emailOwner = await findUserByEmailInsensitive(
        normalizedEmail,
        user._id
      );
      if (emailOwner) {
        return res.status(409).json({ message: "Email already registered" });
      }

      user.email = normalizedEmail;
    }
    if (password !== undefined && password.trim() !== "") {
      // Password will be hashed by pre-save hook
      user.password = password;
    }

    if (printerSettings !== undefined) {
      if (!user.printerSettings) user.printerSettings = {};
      // Merge existing settings with updates
      user.printerSettings = { 
        ...user.printerSettings, 
        ...printerSettings 
      };
    }
    
    // Handle FSSAI Number / GST Number update
    if (fssaiNumber !== undefined) {
      user.fssaiNumber = fssaiNumber;
    } else if (gstNumber !== undefined) {
      // If gstNumber is provided but fssaiNumber is not, use it as fallback for fssaiNumber
      user.fssaiNumber = gstNumber;
      // Also update gstNumber for backward compatibility if we want (actually schema handles it)
      user.gstNumber = gstNumber;
    }
    if (role !== undefined) {
      // Validate role (only super admin can change roles)
      const validRoles = [
        "super_admin",
        "franchise_admin",
        "admin",
        "employee",
        "customer",
      ];
      if (!validRoles.includes(role)) {
        return res.status(400).json({
          message: `Invalid role. Must be one of: ${validRoles.join(", ")}`,
        });
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
      const franchiseDocsDir = path.join(
        __dirname,
        "..",
        "uploads",
        "franchise-docs"
      );

      // Process uploaded files
      if (req.files.aadharCard && req.files.aadharCard[0]) {
        // Delete old file if exists
        if (user.aadharCard) {
          const oldFilePath = path.join(__dirname, "..", user.aadharCard);
          if (fs.existsSync(oldFilePath)) {
            try {
              fs.unlinkSync(oldFilePath);
            } catch (err) {
              console.error("Error deleting old aadharCard:", err);
            }
          }
        }
        filePaths.aadharCard = `/uploads/franchise-docs/${req.files.aadharCard[0].filename}`;
      }
      if (req.files.panCard && req.files.panCard[0]) {
        if (user.panCard) {
          const oldFilePath = path.join(__dirname, "..", user.panCard);
          if (fs.existsSync(oldFilePath)) {
            try {
              fs.unlinkSync(oldFilePath);
            } catch (err) {
              console.error("Error deleting old panCard:", err);
            }
          }
        }
        filePaths.panCard = `/uploads/franchise-docs/${req.files.panCard[0].filename}`;
      }
      if (req.files.gstCertificate && req.files.gstCertificate[0]) {
        if (user.gstCertificate) {
          const oldFilePath = path.join(__dirname, "..", user.gstCertificate);
          if (fs.existsSync(oldFilePath)) {
            try {
              fs.unlinkSync(oldFilePath);
            } catch (err) {
              console.error("Error deleting old gstCertificate:", err);
            }
          }
        }
        filePaths.gstCertificate = `/uploads/franchise-docs/${req.files.gstCertificate[0].filename}`;
      }
      if (req.files.shopActLicense && req.files.shopActLicense[0]) {
        if (user.shopActLicense) {
          const oldFilePath = path.join(__dirname, "..", user.shopActLicense);
          if (fs.existsSync(oldFilePath)) {
            try {
              fs.unlinkSync(oldFilePath);
            } catch (err) {
              console.error("Error deleting old shopActLicense:", err);
            }
          }
        }
        filePaths.shopActLicense = `/uploads/franchise-docs/${req.files.shopActLicense[0].filename}`;
      }
      if (req.files.fssaiLicense && req.files.fssaiLicense[0]) {
        if (user.fssaiLicense) {
          const oldFilePath = path.join(__dirname, "..", user.fssaiLicense);
          if (fs.existsSync(oldFilePath)) {
            try {
              fs.unlinkSync(oldFilePath);
            } catch (err) {
              console.error("Error deleting old fssaiLicense:", err);
            }
          }
        }
        filePaths.fssaiLicense = `/uploads/franchise-docs/${req.files.fssaiLicense[0].filename}`;
      }
      if (req.files.electricityBill && req.files.electricityBill[0]) {
        if (user.electricityBill) {
          const oldFilePath = path.join(__dirname, "..", user.electricityBill);
          if (fs.existsSync(oldFilePath)) {
            try {
              fs.unlinkSync(oldFilePath);
            } catch (err) {
              console.error("Error deleting old electricityBill:", err);
            }
          }
        }
        filePaths.electricityBill = `/uploads/franchise-docs/${req.files.electricityBill[0].filename}`;
      }
      if (req.files.rentAgreement && req.files.rentAgreement[0]) {
        if (user.rentAgreement) {
          const oldFilePath = path.join(__dirname, "..", user.rentAgreement);
          if (fs.existsSync(oldFilePath)) {
            try {
              fs.unlinkSync(oldFilePath);
            } catch (err) {
              console.error("Error deleting old rentAgreement:", err);
            }
          }
        }
        filePaths.rentAgreement = `/uploads/franchise-docs/${req.files.rentAgreement[0].filename}`;
      }
    }

    // Update other fields (cartName, location, phone, address, etc.)
    Object.keys(otherFields).forEach((key) => {
      if (otherFields[key] !== undefined) {
        // Prevent franchise admin from changing franchiseId
        if (key === "franchiseId" && req.user.role === "franchise_admin") {
          return; // Skip this field
        }
        // Skip document fields if they're coming from req.body (should come from req.files)
        if (
          [
            "aadharCard",
            "panCard",
            "gstCertificate",
            "shopActLicense",
            "fssaiLicense",
            "electricityBill",
            "rentAgreement",
          ].includes(key)
        ) {
          return; // Skip these - they're handled via file uploads
        }
        // Skip expiry date fields - they're handled separately (only for documents that can expire)
        if (
          [
            "gstCertificateExpiry",
            "shopActLicenseExpiry",
            "fssaiLicenseExpiry",
          ].includes(key)
        ) {
          return; // Skip these - they're handled separately
        }
        user[key] = otherFields[key];
      }
    });

    // Update document file paths if new files were uploaded
    if (filePaths.aadharCard) user.aadharCard = filePaths.aadharCard;
    if (filePaths.panCard) user.panCard = filePaths.panCard;
    if (filePaths.gstCertificate)
      user.gstCertificate = filePaths.gstCertificate;
    if (filePaths.shopActLicense)
      user.shopActLicense = filePaths.shopActLicense;
    if (filePaths.fssaiLicense) user.fssaiLicense = filePaths.fssaiLicense;
    if (filePaths.electricityBill)
      user.electricityBill = filePaths.electricityBill;
    if (filePaths.rentAgreement) user.rentAgreement = filePaths.rentAgreement;

    // Update document expiry dates if provided (only for documents that can expire)
    const { gstCertificateExpiry, shopActLicenseExpiry, fssaiLicenseExpiry } =
      req.body;

    // Skip document expiry fields if they're coming from req.body (should be handled separately)
    if (gstCertificateExpiry !== undefined) {
      user.gstCertificateExpiry = gstCertificateExpiry
        ? new Date(gstCertificateExpiry)
        : null;
    }
    if (shopActLicenseExpiry !== undefined) {
      user.shopActLicenseExpiry = shopActLicenseExpiry
        ? new Date(shopActLicenseExpiry)
        : null;
    }
    if (fssaiLicenseExpiry !== undefined) {
      user.fssaiLicenseExpiry = fssaiLicenseExpiry
        ? new Date(fssaiLicenseExpiry)
        : null;
    }

    // Save the user (this will trigger password hashing if password was changed)
    await user.save();

    // Keep customer-facing Cart document in sync with cart admin profile updates.
    // This ensures Pickup/Delivery store name reflects latest admin updates.
    const shouldSyncCartRecord =
      user.role === "admin" &&
      (cartName !== undefined || name !== undefined || location !== undefined);
    if (shouldSyncCartRecord) {
      try {
        const syncedCartName =
          (typeof user.cartName === "string" && user.cartName.trim()) ||
          (typeof user.name === "string" && user.name.trim()) ||
          "Cart";
        const cartUpdate = { name: syncedCartName };
        if (location !== undefined) {
          cartUpdate.location =
            typeof user.location === "string" ? user.location : "";
        }

        if (user.franchiseId) {
          await Cart.findOneAndUpdate(
            { cartAdminId: user._id },
            {
              $set: cartUpdate,
              $setOnInsert: {
                name: syncedCartName,
                franchiseId: user.franchiseId,
                cartAdminId: user._id,
                location:
                  typeof user.location === "string" ? user.location : "",
                pickupEnabled: true,
                deliveryEnabled: false,
                deliveryRadius: 5,
                deliveryCharge: 0,
                isActive: user.isActive !== false,
              },
            },
            { upsert: true }
          );
        } else {
          await Cart.findOneAndUpdate(
            { cartAdminId: user._id },
            { $set: cartUpdate },
            { upsert: false }
          );
        }
      } catch (syncError) {
        console.error(
          `[UPDATE_USER] Cart sync failed for admin ${user._id}:`,
          syncError.message
        );
      }
    }

    // Don't send password in response
    const userResponse = user.toObject();
    delete userResponse.password;

    res.json(userResponse);
  } catch (error) {
    if (isDuplicateEmailError(error)) {
      return res.status(409).json({ message: "Email already registered" });
    }
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
      return res.status(400).json({
        message: "Only franchise admins can have their status toggled",
      });
    }

    user.isActive = user.isActive === false ? true : false;
    await user.save();

    // Automatically toggle all carts under this franchise
    const franchiseId = user._id;
    const carts = await User.find({
      role: "admin",
      franchiseId: franchiseId,
    });

    if (carts.length > 0) {
      await User.updateMany(
        { role: "admin", franchiseId: franchiseId },
        { $set: { isActive: user.isActive } }
      );
    }

    res.json({
      success: true,
      message: `Franchise ${
        user.isActive ? "activated" : "deactivated"
      } successfully. ${carts.length} cart(s) under this franchise have been ${
        user.isActive ? "activated" : "deactivated"
      }.`,
      data: {
        _id: user._id,
        name: user.name,
        email: user.email,
        isActive: user.isActive,
        cartsUpdated: carts.length,
      },
    });
  } catch (error) {
    console.error("[TOGGLE] Error:", error);
    res.status(500).json({ message: error.message });
  }
};

// @desc    Bulk activate/deactivate administrative users by persona (super admin only)
// @route   PATCH /api/users/bulk-status
exports.bulkUpdateAdministrativeStatus = async (req, res) => {
  try {
    const persona = String(req.body?.persona || "")
      .trim()
      .toLowerCase();
    const { isActive } = req.body || {};

    if (!["franchise_admin", "cart_admin"].includes(persona)) {
      return res.status(400).json({
        message:
          "Invalid persona. Allowed values: franchise_admin, cart_admin",
      });
    }

    if (typeof isActive !== "boolean") {
      return res.status(400).json({
        message: "isActive must be a boolean value",
      });
    }

    let updatedFranchises = 0;
    let updatedCarts = 0;
    let skippedCarts = 0;

    if (persona === "franchise_admin") {
      const franchises = await User.find({ role: "franchise_admin" })
        .select("_id")
        .lean();
      const franchiseIds = franchises.map((f) => f._id);

      const franchiseUpdateResult = await User.updateMany(
        { role: "franchise_admin", isActive: { $ne: isActive } },
        { $set: { isActive } }
      );
      updatedFranchises = Number(franchiseUpdateResult?.modifiedCount || 0);

      if (franchiseIds.length > 0) {
        const cartUpdateResult = await User.updateMany(
          {
            role: { $in: ["admin", "cart_admin"] },
            franchiseId: { $in: franchiseIds },
            isActive: { $ne: isActive },
          },
          { $set: { isActive } }
        );
        updatedCarts = Number(cartUpdateResult?.modifiedCount || 0);
      }

      return res.json({
        success: true,
        message: `Franchise admins ${
          isActive ? "activated" : "deactivated"
        } successfully`,
        data: {
          persona,
          isActive,
          updatedFranchises,
          updatedCarts,
          totalUpdated: updatedFranchises + updatedCarts,
        },
      });
    }

    // persona === "cart_admin"
    if (isActive) {
      const activeFranchises = await User.find({
        role: "franchise_admin",
        isActive: { $ne: false },
      })
        .select("_id")
        .lean();
      const activeFranchiseIds = activeFranchises.map((f) => f._id);

      const cartUpdateResult = await User.updateMany(
        {
          role: { $in: ["admin", "cart_admin"] },
          isActive: { $ne: true },
          $or: [
            { franchiseId: { $in: activeFranchiseIds } },
            { franchiseId: null },
            { franchiseId: { $exists: false } },
          ],
        },
        {
          $set: {
            isActive: true,
            isApproved: true,
            approvedBy: req.user._id,
            approvedAt: new Date(),
          },
        }
      );
      updatedCarts = Number(cartUpdateResult?.modifiedCount || 0);

      skippedCarts = await User.countDocuments({
        role: { $in: ["admin", "cart_admin"] },
        isActive: { $ne: true },
        franchiseId: { $exists: true, $ne: null, $nin: activeFranchiseIds },
      });
    } else {
      const cartUpdateResult = await User.updateMany(
        { role: { $in: ["admin", "cart_admin"] }, isActive: { $ne: false } },
        { $set: { isActive: false } }
      );
      updatedCarts = Number(cartUpdateResult?.modifiedCount || 0);
    }

    return res.json({
      success: true,
      message: `Cart admins ${
        isActive ? "activated" : "deactivated"
      } successfully`,
      data: {
        persona,
        isActive,
        updatedCarts,
        skippedCarts,
        totalUpdated: updatedCarts,
      },
    });
  } catch (error) {
    console.error("[BULK USER STATUS] Error:", error);
    return res.status(500).json({ message: error.message });
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
      return res.status(403).json({
        message: "Only franchise admins can generate franchise codes",
      });
    }

    // Check if code already exists
    if (user.franchiseCode) {
      return res.json({
        message: "Franchise code already exists",
        franchiseCode: user.franchiseCode,
        franchiseShortcut: user.franchiseShortcut,
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

    console.log(
      `[FRANCHISE CODE] Generated: ${codeData.franchiseCode} for franchise "${user.name}" (${userId})`
    );

    res.json({
      success: true,
      message: "Franchise code generated successfully",
      franchiseCode: codeData.franchiseCode,
      franchiseShortcut: codeData.franchiseShortcut,
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

    // === SECURITY CHECKS ===

    // 1. Never allow deleting a Super Admin
    if (userToDelete.role === "super_admin") {
      return res.status(403).json({ message: "Super Admin accounts cannot be deleted" });
    }

    // 2. Only Super Admin can delete Franchise Admin
    if (userToDelete.role === "franchise_admin" && req.user.role !== "super_admin") {
      // Allow them to deactivate (which logic is below), but not delete
      // Actually, the existing logic below allows deactivation for non-super-admins
      // But we should strictly enforce that only Super Admin can perform the DELETE action
      // The frontend calls DELETE for deactivation, so we must rely on the logic below for that specific case.
      // However, we should block any other role (like 'admin' or 'employee') from even touching this.
      return res.status(403).json({ message: "Only Super Admin can manage Franchise Admins" });
    }

    // 3. Only Super Admin or the owning Franchise Admin can delete a Cart Admin
    if (userToDelete.role === "admin") {
      if (req.user.role === "super_admin") {
        // Allowed
      } else if (req.user.role === "franchise_admin") {
        // Check ownership
        if (userToDelete.franchiseId?.toString() !== req.user._id.toString()) {
           return res.status(403).json({ message: "You can only delete carts belonging to your franchise" });
        }
      } else {
        return res.status(403).json({ message: "Unauthorized to delete this cart" });
      }
    }

    // 4. Block low-level roles from deleting users entirely
    const allowedDeleters = ["super_admin", "franchise_admin", "admin"];
    if (!allowedDeleters.includes(req.user.role)) {
       return res.status(403).json({ message: "You do not have permission to delete users" });
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
          message:
            "Franchise deactivated successfully. All data is preserved and can be reactivated later.",
          data: {
            _id: userToDelete._id,
            name: userToDelete.name,
            email: userToDelete.email,
            isActive: false,
            note: "Franchise is deactivated. Use toggle-status endpoint to reactivate.",
          },
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
        franchiseId: userToDelete._id,
      });

      // Delete all cafes under this franchise
      const cartIds = cafes.map((cafe) => cafe._id);

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
        const nonPaidStatuses = [
          "Pending",
          "Confirmed",
          "Preparing",
          "Ready",
          "Served",
          "Cancelled",
          "Returned",
        ];

        // Get all orders (both paid and non-paid) for reporting
        const allOrders = await Order.find({
          $or: [
            { cartId: { $in: cartIds } },
            { franchiseId: userToDelete._id },
          ],
        })
          .select("_id status")
          .lean();

        // Separate paid and non-paid orders
        const paidOrders = allOrders.filter((o) => o.status === "Paid");
        const nonPaidOrders = allOrders.filter((o) =>
          nonPaidStatuses.includes(o.status)
        );
        const nonPaidOrderIds = nonPaidOrders.map((o) => o._id);

        // Get all table IDs from these cafes before deleting tables
        const tablesToDelete = await Table.find({
          $or: [
            { cartId: { $in: cartIds } },
            { franchiseId: userToDelete._id },
          ],
        })
          .select("_id")
          .lean();
        const tableIds = tablesToDelete.map((t) => t._id);

        // Delete payments associated with NON-PAID orders only
        // Paid orders' payments must be preserved for revenue tracking
        if (nonPaidOrderIds.length > 0) {
          await Payment.deleteMany({
            orderId: { $in: nonPaidOrderIds },
            status: { $ne: "PAID" }, // Extra safety - don't delete PAID payments
          });
        }

        // Delete waitlist entries for these tables
        if (tableIds.length > 0) {
          await Waitlist.deleteMany({ table: { $in: tableIds } });
        }

        // Delete employees belonging to these cafes or franchise
        const employeesToDelete = await Employee.find({
          $or: [
            { cartId: { $in: cartIds } },
            { franchiseId: userToDelete._id },
          ],
        }).select("userId").lean();
        
        const employeeUserIds = employeesToDelete
          .map(e => e.userId)
          .filter(id => id);

        if (employeeUserIds.length > 0) {
          await User.deleteMany({ _id: { $in: employeeUserIds } });
        }

        // AGGRESSIVE CLEANUP: Delete all Users linked to these carts (Waiters, Cooks, etc.)
        // This catches any users that might be orphaned from their Employee records
        if (cartIds.length > 0) {
          await User.deleteMany({ cafeId: { $in: cartIds } });
        }

        await Employee.deleteMany({
          $or: [
            { cartId: { $in: cartIds } },
            { franchiseId: userToDelete._id },
          ],
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
            _id: { $in: nonPaidOrderIds },
          });
        }

        // Delete cafes (this removes all cafe login credentials and data)
        await User.deleteMany({ _id: { $in: cartIds } });

        // Also delete tables and NON-PAID orders directly linked to franchise
        const franchiseAllOrders = await Order.find({
          franchiseId: userToDelete._id,
        })
          .select("_id status")
          .lean();
        const franchisePaidOrders = franchiseAllOrders.filter(
          (o) => o.status === "Paid"
        );
        const franchiseNonPaidOrders = franchiseAllOrders.filter((o) =>
          nonPaidStatuses.includes(o.status)
        );
        const franchiseNonPaidOrderIds = franchiseNonPaidOrders.map(
          (o) => o._id
        );

        if (franchiseNonPaidOrderIds.length > 0) {
          await Payment.deleteMany({
            orderId: { $in: franchiseNonPaidOrderIds },
            status: { $ne: "PAID" },
          });
        }

        const franchiseTables = await Table.find({
          franchiseId: userToDelete._id,
        })
          .select("_id")
          .lean();
        const franchiseTableIds = franchiseTables.map((t) => t._id);
        if (franchiseTableIds.length > 0) {
          await Waitlist.deleteMany({ table: { $in: franchiseTableIds } });
        }

        await Table.deleteMany({ franchiseId: userToDelete._id });

        // Delete ONLY non-paid orders directly linked to franchise
        if (franchiseNonPaidOrderIds.length > 0) {
          await Order.deleteMany({
            _id: { $in: franchiseNonPaidOrderIds },
          });
        }
      } else {
        // No cafes, but still clean up any tables/orders/employees directly linked to franchise
        // CRITICAL: Protect paid orders - they contain revenue data
        const nonPaidStatuses = [
          "Pending",
          "Confirmed",
          "Preparing",
          "Ready",
          "Served",
          "Cancelled",
          "Returned",
        ];

        const { Table } = require("../models/tableModel");
        const { Payment } = require("../models/paymentModel");
        const Waitlist = require("../models/waitlistModel");
        const Employee = require("../models/employeeModel");

        // Delete franchise-level employees
        const franchiseEmployees = await Employee.find({ franchiseId: userToDelete._id }).select("userId").lean();
        const franchiseEmpUserIds = franchiseEmployees
          .map(e => e.userId)
          .filter(id => id);

        if (franchiseEmpUserIds.length > 0) {
          await User.deleteMany({ _id: { $in: franchiseEmpUserIds } });
        }
        
        // AGGRESSIVE CLEANUP: Delete all users linked to this franchise
        // This covers Franchise Employees and potentially missed Cart Admins
        await User.deleteMany({ franchiseId: userToDelete._id, role: { $ne: 'franchise_admin' } });

        await Employee.deleteMany({ franchiseId: userToDelete._id });

        const franchiseAllOrders = await Order.find({
          franchiseId: userToDelete._id,
        })
          .select("_id status")
          .lean();
        const franchisePaidOrders = franchiseAllOrders.filter(
          (o) => o.status === "Paid"
        );
        const franchiseNonPaidOrders = franchiseAllOrders.filter((o) =>
          nonPaidStatuses.includes(o.status)
        );
        const franchiseNonPaidOrderIds = franchiseNonPaidOrders.map(
          (o) => o._id
        );

        if (franchiseNonPaidOrderIds.length > 0) {
          await Payment.deleteMany({
            orderId: { $in: franchiseNonPaidOrderIds },
            status: { $ne: "PAID" },
          });
        }

        const franchiseTables = await Table.find({
          franchiseId: userToDelete._id,
        })
          .select("_id")
          .lean();
        const franchiseTableIds = franchiseTables.map((t) => t._id);
        if (franchiseTableIds.length > 0) {
          await Waitlist.deleteMany({ table: { $in: franchiseTableIds } });
        }

        await Table.deleteMany({ franchiseId: userToDelete._id });

        // Delete ONLY non-paid orders
        if (franchiseNonPaidOrderIds.length > 0) {
          await Order.deleteMany({
            _id: { $in: franchiseNonPaidOrderIds },
          });
        }
      }
    }

    // If deleting a cafe admin, clean up their data
    // If deleting a cafe admin (not franchise admin), clean up their data
    if (userToDelete.role === "admin") {
      const cartId = userToDelete._id;
      // Import models
      const { Table } = require("../models/tableModel");
      const { Payment } = require("../models/paymentModel");
      const { MenuItem } = require("../models/menuItemModel");
      const MenuCategory = require("../models/menuCategoryModel");
      const Waitlist = require("../models/waitlistModel");
      const Employee = require("../models/employeeModel");
      
      // Delete employees associated with this cart
      // First, find employees to get their linked User accounts
      const employeesToDelete = await Employee.find({ cartId: cartId }).select("userId").lean();
      const employeeUserIds = employeesToDelete
        .map(e => e.userId)
        .filter(id => id); // Filter out null/undefined

      // Delete linked User accounts for these employees
      if (employeeUserIds.length > 0) {
        await User.deleteMany({ _id: { $in: employeeUserIds } });
      }

      // AGGRESSIVE CLEANUP: Delete all mobile users linked to this cart (Waiters, Cooks, etc.)
      await User.deleteMany({ cafeId: cartId });

      // Then delete the employee records
      await Employee.deleteMany({ cartId: cartId });

      // Delete menu items and categories
      await MenuItem.deleteMany({ cartId: cartId });
      await MenuCategory.deleteMany({ cartId: cartId });

      // Delete tables and waitlist
      const tablesToDelete = await Table.find({ cartId: cartId }).select("_id").lean();
      const tableIds = tablesToDelete.map((t) => t._id);
      
      if (tableIds.length > 0) {
        await Waitlist.deleteMany({ table: { $in: tableIds } });
      }
      await Table.deleteMany({ cartId: cartId });

      // Handle Orders
      const nonPaidStatuses = [
        "Pending",
        "Confirmed",
        "Preparing",
        "Ready",
        "Served",
        "Cancelled",
        "Returned",
      ];

      // Get all orders for this cafe admin
      const allCafeOrders = await Order.find({ cartId: cartId })
        .select("_id status")
        .lean();

      // Separate paid and non-paid orders
      const cafeNonPaidOrders = allCafeOrders.filter((o) =>
        nonPaidStatuses.includes(o.status)
      );
      const cafeNonPaidOrderIds = cafeNonPaidOrders.map((o) => o._id);

      // Delete only non-paid orders and their payments
      if (cafeNonPaidOrderIds.length > 0) {
        await Payment.deleteMany({
          orderId: { $in: cafeNonPaidOrderIds },
          status: { $ne: "PAID" },
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
        status: "Paid",
      }).countDocuments();
      preservedPaidOrdersCount = preservedOrders;
    } else if (userToDelete.role === "admin") {
      const preservedOrders = await Order.find({
        cartId: userToDelete._id,
        status: "Paid",
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
      warning:
        preservedPaidOrdersCount > 0
          ? "Paid orders and revenue data have been preserved in the database for financial records. Revenue calculations will continue to work."
          : null,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
