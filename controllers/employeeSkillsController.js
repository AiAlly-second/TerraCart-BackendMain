const EmployeeSkillsMaster = require("../models/employeeSkillsMasterModel");
const EmployeeSkillsMapping = require("../models/employeeSkillsMappingModel");
const Employee = require("../models/employeeModel");

// ========== Skills Master Management ==========

// Get all skills
exports.getAllSkills = async (req, res) => {
  try {
    const skills = await EmployeeSkillsMaster.find({ isActive: true }).sort({ skillName: 1 });
    return res.json(skills);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Create skill
exports.createSkill = async (req, res) => {
  try {
    const skill = await EmployeeSkillsMaster.create(req.body);
    return res.status(201).json(skill);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Update skill
exports.updateSkill = async (req, res) => {
  try {
    const { id } = req.params;
    const skill = await EmployeeSkillsMaster.findByIdAndUpdate(id, req.body, { new: true });
    if (!skill) {
      return res.status(404).json({ message: "Skill not found" });
    }
    return res.json(skill);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Delete skill
exports.deleteSkill = async (req, res) => {
  try {
    const { id } = req.params;
    const skill = await EmployeeSkillsMaster.findByIdAndUpdate(
      id,
      { isActive: false },
      { new: true }
    );
    if (!skill) {
      return res.status(404).json({ message: "Skill not found" });
    }
    return res.json({ message: "Skill deactivated successfully" });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ========== Employee-Skills Mapping ==========

// Helper function to build query based on user role
const buildHierarchyQuery = (user) => {
  const query = {};
  if (user.role === "admin") {
    query.cafeId = user._id;
  } else if (user.role === "franchise_admin") {
    query.franchiseId = user._id;
  }
  return query;
};

// Get all mappings
exports.getAllMappings = async (req, res) => {
  try {
    const hierarchyQuery = buildHierarchyQuery(req.user);
    
    // Get employee IDs that match hierarchy
    const employees = await Employee.find(hierarchyQuery).select("_id");
    const employeeIds = employees.map((e) => e._id);
    
    const mappings = await EmployeeSkillsMapping.find({
      employeeId: { $in: employeeIds },
    })
      .populate("employeeId", "name employeeRole")
      .populate("skillId", "skillName category");
    
    return res.json(mappings);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Get mappings for a specific employee
exports.getEmployeeMappings = async (req, res) => {
  try {
    const { employeeId } = req.params;
    
    // Verify employee belongs to user's hierarchy
    const hierarchyQuery = buildHierarchyQuery(req.user);
    const employee = await Employee.findOne({ _id: employeeId, ...hierarchyQuery });
    if (!employee) {
      return res.status(404).json({ message: "Employee not found" });
    }
    
    const mappings = await EmployeeSkillsMapping.find({ employeeId })
      .populate("skillId", "skillName category description");
    
    return res.json(mappings);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Create mapping
exports.createMapping = async (req, res) => {
  try {
    const { employeeId } = req.body;
    
    // Verify employee belongs to user's hierarchy
    const hierarchyQuery = buildHierarchyQuery(req.user);
    const employee = await Employee.findOne({ _id: employeeId, ...hierarchyQuery });
    if (!employee) {
      return res.status(404).json({ message: "Employee not found" });
    }
    
    const mapping = await EmployeeSkillsMapping.create(req.body);
    await mapping.populate("skillId", "skillName category");
    return res.status(201).json(mapping);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ message: "This skill is already mapped to this employee" });
    }
    return res.status(500).json({ message: err.message });
  }
};

// Update mapping
exports.updateMapping = async (req, res) => {
  try {
    const { id } = req.params;
    const mapping = await EmployeeSkillsMapping.findById(id).populate("employeeId");
    
    if (!mapping) {
      return res.status(404).json({ message: "Mapping not found" });
    }
    
    // Verify employee belongs to user's hierarchy
    const hierarchyQuery = buildHierarchyQuery(req.user);
    const employee = await Employee.findOne({
      _id: mapping.employeeId._id,
      ...hierarchyQuery,
    });
    if (!employee) {
      return res.status(403).json({ message: "Access denied" });
    }
    
    Object.assign(mapping, req.body);
    await mapping.save();
    await mapping.populate("skillId", "skillName category");
    return res.json(mapping);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Delete mapping
exports.deleteMapping = async (req, res) => {
  try {
    const { id } = req.params;
    const mapping = await EmployeeSkillsMapping.findById(id).populate("employeeId");
    
    if (!mapping) {
      return res.status(404).json({ message: "Mapping not found" });
    }
    
    // Verify employee belongs to user's hierarchy
    const hierarchyQuery = buildHierarchyQuery(req.user);
    const employee = await Employee.findOne({
      _id: mapping.employeeId._id,
      ...hierarchyQuery,
    });
    if (!employee) {
      return res.status(403).json({ message: "Access denied" });
    }
    
    await mapping.deleteOne();
    return res.json({ message: "Mapping deleted successfully" });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};













