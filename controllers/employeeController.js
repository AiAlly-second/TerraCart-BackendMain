const Employee = require("../models/employeeModel");
const User = require("../models/userModel");

// Minimum age as per Indian Labor Laws (18 years for general employment)
const MINIMUM_WORKING_AGE = 18;
const MOBILE_EMPLOYEE_ROLES = ["waiter", "cook", "captain", "manager"];

const escapeRegex = (value = "") =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const normalizeEmail = (email = "") => String(email).trim().toLowerCase();

const findEmployeeByEmailInsensitive = async (email, excludeEmployeeId = null) => {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;

  const query = {
    email: {
      $regex: `^${escapeRegex(normalizedEmail)}$`,
      $options: "i",
    },
  };

  if (excludeEmployeeId) {
    query._id = { $ne: excludeEmployeeId };
  }

  return Employee.findOne(query).select("_id email userId name");
};

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

  return User.findOne(query).select("_id email role employeeId");
};

const isDuplicateEmailError = (error) =>
  Boolean(error?.code === 11000 && error?.keyPattern?.email);

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
// CRITICAL: Cart admins must only see their own data (filtered by cafeId/cartId)
const buildHierarchyQuery = async (user) => {
  const query = {};
  // Normalize role: treat 'cart_admin' as 'admin' for backward compatibility
  const userRole = user.role === "cart_admin" ? "admin" : user.role;
  
  if (userRole === "admin") {
    // CRITICAL: Cart admin - ONLY see employees from their own cart
    // Employee model uses cartId (changed from cafeId, which should match cart admin's _id)
    query.cartId = user._id;
    console.log(`[EMPLOYEE_QUERY] Cart admin ${user._id} - filtering by cartId: ${user._id}`);
  } else if (user.role === "franchise_admin") {
    // Franchise admin - see employees from all cafes under their franchise
    query.franchiseId = user._id;
  } else if (["waiter", "cook", "captain", "manager"].includes(user.role)) {
    // Mobile users (waiter, cook, captain, manager) - get cartId from user or employee record
    // Note: user.cafeId is the User model field (for mobile users linking to cart admin) - keep as is
    let cartId = null;
    
    // First check if User has cafeId directly (this is the User model field, not Employee model)
    if (user.cafeId) {
      cartId = user.cafeId; // User.cafeId links to cart admin, which is what we need for Employee.cartId
      console.log(`[EMPLOYEE_QUERY] Mobile user ${user._id} (${user.role}) - has direct cafeId (User model): ${cartId}`);
    } else {
      // Fallback: find Employee record by email to get cartId (Employee model now uses cartId)
      const employee = await Employee.findOne({ email: user.email?.toLowerCase() }).lean();
      if (employee && employee.cartId) {
        cartId = employee.cartId;
        console.log(`[EMPLOYEE_QUERY] Mobile user ${user._id} (${user.role}) - found cartId from employee record: ${cartId}`);
      } else {
        console.log(`[EMPLOYEE_QUERY] Mobile user ${user._id} (${user.role}) - no cartId found`);
      }
    }
    
    if (cartId) {
      query.cartId = cartId;
    } else {
      // If no cartId found, return empty query (will return no employees)
      // This ensures managers only see employees from their cart
      console.log(`[EMPLOYEE_QUERY] Mobile user ${user._id} (${user.role}) - no cartId, returning empty query`);
      query.cartId = null; // This will match nothing
    }
  }
  // For super_admin, no filter (see all employees)
  return query;
};

// Get all employees
exports.getAllEmployees = async (req, res) => {
  try {
    // buildHierarchyQuery is now async, so we need to await it
    const query = await buildHierarchyQuery(req.user);
    
    // If query has cartId: null, return empty array (no employees found for this user)
    if (query.cartId === null && Object.keys(query).length === 1) {
      console.log(`[EMPLOYEE_QUERY] No cartId found for user ${req.user._id}, returning empty array`);
      return res.json({ success: true, data: [] });
    }
    
    const employees = await Employee.find(query)
      .populate("cartId", "name cafeName email") // Changed from cafeId to cartId
      .populate("franchiseId", "name email")
      .populate("userId", "email")
      .sort({ createdAt: -1 })
      .lean();
    
    // Extract email from User model (via userId) if available
    const employeesWithEmail = await Promise.all(employees.map(async (emp) => {
      let userEmail = null;
      
      if (emp.userId) {
        if (emp.userId.email) {
          userEmail = emp.userId.email;
        } else if (typeof emp.userId === 'string' || emp.userId._id) {
          const userId = typeof emp.userId === 'string' ? emp.userId : emp.userId._id;
          const user = await User.findById(userId).select('email').lean();
          if (user && user.email) {
            userEmail = user.email;
          }
        }
      }
      
      // FALLBACK: If no userId but employee has email, try to find User by email
      if (!userEmail && emp.email && emp.email !== 'employee@example.com') {
        try {
          const userByEmail = await User.findOne({ email: emp.email.toLowerCase().trim() })
            .select('_id email')
            .lean();
          if (userByEmail) {
            userEmail = userByEmail.email;
            // Link userId if missing
            if (!emp.userId) {
              Employee.findByIdAndUpdate(emp._id, { userId: userByEmail._id }).catch(err => 
                console.warn(`[GET_ALL_EMPLOYEES] Failed to link userId:`, err.message)
              );
            }
          }
        } catch (err) {
          // Ignore errors
        }
      }
      
      if (userEmail) {
        emp.email = userEmail;
      }
      
      return emp;
    }));
    
    console.log(`[EMPLOYEE_QUERY] Found ${employeesWithEmail.length} employees for user ${req.user._id} (${req.user.role})`);
    
    return res.json({ success: true, data: employeesWithEmail });
  } catch (err) {
    console.error('[EMPLOYEE_QUERY] Error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// Get single employee
exports.getEmployee = async (req, res) => {
  try {
    const { id } = req.params;
    const hierarchyQuery = await buildHierarchyQuery(req.user);
    const query = { _id: id, ...hierarchyQuery };
    
    // If hierarchy query has cartId: null, employee not accessible
    if (hierarchyQuery.cartId === null && Object.keys(hierarchyQuery).length === 1) {
      return res.status(403).json({ success: false, message: "Access denied: No cart associated with this user" });
    }
    
    const employee = await Employee.findOne(query)
      .populate("cartId", "name cafeName email") // Changed from cafeId to cartId
      .populate("franchiseId", "name email")
      .populate("userId", "email") // Populate userId to get email from User model
      .lean();
    
    if (!employee) {
      return res.status(404).json({ success: false, message: "Employee not found" });
    }
    
    // If email is in User model (via userId), prefer it over employee.email
    // User email is the source of truth for login accounts
    let userEmail = null;
    
    if (employee.userId) {
      if (employee.userId.email) {
        // userId is populated and has email
        userEmail = employee.userId.email;
        console.log(`[GET_EMPLOYEE] Email from populated userId: ${userEmail}`);
      } else {
        // userId is just an ID, fetch the User
        const userId = typeof employee.userId === 'string' ? employee.userId : (employee.userId._id || employee.userId.id);
        if (userId) {
          try {
            const user = await User.findById(userId).select('email').lean();
            if (user && user.email) {
              userEmail = user.email;
              console.log(`[GET_EMPLOYEE] Email fetched from User model for userId ${userId}: ${userEmail}`);
            } else {
              console.warn(`[GET_EMPLOYEE] User found for userId ${userId} but no email field`);
            }
          } catch (userErr) {
            console.error(`[GET_EMPLOYEE] Error fetching User for userId ${userId}:`, userErr.message);
          }
        }
      }
    }
    
    // FALLBACK: If no userId but employee has email, try to find User by email
    // This handles cases where userId link might be missing
    if (!userEmail && employee.email && employee.email !== 'employee@example.com') {
      try {
        const userByEmail = await User.findOne({ email: employee.email.toLowerCase().trim() })
          .select('_id email')
          .lean();
        if (userByEmail) {
          userEmail = userByEmail.email;
          // Also link userId if missing
          if (!employee.userId) {
            console.log(`[GET_EMPLOYEE] Found User by email, linking userId ${userByEmail._id} to employee`);
            await Employee.findByIdAndUpdate(employee._id, { userId: userByEmail._id });
            employee.userId = userByEmail._id;
          }
          console.log(`[GET_EMPLOYEE] Email found via email lookup: ${userEmail}`);
        }
      } catch (emailLookupErr) {
        console.warn(`[GET_EMPLOYEE] Error looking up User by email:`, emailLookupErr.message);
      }
    }
    
    // Always use User email if available (it's the source of truth)
    if (userEmail) {
      employee.email = userEmail;
    }
    
    // Log final email value
    console.log(`[GET_EMPLOYEE] Final email for employee ${employee._id}: ${employee.email || 'NOT FOUND'}`);
    console.log(`[GET_EMPLOYEE] Employee userId: ${employee.userId ? (typeof employee.userId === 'object' ? employee.userId._id : employee.userId) : 'NONE'}`);
    
    return res.json({ success: true, data: employee });
  } catch (err) {
    console.error('[EMPLOYEE_QUERY] Get employee error:', err);
    return res.status(500).json({ success: false, message: err.message });
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
    
    // Map cafeId to cartId for backward compatibility (frontend may send cafeId)
    if (employeeData.cafeId && !employeeData.cartId) {
      employeeData.cartId = employeeData.cafeId;
      delete employeeData.cafeId;
    }
    
    // Set hierarchy relationships based on user role
    if (req.user.role === "admin") {
      employeeData.cartId = req.user._id; // Changed from cafeId to cartId
      if (req.user.franchiseId) {
        employeeData.franchiseId = req.user.franchiseId;
      }
    } else if (req.user.role === "franchise_admin") {
      employeeData.franchiseId = req.user._id;
      // If cartId is provided, validate it belongs to this franchise
      if (employeeData.cartId) { // Changed from cafeId to cartId
        const cart = await User.findById(employeeData.cartId);
        if (!cart || cart.franchiseId?.toString() !== req.user._id.toString()) {
          return res.status(403).json({ message: "Invalid cart selection" });
        }
      }
    }
    
    // Normalize and validate email uniqueness before create
    const normalizedEmail = employeeData.email
      ? normalizeEmail(employeeData.email)
      : "";
    if (normalizedEmail) {
      employeeData.email = normalizedEmail;

      const existingEmployee = await findEmployeeByEmailInsensitive(
        normalizedEmail
      );
      if (existingEmployee) {
        return res.status(409).json({
          message: "Email already registered for another employee",
        });
      }

      const existingUser = await findUserByEmailInsensitive(normalizedEmail);
      if (existingUser) {
        return res.status(409).json({ message: "Email already registered" });
      }
    }
    
    // Extract password for User account creation
    const { password, ...employeeDataToSave } = employeeData;
    
    // Create employee record
    const employee = await Employee.create(employeeDataToSave);
    
    // If email and password are provided, and employee role is a mobile role, create User account
    if (
      employeeData.email &&
      password &&
      MOBILE_EMPLOYEE_ROLES.includes(employee.employeeRole)
    ) {
      try {
        // Create new User account for mobile login
        const userData = {
          name: employee.name,
          email: employeeData.email,
          password: password,
          role: employee.employeeRole, // Set role to match employee role (waiter, cook, captain, manager)
          cafeId: employee.cartId, // Employee.cartId -> User.cafeId (User model field for mobile users)
          employeeId: employee._id, // Link to employee
        };

        // Set franchiseId if employee has one
        if (employee.franchiseId) {
          userData.franchiseId = employee.franchiseId;
        }

        const user = await User.create(userData);

        // Link userId in employee
        employee.userId = user._id;
        await employee.save();

        console.log(
          `[EMPLOYEE] Created User account for employee: ${employee.name} (${employee.employeeRole})`
        );
        console.log(
          `[EMPLOYEE] User ID: ${user._id}, Email: ${user.email}, CafeId: ${user.cafeId}`
        );
        console.log(`[EMPLOYEE] Employee userId linked: ${employee.userId}`);
      } catch (userError) {
        console.error("[EMPLOYEE] Error creating User account:", userError.message);
        // Roll back employee creation if login account creation fails.
        await Employee.findByIdAndDelete(employee._id).catch((rollbackErr) => {
          console.error(
            "[EMPLOYEE] Failed to rollback employee after user create failure:",
            rollbackErr.message
          );
        });

        if (isDuplicateEmailError(userError)) {
          return res.status(409).json({ message: "Email already registered" });
        }
        return res.status(400).json({
          message:
            userError.message || "Failed to create employee login account",
        });
      }
    }
    
    // Populate relationships before returning
    await employee.populate("cartId", "name cafeName email"); // Changed from cafeId to cartId
    await employee.populate("franchiseId", "name email");
    await employee.populate("userId", "email"); // Populate userId to include email
    
    // Extract email from User model if userId exists
    if (employee.userId && employee.userId.email) {
      employee.email = employee.userId.email;
      console.log(`[EMPLOYEE] Email from User model after creation: ${employee.email}`);
    }
    
    return res.status(201).json(employee);
  } catch (err) {
    if (isDuplicateEmailError(err)) {
      return res.status(409).json({ message: "Email already registered" });
    }
    return res.status(500).json({ message: err.message });
  }
};

// Update employee
exports.updateEmployee = async (req, res) => {
  try {
    const { id } = req.params;
    const hierarchyQuery = await buildHierarchyQuery(req.user);
    const query = { _id: id, ...hierarchyQuery };

    // If hierarchy query has cartId: null, employee not accessible
    if (hierarchyQuery.cartId === null && Object.keys(hierarchyQuery).length === 1) {
      return res.status(403).json({
        success: false,
        message: "Access denied: No cart associated with this user",
      });
    }
    
    const employee = await Employee.findOne(query);
    if (!employee) {
      return res.status(404).json({ message: "Employee not found" });
    }

    // Normalize role: treat "cart_admin" as "admin" for backward compatibility
    const actorRole = req.user.role === "cart_admin" ? "admin" : req.user.role;

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
    
    // Map cafeId to cartId for backward compatibility (frontend may send cafeId)
    if (req.body.cafeId && !req.body.cartId) {
      req.body.cartId = req.body.cafeId;
      delete req.body.cafeId;
    }
    
    // Handle hierarchy changes based on role
    if (actorRole === "franchise_admin") {
      // Franchise admin can assign employees to cafes within their franchise
      if (req.body.cartId !== undefined) { // Changed from cafeId to cartId
        if (req.body.cartId) {
          // Validate cart belongs to this franchise
          const cart = await User.findById(req.body.cartId);
          if (!cart || cart.franchiseId?.toString() !== req.user._id.toString()) {
            return res.status(403).json({ message: "Invalid cart selection" });
          }
          employee.cartId = req.body.cartId; // Changed from cafeId to cartId
        } else {
          // Remove cart assignment (franchise level employee)
          employee.cartId = null; // Changed from cafeId to cartId
        }
      }
      // Prevent changing franchiseId
      delete req.body.franchiseId;
    } else if (actorRole === "admin") {
      // Cart admin cannot change cartId or franchiseId
      delete req.body.cartId; // Changed from cafeId to cartId
      delete req.body.franchiseId;
    } else if (actorRole !== "super_admin") {
      // Other roles cannot change hierarchy
      delete req.body.cafeId;
      delete req.body.franchiseId;
    }
    
    const hasEmailField = Object.prototype.hasOwnProperty.call(req.body, "email");
    const incomingPassword =
      typeof req.body.password === "string" ? req.body.password.trim() : "";
    const passwordProvided = incomingPassword.length > 0;

    // Handle email update (normalize if provided)
    if (hasEmailField) {
      req.body.email = req.body.email ? normalizeEmail(req.body.email) : null;

      if (req.body.email) {
        const duplicateEmployee = await findEmployeeByEmailInsensitive(
          req.body.email,
          employee._id
        );
        if (duplicateEmployee) {
          return res.status(409).json({
            message: "Email already registered for another employee",
          });
        }

        const duplicateUser = await findUserByEmailInsensitive(req.body.email);
        const sameLinkedUser =
          duplicateUser &&
          employee.userId &&
          duplicateUser._id.toString() === employee.userId.toString();
        const sameEmployeeOnUser =
          duplicateUser &&
          duplicateUser.employeeId &&
          duplicateUser.employeeId.toString() === employee._id.toString();

        if (duplicateUser && !sameLinkedUser && !sameEmployeeOnUser) {
          return res.status(409).json({ message: "Email already registered" });
        }
      }
    }
    
    // Extract password for User account creation/update
    const { password, ...updateData } = req.body;
    const previousEmail = employee.email;
    
    Object.assign(employee, updateData);
    
    // Keep User login in sync for mobile roles.
    // Supports: email-only update, password-only update, and email+password update.
    if (MOBILE_EMPLOYEE_ROLES.includes(employee.employeeRole)) {
      const wantsCredentialSync = hasEmailField || passwordProvided || Boolean(employee.userId);

      if (wantsCredentialSync) {
        let user = null;

        // Prefer linked user first
        if (employee.userId) {
          user = await User.findById(employee.userId);
        }

        // Fallback: find by current email if link is missing/stale
        if (!user && employee.email) {
          user = await findUserByEmailInsensitive(employee.email);
        }

        // If email was changed and link is missing, try old email before creating a new account
        if (!user && previousEmail && previousEmail !== employee.email) {
          user = await findUserByEmailInsensitive(previousEmail);
        }

        if (
          user &&
          user.employeeId &&
          user.employeeId.toString() !== employee._id.toString()
        ) {
          return res.status(409).json({
            message: "Email already linked to another employee account",
          });
        }

        if (
          user &&
          ["super_admin", "franchise_admin", "admin", "customer"].includes(
            user.role
          ) &&
          (!user.employeeId ||
            user.employeeId.toString() !== employee._id.toString())
        ) {
          return res.status(409).json({
            message: "Email already registered for another account",
          });
        }

        if (user) {
          // If frontend sent blank email, keep current login email and avoid breaking the account
          if (hasEmailField && !employee.email) {
            employee.email = user.email;
          }

          if (employee.email && user.email !== employee.email) {
            const emailConflict = await findUserByEmailInsensitive(
              employee.email,
              user._id
            );
            if (emailConflict) {
              return res
                .status(409)
                .json({ message: "Email already exists for another account" });
            }
            user.email = employee.email;
          }

          if (passwordProvided) {
            // Password will be hashed by User model pre-save hook
            user.password = incomingPassword;
          }

          user.name = employee.name;
          user.role = employee.employeeRole;
          user.cafeId = employee.cartId || user.cafeId;
          user.employeeId = employee._id;
          user.franchiseId = employee.franchiseId || user.franchiseId;
          await user.save();

          if (!employee.userId || employee.userId.toString() !== user._id.toString()) {
            employee.userId = user._id;
          }

          console.log(
            `[UPDATE_EMPLOYEE] Synced linked user for employee ${employee._id}: ${user.email}`
          );
        } else if (employee.email || passwordProvided) {
          // No existing user found. Create one only when both email and password are available.
          if (!employee.email) {
            return res.status(400).json({
              message:
                "Email is required to create login access for this employee",
            });
          }

          if (!passwordProvided) {
            return res.status(400).json({
              message:
                "Password is required to create login access for this employee",
            });
          }

          const emailConflict = await findUserByEmailInsensitive(employee.email);
          if (emailConflict) {
            return res
              .status(409)
              .json({ message: "Email already exists for another account" });
          }

          const userData = {
            name: employee.name,
            email: employee.email,
            password: incomingPassword,
            role: employee.employeeRole,
            cafeId: employee.cartId, // Employee.cartId -> User.cafeId
            employeeId: employee._id,
          };

          if (employee.franchiseId) {
            userData.franchiseId = employee.franchiseId;
          }

          const createdUser = await User.create(userData);
          employee.userId = createdUser._id;

          console.log(
            `[UPDATE_EMPLOYEE] Created user ${createdUser._id} for employee ${employee._id}`
          );
        }
      }
    }

    await employee.save();
    
    await employee.populate("cartId", "name cafeName email"); // Changed from cafeId to cartId
    await employee.populate("franchiseId", "name email");
    await employee.populate("userId", "email"); // Populate userId to include email
    
    // Extract email from User model if userId exists (User is source of truth)
    if (employee.userId && employee.userId.email) {
      employee.email = employee.userId.email;
      console.log(`[UPDATE_EMPLOYEE] Email from User model: ${employee.email}`);
    }
    
    return res.json(employee);
  } catch (err) {
    if (isDuplicateEmailError(err)) {
      return res.status(409).json({ message: "Email already registered" });
    }
    return res.status(500).json({ message: err.message });
  }
};

// Delete employee
exports.deleteEmployee = async (req, res) => {
  try {
    const { id } = req.params;
    // Fix: buildHierarchyQuery is async, must await it
    const hierarchyQuery = await buildHierarchyQuery(req.user);
    const query = { _id: id, ...hierarchyQuery };
    
    // First find the employee to get the userId
    const employee = await Employee.findOne(query);
    if (!employee) {
      return res.status(404).json({ message: "Employee not found" });
    }

    // Delete the associated User account if it exists (Clean up for Admin Panel)
    if (employee.userId) {
      try {
        const userId = typeof employee.userId === 'object' ? employee.userId._id : employee.userId;
        await User.findByIdAndDelete(userId);
        console.log(`[DELETE_EMPLOYEE] Deleted associated User account: ${userId}`);
      } catch (userError) {
        console.error('[DELETE_EMPLOYEE] Error deleting associated User:', userError.message);
      }
    }
    
    // Now delete the employee record
    await Employee.findByIdAndDelete(id);
    
    return res.json({ message: "Employee and associated user account deleted successfully" });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Get hierarchical structure (franchises and cafes) - Filtered by role
exports.getHierarchy = async (req, res) => {
  try {
    // Normalize role: treat 'cart_admin' as 'admin' for backward compatibility
    let userRole = req.user.role;
    if (userRole === "cart_admin") {
      userRole = "admin";
    }
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
        .populate("cartId", "name cafeName email") // Changed from cafeId to cartId
        .populate("franchiseId", "name email")
        .populate("userId", "email")
        .sort({ createdAt: -1 })
        .lean();
      
      // Extract email from User model (via userId) if available
      employees = await Promise.all(employees.map(async (emp) => {
        let userEmail = null;
        
        if (emp.userId) {
          if (emp.userId.email) {
            userEmail = emp.userId.email;
          } else if (typeof emp.userId === 'string' || emp.userId._id) {
            const userId = typeof emp.userId === 'string' ? emp.userId : emp.userId._id;
            const user = await User.findById(userId).select('email').lean();
            if (user && user.email) {
              userEmail = user.email;
            }
          }
        }
        
        // FALLBACK: If no userId but employee has email, try to find User by email
        if (!userEmail && emp.email && emp.email !== 'employee@example.com') {
          try {
            const userByEmail = await User.findOne({ email: emp.email.toLowerCase().trim() })
              .select('_id email')
              .lean();
            if (userByEmail) {
              userEmail = userByEmail.email;
              if (!emp.userId) {
                Employee.findByIdAndUpdate(emp._id, { userId: userByEmail._id }).catch(() => {});
              }
            }
          } catch (err) {}
        }
        
        if (userEmail) {
          emp.email = userEmail;
        }
        
        return emp;
      }));

      // Organize employees by franchise and cafe
      hierarchy = franchises.map(franchise => {
        const franchiseCafes = cafes.filter(
          cafe => cafe.franchiseId && cafe.franchiseId._id.toString() === franchise._id.toString()
        );

        const cafesWithEmployees = franchiseCafes.map(cafe => {
          const cafeEmployees = employees.filter(
            emp => emp.cartId && emp.cartId && emp.cartId._id && emp.cartId._id.toString() === cafe._id.toString()
          );
          return {
            ...cafe.toObject(),
            employees: cafeEmployees || []
          };
        });

        // Franchise-level employees (no cafe assigned)
        const franchiseEmployees = employees.filter(
          emp => emp.franchiseId && 
                 emp.franchiseId._id.toString() === franchise._id.toString() &&
                 !emp.cartId
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
        .populate("cartId", "name cafeName email") // Changed from cafeId to cartId
        .populate("franchiseId", "name email")
        .populate("userId", "email")
        .sort({ createdAt: -1 })
        .lean();
      
      // Extract email from User model (via userId) if available
      employees = await Promise.all(employees.map(async (emp) => {
        let userEmail = null;
        
        if (emp.userId) {
          if (emp.userId.email) {
            userEmail = emp.userId.email;
          } else if (typeof emp.userId === 'string' || emp.userId._id) {
            const userId = typeof emp.userId === 'string' ? emp.userId : emp.userId._id;
            const user = await User.findById(userId).select('email').lean();
            if (user && user.email) {
              userEmail = user.email;
            }
          }
        }
        
        // FALLBACK: If no userId but employee has email, try to find User by email
        if (!userEmail && emp.email && emp.email !== 'employee@example.com') {
          try {
            const userByEmail = await User.findOne({ email: emp.email.toLowerCase().trim() })
              .select('_id email')
              .lean();
            if (userByEmail) {
              userEmail = userByEmail.email;
              if (!emp.userId) {
                Employee.findByIdAndUpdate(emp._id, { userId: userByEmail._id }).catch(() => {});
              }
            }
          } catch (err) {}
        }
        
        if (userEmail) {
          emp.email = userEmail;
        }
        
        return emp;
      }));

      const cafesWithEmployees = cafes.map(cafe => {
        const cafeEmployees = employees.filter(
          emp => emp.cartId && emp.cartId && emp.cartId._id && emp.cartId._id.toString() === cafe._id.toString()
        );
        return {
          ...cafe.toObject(),
          employees: cafeEmployees || []
        };
      });

      // Franchise-level employees (no cafe assigned)
      const franchiseEmployees = employees.filter(
        emp => !emp.cartId
      );

      hierarchy = [{
        ...franchise,
        cafes: cafesWithEmployees,
        employees: franchiseEmployees
      }];

    } else if (userRole === "admin") {
      // Cafe admin sees only their cafe and employees (NO franchise-level employees)
      const cafe = await User.findById(userId)
        .select("_id name cafeName email franchiseId isActive")
        .populate("franchiseId", "name email")
        .lean();

      if (!cafe) {
        return res.status(404).json({ message: "Cafe not found" });
      }

      // IMPORTANT: Cart admin only sees employees assigned to their cart (cartId = userId)
      // They should NOT see franchise-level employees (employees with franchiseId but no cartId)
      employees = await Employee.find({ cartId: userId }) // Changed from cafeId to cartId
        .populate("cartId", "name cafeName email") // Changed from cafeId to cartId
        .populate("franchiseId", "name email")
        .populate("userId", "email")
        .sort({ createdAt: -1 })
        .lean();
      
      // Extract email from User model (via userId) if available
      employees = await Promise.all(employees.map(async (emp) => {
        let userEmail = null;
        
        if (emp.userId) {
          if (emp.userId.email) {
            userEmail = emp.userId.email;
          } else if (typeof emp.userId === 'string' || emp.userId._id) {
            const userId = typeof emp.userId === 'string' ? emp.userId : emp.userId._id;
            const user = await User.findById(userId).select('email').lean();
            if (user && user.email) {
              userEmail = user.email;
            }
          }
        }
        
        // FALLBACK: If no userId but employee has email, try to find User by email
        if (!userEmail && emp.email && emp.email !== 'employee@example.com') {
          try {
            const userByEmail = await User.findOne({ email: emp.email.toLowerCase().trim() })
              .select('_id email')
              .lean();
            if (userByEmail) {
              userEmail = userByEmail.email;
              if (!emp.userId) {
                Employee.findByIdAndUpdate(emp._id, { userId: userByEmail._id }).catch(() => {});
              }
            }
          } catch (err) {}
        }
        
        if (userEmail) {
          emp.email = userEmail;
        }
        
        return emp;
      }));

      // Cart admin view: Show only their cart with its employees
      // Do NOT include franchise information or franchise-level employees
      hierarchy = [{
        _id: cafe._id,
        name: cafe.cafeName || cafe.name,
        email: cafe.email,
        isActive: cafe.isActive,
        cafes: [{
          ...cafe,
          employees: employees || []
        }],
        employees: [] // No franchise-level employees for cart admin
      }];
    } else {
      return res.status(403).json({ message: "Access denied. Invalid role." });
    }

    // Employees with no franchise or cafe (orphaned)
    const orphanEmployees = employees.filter(
      emp => (!emp.franchiseId || !emp.franchiseId._id) && (!emp.cartId || !emp.cartId._id)
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

