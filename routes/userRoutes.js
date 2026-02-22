const express = require("express");
const router = express.Router();
const {
  loginUser,
  getUsers,
  getCartStatistics,
  createUser,
  registerCafeAdmin,
  approveCafeAdmin,
  rejectCafeAdmin,
  toggleCafeStatus,
  getUserById,
  getMe,
  getEmergencyContacts,
  logoutUser,
  updateUser,
  updateEmergencyContacts,
  toggleFranchiseStatus,
  bulkUpdateAdministrativeStatus,
  deleteUser,
  uploadFranchiseDocs,
  uploadCafeAdminDocs,
  generateMyFranchiseCode,
} = require("../controllers/userController");
const { protect, authorize } = require("../middleware/authMiddleware");
const { rateLimiters } = require("../middleware/securityMiddleware");
const {
  validateRequired,
  validateEmail,
  validatePassword,
  validateObjectId,
} = require("../middleware/validationMiddleware");

// ============= PUBLIC ROUTES =============

// Login with rate limiting and validation
router.post(
  "/login",
  rateLimiters.login,
  validateRequired(["email", "password"]),
  validateEmail("email"),
  loginUser
);

// Public cafe admin registration (for signup page)
router.post(
  "/register-cafe-admin-public",
  rateLimiters.login, // Use login limiter for registration too
  uploadCafeAdminDocs,
  validateRequired(["name", "email", "password", "cartName", "location"]),
  validateEmail("email"),
  validatePassword("password", 6),
  registerCafeAdmin
);

// Protected cafe admin registration (via admin panel)
router.post(
  "/register-cafe-admin",
  protect,
  uploadCafeAdminDocs,
  validateRequired(["name", "email", "password", "cartName", "location"]),
  validateEmail("email"),
  validatePassword("password", 6),
  registerCafeAdmin
);

// ============= PROTECTED ROUTES =============
router.use(protect);

// Get current user (me)
router.get("/me", getMe);

// Emergency contacts for current user's profile/cart
router.get("/emergency-contacts", getEmergencyContacts);
router.put("/emergency-contacts", updateEmergencyContacts);

// Logout user
router.post("/logout", logoutUser);

// Generate franchise code for current user (franchise admin only)
router.post(
  "/generate-franchise-code",
  authorize(["franchise_admin"]),
  generateMyFranchiseCode
);

// User management routes
router.get("/", getUsers);

router.get(
  "/stats/carts",
  authorize(["super_admin", "franchise_admin"]),
  getCartStatistics
);

router.patch(
  "/bulk-status",
  authorize(["super_admin"]),
  bulkUpdateAdministrativeStatus
);

router.get("/:id", validateObjectId("id"), getUserById);

router.post(
  "/",
  authorize(["super_admin"]),
  uploadFranchiseDocs,
  validateRequired(["name", "email", "password", "role"]),
  validateEmail("email"),
  validatePassword("password", 6),
  createUser
);

router.put("/:id", validateObjectId("id"), uploadCafeAdminDocs, updateUser);

router.delete("/:id", validateObjectId("id"), deleteUser);

// Cafe admin management routes
router.patch(
  "/:id/approve",
  validateObjectId("id"),
  authorize(["franchise_admin"]),
  approveCafeAdmin
);

router.patch(
  "/:id/reject",
  validateObjectId("id"),
  authorize(["franchise_admin"]),
  rejectCafeAdmin
);

router.patch(
  "/:id/toggle-cafe-status",
  validateObjectId("id"),
  authorize(["franchise_admin", "super_admin"]),
  toggleCafeStatus
);

// Franchise status toggle (super admin only)
router.patch(
  "/:id/toggle-status",
  validateObjectId("id"),
  authorize(["super_admin"]),
  toggleFranchiseStatus
);

module.exports = router;
