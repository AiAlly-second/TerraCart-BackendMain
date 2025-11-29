const Employee = require("../models/employeeModel");
const User = require("../models/userModel");

// Minimum age as per Indian Labor Laws (18 years for general employment)
const MINIMUM_WORKING_AGE = 18;

// Helper function to calculate age from DOB
const calculateAge = (dateOfBirth) => {
  const today = new Date();
  const birthDate = new Date(dateOfBirth);
  let age = today.getFullYear() - birthDate.getFullYear();
  const monthDiff = today.getMonth() - birthDate.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
    age--;
  }
  return age;
};

// Helper function to validate DOB as per Indian Labor Laws
const validateDOB = (dateOfBirth) => {
  if (!dateOfBirth) {
    return { valid: false, message: "Date of birth is required" };
  }
  
  const age = calculateAge(dateOfBirth);
  
  if (age < MINIMUM_WORKING_AGE) {
    return {
      valid: false,
      message: `As per Indian Labor Laws (Child and Adolescent Labour Act, 1986), the minimum working age is ${MINIMUM_WORKING_AGE} years. Employee's age: ${age} years.`,
      age: age
    };
  }
  
  return { valid: true, age: age };
};

// Helper function to build query based on user role
const buildHierarchyQuery = (user) => {
  const query = {};
  if (user.role === "admin") {
    // Cafe admin - only see employees from their cafe
    query.cafeId = user._id;
  } else if (user.role === "franchise_admin") {
    // Franchise admin - see employees from all cafes under their franchise
    query.franchiseId = user._id;
  }
  // For super_admin, no filter (see all employees)
  return query;
};

// Get all employees
exports.getAllEmployees = async (req, res) => {
  try {
    const query = buildHierarchyQuery(req.user);
    const employees = await Employee.find(query)
      .populate("cafeId", "name cafeName email")
      .populate("franchiseId", "name email")
      .sort({ createdAt: -1 });
    return res.json(employees);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Get single employee
exports.getEmployee = async (req, res) => {
  try {
    const { id } = req.params;
    const query = { _id: id, ...buildHierarchyQuery(req.user) };
    const employee = await Employee.findOne(query)
      .populate("cafeId", "name cafeName email")
      .populate("franchiseId", "name email");
    
    if (!employee) {
      return res.status(404).json({ message: "Employee not found" });
    }
    return res.json(employee);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Create employee
exports.createEmployee = async (req, res) => {
  try {
    const employeeData = { ...req.body };
    
    // Validate DOB as per Indian Labor Laws
    const dobValidation = validateDOB(employeeData.dateOfBirth);
    if (!dobValidation.valid) {
      return res.status(400).json({ 
        message: dobValidation.message,
        error: "AGE_VALIDATION_FAILED",
        age: dobValidation.age,
        minimumAge: MINIMUM_WORKING_AGE
      });
    }
    
    // Set hierarchy relationships based on user role
    if (req.user.role === "admin") {
      employeeData.cafeId = req.user._id;
      if (req.user.franchiseId) {
        employeeData.franchiseId = req.user.franchiseId;
      }
    } else if (req.user.role === "franchise_admin") {
      employeeData.franchiseId = req.user._id;
      // If cafeId is provided, validate it belongs to this franchise
      if (employeeData.cafeId) {
        const cafe = await User.findById(employeeData.cafeId);
        if (!cafe || cafe.franchiseId?.toString() !== req.user._id.toString()) {
          return res.status(403).json({ message: "Invalid cafe selection" });
        }
      }
    }
    
    const employee = await Employee.create(employeeData);
    return res.status(201).json(employee);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Update employee
exports.updateEmployee = async (req, res) => {
  try {
    const { id } = req.params;
    const query = { _id: id, ...buildHierarchyQuery(req.user) };
    
    const employee = await Employee.findOne(query);
    if (!employee) {
      return res.status(404).json({ message: "Employee not found" });
    }

    // Validate DOB if being updated
    if (req.body.dateOfBirth) {
      const dobValidation = validateDOB(req.body.dateOfBirth);
      if (!dobValidation.valid) {
        return res.status(400).json({ 
          message: dobValidation.message,
          error: "AGE_VALIDATION_FAILED",
          age: dobValidation.age,
          minimumAge: MINIMUM_WORKING_AGE
        });
      }
    }
    
    // Handle hierarchy changes based on role
    if (req.user.role === "franchise_admin") {
      // Franchise admin can assign employees to cafes within their franchise
      if (req.body.cafeId !== undefined) {
        if (req.body.cafeId) {
          // Validate cafe belongs to this franchise
          const cafe = await User.findById(req.body.cafeId);
          if (!cafe || cafe.franchiseId?.toString() !== req.user._id.toString()) {
            return res.status(403).json({ message: "Invalid cafe selection" });
          }
          employee.cafeId = req.body.cafeId;
        } else {
          // Remove cafe assignment (franchise level employee)
          employee.cafeId = null;
        }
      }
      // Prevent changing franchiseId
      delete req.body.franchiseId;
    } else if (req.user.role === "admin") {
      // Cafe admin cannot change cafeId or franchiseId
      delete req.body.cafeId;
      delete req.body.franchiseId;
    } else if (req.user.role !== "super_admin") {
      // Other roles cannot change hierarchy
      delete req.body.cafeId;
      delete req.body.franchiseId;
    }
    
    Object.assign(employee, req.body);
    await employee.save();
    await employee.populate("cafeId", "name cafeName email");
    await employee.populate("franchiseId", "name email");
    return res.json(employee);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Delete employee
exports.deleteEmployee = async (req, res) => {
  try {
    const { id } = req.params;
    const query = { _id: id, ...buildHierarchyQuery(req.user) };
    
    const employee = await Employee.findOneAndDelete(query);
    if (!employee) {
      return res.status(404).json({ message: "Employee not found" });
    }
    return res.json({ message: "Employee deleted successfully" });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Get hierarchical structure (franchises and cafes) - Filtered by role
exports.getHierarchy = async (req, res) => {
  try {
    const userRole = req.user.role;
    const userId = req.user._id;

    let franchises = [];
    let cafes = [];
    let employees = [];
    let hierarchy = [];

    if (userRole === "super_admin") {
      // Super admin sees all franchises, cafes, and employees
      franchises = await User.find({ role: "franchise_admin" })
        .select("_id name email isActive")
        .sort({ name: 1 });

      cafes = await User.find({ role: "admin" })
        .select("_id name cafeName email franchiseId isActive")
        .populate("franchiseId", "name email")
        .sort({ cafeName: 1 });

      employees = await Employee.find({})
        .populate("cafeId", "name cafeName email")
        .populate("franchiseId", "name email")
        .sort({ createdAt: -1 });

      // Organize employees by franchise and cafe
      hierarchy = franchises.map(franchise => {
        const franchiseCafes = cafes.filter(
          cafe => cafe.franchiseId && cafe.franchiseId._id.toString() === franchise._id.toString()
        );

        const cafesWithEmployees = franchiseCafes.map(cafe => {
          const cafeEmployees = employees.filter(
            emp => emp.cafeId && emp.cafeId._id.toString() === cafe._id.toString()
          );
          return {
            ...cafe.toObject(),
            employees: cafeEmployees
          };
        });

        // Franchise-level employees (no cafe assigned)
        const franchiseEmployees = employees.filter(
          emp => emp.franchiseId && 
                 emp.franchiseId._id.toString() === franchise._id.toString() &&
                 !emp.cafeId
        );

        return {
          ...franchise.toObject(),
          cafes: cafesWithEmployees,
          employees: franchiseEmployees
        };
      });

    } else if (userRole === "franchise_admin") {
      // Franchise admin sees only their franchise, its cafes, and employees
      const franchise = await User.findById(userId)
        .select("_id name email isActive")
        .lean();

      if (!franchise) {
        return res.status(404).json({ message: "Franchise not found" });
      }

      cafes = await User.find({ 
        role: "admin",
        franchiseId: userId
      })
        .select("_id name cafeName email franchiseId isActive")
        .populate("franchiseId", "name email")
        .sort({ cafeName: 1 });

      employees = await Employee.find({ franchiseId: userId })
        .populate("cafeId", "name cafeName email")
        .populate("franchiseId", "name email")
        .sort({ createdAt: -1 });

      const cafesWithEmployees = cafes.map(cafe => {
        const cafeEmployees = employees.filter(
          emp => emp.cafeId && emp.cafeId._id.toString() === cafe._id.toString()
        );
        return {
          ...cafe.toObject(),
          employees: cafeEmployees
        };
      });

      // Franchise-level employees (no cafe assigned)
      const franchiseEmployees = employees.filter(
        emp => !emp.cafeId
      );

      hierarchy = [{
        ...franchise,
        cafes: cafesWithEmployees,
        employees: franchiseEmployees
      }];

    } else if (userRole === "admin") {
      // Cafe admin sees only their cafe and employees
      const cafe = await User.findById(userId)
        .select("_id name cafeName email franchiseId isActive")
        .populate("franchiseId", "name email")
        .lean();

      if (!cafe) {
        return res.status(404).json({ message: "Cafe not found" });
      }

      employees = await Employee.find({ cafeId: userId })
        .populate("cafeId", "name cafeName email")
        .populate("franchiseId", "name email")
        .sort({ createdAt: -1 });

      // If cafe has a franchise, include franchise info
      if (cafe.franchiseId) {
        const franchise = await User.findById(cafe.franchiseId._id)
          .select("_id name email isActive")
          .lean();

        hierarchy = [{
          ...franchise,
          cafes: [{
            ...cafe,
            employees: employees
          }],
          employees: []
        }];
      } else {
        // Cafe without franchise
        hierarchy = [{
          _id: cafe._id,
          name: cafe.cafeName || cafe.name,
          email: cafe.email,
          isActive: cafe.isActive,
          cafes: [],
          employees: []
        }];
      }
    } else {
      return res.status(403).json({ message: "Access denied. Invalid role." });
    }

    // Employees with no franchise or cafe (orphaned)
    const orphanEmployees = employees.filter(
      emp => !emp.franchiseId && !emp.cafeId
    );

    return res.json({
      hierarchy,
      orphanEmployees: userRole === "super_admin" ? orphanEmployees : []
    });
  } catch (err) {
    console.error("[getHierarchy Error]:", err);
    return res.status(500).json({ message: err.message });
  }
};

