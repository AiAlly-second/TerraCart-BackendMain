const express = require("express");
const router = express.Router();
const { protect, authorize } = require("../middleware/authMiddleware");
const {
  getAllEmployees,
  getEmployee,
  createEmployee,
  updateEmployee,
  deleteEmployee,
  getHierarchy,
} = require("../controllers/employeeController");

router.use(protect); // All routes require authentication

router.get(
  "/",
  authorize(["super_admin", "franchise_admin", "admin", "manager", "captain"]),
  getAllEmployees
);
router.get(
  "/hierarchy",
  authorize(["super_admin", "franchise_admin", "admin", "manager"]),
  getHierarchy
); // Get hierarchical structure (filtered by role)
router.get(
  "/:id",
  authorize([
    "super_admin",
    "franchise_admin",
    "admin",
    "manager",
    "captain",
    "waiter",
    "cook",
    "employee",
  ]),
  getEmployee
);
router.post(
  "/",
  authorize(["super_admin", "franchise_admin", "admin"]),
  createEmployee
);
router.put(
  "/:id",
  authorize(["super_admin", "franchise_admin", "admin"]),
  updateEmployee
);
router.delete(
  "/:id",
  authorize(["super_admin", "franchise_admin", "admin"]),
  deleteEmployee
);

module.exports = router;


