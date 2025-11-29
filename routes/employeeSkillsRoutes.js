const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const {
  getAllSkills,
  createSkill,
  updateSkill,
  deleteSkill,
  getAllMappings,
  getEmployeeMappings,
  createMapping,
  updateMapping,
  deleteMapping,
} = require("../controllers/employeeSkillsController");

router.use(protect); // All routes require authentication

// Skills Master routes
router.get("/skills", getAllSkills);
router.post("/skills", createSkill);
router.put("/skills/:id", updateSkill);
router.delete("/skills/:id", deleteSkill);

// Employee-Skills Mapping routes
router.get("/mappings", getAllMappings);
router.get("/mappings/employee/:employeeId", getEmployeeMappings);
router.post("/mappings", createMapping);
router.put("/mappings/:id", updateMapping);
router.delete("/mappings/:id", deleteMapping);

module.exports = router;













