const CustomerRequest = require("../models/customerRequestModel");
const Employee = require("../models/employeeModel");
const { asyncHandler } = require("../utils/asyncHandler");

/**
 * @desc    Get all customer requests (filtered by role and data isolation)
 * @route   GET /api/customer-requests
 * @access  Private
 */
exports.getAllRequests = asyncHandler(async (req, res) => {
  const {
    status,
    requestType,
    tableId,
    assignedTo,
    priority,
    page = 1,
    limit = 20,
    sort = "-createdAt",
  } = req.query;

  const query = {};

  // Data isolation - Filter requests based on role:
  // - Cafe admin: only requests from their cafe (cartId matches their _id)
  // - Franchise admin: only requests from cafes under their franchise (franchiseId matches their _id)
  // - Mobile roles (waiter, cook, captain, manager): only requests from their cafe (cafeId)
  // - Super admin: all requests (no filter)
  if (req.user && req.user.role === "admin" && req.user._id) {
    // Cafe admin - only see requests from their cafe
    query.cafeId = req.user._id;
  } else if (req.user && req.user.role === "franchise_admin" && req.user._id) {
    // Franchise admin - only see requests from cafes under their franchise
    query.franchiseId = req.user._id;
  } else if (req.user && ["waiter", "cook", "captain", "manager"].includes(req.user.role)) {
    // Mobile roles - filter by cartId (cafeId in user should match cafeId in requests)
    // First try to get cafeId from user (which should be populated from Employee during login)
    let cafeId = req.user.cafeId;
    
    if (!cafeId) {
      // Fallback: Try to get cafeId from Employee model by matching name
      const employee = await Employee.findOne({ 
        name: req.user.name
      }).select('cafeId franchiseId').lean();
      if (employee && employee.cafeId) {
        cafeId = employee.cafeId;
      }
    }
    
    if (cafeId) {
      // Filter requests by cafeId (which references the cafe admin's user ID)
      query.cafeId = cafeId;
    } else if (req.user.franchiseId) {
      // Fallback to franchiseId if cafeId not available
      query.franchiseId = req.user.franchiseId;
    } else {
      // If no cafeId or franchiseId, return empty array
      return res.json({
        success: true,
        data: [],
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: 0,
          pages: 0,
        },
      });
    }
  } else if (req.user && req.user.cafeId) {
    // For other roles with cafeId, use it directly
    query.cafeId = req.user.cafeId;
  } else if (req.user && req.user.franchiseId) {
    // For other roles with franchiseId, use it directly
    query.franchiseId = req.user.franchiseId;
  }
  // For super_admin, no filter (see all requests)

  // Role-based filtering - staff can see all requests, cooks don't see requests
  if (req.user.role === "chef" || req.user.role === "cook") {
    return res.status(403).json({
      success: false,
      message: "Cooks do not have access to customer requests",
    });
  }

  // Apply filters
  if (status) query.status = status;
  if (requestType) query.requestType = requestType;
  if (tableId) query.tableId = tableId;
  if (assignedTo) query.assignedTo = assignedTo;
  if (priority) query.priority = priority;

  // Pagination
  const pageNum = parseInt(page);
  const limitNum = parseInt(limit);
  const skip = (pageNum - 1) * limitNum;

  const requests = await CustomerRequest.find(query)
    .populate("tableId", "number name status")
    .populate("orderId", "_id status")
    .populate("assignedTo", "name employeeRole")
    .populate("assignedToUser", "name email")
    .populate("acknowledgedBy", "name employeeRole")
    .populate("resolvedBy", "name employeeRole")
    .sort(sort)
    .skip(skip)
    .limit(limitNum);

  const total = await CustomerRequest.countDocuments(query);

  res.status(200).json({
    success: true,
    data: requests,
    pagination: {
      page: pageNum,
      limit: limitNum,
      total,
      pages: Math.ceil(total / limitNum),
    },
  });
});

/**
 * @desc    Get pending requests
 * @route   GET /api/customer-requests/pending
 * @access  Private
 */
exports.getPendingRequests = asyncHandler(async (req, res) => {
  const query = {
    status: "pending",
  };

  // Data isolation - Filter requests based on role (same logic as getAllRequests)
  if (req.user && req.user.role === "admin" && req.user._id) {
    query.cafeId = req.user._id;
  } else if (req.user && req.user.role === "franchise_admin" && req.user._id) {
    query.franchiseId = req.user._id;
  } else if (req.user && ["waiter", "cook", "captain", "manager"].includes(req.user.role)) {
    let cafeId = req.user.cafeId;
    
    if (!cafeId) {
      const employee = await Employee.findOne({ 
        name: req.user.name
      }).select('cafeId franchiseId').lean();
      if (employee && employee.cafeId) {
        cafeId = employee.cafeId;
      }
    }
    
    if (cafeId) {
      query.cafeId = cafeId;
    } else if (req.user.franchiseId) {
      query.franchiseId = req.user.franchiseId;
    } else {
      return res.json({
        success: true,
        data: [],
      });
    }
  } else if (req.user && req.user.cafeId) {
    query.cafeId = req.user.cafeId;
  } else if (req.user && req.user.franchiseId) {
    query.franchiseId = req.user.franchiseId;
  }

  const requests = await CustomerRequest.find(query)
    .populate("tableId", "number name status")
    .populate("orderId", "_id status")
    .sort("-priority -createdAt")
    .limit(50);

  res.status(200).json({
    success: true,
    data: requests,
  });
});

/**
 * @desc    Get request by ID
 * @route   GET /api/customer-requests/:id
 * @access  Private
 */
exports.getRequestById = asyncHandler(async (req, res) => {
  const query = { _id: req.params.id };

  // Data isolation - Filter requests based on role (same logic as getAllRequests)
  if (req.user && req.user.role === "admin" && req.user._id) {
    query.cafeId = req.user._id;
  } else if (req.user && req.user.role === "franchise_admin" && req.user._id) {
    query.franchiseId = req.user._id;
  } else if (req.user && ["waiter", "cook", "captain", "manager"].includes(req.user.role)) {
    let cafeId = req.user.cafeId;
    
    if (!cafeId) {
      const employee = await Employee.findOne({ 
        name: req.user.name
      }).select('cafeId franchiseId').lean();
      if (employee && employee.cafeId) {
        cafeId = employee.cafeId;
      }
    }
    
    if (cafeId) {
      query.cafeId = cafeId;
    } else if (req.user.franchiseId) {
      query.franchiseId = req.user.franchiseId;
    }
  } else if (req.user && req.user.cafeId) {
    query.cafeId = req.user.cafeId;
  } else if (req.user && req.user.franchiseId) {
    query.franchiseId = req.user.franchiseId;
  }

  const request = await CustomerRequest.findOne(query)
    .populate("tableId", "number name status")
    .populate("orderId", "_id status")
    .populate("assignedTo", "name employeeRole")
    .populate("assignedToUser", "name email")
    .populate("acknowledgedBy", "name employeeRole")
    .populate("resolvedBy", "name employeeRole");

  if (!request) {
    return res.status(404).json({
      success: false,
      message: "Request not found",
    });
  }

  res.status(200).json({
    success: true,
    data: request,
  });
});

/**
 * @desc    Create customer request
 * @route   POST /api/customer-requests
 * @access  Private (Staff, Manager) or Public (from customer)
 */
exports.createRequest = asyncHandler(async (req, res) => {
  const {
    tableId,
    orderId,
    requestType,
    description,
    priority,
  } = req.body;

  if (!requestType) {
    return res.status(400).json({
      success: false,
      message: "Request type is required",
    });
  }

  const requestData = {
    requestType,
    description: description || "",
    priority: priority || "medium",
    status: "pending",
  };

  // Data isolation
  if (req.user) {
    if (req.user.cafeId) {
      requestData.cafeId = req.user.cafeId;
      requestData.franchiseId = req.user.franchiseId;
    } else if (req.user.franchiseId) {
      requestData.franchiseId = req.user.franchiseId;
    }
  } else {
    // Public request from customer - need to get cafeId from table
    if (tableId) {
      const Table = require("../models/tableModel").Table;
      const table = await Table.findById(tableId);
      if (table) {
        requestData.cafeId = table.cartId;
        requestData.franchiseId = table.franchiseId;
      }
    }
  }

  if (tableId) requestData.tableId = tableId;
  if (orderId) requestData.orderId = orderId;

  const request = await CustomerRequest.create(requestData);

  await request.populate("tableId", "number name");
  await request.populate("orderId", "_id status");

  // Emit Socket.IO event
  if (req.app && req.app.get("io")) {
    req.app.get("io").emit("request:created", request);
  }

  res.status(201).json({
    success: true,
    message: "Request created successfully",
    data: request,
  });
});

/**
 * @desc    Update request
 * @route   PATCH /api/customer-requests/:id
 * @access  Private
 */
exports.updateRequest = asyncHandler(async (req, res) => {
  const query = { _id: req.params.id };

  // Data isolation
  if (req.user.cafeId) {
    query.cafeId = req.user.cafeId;
  } else if (req.user.franchiseId) {
    query.franchiseId = req.user.franchiseId;
  }

  const request = await CustomerRequest.findOne(query);

  if (!request) {
    return res.status(404).json({
      success: false,
      message: "Request not found",
    });
  }

  // Update allowed fields
  const allowedFields = ["requestType", "description", "priority", "assignedTo", "assignedToUser", "status"];
  allowedFields.forEach((field) => {
    if (req.body[field] !== undefined) {
      request[field] = req.body[field];
    }
  });

  await request.save();

  await request.populate("tableId", "number name");
  await request.populate("assignedTo", "name employeeRole");

  // Emit Socket.IO event
  if (req.app && req.app.get("io")) {
    req.app.get("io").emit("request:updated", request);
  }

  res.status(200).json({
    success: true,
    message: "Request updated successfully",
    data: request,
  });
});

/**
 * @desc    Acknowledge request
 * @route   PATCH /api/customer-requests/:id/acknowledge
 * @access  Private (Staff, Manager)
 */
exports.acknowledgeRequest = asyncHandler(async (req, res) => {
  const query = { _id: req.params.id };

  // Data isolation
  if (req.user.cafeId) {
    query.cafeId = req.user.cafeId;
  } else if (req.user.franchiseId) {
    query.franchiseId = req.user.franchiseId;
  }

  const request = await CustomerRequest.findOne(query);

  if (!request) {
    return res.status(404).json({
      success: false,
      message: "Request not found",
    });
  }

  if (request.status === "resolved" || request.status === "cancelled") {
    return res.status(400).json({
      success: false,
      message: "Cannot acknowledge a resolved or cancelled request",
    });
  }

  const employee = await Employee.findOne({
    $or: [
      { _id: req.user.employeeId },
      { userId: req.user._id }
    ]
  });

  request.status = "acknowledged";
  request.acknowledgedAt = new Date();
  if (employee) {
    request.acknowledgedBy = employee._id;
    request.assignedTo = employee._id;
  } else {
    request.assignedToUser = req.user._id;
  }

  await request.save();

  await request.populate("tableId", "number name");
  await request.populate("acknowledgedBy", "name employeeRole");

  // Emit Socket.IO event
  if (req.app && req.app.get("io")) {
    req.app.get("io").emit("request:acknowledged", request);
  }

  res.status(200).json({
    success: true,
    message: "Request acknowledged",
    data: request,
  });
});

/**
 * @desc    Resolve request
 * @route   PATCH /api/customer-requests/:id/resolve
 * @access  Private (Staff, Manager)
 */
exports.resolveRequest = asyncHandler(async (req, res) => {
  const query = { _id: req.params.id };

  // Data isolation
  if (req.user.cafeId) {
    query.cafeId = req.user.cafeId;
  } else if (req.user.franchiseId) {
    query.franchiseId = req.user.franchiseId;
  }

  const request = await CustomerRequest.findOne(query);

  if (!request) {
    return res.status(404).json({
      success: false,
      message: "Request not found",
    });
  }

  if (request.status === "resolved") {
    return res.status(400).json({
      success: false,
      message: "Request is already resolved",
    });
  }

  const employee = await Employee.findOne({
    $or: [
      { _id: req.user.employeeId },
      { userId: req.user._id }
    ]
  });

  request.status = "resolved";
  request.resolvedAt = new Date();
  request.resolutionNotes = req.body.notes || "";
  if (employee) {
    request.resolvedBy = employee._id;
  }

  await request.save();

  await request.populate("tableId", "number name");
  await request.populate("resolvedBy", "name employeeRole");

  // Emit Socket.IO event
  if (req.app && req.app.get("io")) {
    req.app.get("io").emit("request:resolved", request);
  }

  res.status(200).json({
    success: true,
    message: "Request resolved successfully",
    data: request,
  });
});

/**
 * @desc    Delete request
 * @route   DELETE /api/customer-requests/:id
 * @access  Private (Manager only)
 */
exports.deleteRequest = asyncHandler(async (req, res) => {
  const query = { _id: req.params.id };

  // Data isolation
  if (req.user.cafeId) {
    query.cafeId = req.user.cafeId;
  } else if (req.user.franchiseId) {
    query.franchiseId = req.user.franchiseId;
  }

  const request = await CustomerRequest.findOneAndDelete(query);

  if (!request) {
    return res.status(404).json({
      success: false,
      message: "Request not found",
    });
  }

  // Emit Socket.IO event
  if (req.app && req.app.get("io")) {
    req.app.get("io").emit("request:deleted", { id: req.params.id });
  }

  res.status(200).json({
    success: true,
    message: "Request deleted successfully",
  });
});

