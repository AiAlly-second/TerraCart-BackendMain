const Compliance = require("../models/complianceModel");
const { asyncHandler } = require("../utils/asyncHandler");

/**
 * @desc    Get all compliance documents
 * @route   GET /api/compliance
 * @access  Private (Manager only)
 */
exports.getAllCompliance = asyncHandler(async (req, res) => {
  const {
    type,
    status,
    page = 1,
    limit = 20,
    sort = "-expiryDate",
  } = req.query;

  const query = {};

  // Data isolation
  if (req.user.cafeId) {
    query.cafeId = req.user.cafeId;
  } else if (req.user.franchiseId) {
    query.franchiseId = req.user.franchiseId;
  }

  // Apply filters
  if (type) query.type = type;
  if (status) query.status = status;

  // Pagination
  const pageNum = parseInt(page);
  const limitNum = parseInt(limit);
  const skip = (pageNum - 1) * limitNum;

  const compliance = await Compliance.find(query)
    .sort(sort)
    .skip(skip)
    .limit(limitNum);

  const total = await Compliance.countDocuments(query);

  res.status(200).json({
    success: true,
    data: compliance,
    pagination: {
      page: pageNum,
      limit: limitNum,
      total,
      pages: Math.ceil(total / limitNum),
    },
  });
});

/**
 * @desc    Get expiring compliance documents
 * @route   GET /api/compliance/expiring
 * @access  Private (Manager only)
 */
exports.getExpiringCompliance = asyncHandler(async (req, res) => {
  const { days = 30 } = req.query;
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + parseInt(days));

  const query = {
    expiryDate: { $lte: futureDate, $gte: new Date() },
    status: { $ne: "expired" },
  };

  // Data isolation
  if (req.user.cafeId) {
    query.cafeId = req.user.cafeId;
  } else if (req.user.franchiseId) {
    query.franchiseId = req.user.franchiseId;
  }

  const compliance = await Compliance.find(query)
    .sort("expiryDate")
    .limit(50);

  res.status(200).json({
    success: true,
    data: compliance,
  });
});

/**
 * @desc    Get compliance document by ID
 * @route   GET /api/compliance/:id
 * @access  Private (Manager only)
 */
exports.getComplianceById = asyncHandler(async (req, res) => {
  const query = { _id: req.params.id };

  // Data isolation
  if (req.user.cafeId) {
    query.cafeId = req.user.cafeId;
  } else if (req.user.franchiseId) {
    query.franchiseId = req.user.franchiseId;
  }

  const compliance = await Compliance.findOne(query);

  if (!compliance) {
    return res.status(404).json({
      success: false,
      message: "Compliance document not found",
    });
  }

  res.status(200).json({
    success: true,
    data: compliance,
  });
});

/**
 * @desc    Create compliance document
 * @route   POST /api/compliance
 * @access  Private (Manager only)
 */
exports.createCompliance = asyncHandler(async (req, res) => {
  const {
    title,
    type,
    expiryDate,
    documentUrl,
    renewalDate,
    renewalReminderDays,
    notes,
  } = req.body;

  if (!title || !type || !expiryDate) {
    return res.status(400).json({
      success: false,
      message: "Title, type, and expiry date are required",
    });
  }

  const complianceData = {
    title,
    type,
    expiryDate: new Date(expiryDate),
    documentUrl: documentUrl || "",
    renewalReminderDays: renewalReminderDays || 30,
    notes: notes || "",
  };

  // Data isolation
  if (req.user.cafeId) {
    complianceData.cafeId = req.user.cafeId;
    complianceData.franchiseId = req.user.franchiseId;
  } else if (req.user.franchiseId) {
    complianceData.franchiseId = req.user.franchiseId;
  }

  if (renewalDate) {
    complianceData.renewalDate = new Date(renewalDate);
  }

  const compliance = await Compliance.create(complianceData);

  // Emit Socket.IO event
  if (req.app && req.app.get("io")) {
    req.app.get("io").emit("compliance:created", compliance);
  }

  res.status(201).json({
    success: true,
    message: "Compliance document created successfully",
    data: compliance,
  });
});

/**
 * @desc    Update compliance document
 * @route   PATCH /api/compliance/:id
 * @access  Private (Manager only)
 */
exports.updateCompliance = asyncHandler(async (req, res) => {
  const query = { _id: req.params.id };

  // Data isolation
  if (req.user.cafeId) {
    query.cafeId = req.user.cafeId;
  } else if (req.user.franchiseId) {
    query.franchiseId = req.user.franchiseId;
  }

  const compliance = await Compliance.findOne(query);

  if (!compliance) {
    return res.status(404).json({
      success: false,
      message: "Compliance document not found",
    });
  }

  // Update allowed fields
  const allowedFields = [
    "title",
    "type",
    "expiryDate",
    "documentUrl",
    "renewalDate",
    "renewalReminderDays",
    "notes",
  ];
  allowedFields.forEach((field) => {
    if (req.body[field] !== undefined) {
      if (field === "expiryDate" || field === "renewalDate") {
        compliance[field] = new Date(req.body[field]);
      } else {
        compliance[field] = req.body[field];
      }
    }
  });

  await compliance.save();

  // Emit Socket.IO event
  if (req.app && req.app.get("io")) {
    req.app.get("io").emit("compliance:updated", compliance);
  }

  res.status(200).json({
    success: true,
    message: "Compliance document updated successfully",
    data: compliance,
  });
});

/**
 * @desc    Delete compliance document
 * @route   DELETE /api/compliance/:id
 * @access  Private (Manager only)
 */
exports.deleteCompliance = asyncHandler(async (req, res) => {
  const query = { _id: req.params.id };

  // Data isolation
  if (req.user.cafeId) {
    query.cafeId = req.user.cafeId;
  } else if (req.user.franchiseId) {
    query.franchiseId = req.user.franchiseId;
  }

  const compliance = await Compliance.findOneAndDelete(query);

  if (!compliance) {
    return res.status(404).json({
      success: false,
      message: "Compliance document not found",
    });
  }

  // Emit Socket.IO event
  if (req.app && req.app.get("io")) {
    req.app.get("io").emit("compliance:deleted", { id: req.params.id });
  }

  res.status(200).json({
    success: true,
    message: "Compliance document deleted successfully",
  });
});

/**
 * @desc    Get compliance statistics
 * @route   GET /api/compliance/stats
 * @access  Private (Manager only)
 */
exports.getComplianceStats = asyncHandler(async (req, res) => {
  const query = {};

  // Data isolation
  if (req.user.cafeId) {
    query.cafeId = req.user.cafeId;
  } else if (req.user.franchiseId) {
    query.franchiseId = req.user.franchiseId;
  }

  const [
    total,
    valid,
    expiringSoon,
    expired,
    renewalPending,
  ] = await Promise.all([
    Compliance.countDocuments(query),
    Compliance.countDocuments({ ...query, status: "valid" }),
    Compliance.countDocuments({ ...query, status: "expiring_soon" }),
    Compliance.countDocuments({ ...query, status: "expired" }),
    Compliance.countDocuments({ ...query, status: "renewal_pending" }),
  ]);

  res.status(200).json({
    success: true,
    data: {
      total,
      valid,
      expiringSoon,
      expired,
      renewalPending,
    },
  });
});

