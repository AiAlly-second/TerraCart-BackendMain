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
      .populate("userId", "email")
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
      .populate("franchiseId", "name email")
      .populate("userId", "email");
    
    if (!employee) {
      return res.status(404).json({ message: "Employee not found" });
    }
    return res.json(employee);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Create employee
// @note    Creates both User and Employee documents for unified user system
// @note    User role is set from employeeRole (manager, captain, waiter, cook)
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
    
    // Handle both 'role' and 'employeeRole' fields (frontend may send either)
    // Priority: employeeRole > role
    if (!employeeData.employeeRole && employeeData.role) {
      employeeData.employeeRole = employeeData.role;
    }
    
    // Ensure employeeRole is set
    if (!employeeData.employeeRole) {
      return res.status(400).json({ message: "employeeRole is required" });
    }
    
    // Map employeeRole to user role (for unified system)
    const roleMapping = {
      "waiter": "waiter",
      "chef": "cook",
      "cook": "cook",
      "manager": "manager",
      "captain": "captain",
      "cashier": "waiter", // Map cashier to waiter for now
      "cleaner": "waiter", // Map cleaner to waiter for now
    };
    
    // Get user role from employeeRole, default to employeeRole if not mapped
    const userRole = roleMapping[employeeData.employeeRole] || employeeData.employeeRole;
    const allowedEmployeeRoles = ["manager", "captain", "waiter", "cook"];
    
    // Only create User if role is one of the unified roles
    let user = null;
    if (allowedEmployeeRoles.includes(userRole)) {
      // Check if user already exists (by email if provided)
      if (employeeData.email) {
        user = await User.findOne({ email: employeeData.email.toLowerCase().trim() });
      }
      
      // If user doesn't exist, create one
      if (!user) {
        // Generate a default password if not provided (employee should change on first login)
        const defaultPassword = employeeData.password || `Temp${Date.now()}`;
        
        const userData = {
          name: employeeData.name,
          email: employeeData.email || `${employeeData.name.toLowerCase().replace(/\s+/g, '.')}@employee.local`,
          password: defaultPassword,
          role: userRole,
        };
        
        // Set hierarchy relationships based on user role
        if (req.user.role === "admin") {
          userData.cafeId = req.user._id;
          if (req.user.franchiseId) {
            userData.franchiseId = req.user.franchiseId;
          }
        } else if (req.user.role === "franchise_admin") {
          userData.franchiseId = req.user._id;
          // If cafeId is provided, validate it belongs to this franchise
          if (employeeData.cafeId) {
            const cafe = await User.findById(employeeData.cafeId);
            if (!cafe || cafe.franchiseId?.toString() !== req.user._id.toString()) {
              return res.status(403).json({ message: "Invalid cafe selection" });
            }
            userData.cafeId = employeeData.cafeId;
          }
        } else if (req.user.role === "super_admin") {
          // Super admin can specify cafeId/franchiseId
          if (employeeData.cafeId) userData.cafeId = employeeData.cafeId;
          if (employeeData.franchiseId) userData.franchiseId = employeeData.franchiseId;
        }
        
        user = await User.create(userData);
        console.log(`[EMPLOYEE CREATION] ✅ Created User for employee: ${user.name} (User ID: ${user._id}, Role: ${userRole})`);
      }
    }
    
    // Set hierarchy relationships for Employee document
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
    
    // Link employee to user if user was created/found
    if (user) {
      employeeData.userId = user._id;
      // Sync email: prefer employeeData.email, fallback to user.email
      if (!employeeData.email && user.email) {
        employeeData.email = user.email;
      } else if (employeeData.email && user.email !== employeeData.email) {
        // If employee email differs from user email, update user email
        await User.findByIdAndUpdate(user._id, { email: employeeData.email });
      }
    }
    
    const employee = await Employee.create(employeeData);
    
    // Return both user and employee data
    const response = { ...employee.toObject() };
    if (user) {
      response.user = {
        _id: user._id,
        email: user.email,
        role: user.role
      };
    }
    
    return res.status(201).json(response);
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
    
    // Handle both 'role' and 'employeeRole' fields (frontend may send either)
    // Priority: employeeRole > role
    if (!req.body.employeeRole && req.body.role) {
      req.body.employeeRole = req.body.role;
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
    
    // If email is being updated, sync it to the linked User document
    if (req.body.email && employee.userId) {
      await User.findByIdAndUpdate(employee.userId, { email: req.body.email });
    }
    
    Object.assign(employee, req.body);
    await employee.save();
    await employee.populate("cafeId", "name cafeName email");
    await employee.populate("franchiseId", "name email");
    await employee.populate("userId", "email");
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
        .populate("userId", "email")
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
        .populate("userId", "email")
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
        .populate("userId", "email")
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

    // Helper function to ensure email is included in employee objects
    const enrichEmployeeWithEmail = (emp) => {
      const empObj = emp.toObject ? emp.toObject() : emp;
      // If email is not on employee, get it from linked User
      if (!empObj.email && empObj.userId) {
        if (typeof empObj.userId === 'object' && empObj.userId.email) {
          empObj.email = empObj.userId.email;
        }
      }
      return empObj;
    };

    // Enrich all employees with email
    const enrichHierarchy = (hier) => {
      return hier.map(franchise => {
        const enrichedFranchise = { ...franchise };
        if (franchise.employees) {
          enrichedFranchise.employees = franchise.employees.map(enrichEmployeeWithEmail);
        }
        if (franchise.cafes) {
          enrichedFranchise.cafes = franchise.cafes.map(cafe => {
            const enrichedCafe = { ...cafe };
            if (cafe.employees) {
              enrichedCafe.employees = cafe.employees.map(enrichEmployeeWithEmail);
            }
            return enrichedCafe;
          });
        }
        return enrichedFranchise;
      });
    };

    const enrichedHierarchy = enrichHierarchy(hierarchy);
    const enrichedOrphanEmployees = orphanEmployees.map(enrichEmployeeWithEmail);

    return res.json({
      hierarchy: enrichedHierarchy,
      orphanEmployees: userRole === "super_admin" ? enrichedOrphanEmployees : []
    });
  } catch (err) {
    console.error("[getHierarchy Error]:", err);
    return res.status(500).json({ message: err.message });
  }
};

