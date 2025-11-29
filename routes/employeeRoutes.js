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

router.get("/", getAllEmployees);
router.get("/hierarchy", getHierarchy); // Get hierarchical structure (filtered by role)
router.get("/:id", getEmployee);
router.post("/", createEmployee);
router.put("/:id", updateEmployee);
router.delete("/:id", deleteEmployee);

module.exports = router;


