const express = require("express");
const {
  getUsers,
  createUser,
  getUserById,
  updateUser,
  deleteUser,
  loginUser,
  registerCafeAdmin,
  approveCafeAdmin,
  rejectCafeAdmin,
  toggleFranchiseStatus,
} = require("../controllers/userController");
const { protect, admin, franchiseAdmin, authorize } = require('../middleware/authMiddleware');

const router = express.Router();

// Public routes
router.post("/login", loginUser);

// Franchise admin can register cafe admins (or super admin)
router.post("/register-cafe-admin", protect, authorize(["franchise_admin", "super_admin"]), registerCafeAdmin);

router.route("/")
  .get(protect, admin, getUsers)     // GET all users (admin only)
  .post(protect, authorize(["super_admin"]), createUser); // POST new user (super admin only)

// IMPORTANT: Specific routes must be defined BEFORE generic /:id route
// Otherwise Express will match /:id first and these routes won't work

// Franchise admin only routes
router.patch("/:id/approve", protect, franchiseAdmin, approveCafeAdmin);
router.patch("/:id/reject", protect, franchiseAdmin, rejectCafeAdmin);

// Super admin only - toggle franchise active/inactive status
router.patch("/:id/toggle-status", protect, authorize(["super_admin"]), (req, res, next) => {
  console.log('[ROUTE DEBUG] toggle-status route hit!', {
    method: req.method,
    path: req.path,
    params: req.params,
    userRole: req.user?.role
  });
  next();
}, toggleFranchiseStatus);

// Generic /:id route (must be last)
router.route("/:id")
  .get(protect, admin, getUserById)   // GET user by id (admin only)
  .put(protect, admin, updateUser)    // PUT update user (admin only)
  .delete(protect, admin, deleteUser); // DELETE user (admin only) - for franchises, sets isActive=false

module.exports = router;
