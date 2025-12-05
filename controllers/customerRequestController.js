const CustomerRequest = require("../models/customerRequestModel");
const Employee = require("../models/employeeModel");
const { Table } = require("../models/tableModel");
const Order = require("../models/orderModel");

// Helper function to build query based on user role
const buildHierarchyQuery = async (user) => {
  const query = {};
  if (user.role === "admin") {
    query.cafeId = user._id;
  } else if (user.role === "franchise_admin") {
    query.franchiseId = user._id;
  } else if (["waiter", "cook", "captain", "manager"].includes(user.role)) {
    // Mobile users - get their cafeId from user or employee record
    if (user.cafeId) {
      query.cafeId = user.cafeId;
    } else if (user.employeeId) {
      const employee = await Employee.findById(user.employeeId).lean();
      if (employee && employee.cafeId) {
        query.cafeId = employee.cafeId;
      }
    } else {
      // Fallback: find by email
      const employee = await Employee.findOne({ email: user.email?.toLowerCase() }).lean();
      if (employee && employee.cafeId) {
        query.cafeId = employee.cafeId;
      }
    }
  } else if (user.role === "employee") {
    // Legacy employee role
    const employee = await Employee.findOne({ email: user.email?.toLowerCase() }).lean();
    if (employee && employee.cafeId) {
      query.cafeId = employee.cafeId;
    }
  }
  return query;
};

// Get all customer requests
exports.getAllRequests = async (req, res) => {
  try {
    const { status, requestType, tableId } = req.query;
    const hierarchyQuery = await buildHierarchyQuery(req.user);
    const query = { ...hierarchyQuery };

    if (status) {
      query.status = status;
    }
    if (requestType) {
      query.requestType = requestType;
    }
    if (tableId) {
      query.tableId = tableId;
    }

    const requests = await CustomerRequest.find(query)
      .populate("tableId", "number name status")
      .populate("assignedTo", "name mobile employeeRole")
      .populate("assignedToUser", "name email role")
      .populate("acknowledgedBy", "name mobile employeeRole")
      .populate("resolvedBy", "name mobile employeeRole")
      .sort({ createdAt: -1 })
      .lean();

    return res.json(requests);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Get pending requests
exports.getPendingRequests = async (req, res) => {
  try {
    const hierarchyQuery = await buildHierarchyQuery(req.user);
    const query = {
      ...hierarchyQuery,
      status: "pending",
    };

    const requests = await CustomerRequest.find(query)
      .populate("tableId", "number name status")
      .populate("assignedTo", "name mobile employeeRole")
      .sort({ createdAt: 1 }) // Oldest first
      .lean();

    return res.json(requests);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Get request by ID
exports.getRequestById = async (req, res) => {
  try {
    const { id } = req.params;
    const hierarchyQuery = await buildHierarchyQuery(req.user);
    const query = { _id: id, ...hierarchyQuery };

    const request = await CustomerRequest.findOne(query)
      .populate("tableId", "number name status")
      .populate("orderId")
      .populate("assignedTo", "name mobile employeeRole")
      .populate("assignedToUser", "name email role")
      .populate("acknowledgedBy", "name mobile employeeRole")
      .populate("resolvedBy", "name mobile employeeRole");

    if (!request) {
      return res.status(404).json({ message: "Customer request not found" });
    }

    return res.json(request);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Create customer request (public endpoint for customers, or mobile users)
exports.createRequest = async (req, res) => {
  try {
    const requestData = { ...req.body };
    const user = req.user;

    // If user is authenticated, set hierarchy relationships
    if (user) {
      if (user.role === "admin") {
        requestData.cafeId = user._id;
        if (user.franchiseId) {
          requestData.franchiseId = user.franchiseId;
        }
      } else if (user.role === "franchise_admin") {
        requestData.franchiseId = user._id;
      } else if (["waiter", "cook", "captain", "manager"].includes(user.role)) {
        if (user.cafeId) {
          requestData.cafeId = user.cafeId;
        } else if (user.employeeId) {
          const employee = await Employee.findById(user.employeeId).lean();
          if (employee && employee.cafeId) {
            requestData.cafeId = employee.cafeId;
          }
        }
        if (user.franchiseId) {
          requestData.franchiseId = user.franchiseId;
        }
      }
    } else {
      // Public request - get cafeId from tableId or orderId
      if (requestData.tableId) {
        const table = await Table.findById(requestData.tableId).lean();
        if (table && table.cartId) {
          requestData.cafeId = table.cartId;
          requestData.franchiseId = table.franchiseId;
        }
      } else if (requestData.orderId) {
        const order = await Order.findById(requestData.orderId).lean();
        if (order && order.cartId) {
          requestData.cafeId = order.cartId;
          requestData.franchiseId = order.franchiseId;
        }
      }
    }

    const request = await CustomerRequest.create(requestData);
    await request.populate("tableId", "number name status");
    await request.populate("assignedTo", "name mobile employeeRole");

    // Emit socket event
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    if (io && emitToCafe && request.cafeId) {
      emitToCafe(io, request.cafeId.toString(), "request:created", request);
    }

    return res.status(201).json(request);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Acknowledge request
exports.acknowledgeRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;
    const hierarchyQuery = await buildHierarchyQuery(req.user);
    const query = { _id: id, ...hierarchyQuery };

    const request = await CustomerRequest.findOne(query);
    if (!request) {
      return res.status(404).json({ message: "Customer request not found" });
    }

    if (request.status !== "pending") {
      return res.status(400).json({ message: `Request is already ${request.status}` });
    }

    request.status = "acknowledged";
    request.acknowledgedAt = new Date();
    
    // Set acknowledgedBy from current user's employeeId
    if (req.user.employeeId) {
      request.acknowledgedBy = req.user.employeeId;
      request.assignedTo = req.user.employeeId;
      request.assignedToUser = req.user._id;
    } else if (["waiter", "cook", "captain", "manager"].includes(req.user.role)) {
      const employee = await Employee.findOne({
        $or: [
          { userId: req.user._id },
          { email: req.user.email?.toLowerCase() }
        ]
      }).lean();
      if (employee) {
        request.acknowledgedBy = employee._id;
        request.assignedTo = employee._id;
        request.assignedToUser = req.user._id;
      }
    }

    if (notes) {
      request.notes = notes;
    }

    await request.save();
    await request.populate("tableId", "number name status");
    await request.populate("assignedTo", "name mobile employeeRole");
    await request.populate("acknowledgedBy", "name mobile employeeRole");

    // Emit socket event
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    if (io && emitToCafe && request.cafeId) {
      emitToCafe(io, request.cafeId.toString(), "request:acknowledged", request);
      emitToCafe(io, request.cafeId.toString(), "request:updated", request);
    }

    return res.json(request);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Resolve request
exports.resolveRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;
    const hierarchyQuery = await buildHierarchyQuery(req.user);
    const query = { _id: id, ...hierarchyQuery };

    const request = await CustomerRequest.findOne(query);
    if (!request) {
      return res.status(404).json({ message: "Customer request not found" });
    }

    if (request.status === "resolved") {
      return res.status(400).json({ message: "Request already resolved" });
    }

    request.status = "resolved";
    request.resolvedAt = new Date();
    
    // Set resolvedBy from current user's employeeId
    if (req.user.employeeId) {
      request.resolvedBy = req.user.employeeId;
    } else if (["waiter", "cook", "captain", "manager"].includes(req.user.role)) {
      const employee = await Employee.findOne({
        $or: [
          { userId: req.user._id },
          { email: req.user.email?.toLowerCase() }
        ]
      }).lean();
      if (employee) {
        request.resolvedBy = employee._id;
      }
    }

    if (notes) {
      request.notes = notes;
    }

    await request.save();
    await request.populate("tableId", "number name status");
    await request.populate("assignedTo", "name mobile employeeRole");
    await request.populate("resolvedBy", "name mobile employeeRole");

    // Emit socket event
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    if (io && emitToCafe && request.cafeId) {
      emitToCafe(io, request.cafeId.toString(), "request:resolved", request);
      emitToCafe(io, request.cafeId.toString(), "request:updated", request);
    }

    return res.json(request);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Update request
exports.updateRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    const hierarchyQuery = await buildHierarchyQuery(req.user);
    const query = { _id: id, ...hierarchyQuery };

    const request = await CustomerRequest.findOne(query);
    if (!request) {
      return res.status(404).json({ message: "Customer request not found" });
    }

    // Update fields
    Object.keys(updates).forEach((key) => {
      if (key !== "_id" && key !== "cafeId" && key !== "franchiseId") {
        request[key] = updates[key];
      }
    });

    await request.save();
    await request.populate("tableId", "number name status");
    await request.populate("assignedTo", "name mobile employeeRole");

    // Emit socket event
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    if (io && emitToCafe && request.cafeId) {
      emitToCafe(io, request.cafeId.toString(), "request:updated", request);
    }

    return res.json(request);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Delete request
exports.deleteRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const hierarchyQuery = await buildHierarchyQuery(req.user);
    const query = { _id: id, ...hierarchyQuery };

    const request = await CustomerRequest.findOne(query);
    if (!request) {
      return res.status(404).json({ message: "Customer request not found" });
    }

    const cafeId = request.cafeId;
    await CustomerRequest.deleteOne({ _id: id });

    // Emit socket event
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    if (io && emitToCafe && cafeId) {
      emitToCafe(io, cafeId.toString(), "request:deleted", { id });
    }

    return res.json({ message: "Customer request deleted successfully" });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Get request statistics
exports.getRequestStats = async (req, res) => {
  try {
    const hierarchyQuery = await buildHierarchyQuery(req.user);
    const requests = await CustomerRequest.find(hierarchyQuery).lean();

    const stats = {
      total: requests.length,
      pending: requests.filter((r) => r.status === "pending").length,
      acknowledged: requests.filter((r) => r.status === "acknowledged").length,
      resolved: requests.filter((r) => r.status === "resolved").length,
      cancelled: requests.filter((r) => r.status === "cancelled").length,
    };

    return res.json(stats);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

