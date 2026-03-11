const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const Supplier = require("../../models/costing-v2/supplierModel");
const Ingredient = require("../../models/costing-v2/ingredientModel");
const Purchase = require("../../models/costing-v2/purchaseModel");
const InventoryTransaction = require("../../models/costing-v2/inventoryTransactionModel");
const Recipe = require("../../models/costing-v2/recipeModel");

// Helper function for logging
const logDebug = (location, message, data, hypothesisId) => {
  try {
    const logEntry = {
      location,
      message,
      data,
      timestamp: Date.now(),
      sessionId: "debug-session",
      runId: "pre-fix",
      hypothesisId,
    };
    const logPath = path.join(__dirname, "../../../.cursor/debug.log");
    fs.appendFileSync(logPath, JSON.stringify(logEntry) + "\n");
  } catch (err) {
    // Silently fail if logging fails
  }
};
const MenuItem = require("../../models/costing-v2/menuItemModel");
const { MenuItem: OperationalMenuItem } = require("../../models/menuItemModel");
const MenuCategory = require("../../models/menuCategoryModel");

// Helper function for manual unit conversion (fallback when ingredient method fails)
function convertQtyToBaseUnit(qty, fromUom, baseUnit) {
  if (fromUom === baseUnit) return qty;

  // Standard conversions
  if (baseUnit === 'g') {
    if (fromUom === 'kg') return qty * 1000;
    if (fromUom === 'g') return qty;
  } else if (baseUnit === 'ml') {
    if (fromUom === 'l') return qty * 1000;
    if (fromUom === 'ml') return qty;
  } else if (baseUnit === 'pcs') {
    if (fromUom === 'pcs' || fromUom === 'pack' || fromUom === 'box' || fromUom === 'bottle' || fromUom === 'dozen') {
      // For pieces, assume 1:1 unless it's dozen
      if (fromUom === 'dozen') return qty * 12;
      return qty;
    }
  }

  // If no conversion found, return original qty (assume same unit)
  console.warn(`[CONVERSION] No conversion factor found for ${fromUom} to ${baseUnit}, using original qty`);
  return qty;
}

// Helper function to safely convert to base unit (works with both Mongoose documents and plain objects)
function safeConvertToBaseUnit(ingredient, qty, fromUom) {
  // If ingredient has the method (Mongoose document), use it
  if (ingredient && typeof ingredient.convertToBaseUnit === 'function') {
    try {
      return ingredient.convertToBaseUnit(qty, fromUom);
    } catch (error) {
      // Fallback to manual conversion if method fails
      return convertQtyToBaseUnit(qty, fromUom, ingredient.baseUnit);
    }
  }

  // Otherwise, use manual conversion
  const baseUnit = ingredient?.baseUnit || 'pcs';
  return convertQtyToBaseUnit(qty, fromUom, baseUnit);
}

const Waste = require("../../models/costing-v2/wasteModel");
const LabourCost = require("../../models/costing-v2/labourCostModel");
const Overhead = require("../../models/costing-v2/overheadModel");
const User = require("../../models/userModel");
const Employee = require("../../models/employeeModel");
const Cart = require("../../models/cartModel");
const CartMenuItem = require("../../models/cartMenuModel");
const CostingExpense = require("../../models/costing-v2/expenseModel");
const CostingExpenseCategory = require("../../models/costing-v2/expenseCategoryModel");
const Order = require("../../models/orderModel");
const DefaultMenu = require("../../models/defaultMenuModel");
const FIFOService = require("../../services/costing-v2/fifoService");
const WeightedAverageService = require("../../services/costing-v2/weightedAverageService");
const { convertUnit } = require("../../utils/costing-v2/unitConverter");
const {
  buildCostingQuery,
  getAllowedOutlets,
  validateOutletAccess,
  setOutletContext,
} = require("../../utils/costing-v2/accessControl");

/** Safe ObjectId conversion - returns null for invalid IDs instead of throwing. */
const toObjectIdSafe = (id) => {
  if (id == null || id === "") return null;
  const str = String(id);
  return mongoose.Types.ObjectId.isValid(str) ? new mongoose.Types.ObjectId(str) : null;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_MINUTE = 60 * 1000;

const parseOptionalDate = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const parseBooleanish = (value) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const token = value.trim().toLowerCase();
    if (["true", "1", "yes", "y"].includes(token)) return true;
    if (["false", "0", "no", "n"].includes(token)) return false;
  }
  return null;
};

const toFiniteNumberOrNull = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const formatRemainingShelfLife = (remainingMs) => {
  if (remainingMs <= 0) return "Expired";

  const minutes = Math.ceil(remainingMs / MS_PER_MINUTE);
  if (minutes < 60) {
    return `${minutes} min left`;
  }

  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (remainingMs < MS_PER_DAY) {
    if (mins === 0) {
      return `${hours} hr${hours !== 1 ? "s" : ""} left`;
    }
    return `${hours} hr${hours !== 1 ? "s" : ""} ${mins} min left`;
  }

  const days = Math.ceil(remainingMs / MS_PER_DAY);
  return `${days} day${days !== 1 ? "s" : ""} left`;
};

const resolveShelfLifeState = ({
  shelfTimeDays,
  lastReceivedAt,
  expiryDate,
  now = new Date(),
}) => {
  const shelfDays = toFiniteNumberOrNull(shelfTimeDays);
  const startDate = parseOptionalDate(lastReceivedAt);
  const explicitExpiryDate = parseOptionalDate(expiryDate);

  let resolvedExpiryDate = explicitExpiryDate;
  if (!resolvedExpiryDate && shelfDays !== null && startDate) {
    resolvedExpiryDate = new Date(startDate);
    resolvedExpiryDate.setDate(resolvedExpiryDate.getDate() + shelfDays);
  }

  if (!resolvedExpiryDate) {
    if (shelfDays !== null) {
      return {
        shelfDays,
        shelfLifeText: `Shelf: ${shelfDays} day${shelfDays !== 1 ? "s" : ""}`,
        shelfLifeStatus: "shelf_only",
        remainingMs: null,
        remainingMinutes: null,
        daysRemaining: null,
        expiryAt: null,
      };
    }
    return {
      shelfDays: null,
      shelfLifeText: null,
      shelfLifeStatus: null,
      remainingMs: null,
      remainingMinutes: null,
      daysRemaining: null,
      expiryAt: null,
    };
  }

  const remainingMs = resolvedExpiryDate.getTime() - now.getTime();
  const remainingMinutes = Math.ceil(remainingMs / MS_PER_MINUTE);
  const daysRemaining = Math.ceil(remainingMs / MS_PER_DAY);
  const isExpired = remainingMs <= 0;

  return {
    shelfDays,
    shelfLifeText: formatRemainingShelfLife(remainingMs),
    shelfLifeStatus: isExpired
      ? "expired"
      : daysRemaining <= 3
      ? "near_expiry"
      : "fresh",
    remainingMs,
    remainingMinutes,
    daysRemaining,
    expiryAt: resolvedExpiryDate,
  };
};

const parseDateAtStartOfDay = (value) => {
  if (value == null || value === "") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  date.setHours(0, 0, 0, 0);
  return date;
};

const parseDateAtEndOfDay = (value) => {
  if (value == null || value === "") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  date.setHours(23, 59, 59, 999);
  return date;
};

/**
 * Supports both query styles:
 * - from/to (current costing-v2 UI)
 * - startDate/endDate (backward compatibility)
 */
const resolveDateRangeFromQuery = (query = {}) => {
  const rawFrom =
    typeof query.from === "string" && query.from.trim() !== ""
      ? query.from.trim()
      : typeof query.startDate === "string" && query.startDate.trim() !== ""
      ? query.startDate.trim()
      : null;
  const rawTo =
    typeof query.to === "string" && query.to.trim() !== ""
      ? query.to.trim()
      : typeof query.endDate === "string" && query.endDate.trim() !== ""
      ? query.endDate.trim()
      : null;

  const fromDate = rawFrom ? parseDateAtStartOfDay(rawFrom) : null;
  const toDate = rawTo ? parseDateAtEndOfDay(rawTo) : null;

  if ((rawFrom && !fromDate) || (rawTo && !toDate)) {
    return {
      error: "Invalid date format. Use YYYY-MM-DD for from/to filters",
    };
  }

  if (fromDate && toDate && fromDate > toDate) {
    return { error: "From date cannot be after to date" };
  }

  return {
    from: rawFrom,
    to: rawTo,
    fromDate,
    toDate,
  };
};

/** Build cartId match that supports both ObjectId and string stored IDs. */
const buildFlexibleCartIdFilter = (id) => {
  const objId = toObjectIdSafe(id);
  const strId = id
    ? typeof id === "string"
      ? id
      : id.toString?.() || String(id)
    : null;

  const values = [];
  if (objId) values.push(objId);
  if (strId && (!objId || strId !== objId.toString())) values.push(strId);

  if (values.length === 0) return null;
  if (values.length === 1) return values[0];
  return { $in: values };
};

const flattenCartIdFilterValues = (ids = []) =>
  ids.flatMap((id) => {
    const filter = buildFlexibleCartIdFilter(id);
    if (!filter) return [];
    return filter.$in ? filter.$in : [filter];
  });

/**
 * Sales-recognized order clause:
 * - Supports current canonical model (`paymentStatus: PAID`, `isPaid`)
 * - Keeps legacy status compatibility for older records.
 */
const buildSalesRecognizedOrderClause = () => ({
  $or: [
    { paymentStatus: "PAID" },
    { isPaid: true },
    {
      status: {
        $in: [
          "PAID",
          "Paid",
          "FINALIZED",
          "Finalized",
          "EXIT",
          "Exit",
          "COMPLETED",
          "Completed",
          "SERVED",
          "Served",
        ],
      },
    },
    { lifecycleStatus: { $in: ["COMPLETED", "SERVED"] } },
  ],
});

const sumProratedPeriodAmount = (rows = [], fromDate = null, toDate = null) =>
  Number(
    rows
      .reduce((sum, row) => {
        const amount = Number(row?.amount) || 0;
        if (amount === 0) return sum;

        const periodFrom = parseDateAtStartOfDay(row?.periodFrom);
        const periodTo = parseDateAtEndOfDay(row?.periodTo);
        if (!periodFrom || !periodTo || periodTo < periodFrom) return sum;

        if (!fromDate && !toDate) return sum + amount;

        const effectiveFrom = fromDate || periodFrom;
        const effectiveTo = toDate || periodTo;
        const overlapFrom = periodFrom > effectiveFrom ? periodFrom : effectiveFrom;
        const overlapTo = periodTo < effectiveTo ? periodTo : effectiveTo;
        if (overlapTo < overlapFrom) return sum;

        const totalDays =
          Math.max(0, Math.floor((periodTo.getTime() - periodFrom.getTime()) / MS_PER_DAY)) + 1;
        const overlapDays =
          Math.max(0, Math.floor((overlapTo.getTime() - overlapFrom.getTime()) / MS_PER_DAY)) + 1;
        if (totalDays <= 0 || overlapDays <= 0) return sum;

        return sum + (amount * overlapDays) / totalDays;
      }, 0)
      .toFixed(2)
  );

/**
 * Decode HTML entities in a string
 * Handles common HTML entities like &amp;, &lt;, &gt;, &quot;, &#39;
 */
const decodeHtmlEntities = (str) => {
  if (typeof str !== "string") return str;
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/");
};

const resolveUserCartId = async (user) => {
  if (!user) return null;

  if (user.cartId) return user.cartId;
  if (user.cafeId) return user.cafeId;

  if (user.employeeId) {
    const employee = await Employee.findById(user.employeeId)
      .select("cartId cafeId")
      .lean();
    if (employee?.cartId || employee?.cafeId) {
      return employee.cartId || employee.cafeId;
    }
  }

  const employee = await Employee.findOne({
    $or: [{ userId: user._id }, { email: user.email?.toLowerCase() }],
  })
    .select("cartId cafeId")
    .lean();

  return employee?.cartId || employee?.cafeId || null;
};

// ==================== SUPPLIERS ====================

/**
 * @route   GET /api/costing-v2/suppliers
 * @desc    Get suppliers filtered by cart/kiosk/cafe
 * @note    Suppliers are now cart-specific (have cartId field)
 */
exports.getSuppliers = async (req, res) => {
  try {
    const { isActive, search } = req.query;
    const filter = {};

    if (isActive !== undefined) filter.isActive = isActive === "true";
    if (search) filter.name = { $regex: search, $options: "i" };

    // Apply role-based filtering using buildCostingQuery (suppliers now have cartId)
    const costingFilter = await buildCostingQuery(req.user, filter);

    console.log(
      "[GET_SUPPLIERS] Filter:",
      JSON.stringify(costingFilter),
      "User role:",
      req.user.role
    );

    const suppliers = await Supplier.find(costingFilter).sort({ name: 1 });
    res.json({ success: true, data: suppliers });
  } catch (error) {
    console.error("[GET_SUPPLIERS] Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   POST /api/costing-v2/suppliers
 * @desc    Create supplier (automatically associates with cart/kiosk/cafe)
 */
exports.createSupplier = async (req, res) => {
  try {
    // Use setOutletContext to automatically set cartId and franchiseId based on user role
    const supplierData = { ...req.body };

    // Handle cartId from request body (convert to cartId for consistency)
    if (supplierData.cartId && !supplierData.cartId) {
      supplierData.cartId = supplierData.cartId;
      delete supplierData.cartId;
    }

    // Use setOutletContext utility to set cartId and franchiseId
    const data = await setOutletContext(req.user, supplierData, true);

    console.log("[CREATE_SUPPLIER] Creating supplier with:", {
      name: data.name,
      cartId: data.cartId,
      franchiseId: data.franchiseId,
      userRole: req.user.role,
    });

    const supplier = new Supplier(data);
    await supplier.save();
    res.status(201).json({ success: true, data: supplier });
  } catch (error) {
    console.error("[CREATE_SUPPLIER] Error:", error);
    res.status(400).json({ success: false, message: error.message });
  }
};

/**
 * @route   PUT /api/costing-v2/suppliers/:id
 * @desc    Update supplier
 */
exports.updateSupplier = async (req, res) => {
  try {
    const supplier = await Supplier.findById(req.params.id);
    if (!supplier) {
      return res
        .status(404)
        .json({ success: false, message: "Supplier not found" });
    }

    // Check access: cart admin can only update their own suppliers
    if (req.user.role === "admin") {
      if (supplier.cartId?.toString() !== req.user._id.toString()) {
        return res.status(403).json({
          success: false,
          message:
            "Access denied: You can only update suppliers belonging to your cart",
        });
      }
    } else if (req.user.role === "manager") {
      // Manager can only update suppliers for their own cart
      const managerCartId = await resolveUserCartId(req.user);
      if (!managerCartId || supplier.cartId?.toString() !== managerCartId.toString()) {
        return res.status(403).json({
          success: false,
          message:
            "Access denied: You can only update suppliers belonging to your cart",
        });
      }
    } else if (req.user.role === "franchise_admin") {
      // Franchise admin can update suppliers from their franchise carts
      const outlet = await User.findById(supplier.cartId);
      if (
        !outlet ||
        outlet.franchiseId?.toString() !== req.user._id.toString()
      ) {
        return res.status(403).json({
          success: false,
          message: "Access denied: Supplier does not belong to your franchise",
        });
      }
    }
    // Super admin can update any supplier

    // Prevent changing cartId/franchiseId (suppliers are cart-specific)
    const updateData = { ...req.body };
    delete updateData.cartId;
    delete updateData.franchiseId;

    const updatedSupplier = await Supplier.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    );

    res.json({ success: true, data: updatedSupplier });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

/**
 * @route   DELETE /api/costing-v2/suppliers/:id
 * @desc    Delete supplier
 */
exports.deleteSupplier = async (req, res) => {
  try {
    const supplier = await Supplier.findById(req.params.id);
    if (!supplier) {
      return res
        .status(404)
        .json({ success: false, message: "Supplier not found" });
    }

    // Check access: cart admin can only delete their own suppliers
    if (req.user.role === "admin") {
      if (supplier.cartId?.toString() !== req.user._id.toString()) {
        return res.status(403).json({
          success: false,
          message:
            "Access denied: You can only delete suppliers belonging to your cart",
        });
      }
    } else if (req.user.role === "manager") {
      // Manager can only delete suppliers for their own cart
      const managerCartId = await resolveUserCartId(req.user);
      if (!managerCartId || supplier.cartId?.toString() !== managerCartId.toString()) {
        return res.status(403).json({
          success: false,
          message:
            "Access denied: You can only delete suppliers belonging to your cart",
        });
      }
    } else if (req.user.role === "franchise_admin") {
      // Franchise admin can delete suppliers from their franchise carts
      const outlet = await User.findById(supplier.cartId);
      if (
        !outlet ||
        outlet.franchiseId?.toString() !== req.user._id.toString()
      ) {
        return res.status(403).json({
          success: false,
          message: "Access denied: Supplier does not belong to your franchise",
        });
      }
    }
    // Super admin can delete any supplier

    await Supplier.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: "Supplier deleted" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ==================== INGREDIENTS ====================

/**
 * @route   GET /api/costing-v2/ingredients
 * @desc    Get all ingredients with filters
 */
exports.getIngredients = async (req, res) => {
  try {
    // CRITICAL: Log request details for debugging
    console.log(`[GET_INGREDIENTS] Request received - User: ${req.user?.role} (${req.user?._id}), Query:`, req.query);

    const {
      uom,
      lowStock,
      search,
      isActive,
      cartId: queryCartId,
      outletId, // Backward compatibility - will be mapped to cartId
      category,
      storageLocation,
    } = req.query;
    const filter = {};

    if (uom) filter.uom = uom;
    // CRITICAL: Only apply isActive filter if explicitly provided
    // Don't default to isActive: true for cart admin - they need to see shared ingredients
    // even if they're inactive (super admin might have created them as inactive)
    if (isActive !== undefined && isActive !== "") {
      filter.isActive = isActive === "true";
    }
    // Removed default isActive: true - let cart admin see all shared ingredients
    if (search) filter.name = { $regex: search, $options: "i" };
    // Only set cartId from query parameter for franchise/super admins, not for cart admins
    // Cart admins should see both their own ingredients (cartId = their _id) AND shared ingredients (cartId = null)
    // This is handled by buildCostingQuery with includeShared: true
    // Support both cartId and outletId (backward compatibility)
    const cartIdParam = queryCartId || outletId;
    if (cartIdParam && req.user.role !== "admin") {
      filter.cartId = cartIdParam;
    }
    if (category) filter.category = category;
    if (storageLocation) filter.storageLocation = storageLocation;

    // Apply role-based filtering
    // For cart admins (role: "admin"), always filter by their cartId (req.user._id)
    // This ensures cart admins only see ingredients belonging to their cart/kiosk
    // For franchise/super admins, can see shared ingredients (cartId=null) or filter by specific cartId.
    // Additionally, for franchise_admin we include shared/global ingredients (franchiseId=null).
    const shouldSkipCartFilter =
      (req.user.role === "franchise_admin" ||
        req.user.role === "super_admin") &&
      !cartIdParam;
    let costingFilter = await buildCostingQuery(req.user, filter, {
      skipOutletFilter: shouldSkipCartFilter,
      includeShared: true,
    });

    // Enhanced logging for debugging
    console.log(`[GET_INGREDIENTS] User: ${req.user?.role} (${req.user?._id})`);
    console.log(`[GET_INGREDIENTS] Input filter:`, JSON.stringify(filter, null, 2));
    console.log(`[GET_INGREDIENTS] Final costingFilter:`, JSON.stringify(costingFilter, null, 2));

    if (req.user.role === "admin") {
      // Check what ingredients exist before query
      const userCartId = req.user._id;
      const userCartIdObj = mongoose.Types.ObjectId.isValid(userCartId)
        ? new mongoose.Types.ObjectId(userCartId)
        : userCartId;

      const cartSpecificCount = await Ingredient.countDocuments({ cartId: userCartIdObj });
      const sharedCount = await Ingredient.countDocuments({ cartId: null });
      const noCartIdCount = await Ingredient.countDocuments({ cartId: { $exists: false } });

      console.log(`[GET_INGREDIENTS] Cart admin ${req.user._id} - Before query:`);
      console.log(`  - Cart-specific (cartId=${userCartIdObj}): ${cartSpecificCount}`);
      console.log(`  - Shared (cartId=null): ${sharedCount}`);
      console.log(`  - Legacy (no cartId): ${noCartIdCount}`);
      console.log(`  - Total: ${cartSpecificCount + sharedCount + noCartIdCount}`);
    }

    // CRITICAL: For cart admins, test the query directly before executing
    if (req.user.role === "admin") {
      const userCartId = req.user._id;
      const userCartIdObj = mongoose.Types.ObjectId.isValid(userCartId)
        ? new mongoose.Types.ObjectId(userCartId)
        : userCartId;

      // Test direct queries
      const directTest1 = await Ingredient.find({ cartId: userCartIdObj }).countDocuments();
      const directTest2 = await Ingredient.find({ cartId: null }).countDocuments();
      const directTest3 = await Ingredient.find({
        $or: [
          { cartId: userCartIdObj },
          { cartId: null },
          { cartId: { $exists: false } }
        ]
      }).countDocuments();

      console.log(`[GET_INGREDIENTS] Direct query tests:`);
      console.log(`  - {cartId: ObjectId("${userCartIdObj}")}: ${directTest1} results`);
      console.log(`  - {cartId: null}: ${directTest2} results`);
      console.log(`  - {$or: [...]}: ${directTest3} results`);
      console.log(`[GET_INGREDIENTS] Executing query with filter:`, JSON.stringify(costingFilter, null, 2));
    }

    // CRITICAL: For cart admins, use a SIMPLIFIED and DIRECT query (like recipes)
    let ingredients = [];

    // CRITICAL FIX: For cart admin, use a simple direct query that definitely works
    let ingredientsFetched = false;
    if (req.user.role === "admin") {
      const userCartId = req.user._id;
      const userCartIdObj = mongoose.Types.ObjectId.isValid(userCartId)
        ? new mongoose.Types.ObjectId(userCartId)
        : userCartId;

      // FIRST: Check what actually exists in the database
      const dbCheckCart = await Ingredient.countDocuments({ cartId: userCartIdObj });
      const dbCheckNull = await Ingredient.countDocuments({ cartId: null });
      const dbCheckNullActive = await Ingredient.countDocuments({ cartId: null, isActive: true });
      const dbCheckNullInactive = await Ingredient.countDocuments({ cartId: null, isActive: false });
      const dbCheckExists = await Ingredient.countDocuments({ cartId: { $exists: false } });

      console.log(`[GET_INGREDIENTS] 🔍 DATABASE STATE CHECK:`);
      console.log(`  - Ingredients with cartId=${userCartIdObj}: ${dbCheckCart}`);
      console.log(`  - Ingredients with cartId=null (ALL): ${dbCheckNull}`);
      console.log(`  - Ingredients with cartId=null AND isActive=true: ${dbCheckNullActive}`);
      console.log(`  - Ingredients with cartId=null AND isActive=false: ${dbCheckNullInactive}`);
      console.log(`  - Ingredients without cartId field: ${dbCheckExists}`);
      console.log(`  - TOTAL SHARED (null + no field): ${dbCheckNull + dbCheckExists}`);

      // Build a simple, direct query similar to recipes
      // Get ingredients with cartId = userCartId OR cartId = null (shared from super admin)
      // CRITICAL: This query ensures cart admin sees:
      // 1. Ingredients created by super admin (cartId: null) - SHARED
      // 2. Ingredients specific to this cart (cartId: userCartId)
      // 3. Legacy ingredients without cartId field
      const baseQuery = {
        $or: [
          { cartId: null },                    // Shared ingredients from super admin
          { cartId: userCartIdObj },           // Cart-specific ingredients
          { cartId: { $exists: false } }       // Legacy ingredients
        ]
      };

      console.log(`[GET_INGREDIENTS] 🔗 CONNECTION: Cart admin query will find:`);
      console.log(`   - Shared ingredients (cartId: null) from super admin`);
      console.log(`   - Cart-specific ingredients (cartId: ${userCartIdObj})`);
      console.log(`   - Legacy ingredients (no cartId field)`);

      // Apply other filters (category, search, etc.) using $and
      // NOTE: Don't apply isActive filter here - we want to see ALL shared ingredients
      // Cart admin can filter by isActive on the frontend if needed
      const otherFilters = {};
      // Skip isActive filter to ensure shared ingredients are visible
      if (filter.name) {
        otherFilters.name = filter.name;
      }
      if (filter.category) {
        otherFilters.category = filter.category;
      }
      if (filter.storageLocation) {
        otherFilters.storageLocation = filter.storageLocation;
      }
      if (filter.uom) {
        otherFilters.uom = filter.uom;
      }

      // Combine base query with other filters
      if (Object.keys(otherFilters).length > 0) {
        costingFilter = {
          $and: [
            baseQuery,
            otherFilters
          ]
        };
      } else {
        costingFilter = baseQuery;
      }

      console.log(`[GET_INGREDIENTS] ⚠️ NOT applying isActive filter - showing ALL shared ingredients (active + inactive)`);

      console.log(`[GET_INGREDIENTS] ✅ Using simplified direct query for cart admin`);
      console.log(`[GET_INGREDIENTS] Final filter:`, JSON.stringify(costingFilter, null, 2));

      // Test the query before executing
      const testCount = await Ingredient.countDocuments(costingFilter);
      console.log(`[GET_INGREDIENTS] Test query count: ${testCount}`);

      // Also test without any filters to see total
      const testAllCount = await Ingredient.countDocuments(baseQuery);
      console.log(`[GET_INGREDIENTS] Test base query (no other filters) count: ${testAllCount}`);

      // If test count is 0 but we know ingredients exist, use emergency fallback
      if (testCount === 0 && (dbCheckNull > 0 || dbCheckExists > 0)) {
        console.error(`[GET_INGREDIENTS] ⚠️⚠️⚠️ CRITICAL: Query returns 0 but ingredients exist!`);
        console.error(`[GET_INGREDIENTS] Using emergency fallback: Fetching shared ingredients directly...`);

        // Emergency fallback: fetch shared ingredients directly
        const sharedIngredients = await Ingredient.find({ cartId: null })
          .populate("preferredSupplierId", "name")
          .populate("cartId", "name cafeName")
          .sort({ category: 1, name: 1 });

        // Also get cart-specific ingredients
        const cartSpecificIngredients = await Ingredient.find({ cartId: userCartIdObj })
          .populate("preferredSupplierId", "name")
          .populate("cartId", "name cafeName")
          .sort({ category: 1, name: 1 });

        // Combine both
        ingredients = [...sharedIngredients, ...cartSpecificIngredients];
        ingredientsFetched = true;
        console.error(`[GET_INGREDIENTS] ✅ Emergency fetch: ${sharedIngredients.length} shared + ${cartSpecificIngredients.length} cart-specific = ${ingredients.length} total`);
      }
    }

    // Unified query execution for all roles (only if not already fetched)
    if (!ingredientsFetched) {
      // Ensure costingFilter is defined (for non-admin users, it's set by buildCostingQuery above)
      if (!costingFilter) {
        costingFilter = await buildCostingQuery(req.user, filter, {
          skipOutletFilter: shouldSkipCartFilter,
          includeShared: true,
        });
      }
      ingredients = await Ingredient.find(costingFilter)
        .populate("preferredSupplierId", "name")
        .populate("cartId", "name cafeName")
        .sort({ category: 1, name: 1 });
    }

    // CRITICAL: Log final count before processing
    console.log(`[GET_INGREDIENTS] Final ingredients count before processing: ${ingredients.length}`);

    // CRITICAL: If ingredients is empty, log detailed debugging info
    if (ingredients.length === 0) {
      console.warn(`[GET_INGREDIENTS] ⚠️⚠️⚠️ NO INGREDIENTS FOUND!`);
      console.warn(`[GET_INGREDIENTS] User role: ${req.user.role}, User ID: ${req.user._id}`);
      console.warn(`[GET_INGREDIENTS] Query filter used:`, JSON.stringify(costingFilter, null, 2));
      console.warn(`[GET_INGREDIENTS] ingredientsFetched: ${ingredientsFetched}`);

      // Check database directly
      const totalInDB = await Ingredient.countDocuments({});
      console.warn(`[GET_INGREDIENTS] Total ingredients in database: ${totalInDB}`);

      if (req.user.role === "admin") {
        const userCartId = req.user._id;
        const userCartIdObj = mongoose.Types.ObjectId.isValid(userCartId)
          ? new mongoose.Types.ObjectId(userCartId)
          : userCartId;

        const cartSpecific = await Ingredient.countDocuments({ cartId: userCartIdObj });
        const shared = await Ingredient.countDocuments({ cartId: null });
        const noCartId = await Ingredient.countDocuments({ cartId: { $exists: false } });

        console.warn(`[GET_INGREDIENTS] Cart admin breakdown:`);
        console.warn(`  - Cart-specific (cartId=${userCartIdObj}): ${cartSpecific}`);
        console.warn(`  - Shared (cartId=null): ${shared}`);
        console.warn(`  - Legacy (no cartId): ${noCartId}`);
        console.warn(`  - Total should be visible: ${cartSpecific + shared + noCartId}`);

        // Try the exact query we're using
        const testQueryResult = await Ingredient.find(costingFilter).limit(5);
        console.warn(`[GET_INGREDIENTS] Test query result count: ${testQueryResult.length}`);
        if (testQueryResult.length > 0) {
          console.warn(`[GET_INGREDIENTS] Test query found ingredients! Sample:`, testQueryResult[0].name);
        }
      }
    }

    // If no ingredients found, log detailed info and try without isActive filter
    if (ingredients.length === 0 && req.user.role === "admin") {
      console.warn(`[GET_INGREDIENTS] ⚠️ No ingredients found with current filter!`);
      console.warn(`[GET_INGREDIENTS] User role: ${req.user.role}, User ID: ${req.user._id}`);

      const userCartId = req.user._id;
      const userCartIdObj = mongoose.Types.ObjectId.isValid(userCartId)
        ? new mongoose.Types.ObjectId(userCartId)
        : userCartId;

      // Check database directly
      const dbCheck1 = await Ingredient.countDocuments({ cartId: userCartIdObj });
      const dbCheck2 = await Ingredient.countDocuments({ cartId: null });
      const dbCheck2Active = await Ingredient.countDocuments({ cartId: null, isActive: true });
      const dbCheck2Inactive = await Ingredient.countDocuments({ cartId: null, isActive: false });
      const dbCheck3 = await Ingredient.countDocuments({});

      console.warn(`[GET_INGREDIENTS] Database check:`);
      console.warn(`  - Total ingredients in DB: ${dbCheck3}`);
      console.warn(`  - Ingredients with cartId=${userCartIdObj}: ${dbCheck1}`);
      console.warn(`  - Ingredients with cartId=null (all): ${dbCheck2}`);
      console.warn(`  - Ingredients with cartId=null AND isActive=true: ${dbCheck2Active}`);
      console.warn(`  - Ingredients with cartId=null AND isActive=false: ${dbCheck2Inactive}`);

      // If shared ingredients exist but are inactive, try query without isActive filter
      if (dbCheck2 > 0 && dbCheck2Active === 0 && filter.isActive === true) {
        console.warn(`[GET_INGREDIENTS] ⚠️ Shared ingredients exist but are INACTIVE!`);
        console.warn(`[GET_INGREDIENTS] Retrying query without isActive filter...`);

        // Retry without isActive filter
        const retryFilter = { ...costingFilter };
        if (retryFilter.$and) {
          retryFilter.$and = retryFilter.$and.filter(f => f.isActive === undefined);
          if (retryFilter.$and.length === 0) {
            delete retryFilter.$and;
          }
        }
        if (retryFilter.isActive) {
          delete retryFilter.isActive;
        }

        const retryIngredients = await Ingredient.find(retryFilter)
          .populate("preferredSupplierId", "name")
          .populate("cartId", "name cafeName")
          .sort({ category: 1, name: 1 });

        console.warn(`[GET_INGREDIENTS] Retry query found ${retryIngredients.length} ingredients`);
        if (retryIngredients.length > 0) {
          ingredients = retryIngredients;
        }
      }
    }

    // Debug logging for cart admin
    if (req.user.role === "admin") {
      console.log(`[GET_INGREDIENTS] Cart admin ${req.user._id} found ${ingredients.length} ingredients`);
      if (ingredients.length === 0) {
        // Check if there are any ingredients at all for debugging
        const allIngredientsCount = await Ingredient.countDocuments({});
        const cartIngredientsCount = await Ingredient.countDocuments({ cartId: req.user._id });
        const sharedIngredientsCount = await Ingredient.countDocuments({ cartId: null });
        console.log(`[GET_INGREDIENTS] Debug - Total ingredients: ${allIngredientsCount}, Cart-specific: ${cartIngredientsCount}, Shared: ${sharedIngredientsCount}`);

        // Try the query manually to see what's wrong
        const userCartId = req.user._id;
        const userCartIdObj = mongoose.Types.ObjectId.isValid(userCartId)
          ? new mongoose.Types.ObjectId(userCartId)
          : userCartId;

        const testQuery1 = { cartId: userCartIdObj };
        const testQuery2 = { cartId: null };
        const testQuery3 = { $or: [{ cartId: userCartIdObj }, { cartId: null }, { cartId: { $exists: false } }] };

        const test1 = await Ingredient.countDocuments(testQuery1);
        const test2 = await Ingredient.countDocuments(testQuery2);
        const test3 = await Ingredient.countDocuments(testQuery3);

        console.log(`[GET_INGREDIENTS] Test queries:`);
        console.log(`  - Query {cartId: ObjectId("${userCartIdObj}")}: ${test1} results`);
        console.log(`  - Query {cartId: null}: ${test2} results`);
        console.log(`  - Query {$or: [...]}: ${test3} results`);
      } else {
        // Log sample ingredients to verify they're correct
        const sample = ingredients.slice(0, 3).map(ing => ({
          name: ing.name,
          cartId: ing.cartId ? (ing.cartId._id || ing.cartId) : null,
          cartIdType: ing.cartId ? typeof ing.cartId : 'null'
        }));
        console.log(`[GET_INGREDIENTS] Sample ingredients:`, sample);
      }
    }

    // REDESIGNED: Simple and reliable inventory calculation for Cart Admin
    // Calculate everything directly from transactions - no complex logic, no database syncing
    if (req.user.role === "admin") {
      const cartId = req.user._id;

      // CRITICAL: Convert cartId to ObjectId for proper matching
      const cartObjectId = mongoose.Types.ObjectId.isValid(cartId)
        ? new mongoose.Types.ObjectId(cartId)
        : cartId;
      const cartIdString = cartId.toString();

      // DEBUG: First, let's see what transactions actually exist
      if (process.env.NODE_ENV === 'development') {
        const allTransactionsSample = await InventoryTransaction.find({}).limit(5).select('cartId ingredientId type qty qtyInBaseUnit').lean();
        console.log(`[DEBUG] Sample of ALL transactions in database:`, allTransactionsSample.map(t => ({
          cartId: t.cartId ? (t.cartId.toString ? t.cartId.toString() : String(t.cartId)) : 'null',
          cartIdType: t.cartId ? (t.cartId.constructor.name) : 'null',
          ingredientId: t.ingredientId ? t.ingredientId.toString() : 'null',
          type: t.type,
          qty: t.qty,
          qtyInBaseUnit: t.qtyInBaseUnit
        })));
        console.log(`[DEBUG] Looking for cartId matching:`, {
          cartId: cartId.toString(),
          cartObjectId: cartObjectId.toString(),
          cartIdString: cartIdString
        });
      }

      // CRITICAL: Get all transactions for this cart
      // Try multiple query strategies to ensure we find transactions
      let allCartTransactions = [];

      // Strategy 1: Direct ObjectId match (most reliable)
      allCartTransactions = await InventoryTransaction.find({
        cartId: cartObjectId
      }).sort({ date: 1 }).lean();

      // Strategy 2: If no results, try aggregation with string comparison
      if (allCartTransactions.length === 0) {
        const aggResults = await InventoryTransaction.aggregate([
          {
            $match: {
              $expr: {
                $eq: [
                  { $toString: "$cartId" },
                  cartIdString
                ]
              }
            }
          },
          { $sort: { date: 1 } }
        ]);
        allCartTransactions = aggResults;
      }

      // Strategy 3: Try direct string match as last resort
      if (allCartTransactions.length === 0) {
        allCartTransactions = await InventoryTransaction.find({
          cartId: cartIdString
        }).sort({ date: 1 }).lean();
      }

      // Strategy 4: Try null/undefined cartId (legacy transactions)
      if (allCartTransactions.length === 0) {
        allCartTransactions = await InventoryTransaction.find({
          $or: [
            { cartId: null },
            { cartId: { $exists: false } }
          ]
        }).sort({ date: 1 }).lean();
      }

      // If no results, log for debugging
      if (allCartTransactions.length === 0 && process.env.NODE_ENV === 'development') {
        const totalTransactions = await InventoryTransaction.countDocuments({});
        console.warn(`[DEBUG] No transactions found for cartId. Total transactions in DB: ${totalTransactions}`);

        // Get sample transactions to see what cartIds exist
        const sampleTransactions = await InventoryTransaction.find({}).limit(10).select('cartId ingredientId type qty qtyInBaseUnit').lean();
        const uniqueCartIds = [...new Set(sampleTransactions.map(t => t.cartId ? t.cartId.toString() : 'null'))];
        console.log(`[DEBUG] Sample cartIds in transactions:`, uniqueCartIds);
        console.log(`[DEBUG] Looking for:`, { cartId: cartId.toString(), cartObjectId: cartObjectId.toString(), cartIdString });

        // Check if any transactions exist for this ingredient at all
        if (ingredients.length > 0) {
          const firstIngId = ingredients[0]._id;
          const ingTransactions = await InventoryTransaction.find({ ingredientId: firstIngId }).limit(5).select('cartId type qty qtyInBaseUnit').lean();
          console.log(`[DEBUG] Sample transactions for ingredient ${ingredients[0].name}:`, ingTransactions.map(t => ({
            cartId: t.cartId ? t.cartId.toString() : 'null',
            type: t.type,
            qty: t.qty,
            qtyInBaseUnit: t.qtyInBaseUnit
          })));
        }
      }

      // Create a Set of ingredient IDs for fast lookup (convert all to strings)
      const ingredientIdSet = new Set(
        ingredients.map(ing => {
          const id = ing._id;
          return id ? (id.toString ? id.toString() : String(id)) : null;
        }).filter(id => id !== null)
      );

      // Filter transactions to only include those for ingredients we're showing
      const filteredTransactions = allCartTransactions.filter(txn => {
        if (!txn.ingredientId) return false;
        const txnIngId = txn.ingredientId.toString ? txn.ingredientId.toString() : String(txn.ingredientId);
        return ingredientIdSet.has(txnIngId);
      });

      if (process.env.NODE_ENV === 'development') {
        console.log(`[INVENTORY] Cart admin ${cartId}: Found ${allCartTransactions.length} total transactions, ${filteredTransactions.length} for ${ingredients.length} ingredients`);
        console.log(`[INVENTORY] Cart admin cartId: ${cartId}, cartObjectId: ${cartObjectId}, cartIdString: ${cartIdString}`);
        if (allCartTransactions.length === 0) {
          console.warn(`[INVENTORY] No transactions found for cartId. Checking all transactions...`);
          // Check what cartIds exist in transactions
          const sampleTransactions = await InventoryTransaction.find({}).limit(10).select('cartId ingredientId type').lean();
          console.log(`[INVENTORY] Sample transactions in database:`, sampleTransactions.map(t => ({
            cartId: t.cartId ? (t.cartId.toString ? t.cartId.toString() : String(t.cartId)) : 'null',
            cartIdType: typeof t.cartId,
            ingredientId: t.ingredientId ? (t.ingredientId.toString ? t.ingredientId.toString() : String(t.ingredientId)) : 'null',
            type: t.type
          })));
        } else {
          // Log sample transaction to verify structure
          const sampleTxn = allCartTransactions[0];
          console.log(`[INVENTORY] Sample transaction:`, {
            cartId: sampleTxn.cartId ? (sampleTxn.cartId.toString ? sampleTxn.cartId.toString() : String(sampleTxn.cartId)) : 'null',
            cartIdType: typeof sampleTxn.cartId,
            ingredientId: sampleTxn.ingredientId ? (sampleTxn.ingredientId.toString ? sampleTxn.ingredientId.toString() : String(sampleTxn.ingredientId)) : 'null',
            type: sampleTxn.type,
            qty: sampleTxn.qty,
            qtyInBaseUnit: sampleTxn.qtyInBaseUnit,
            unitPrice: sampleTxn.unitPrice
          });
        }
      }

      // Use filtered transactions
      const allCartTransactionsFiltered = filteredTransactions;

      // Group transactions by ingredientId for efficient processing
      // CRITICAL: Handle both ObjectId and string formats for ingredientId matching
      const transactionsByIngredient = {};
      for (const txn of allCartTransactionsFiltered) {
        // Convert ingredientId to string for consistent matching
        const ingId = txn.ingredientId
          ? (txn.ingredientId.toString ? txn.ingredientId.toString() : String(txn.ingredientId))
          : null;
        if (ingId) {
          if (!transactionsByIngredient[ingId]) {
            transactionsByIngredient[ingId] = [];
          }
          transactionsByIngredient[ingId].push(txn);
        }
      }

      // Process each ingredient
      for (const ingredient of ingredients) {
        // CRITICAL: Convert ingredient._id to string for matching
        const ingredientId = ingredient._id
          ? (ingredient._id.toString ? ingredient._id.toString() : String(ingredient._id))
          : null;
        const transactions = ingredientId ? (transactionsByIngredient[ingredientId] || []) : [];

        if (process.env.NODE_ENV === 'development') {
          console.log(`[INVENTORY] ${ingredient.name} (${ingredientId}): Processing ${transactions.length} transactions`);
          if (transactions.length > 0) {
            console.log(`[INVENTORY] ${ingredient.name}: Transaction details:`, transactions.map(t => ({
              type: t.type,
              qty: t.qty,
              uom: t.uom,
              qtyInBaseUnit: t.qtyInBaseUnit,
              unitPrice: t.unitPrice,
              costAllocated: t.costAllocated,
              cartId: t.cartId ? (t.cartId.toString ? t.cartId.toString() : String(t.cartId)) : 'null'
            })));
          } else {
            // Check if ingredientId exists in transactionsByIngredient keys
            const allIngredientIds = Object.keys(transactionsByIngredient);
            console.log(`[INVENTORY] ${ingredient.name}: No transactions found. Available ingredientIds in transactions:`, allIngredientIds.slice(0, 5));
            console.log(`[INVENTORY] ${ingredient.name}: Using stored values - qtyOnHand=${ingredient.qtyOnHand}, currentCostPerBaseUnit=${ingredient.currentCostPerBaseUnit}`);
          }
        }

        // FALLBACK: If no transactions found, use stored values from ingredient
        if (transactions.length === 0) {
          // CRITICAL FIX: For shared ingredients (cartId: null), do NOT use stored qtyOnHand
          // because it's shared across all carts. Each cart should only see their own inventory.

          // For cart admins with no transactions, they have 0 inventory
          if (req.user.role === "admin") {
            ingredient.qtyOnHand = 0;  // Cart-specific: No transactions = No inventory
            ingredient.currentCostPerBaseUnit = 0;
            ingredient.lastPurchaseUnitPrice = 0;
            ingredient.lastPurchaseUom = ingredient.uom;

            if (process.env.NODE_ENV === 'development') {
              console.log(`[INVENTORY] ${ingredient.name}: Cart admin with no transactions - stock=0 (cart-specific isolation)`);
            }
          } else {
            // For super admin or franchise admin, use stored values (they may have set default values)
            ingredient.qtyOnHand = Number(ingredient.qtyOnHand) || 0;
            ingredient.currentCostPerBaseUnit = Number(ingredient.currentCostPerBaseUnit) || 0;
            ingredient.lastPurchaseUnitPrice = 0;
            ingredient.lastPurchaseUom = ingredient.uom;

            // If stock is 0, ensure cost is 0
            if (ingredient.qtyOnHand <= 0) {
              ingredient.currentCostPerBaseUnit = 0;
              ingredient.lastPurchaseUnitPrice = 0;
            }

            if (process.env.NODE_ENV === 'development') {
              console.log(`[INVENTORY] ${ingredient.name}: Using stored values - stock=${ingredient.qtyOnHand} ${ingredient.baseUnit}, cost=₹${ingredient.currentCostPerBaseUnit}/${ingredient.baseUnit}`);
            }
          }
          continue; // Skip transaction-based calculation
        }

        // SIMPLE STOCK CALCULATION: Sum all IN/RETURN, subtract all OUT/WASTE
        let stock = 0;
        let stockDetails = { in: 0, return: 0, out: 0, waste: 0 };

        if (process.env.NODE_ENV === 'development') {
          console.log(`[INVENTORY STOCK] ${ingredient.name}: Starting stock calculation with ${transactions.length} transactions`);
        }

        for (const txn of transactions) {
          // CRITICAL: Use qtyInBaseUnit (always in base unit) for accurate calculation
          // If qtyInBaseUnit is missing or 0, try to convert from qty and uom
          let qty = Number(txn.qtyInBaseUnit);

          if (process.env.NODE_ENV === 'development') {
            console.log(`[INVENTORY STOCK] ${ingredient.name}: Transaction ${txn.type} - qtyInBaseUnit=${txn.qtyInBaseUnit}, qty=${txn.qty}, uom=${txn.uom}, baseUnit=${ingredient.baseUnit}`);
          }

          if (!qty || qty === 0 || isNaN(qty)) {
            // Fallback: convert from qty and uom if qtyInBaseUnit is missing
            if (txn.qty && txn.uom) {
              try {
                // Use safe conversion helper
                qty = safeConvertToBaseUnit(ingredient, Number(txn.qty), txn.uom);
                if (process.env.NODE_ENV === 'development') {
                  console.log(`[INVENTORY STOCK] ${ingredient.name}: Converted ${txn.qty} ${txn.uom} to ${qty} ${ingredient.baseUnit}`);
                }
              } catch (error) {
                console.error(`[INVENTORY STOCK ERROR] ${ingredient.name}: Cannot convert ${txn.qty} ${txn.uom} to ${ingredient.baseUnit}:`, error.message);
                // Last resort: try manual conversion
                try {
                  qty = convertQtyToBaseUnit(Number(txn.qty), txn.uom, ingredient.baseUnit);
                } catch (e) {
                  qty = 0;
                }
              }
            } else {
              qty = Number(txn.qty) || 0;
              if (process.env.NODE_ENV === 'development' && qty > 0) {
                console.warn(`[INVENTORY STOCK] ${ingredient.name}: Using raw qty=${qty} (no uom conversion available)`);
              }
            }
          }

          // Ensure qty is a valid number
          if (isNaN(qty) || !isFinite(qty)) {
            console.error(`[INVENTORY STOCK ERROR] ${ingredient.name}: Invalid qty=${qty} for transaction ${txn.type}, skipping`);
            continue;
          }

          if (txn.type === "IN") {
            stock += qty;
            stockDetails.in += qty;
            if (process.env.NODE_ENV === 'development') {
              console.log(`[INVENTORY STOCK] ${ingredient.name}: IN transaction - added ${qty}, stock now = ${stock}`);
            }
          } else if (txn.type === "RETURN") {
            stock += qty;
            stockDetails.return += qty;
            if (process.env.NODE_ENV === 'development') {
              console.log(`[INVENTORY STOCK] ${ingredient.name}: RETURN transaction - added ${qty}, stock now = ${stock}`);
            }
          } else if (txn.type === "OUT") {
            stock -= qty;
            stockDetails.out += qty;
            if (process.env.NODE_ENV === 'development') {
              console.log(`[INVENTORY STOCK] ${ingredient.name}: OUT transaction - subtracted ${qty}, stock now = ${stock}`);
            }
          } else if (txn.type === "WASTE") {
            stock -= qty;
            stockDetails.waste += qty;
            if (process.env.NODE_ENV === 'development') {
              console.log(`[INVENTORY STOCK] ${ingredient.name}: WASTE transaction - subtracted ${qty}, stock now = ${stock}`);
            }
          }
        }
        stock = Math.max(0, stock); // Never negative

        if (process.env.NODE_ENV === 'development') {
          console.log(`[INVENTORY] ${ingredient.name}: FINAL Calculated stock = ${stock} ${ingredient.baseUnit} (IN: ${stockDetails.in}, RETURN: ${stockDetails.return}, OUT: ${stockDetails.out}, WASTE: ${stockDetails.waste})`);
          if (stock === 0 && transactions.length > 0) {
            console.warn(`[INVENTORY] ${ingredient.name}: WARNING - Stock is 0 but has ${transactions.length} transactions!`);
          }
        }

        // WEIGHTED AVERAGE COST: Calculate from all transactions (not just last purchase)
        let lastPurchaseUnitPrice = 0; // Last purchase unitPrice for display (per display unit)
        let lastPurchaseUom = ingredient.uom; // Unit from last purchase
        let costPerBaseUnit = 0; // Weighted average cost per base unit

        if (stock <= 0) {
          lastPurchaseUnitPrice = 0;
          costPerBaseUnit = 0;
        } else if (transactions.length > 0) {
          // Calculate weighted average from all transactions
          let totalQty = 0;
          let totalValue = 0;
          let weightedAvgCost = 0;

          // Also track last purchase for display
          const purchases = transactions
            .filter(t => t.type === "IN")
            .sort((a, b) => new Date(b.date) - new Date(a.date));

          if (purchases.length > 0) {
            const lastPurchase = purchases[0];
            // Set last purchase price for display
            if (lastPurchase.unitPrice != null && lastPurchase.unitPrice > 0) {
              lastPurchaseUnitPrice = Number(lastPurchase.unitPrice);
              lastPurchaseUom = lastPurchase.uom || ingredient.uom;
            }
          }

          // Calculate weighted average from all transactions
          for (const txn of transactions) {
            const txnQty = txn.qtyInBaseUnit || txn.qty || 0;

            if (txn.type === "IN" || txn.type === "RETURN") {
              // Add to inventory - calculate weighted average
              let txnCostPerBaseUnit = 0;
              if (txn.unitPrice != null && txn.unitPrice > 0) {
                // Use exact purchase price - convert to base unit
                const conversionFactor = safeConvertToBaseUnit(ingredient, 1, txn.uom || ingredient.uom);
                txnCostPerBaseUnit = txn.unitPrice / conversionFactor;
              } else if (txn.costAllocated > 0 && txnQty > 0) {
                // Fallback: calculate from costAllocated
                txnCostPerBaseUnit = txn.costAllocated / txnQty;
              }

              if (txnQty > 0 && txnCostPerBaseUnit > 0) {
                // Weighted average: (existing total value + new value) / (existing qty + new qty)
                const newValue = txnQty * txnCostPerBaseUnit;
                totalValue = totalValue + newValue;
                totalQty += txnQty;
                weightedAvgCost = totalQty > 0 ? totalValue / totalQty : 0;
              }
            } else if (txn.type === "OUT" || txn.type === "WASTE") {
              // Remove from inventory - reduce total value proportionally
              if (totalQty > 0 && weightedAvgCost > 0) {
                const consumedValue = txnQty * weightedAvgCost;
                totalValue = Math.max(0, totalValue - consumedValue);
              }
              totalQty -= txnQty;
              if (totalQty < 0) {
                totalQty = 0;
                totalValue = 0;
                weightedAvgCost = 0;
              } else if (totalQty > 0) {
                weightedAvgCost = totalValue / totalQty;
              } else {
                weightedAvgCost = 0;
              }
            }
          }

          // Use calculated weighted average
          costPerBaseUnit = weightedAvgCost;

          if (process.env.NODE_ENV === 'development') {
            console.log(`[INVENTORY COST] ${ingredient.name}: Weighted average cost = ₹${costPerBaseUnit.toFixed(6)}/${ingredient.baseUnit} (calculated from ${transactions.length} transactions)`);
          }
        } else {
          // No transactions - use saved weighted average from ingredient
          costPerBaseUnit = Number(ingredient.currentCostPerBaseUnit) || 0;
          if (process.env.NODE_ENV === 'development') {
            console.log(`[INVENTORY COST] ${ingredient.name}: No transactions, using saved cost = ₹${costPerBaseUnit.toFixed(6)}/${ingredient.baseUnit}`);
          }
        }

        // CRITICAL: Final check - if stock is 0, cost MUST be 0 (no exceptions)
        if (stock <= 0) {
          lastPurchaseUnitPrice = 0;
          costPerBaseUnit = 0;
        }

        // CRITICAL: Final validation before setting values
        // Ensure stock is a valid number
        if (isNaN(stock) || !isFinite(stock)) {
          console.error(`[INVENTORY ERROR] ${ingredient.name}: Invalid stock=${stock}, resetting to 0`);
          stock = 0;
        }
        stock = Math.max(0, stock); // Ensure non-negative

        // Ensure cost is valid
        if (isNaN(costPerBaseUnit) || !isFinite(costPerBaseUnit)) {
          console.error(`[INVENTORY ERROR] ${ingredient.name}: Invalid costPerBaseUnit=${costPerBaseUnit}, resetting to 0`);
          costPerBaseUnit = 0;
        }
        costPerBaseUnit = Math.max(0, costPerBaseUnit);

        // ABSOLUTE RULE: If stock is 0, cost MUST be 0
        if (stock <= 0) {
          costPerBaseUnit = 0;
          lastPurchaseUnitPrice = 0;
        }

        // CRITICAL: Update ingredient object with calculated values
        // Round stock to 4 decimal places to avoid floating point issues
        const finalStock = Number(stock.toFixed(4));
        const finalCost = Number(costPerBaseUnit.toFixed(6));
        const finalUnitPrice = Number(lastPurchaseUnitPrice.toFixed(2));

        // ABSOLUTE FINAL CHECK: Ensure cost is 0 when stock is 0 (double-check)
        const finalStockValue = finalStock <= 0 ? 0 : finalStock;
        const finalCostValue = finalStockValue <= 0 ? 0 : finalCost;
        const finalUnitPriceValue = finalStockValue <= 0 ? 0 : finalUnitPrice;

        // Set values directly on ingredient object (works for both Mongoose documents and plain objects)
        ingredient.qtyOnHand = finalStockValue;
        ingredient.currentCostPerBaseUnit = finalCostValue;
        ingredient.lastPurchaseUnitPrice = finalUnitPriceValue;
        ingredient.lastPurchaseUom = lastPurchaseUom || ingredient.uom || 'pcs';

        // Mark as modified to ensure values are included in response (only if Mongoose document)
        if (ingredient.markModified && typeof ingredient.markModified === 'function') {
          ingredient.markModified('qtyOnHand');
          ingredient.markModified('currentCostPerBaseUnit');
          ingredient.markModified('lastPurchaseUnitPrice');
          ingredient.markModified('lastPurchaseUom');
        }

        if (process.env.NODE_ENV === 'development') {
          console.log(`[INVENTORY] ${ingredient.name}: FINAL VALUES - stock=${ingredient.qtyOnHand} ${ingredient.baseUnit}, unitPrice=₹${ingredient.lastPurchaseUnitPrice}/${ingredient.lastPurchaseUom}, costPerBaseUnit=₹${ingredient.currentCostPerBaseUnit}/${ingredient.baseUnit}, transactions=${transactions.length}`);
          if (transactions.length > 0 && stock === 0) {
            console.warn(`[INVENTORY] ${ingredient.name}: Has ${transactions.length} transactions but stock is 0. Transaction types:`, transactions.map(t => `${t.type}:${t.qtyInBaseUnit || t.qty}`));
          }
        }
      }
    }

    // For franchise/super admin viewing shared ingredients with cart filter
    const cartIdParamForInventory = req.query.cartId || req.query.outletId; // Backward compatibility
    if ((req.user.role === "franchise_admin" || req.user.role === "super_admin") && cartIdParamForInventory) {
      const cartId = cartIdParamForInventory;

      // Get all transactions for this cart in one query
      const allCartTransactions = await InventoryTransaction.find({
        cartId: cartId,
      }).sort({ date: 1 }).lean();

      // Group transactions by ingredientId
      const transactionsByIngredient = {};
      for (const txn of allCartTransactions) {
        if (!transactionsByIngredient[txn.ingredientId]) {
          transactionsByIngredient[txn.ingredientId] = [];
        }
        transactionsByIngredient[txn.ingredientId].push(txn);
      }

      // Process each ingredient
      for (const ingredient of ingredients) {
        const ingredientId = ingredient._id.toString();
        const transactions = transactionsByIngredient[ingredientId] || [];

        // Calculate stock from transactions
        let stock = 0;
        for (const txn of transactions) {
          const qty = txn.qtyInBaseUnit || txn.qty || 0;
          if (txn.type === "IN" || txn.type === "RETURN") {
            stock += qty;
          } else if (txn.type === "OUT" || txn.type === "WASTE") {
            stock -= qty;
          }
        }
        stock = Math.max(0, stock);

        // Calculate weighted average cost from all transactions
        let cost = 0;
        if (stock > 0 && transactions.length > 0) {
          let totalQty = 0;
          let totalValue = 0;
          let weightedAvgCost = 0;

          // Calculate weighted average from all transactions
          for (const txn of transactions) {
            const txnQty = txn.qtyInBaseUnit || txn.qty || 0;

            if (txn.type === "IN" || txn.type === "RETURN") {
              // Add to inventory - calculate weighted average
              if (totalQty > 0 && txnQty > 0) {
                // Calculate cost per base unit for this transaction
                let txnCostPerBaseUnit = 0;
                if (txn.unitPrice != null && txn.unitPrice > 0) {
                  // Use exact purchase price - convert to base unit
                  const conversionFactor = safeConvertToBaseUnit(ingredient, 1, txn.uom || ingredient.uom);
                  txnCostPerBaseUnit = txn.unitPrice / conversionFactor;
                } else if (txn.costAllocated > 0 && txnQty > 0) {
                  // Fallback: calculate from costAllocated
                  txnCostPerBaseUnit = txn.costAllocated / txnQty;
                }

                // Weighted average: (existing total value + new value) / (existing qty + new qty)
                const existingTotalValue = totalQty * (weightedAvgCost || 0);
                const newValue = txnQty * txnCostPerBaseUnit;
                totalValue = existingTotalValue + newValue;
                totalQty += txnQty;
                weightedAvgCost = totalQty > 0 ? totalValue / totalQty : 0;
              } else if (txnQty > 0) {
                // First purchase - set initial cost
                if (txn.unitPrice != null && txn.unitPrice > 0) {
                  const conversionFactor = safeConvertToBaseUnit(ingredient, 1, txn.uom || ingredient.uom);
                  weightedAvgCost = txn.unitPrice / conversionFactor;
                } else if (txn.costAllocated > 0) {
                  weightedAvgCost = txn.costAllocated / txnQty;
                }
                totalQty = txnQty;
                totalValue = totalQty * weightedAvgCost;
              }
            } else if (txn.type === "OUT" || txn.type === "WASTE") {
              // Remove from inventory (cost already allocated, just reduce quantity)
              // Weighted average cost doesn't change on consumption
              totalQty -= txnQty;
              if (totalQty < 0) totalQty = 0;
              // Recalculate total value based on remaining quantity
              totalValue = totalQty * weightedAvgCost;
            }
          }

          cost = weightedAvgCost;
        }

        ingredient.qtyOnHand = stock;
        ingredient.currentCostPerBaseUnit = cost;
      }
    } else if (req.user.role === "franchise_admin" || req.user.role === "super_admin") {
      // For shared ingredients without cart filter, use existing logic
      const cartIdParamForShared = req.query.cartId || req.query.outletId; // Backward compatibility

      for (const ingredient of ingredients) {
        let cartSpecificQty = 0;
        let cartSpecificCost = 0;

        // For shared ingredients, calculate cart-specific values from transactions
        // This uses weighted average costing (same as BOM calculation)
        // IMPORTANT: For shared ingredients, we need to check BOTH:
        // 1. Cart-specific transactions (cartId = cartIdParamForShared)
        // 2. Global transactions (cartId = null or missing) - for shared ingredients purchased globally
        const cartTransactions = await InventoryTransaction.find({
          ingredientId: ingredient._id,
          $or: [
            { cartId: cartIdParamForShared },
            { cartId: null }, // Global transactions
            { cartId: { $exists: false } } // Also check for missing cartId field
          ]
        }).sort({ date: 1 }); // Sort by date ascending to calculate weighted average

        // Debug: Check transaction counts
        const cartSpecificTransactions = await InventoryTransaction.find({
          ingredientId: ingredient._id,
          cartId: cartIdParamForShared,
        });
        const globalTransactions = await InventoryTransaction.find({
          ingredientId: ingredient._id,
          cartId: null,
        });
        const allTransactions = await InventoryTransaction.find({
          ingredientId: ingredient._id,
        });

        if (process.env.NODE_ENV === 'development') {
          console.log(`[STOCK DEBUG] Shared ingredient ${ingredient.name}:`, {
            ingredientId: ingredient._id,
            cartId: ingredient.cartId,
            cartIdParam: cartIdParamForShared,
            cartSpecificTransactions: cartSpecificTransactions.length,
            globalTransactions: globalTransactions.length,
            totalTransactions: cartTransactions.length,
            allTransactions: allTransactions.length,
            qtyOnHand: ingredient.qtyOnHand,
          });
        }

        let totalQty = 0;
        let weightedAvgCost = 0;

        // If we have transactions, calculate weighted average from them
        if (cartTransactions.length > 0) {
          console.log(`[INVENTORY COST] ${ingredient.name}: Processing ${cartTransactions.length} transactions for weighted average cost calculation`);

          // Calculate weighted average cost from all transactions
          let totalValue = 0; // Total value of inventory in base unit

          for (const txn of cartTransactions) {
            const txnQty = txn.qtyInBaseUnit || txn.qty || 0;
            const txnType = txn.type;

            if (process.env.NODE_ENV === 'development' && txnQty > 0) {
              console.log(`[STOCK CALC] ${ingredient.name}: ${txnType} transaction - qty=${txnQty} ${ingredient.baseUnit}, date=${txn.date}, cartId=${txn.cartId}`);
            }

            if (txn.type === "IN" || txn.type === "RETURN") {
              // Add to inventory - calculate weighted average
              if (totalQty > 0 && txnQty > 0) {
                // Calculate cost per base unit for this transaction
                let txnCostPerBaseUnit = 0;
                if (txn.unitPrice != null && txn.unitPrice > 0) {
                  // Use exact purchase price - convert to base unit
                  const conversionFactor = safeConvertToBaseUnit(ingredient, 1, txn.uom || ingredient.uom);
                  txnCostPerBaseUnit = txn.unitPrice / conversionFactor;
                } else if (txn.costAllocated > 0 && txnQty > 0) {
                  // Fallback: calculate from costAllocated
                  txnCostPerBaseUnit = txn.costAllocated / txnQty;
                }

                // Weighted average: (existing total value + new value) / (existing qty + new qty)
                const existingTotalValue = totalQty * (weightedAvgCost || 0);
                const newValue = txnQty * txnCostPerBaseUnit;
                totalValue = existingTotalValue + newValue;
                totalQty += txnQty;
                weightedAvgCost = totalQty > 0 ? totalValue / totalQty : 0;
              } else if (txnQty > 0) {
                // First purchase - set initial cost
                if (txn.unitPrice != null && txn.unitPrice > 0) {
                  const conversionFactor = safeConvertToBaseUnit(ingredient, 1, txn.uom || ingredient.uom);
                  weightedAvgCost = txn.unitPrice / conversionFactor;
                } else if (txn.costAllocated > 0) {
                  weightedAvgCost = txn.costAllocated / txnQty;
                }
                totalQty = txnQty;
                totalValue = totalQty * weightedAvgCost;
              }
            } else if (txn.type === "OUT" || txn.type === "WASTE") {
              // Remove from inventory (cost already allocated, just reduce quantity)
              // Weighted average cost doesn't change on consumption
              totalQty -= txnQty;
              if (totalQty < 0) totalQty = 0;
              // Recalculate total value based on remaining quantity
              totalValue = totalQty * weightedAvgCost;
            }
          }

          cartSpecificQty = Math.max(0, totalQty);

          if (process.env.NODE_ENV === 'development') {
            console.log(`[STOCK CALC] ${ingredient.name}: Final calculated stock = ${cartSpecificQty} ${ingredient.baseUnit}, weighted avg cost = ₹${weightedAvgCost.toFixed(6)}/${ingredient.baseUnit}`);
          }
        } else {
          // No transactions found for shared ingredient
          // For shared ingredients, if there are no transactions at all, use the ingredient's qtyOnHand
          // This handles cases where stock was set manually or before transaction tracking
          // OR if the ingredient has global stock that should be visible to all carts
          cartSpecificQty = Number(ingredient.qtyOnHand) || 0;
          weightedAvgCost = 0;

          if (process.env.NODE_ENV === 'development') {
            console.log(`[STOCK DEBUG] Shared ingredient ${ingredient.name} has no transactions, using qtyOnHand: ${cartSpecificQty}`);
          }
        }

        // CRITICAL: For inventory value calculation, cost MUST be 0 when stock is 0
        // This is the most important rule - no exceptions
        // Check stock FIRST before calculating cost
        if (cartSpecificQty <= 0) {
          // Stock is 0 - cost MUST be 0 regardless of any other factors
          // This is the absolute rule - no exceptions, no fallbacks
          cartSpecificCost = 0;
        } else {
          // Stock > 0 - use weighted average cost
          if (weightedAvgCost > 0) {
            // We have calculated weighted average from transactions - use it
            cartSpecificCost = weightedAvgCost;
          } else {
            // No transactions found - use ingredient's weighted average cost from database
            // This handles cases where stock exists but no transactions were recorded
            cartSpecificCost = Number(ingredient.currentCostPerBaseUnit) || 0;
          }
        }

        // ABSOLUTE FINAL CHECK: If stock is 0, cost MUST be 0 (no exceptions)
        // This overrides any previous cost calculation
        if (cartSpecificQty <= 0) {
          cartSpecificCost = 0;
        }

        // Override qtyOnHand and currentCostPerBaseUnit with cart-specific values
        ingredient.qtyOnHand = cartSpecificQty;

        // CRITICAL: Set cost - MUST be 0 when stock is 0 (absolute rule)
        // This check happens AFTER all cost calculations to ensure it's never overridden
        if (cartSpecificQty <= 0) {
          // Stock is 0 - cost MUST be 0 (no exceptions)
          ingredient.currentCostPerBaseUnit = 0;
        } else {
          // Stock > 0 - use calculated cost
          ingredient.currentCostPerBaseUnit = cartSpecificCost;
        }

        // Final safety check: ensure cost is 0 if stock is 0 (absolute guarantee)
        // This is a redundant check to catch any edge cases
        if (ingredient.qtyOnHand <= 0) {
          ingredient.currentCostPerBaseUnit = 0;
        }

        // CRITICAL: Absolute final check - use threshold to catch any floating point issues
        const finalQtyCheck = Math.abs(Number(ingredient.qtyOnHand) || 0);
        const finalCostCheck = Math.abs(Number(ingredient.currentCostPerBaseUnit) || 0);

        if (finalQtyCheck < 0.0001 && finalCostCheck > 0) {
          // Stock is essentially 0 but cost is > 0 - force cost to 0
          if (process.env.NODE_ENV === 'development') {
            console.warn(`[INVENTORY VALUE BUG] Ingredient ${ingredient.name} has qtyOnHand=${finalQtyCheck} but cost=${finalCostCheck}. Forcing cost to 0.`);
          }
          ingredient.currentCostPerBaseUnit = 0;
          ingredient.markModified("currentCostPerBaseUnit");
        }

        // Mark as modified so it's included in the response
        ingredient.markModified("qtyOnHand");
        ingredient.markModified("currentCostPerBaseUnit");
        // #region agent log
        logDebug(
          "costingController.js:395",
          "Updated ingredient with cart-specific values",
          {
            ingredientId: ingredient._id,
            ingredientName: ingredient.name,
            cartId: cartIdParamForShared,
            cartSpecificQty: cartSpecificQty,
            cartSpecificCost: cartSpecificCost,
            originalQtyOnHand: ingredient.qtyOnHand,
            originalCost: ingredient.currentCostPerBaseUnit,
          },
          "D"
        );
        // #endregion
      }
    }

    // FINAL SAFETY CHECK: Ensure ALL ingredients have cost = 0 when stock = 0
    // This is a critical check to prevent any inventory value calculation errors
    // Use strict comparison with threshold to catch floating point issues
    for (const ingredient of ingredients) {
      const qty = Math.abs(Number(ingredient.qtyOnHand) || 0);
      let cost = Math.abs(Number(ingredient.currentCostPerBaseUnit) || 0);

      // CRITICAL: If stock is 0 or very close to 0 (within 0.0001), cost MUST be 0
      // This catches any edge cases where stock might be 0.00001 or similar
      if (qty < 0.0001) {
        // Stock is essentially 0 - force cost to 0 regardless of any other factors
        if (cost > 0) {
          if (process.env.NODE_ENV === 'development') {
            console.warn(`[FINAL CHECK] Forcing cost to 0 for ${ingredient.name}: qty=${qty}, cost=${cost}`);
          }
          ingredient.currentCostPerBaseUnit = 0;
          cost = 0; // Update local variable too
          ingredient.markModified("currentCostPerBaseUnit");
        }
      }

      // Double-check: ensure cost is exactly 0 when qty is exactly 0
      if (qty === 0 && cost !== 0) {
        ingredient.currentCostPerBaseUnit = 0;
        ingredient.markModified("currentCostPerBaseUnit");
      }

      // TRIPLE-CHECK: Convert to plain object and verify before response
      // This ensures the value is actually 0 in the response, not just in the Mongoose document
      if (qty < 0.0001) {
        // Force to 0 in the response object
        ingredient.currentCostPerBaseUnit = 0;
      }
    }

    // Filter low stock after fetching (needs qtyOnHand comparison)
    if (lowStock === "true") {
      ingredients = ingredients.filter(
        (ing) => ing.qtyOnHand <= ing.reorderLevel
      );
    }

    // ABSOLUTE FINAL CHECK: Before sending response, ensure cost = 0 when stock = 0
    // Convert to plain objects and verify one last time
    const sanitizedIngredients = ingredients.map((ing) => {
      // CRITICAL: First convert to plain object to ensure we can access all properties
      const plainIng = ing.toObject ? ing.toObject({ getters: true, virtuals: false }) : { ...ing };

      // Extract values from plain object
      let qty = Number(plainIng.qtyOnHand) || 0;
      let cost = Number(plainIng.currentCostPerBaseUnit) || 0;
      let lastPurchaseUnitPrice = Number(plainIng.lastPurchaseUnitPrice) || 0;
      let lastPurchaseUom = plainIng.lastPurchaseUom || plainIng.uom || 'pcs';

      // Ensure qty is non-negative and valid
      qty = Math.max(0, qty);
      if (isNaN(qty) || !isFinite(qty)) qty = 0;

      // CRITICAL: If stock is 0, cost MUST be 0 (absolute rule)
      if (qty < 0.0001) {
        cost = 0;
        lastPurchaseUnitPrice = 0;
      }

      // Ensure cost is valid
      if (isNaN(cost) || !isFinite(cost)) cost = 0;
      if (isNaN(lastPurchaseUnitPrice) || !isFinite(lastPurchaseUnitPrice)) lastPurchaseUnitPrice = 0;

      // CRITICAL: Explicitly set ALL calculated values in the response
      // Round values appropriately
      plainIng.qtyOnHand = Number(qty.toFixed(4)); // Round to 4 decimal places
      plainIng.currentCostPerBaseUnit = Number(cost.toFixed(6)); // Round to 6 decimal places
      plainIng.lastPurchaseUnitPrice = Number(lastPurchaseUnitPrice.toFixed(2)); // Round to 2 decimal places
      plainIng.lastPurchaseUom = lastPurchaseUom;

      // Debug logging for cart admin in development
      if (process.env.NODE_ENV === 'development' && req.user.role === 'admin') {
        console.log(`[RESPONSE] ${ing.name}: qtyOnHand=${plainIng.qtyOnHand}, currentCostPerBaseUnit=${plainIng.currentCostPerBaseUnit}, lastPurchaseUnitPrice=${plainIng.lastPurchaseUnitPrice}/${plainIng.lastPurchaseUom}`);
        if (qty < 0.0001 && cost > 0) {
          console.error(`[SANITIZATION ERROR] ${ing.name}: qty=${qty}, cost=${cost} - forcing cost to 0`);
          plainIng.currentCostPerBaseUnit = 0;
          plainIng.lastPurchaseUnitPrice = 0;
        }
      }

      return plainIng;
    });

    // Final summary log for cart admin
    if (process.env.NODE_ENV === 'development' && req.user.role === 'admin') {
      const totalStock = sanitizedIngredients.reduce((sum, ing) => sum + (Number(ing.qtyOnHand) || 0), 0);
      const itemsWithStock = sanitizedIngredients.filter(ing => (Number(ing.qtyOnHand) || 0) > 0).length;
      console.log(`[RESPONSE SUMMARY] Cart admin ${req.user._id}: Sending ${sanitizedIngredients.length} ingredients, ${itemsWithStock} with stock > 0, total stock = ${totalStock}`);
      if (itemsWithStock === 0 && sanitizedIngredients.length > 0) {
        console.warn(`[RESPONSE WARNING] All ingredients have 0 stock! Check transaction queries.`);
        // Log first 3 ingredients as sample
        sanitizedIngredients.slice(0, 3).forEach(ing => {
          console.log(`  - ${ing.name}: qtyOnHand=${ing.qtyOnHand}, currentCostPerBaseUnit=${ing.currentCostPerBaseUnit}`);
        });
      }
    }

    // CRITICAL: Log final response before sending
    if (process.env.NODE_ENV === 'development' && req.user.role === 'admin') {
      console.log(`[RESPONSE FINAL] Sending response with ${sanitizedIngredients.length} ingredients`);
      // Log first 5 ingredients to verify data
      sanitizedIngredients.slice(0, 5).forEach(ing => {
        const stockValue = (Number(ing.qtyOnHand) || 0) * (Number(ing.currentCostPerBaseUnit) || 0);
        console.log(`[RESPONSE FINAL] ${ing.name}:`, {
          qtyOnHand: ing.qtyOnHand,
          currentCostPerBaseUnit: ing.currentCostPerBaseUnit,
          lastPurchaseUnitPrice: ing.lastPurchaseUnitPrice,
          lastPurchaseUom: ing.lastPurchaseUom,
          baseUnit: ing.baseUnit,
          uom: ing.uom,
          stockValue: stockValue.toFixed(2)
        });
      });

      // Calculate total value from response
      const totalValue = sanitizedIngredients.reduce((sum, ing) => {
        const qty = Number(ing.qtyOnHand) || 0;
        const cost = Number(ing.currentCostPerBaseUnit) || 0;
        return sum + (qty * cost);
      }, 0);
      console.log(`[RESPONSE FINAL] Total inventory value: ₹${totalValue.toFixed(2)}`);
    }

    // CRITICAL: Always return success with data array, even if empty
    console.log(`[GET_INGREDIENTS] ✅ Sending response: ${sanitizedIngredients.length} ingredients`);
    res.json({
      success: true,
      data: sanitizedIngredients || [],
      count: sanitizedIngredients.length,
      message: sanitizedIngredients.length === 0
        ? "No ingredients found. Super admin should create ingredients with cartId: null first."
        : `Found ${sanitizedIngredients.length} ingredients`
    });
  } catch (error) {
    console.error(`[GET_INGREDIENTS ERROR]`, error);
    console.error(`[GET_INGREDIENTS ERROR] Stack:`, error.stack);
    console.error(`[GET_INGREDIENTS ERROR] User:`, req.user?.role, req.user?._id);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch ingredients",
      data: [] // Always return data array
    });
  }
};

/**
 * @route   POST /api/costing-v2/ingredients
 * @desc    Create ingredient
 */
exports.createIngredient = async (req, res) => {
  try {
    // Decode HTML entities in category field if present
    let bodyData = { ...req.body };
    if (bodyData.category) {
      bodyData.category = decodeHtmlEntities(bodyData.category);
    }

    // Ingredients can be shared (cartId optional) or kiosk-specific
    const data = await setOutletContext(req.user, bodyData, false);

    // CRITICAL: For super admin, ALWAYS set cartId to null for shared ingredients
    // This ensures all super admin ingredients are visible to cart admins
    if (req.user.role === "super_admin") {
      // Super admin ingredients should ALWAYS be shared (cartId: null)
      // Unless explicitly setting cartId for a specific cart
      if (!bodyData.cartId && data.cartId !== null) {
        data.cartId = null;
        console.log(`[CREATE_INGREDIENT] ✅ Super admin creating shared ingredient - cartId explicitly set to null`);
      }
      console.log(`[CREATE_INGREDIENT] Super admin - Final cartId value: ${data.cartId === null ? 'null (SHARED)' : data.cartId}`);
    }

    console.log(`[CREATE_INGREDIENT] Creating ingredient: ${bodyData.name}`);
    console.log(`[CREATE_INGREDIENT] User role: ${req.user.role}`);
    console.log(`[CREATE_INGREDIENT] Final cartId: ${data.cartId === null ? 'null (SHARED - visible to all cart admins)' : data.cartId}`);
    console.log(`[CREATE_INGREDIENT] Body cartId: ${bodyData.cartId || 'not provided'}`);

    // Check if ingredient with same name and cartId already exists
    // The database has a unique index on name + cartId (legacy) or name + cartId
    const existingQuery = {
      name: { $regex: new RegExp(`^${data.name.trim()}$`, 'i') }, // Case-insensitive match
    };

    // Add cartId to query if it exists, otherwise check for null
    if (data.cartId) {
      existingQuery.cartId = data.cartId;
    } else {
      // For shared ingredients (cartId: null), check for null or missing cartId
      existingQuery.$or = [
        { cartId: null },
        { cartId: { $exists: false } }
      ];
    }

    const existingIngredient = await Ingredient.findOne(existingQuery);

    if (existingIngredient) {
      // Return existing ingredient with a warning instead of error
      await existingIngredient.populate("cartId", "name cafeName");
      await existingIngredient.populate("preferredSupplierId", "name");

      // Convert to plain object to ensure all fields are included
      const ingredientData = existingIngredient.toObject ? existingIngredient.toObject({ getters: true, virtuals: false }) : existingIngredient;

      const isShared = !data.cartId || data.cartId === null;
      console.log(`[CREATE_INGREDIENT] Returning existing ingredient: ${ingredientData.name} (ID: ${ingredientData._id})`);

      return res.status(200).json({
        success: true,
        message: `Ingredient "${data.name}" already exists${isShared ? ' as a shared ingredient' : ` for this cart`}. Returning existing ingredient.`,
        warning: 'INGREDIENT_ALREADY_EXISTS',
        data: ingredientData,
        isExisting: true
      });
    }

    const ingredient = new Ingredient(data);

    // CRITICAL: Log before saving to verify cartId
    console.log(`[CREATE_INGREDIENT] About to save ingredient:`, {
      name: ingredient.name,
      cartId: ingredient.cartId === null ? 'null (SHARED)' : ingredient.cartId,
      role: req.user.role
    });

    try {
      await ingredient.save();

      // CRITICAL: Verify what was actually saved
      const savedIngredient = await Ingredient.findById(ingredient._id);
      console.log(`[CREATE_INGREDIENT] ✅ Ingredient saved successfully!`);
      console.log(`[CREATE_INGREDIENT] Saved ingredient details:`, {
        _id: savedIngredient._id,
        name: savedIngredient.name,
        cartId: savedIngredient.cartId === null ? 'null (SHARED)' : savedIngredient.cartId,
        isActive: savedIngredient.isActive
      });

      // Verify it's accessible to cart admins
      if (req.user.role === "super_admin" && savedIngredient.cartId === null) {
        console.log(`[CREATE_INGREDIENT] ✅✅✅ VERIFIED: Ingredient saved with cartId: null - WILL BE VISIBLE TO ALL CART ADMINS`);

        // Test: Verify a cart admin can see this ingredient
        const testCartAdminQuery = {
          $or: [
            { cartId: null },
            { cartId: { $exists: false } }
          ]
        };
        const testCount = await Ingredient.countDocuments({
          ...testCartAdminQuery,
          _id: savedIngredient._id
        });
        console.log(`[CREATE_INGREDIENT] ✅ Test: Cart admin query can find this ingredient: ${testCount > 0 ? 'YES' : 'NO'}`);
      } else if (req.user.role === "super_admin" && savedIngredient.cartId !== null) {
        console.error(`[CREATE_INGREDIENT] ⚠️⚠️⚠️ WARNING: Super admin ingredient saved with cartId: ${savedIngredient.cartId} - NOT SHARED!`);
      }
    } catch (saveError) {
      // Handle duplicate key error (unique index violation)
      if (saveError.code === 11000 || saveError.name === 'MongoServerError') {
        // Extract the duplicate key from error message
        const duplicateKeyMatch = saveError.message.match(/dup key: \{ (.+?) \}/);
        const duplicateKey = duplicateKeyMatch ? duplicateKeyMatch[1] : 'unknown';

        // Check if it's a shared ingredient (cartId: null or cartId: null)
        const isShared = duplicateKey.includes('cartId: null') || duplicateKey.includes('cartId: null') || !data.cartId;

        // Try to find the existing ingredient to return it
        let existingIngredient = null;
        try {
          const findQuery = { name: data.name.trim() };
          if (isShared) {
            findQuery.$or = [
              { cartId: null },
              { cartId: { $exists: false } }
            ];
          } else {
            findQuery.cartId = data.cartId;
          }
          existingIngredient = await Ingredient.findOne(findQuery)
            .populate("cartId", "name cafeName")
            .populate("preferredSupplierId", "name");

          // Fallback for legacy unique index on `name` only:
          // duplicate can come from a different cart/shared scope.
          if (!existingIngredient) {
            existingIngredient = await Ingredient.findOne({
              name: { $regex: new RegExp(`^${data.name.trim()}$`, "i") },
            })
              .populate("cartId", "name cafeName")
              .populate("preferredSupplierId", "name");
          }
        } catch (findError) {
          console.error('[CREATE_INGREDIENT] Error finding existing ingredient:', findError);
        }

        // Return existing ingredient with warning instead of error
        if (existingIngredient) {
          // Convert to plain object to ensure all fields are included
          const ingredientData = existingIngredient.toObject ? existingIngredient.toObject({ getters: true, virtuals: false }) : existingIngredient;
          console.log(`[CREATE_INGREDIENT] Returning existing ingredient from duplicate key error: ${ingredientData.name} (ID: ${ingredientData._id})`);

          return res.status(200).json({
            success: true,
            message: `Ingredient "${data.name}" already exists${isShared ? ' as a shared ingredient' : ` for this cart`}. Returning existing ingredient.`,
            warning: 'INGREDIENT_ALREADY_EXISTS',
            data: ingredientData,
            isExisting: true
          });
        } else {
          // If we can't find it, still return success with warning
          return res.status(200).json({
            success: true,
            message: `Ingredient "${data.name}" may already exist. Please check the ingredients list.`,
            warning: 'POSSIBLE_DUPLICATE',
            duplicateKey: duplicateKey
          });
        }
      }
      // Re-throw if it's not a duplicate key error
      throw saveError;
    }

    await ingredient.populate("cartId", "name cafeName");
    await ingredient.populate("preferredSupplierId", "name");

    // Convert to plain object to ensure all fields are included in response
    const ingredientData = ingredient.toObject ? ingredient.toObject({ getters: true, virtuals: false }) : ingredient;

    console.log(`[CREATE_INGREDIENT] ✅ Successfully created ingredient: ${ingredientData.name} (ID: ${ingredientData._id}, cartId: ${ingredientData.cartId || 'null'})`);

    // Emit socket event for real-time sync
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    if (ingredient.cartId) {
      emitToCafe(
        io,
        ingredient.cartId.toString(),
        "ingredient:created",
        ingredientData
      );
    }

    res.status(201).json({
      success: true,
      data: ingredientData,
      message: `Ingredient "${ingredientData.name}" created successfully`
    });
  } catch (error) {
    console.error(`[CREATE_INGREDIENT ERROR]`, error);
    res.status(400).json({
      success: false,
      message: error.message || "Failed to create ingredient"
    });
  }
};

/**
 * @route   PUT /api/costing-v2/ingredients/:id
 * @desc    Update ingredient
 */
exports.updateIngredient = async (req, res) => {
  try {
    // First find the ingredient to check access
    const existingIngredient = await Ingredient.findById(req.params.id);
    if (!existingIngredient) {
      return res
        .status(404)
        .json({ success: false, message: "Ingredient not found" });
    }

    // CRITICAL: Check if this is a SHARED ingredient (cartId: null)
    const isSharedIngredient = existingIngredient.cartId === null || existingIngredient.cartId === undefined;

    console.log(`[UPDATE_INGREDIENT] Updating ingredient: ${existingIngredient.name}`);
    console.log(`[UPDATE_INGREDIENT] Current cartId: ${existingIngredient.cartId === null ? 'null (SHARED)' : existingIngredient.cartId}`);
    console.log(`[UPDATE_INGREDIENT] User role: ${req.user.role} (${req.user._id})`);
    console.log(`[UPDATE_INGREDIENT] Is shared ingredient: ${isSharedIngredient}`);

    // Check access control
    if (req.user.role === "admin") {
      // Cart admins can update:
      // 1. Their own cart-specific ingredients (cartId matches)
      // 2. Shared ingredients (cartId is null) - but ONLY certain fields
      if (existingIngredient.cartId && existingIngredient.cartId.toString() !== req.user._id.toString()) {
        // This ingredient belongs to a different cart - deny access
        return res.status(403).json({
          success: false,
          message: "Access denied. You can only update ingredients belonging to your cart.",
        });
      }

      // If updating a shared ingredient, cart admin can only update certain allowable fields
      // They CANNOT change name, category, or cartId
      if (isSharedIngredient) {
        console.log(`[UPDATE_INGREDIENT] ⚠️ Cart admin updating SHARED ingredient - restricting to allowable fields`);
        const allowedFields = ['qtyOnHand', 'reorderLevel', 'currentCostPerBaseUnit', 'isActive', 'storageLocation'];
        const requestedFields = Object.keys(req.body);
        const disallowedFields = requestedFields.filter(f => !allowedFields.includes(f));

        if (disallowedFields.length > 0) {
          console.warn(`[UPDATE_INGREDIENT] ⚠️ Cart admin attempted to update disallowed fields on shared ingredient: ${disallowedFields.join(', ')}`);
          // Allow the update but log warning - or you can reject it
          // For now, we'll filter out the disallowed fields
        }
      }
    } else if (req.user.role === "manager") {
      // Manager - can update ingredients for their cart (same logic as getCostingInventory)
      let managerCartId = req.user.cartId ?? req.user.cafeId;
      if (!managerCartId && req.user.employeeId) {
        const employee = await require("../../models/employeeModel").findById(req.user.employeeId).lean();
        managerCartId = employee?.cartId || employee?.cafeId;
      }
      if (!managerCartId) {
        const employee = await require("../../models/employeeModel").findOne({
          $or: [{ email: req.user.email?.toLowerCase() }, { userId: req.user._id }],
        }).lean();
        managerCartId = employee?.cartId || employee?.cafeId;
      }
      if (!managerCartId) {
        return res.status(403).json({ success: false, message: "No cart associated with manager" });
      }
      // Manager can update: ingredients with cartId matching their cart, or shared (cartId null)
      if (existingIngredient.cartId && existingIngredient.cartId.toString() !== managerCartId.toString()) {
        return res.status(403).json({
          success: false,
          message: "Access denied. You can only update ingredients belonging to your cart.",
        });
      }
    }

    // Decode HTML entities in category field if present
    let updateData = { ...req.body };
    if (updateData.category) {
      updateData.category = decodeHtmlEntities(updateData.category);
    }

    // CRITICAL FIX: Remove cartId from updateData to prevent overwriting
    // This prevents shared ingredients from being converted to cart-specific
    // when cart admins update other fields like quantity or reorder level
    if (updateData.cartId !== undefined) {
      console.log(`[UPDATE_INGREDIENT] ⚠️ Removing cartId from updateData to prevent overwrite`);
      console.log(`[UPDATE_INGREDIENT] Original ingredient cartId: ${existingIngredient.cartId === null ? 'null (SHARED)' : existingIngredient.cartId}`);
      console.log(`[UPDATE_INGREDIENT] Attempted new cartId: ${updateData.cartId}`);
      delete updateData.cartId;
    }

    // CRITICAL: For shared ingredients, ensure cartId remains null
    if (isSharedIngredient) {
      // Explicitly preserve cartId as null
      updateData.cartId = null;
      console.log(`[UPDATE_INGREDIENT] ✅ Preserved cartId as null for shared ingredient`);
    }

    // Update the ingredient
    const ingredient = await Ingredient.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    );

    // CRITICAL: Verify cartId was not changed
    if (isSharedIngredient && ingredient.cartId !== null) {
      console.error(`[UPDATE_INGREDIENT] ❌❌❌ CRITICAL ERROR: Shared ingredient cartId was changed to ${ingredient.cartId}!`);
      console.error(`[UPDATE_INGREDIENT] This should NEVER happen - investigate immediately!`);
      // Force it back to null
      ingredient.cartId = null;
      await ingredient.save();
      console.log(`[UPDATE_INGREDIENT] ✅ Forced cartId back to null`);
    } else if (isSharedIngredient) {
      console.log(`[UPDATE_INGREDIENT] ✅✅✅ VERIFIED: Shared ingredient cartId remains null after update`);
    }

    if (!ingredient) {
      return res
        .status(404)
        .json({ success: false, message: "Ingredient not found" });
    }

    // Emit socket event for real-time sync
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    if (ingredient.cartId) {
      emitToCafe(
        io,
        ingredient.cartId.toString(),
        "ingredient:updated",
        ingredient
      );

      // Also sync to inventory if linked
      try {
        const InventoryItem = require("../../models/inventoryModel");
        const linkedInventory = await InventoryItem.findOne({
          ingredientId: ingredient._id,
        });
        if (linkedInventory) {
          // Update inventory item with ingredient data
          linkedInventory.quantity =
            ingredient.qtyOnHand || linkedInventory.quantity;
          linkedInventory.minStockLevel =
            ingredient.reorderLevel || linkedInventory.minStockLevel;
          linkedInventory.unitPrice =
            ingredient.currentCostPerBaseUnit || linkedInventory.unitPrice;
          await linkedInventory.save();
          emitToCafe(
            io,
            ingredient.cartId.toString(),
            "inventory:updated",
            linkedInventory
          );
        }
      } catch (syncError) {
        console.error(
          "[COSTING] Error syncing ingredient to inventory:",
          syncError
        );
        // Don't fail the request if sync fails
      }
    }

    res.json({ success: true, data: ingredient });
  } catch (error) {
    console.error("[COSTING] Update ingredient error:", error);
    res.status(400).json({
      success: false,
      message: error.message || "Failed to update ingredient",
    });
  }
};

/**
 * @route   DELETE /api/costing-v2/ingredients/:id
 * @desc    Delete ingredient
 */
exports.deleteIngredient = async (req, res) => {
  try {
    // First find the ingredient to check access and validate
    const ingredient = await Ingredient.findById(req.params.id);
    if (!ingredient) {
      return res
        .status(404)
        .json({ success: false, message: "Ingredient not found" });
    }

    // Check access control
    if (req.user.role === "admin") {
      // If ingredient has cartId, it must match the cart admin's ID
      if (
        ingredient.cartId &&
        ingredient.cartId.toString() !== req.user._id.toString()
      ) {
        return res.status(403).json({
          success: false,
          message:
            "Access denied: You can only delete ingredients belonging to your cart",
        });
      }
      // If ingredient is shared (cartId is null), cart admin cannot delete it
      if (!ingredient.cartId) {
        return res.status(403).json({
          success: false,
          message: "Access denied: You cannot delete shared ingredients",
        });
      }
    } else if (req.user.role === "franchise_admin") {
      // Franchise admin can delete ingredients from their franchise carts
      if (ingredient.cartId) {
        const outlet = await User.findById(ingredient.cartId);
        if (
          !outlet ||
          outlet.franchiseId?.toString() !== req.user._id.toString()
        ) {
          return res.status(403).json({
            success: false,
            message:
              "Access denied: You can only delete ingredients from your franchise carts",
          });
        }
      } else if (
        ingredient.franchiseId &&
        ingredient.franchiseId.toString() !== req.user._id.toString()
      ) {
        return res.status(403).json({
          success: false,
          message:
            "Access denied: You can only delete ingredients from your franchise",
        });
      }
    }

    // Check if ingredient is used in recipes
    const Recipe = require("../../models/costing-v2/recipeModel");
    const recipesUsingIngredient = await Recipe.find({
      "ingredients.ingredientId": ingredient._id,
    });

    if (recipesUsingIngredient.length > 0) {
      // Instead of blocking deletion, automatically remove this ingredient
      // from all BOMs/recipes that reference it.
      console.log(
        `[COSTING] Deleting ingredient ${ingredient._id} used in ${recipesUsingIngredient.length} recipe(s). Removing from BOMs.`
      );

      for (const recipe of recipesUsingIngredient) {
        recipe.ingredients = recipe.ingredients.filter(
          (ing) =>
            !ing.ingredientId ||
            ing.ingredientId.toString() !== ingredient._id.toString()
        );
        await recipe.save();
      }
    }

    // Check if ingredient has active inventory transactions
    const InventoryTransaction = require("../../models/costing-v2/inventoryTransactionModel");
    const hasTransactions = await InventoryTransaction.exists({
      ingredientId: ingredient._id,
    });

    if (hasTransactions) {
      // Allow deletion but warn - or we could prevent it
      console.log(
        `[COSTING] Warning: Deleting ingredient ${ingredient._id} with existing inventory transactions`
      );
    }

    // Delete the ingredient
    await Ingredient.findByIdAndDelete(req.params.id);

    // Emit socket event for real-time sync
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    if (ingredient.cartId) {
      emitToCafe(io, ingredient.cartId.toString(), "ingredient:deleted", {
        id: ingredient._id,
      });
    }

    res.json({ success: true, message: "Ingredient deleted successfully" });
  } catch (error) {
    console.error("[COSTING] Delete ingredient error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to delete ingredient",
    });
  }
};

/**
 * @route   GET /api/costing-v2/ingredients/:id/fifo-layers
 * @desc    Get FIFO layers for ingredient
 */
exports.getFIFOLayers = async (req, res) => {
  try {
    // First verify the ingredient exists and check access
    const ingredient = await Ingredient.findById(req.params.id);
    if (!ingredient) {
      return res
        .status(404)
        .json({ success: false, message: "Ingredient not found" });
    }

    // Check access control - cart admins can only view FIFO for their own ingredients
    if (req.user.role === "admin") {
      if (
        ingredient.cartId &&
        ingredient.cartId.toString() !== req.user._id.toString()
      ) {
        return res.status(403).json({
          success: false,
          message:
            "Access denied. You can only view FIFO layers for ingredients belonging to your cart.",
        });
      }
    }

    // Get FIFO layers
    const layers = await FIFOService.getLayers(req.params.id);
    res.json({ success: true, data: layers || [] });
  } catch (error) {
    console.error("[COSTING] Get FIFO layers error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch FIFO layers",
    });
  }
};

// ==================== PURCHASES ====================

/**
 * @route   GET /api/costing-v2/purchases
 * @desc    Get all purchases
 */
exports.getPurchases = async (req, res) => {
  try {
    const { status, supplierId, from, to, cartId } = req.query;
    const filter = {};

    if (status) filter.status = status;
    if (supplierId) filter.supplierId = supplierId;
    if (cartId) filter.cartId = cartId;
    if (from || to) {
      filter.date = {};
      if (from) filter.date.$gte = new Date(from);
      if (to) filter.date.$lte = new Date(to);
    }

    // Apply role-based filtering
    const costingFilter = await buildCostingQuery(req.user, filter);

    const purchases = await Purchase.find(costingFilter)
      .populate("supplierId", "name")
      .populate("items.ingredientId", "name uom baseUnit")
      .populate("receivedBy", "name email")
      .populate("cartId", "name cafeName")
      .sort({ date: -1 });

    res.json({ success: true, data: purchases });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   POST /api/costing-v2/purchases
 * @desc    Create purchase order
 */
const processPurchaseReceipt = async ({ purchase, userId }) => {
  const purchasedIngredientIds = [];

  for (const item of purchase.items) {
    const ingredient = await Ingredient.findById(item.ingredientId);
    if (!ingredient) continue;

    const hasExplicitExpiryDate =
      item.expiryDate !== undefined &&
      item.expiryDate !== null &&
      item.expiryDate !== "";
    const parsedExpiryDate = parseOptionalDate(item.expiryDate);
    if (hasExplicitExpiryDate && !parsedExpiryDate) {
      throw new Error(`Invalid expiryDate for ingredient ${ingredient.name}`);
    }

    purchasedIngredientIds.push(item.ingredientId);

    const qtyInBaseUnit = safeConvertToBaseUnit(ingredient, item.qty, item.uom);
    const conversionFactor = safeConvertToBaseUnit(ingredient, 1, item.uom);
    const unitCostInBaseUnit = item.unitPrice / conversionFactor;

    if (
      (ingredient.baseUnit === "g" || ingredient.baseUnit === "ml") &&
      unitCostInBaseUnit > 100
    ) {
      console.error(
        `[PURCHASE COST ERROR] ${ingredient.name}: cost per ${ingredient.baseUnit} seems high (${unitCostInBaseUnit.toFixed(6)}).`,
      );
    }

    console.log(
      `[PURCHASE] ${ingredient.name}: unitPrice=${item.unitPrice}/${item.uom}, baseUnit=${ingredient.baseUnit}, conversionFactor=${conversionFactor}, unitCostInBaseUnit=${unitCostInBaseUnit.toFixed(6)}/${ingredient.baseUnit}`,
    );

    const cartId = purchase.cartId || null;

    if (process.env.NODE_ENV === "development") {
      console.log(
        `[PURCHASE RECEIVE] ${ingredient.name}: updating stock - qtyInBaseUnit=${qtyInBaseUnit} ${ingredient.baseUnit}, pricePerBase=${unitCostInBaseUnit.toFixed(6)}, cartId=${cartId}`,
      );
    }

    const stockUpdateResult = await WeightedAverageService.updateWeightedAverage(
      item.ingredientId,
      qtyInBaseUnit,
      unitCostInBaseUnit,
      cartId,
    );

    if (process.env.NODE_ENV === "development") {
      console.log(
        `[PURCHASE RECEIVE] ${ingredient.name}: stock updated - previousQty=${stockUpdateResult.previousQty}, previousAvgCost=${stockUpdateResult.previousAvgCost.toFixed(6)}, updatedQtyOnHand=${stockUpdateResult.updatedQtyOnHand} ${ingredient.baseUnit}, weightedAvgCost=${stockUpdateResult.newAverageCost.toFixed(6)}/${ingredient.baseUnit}`,
      );
    }

    await Ingredient.findByIdAndUpdate(item.ingredientId, {
      $set: {
        lastReceivedAt: new Date(),
        expiryDate: parsedExpiryDate || null,
      },
    });

    const costAllocated = qtyInBaseUnit * unitCostInBaseUnit;

    if (process.env.NODE_ENV === "development") {
      const expectedCost = item.unitPrice * item.qty;
      if (Math.abs(expectedCost - costAllocated) > 0.01) {
        console.warn(
          `[PURCHASE] ${ingredient.name}: cost mismatch! expected=${expectedCost.toFixed(2)}, calculated=${costAllocated.toFixed(2)}`,
        );
      }
    }

    let transactionCartId = purchase.cartId || null;
    if (
      transactionCartId &&
      mongoose.Types.ObjectId.isValid(transactionCartId)
    ) {
      transactionCartId = new mongoose.Types.ObjectId(transactionCartId);
    }

    const transaction = new InventoryTransaction({
      ingredientId: item.ingredientId,
      type: "IN",
      qty: item.qty,
      uom: item.uom,
      qtyInBaseUnit,
      refType: "purchase",
      refId: purchase._id,
      date: new Date(),
      costAllocated,
      unitPrice: item.unitPrice,
      recordedBy: userId,
      cartId: transactionCartId,
    });

    if (qtyInBaseUnit <= 0) {
      throw new Error(
        `Invalid qtyInBaseUnit for ${ingredient.name}: ${qtyInBaseUnit}. Original qty: ${item.qty} ${item.uom}`,
      );
    }
    if (costAllocated < 0) {
      throw new Error(`Invalid costAllocated for ${ingredient.name}: ${costAllocated}`);
    }

    await transaction.save();

    if (process.env.NODE_ENV === "development") {
      console.log(
        `[PURCHASE RECEIVE] ${ingredient.name}: transaction created - qty=${item.qty} ${item.uom}, qtyInBaseUnit=${qtyInBaseUnit} ${ingredient.baseUnit}, costAllocated=${costAllocated.toFixed(2)}, unitPrice=${item.unitPrice}/${item.uom}, cartId=${transactionCartId ? transactionCartId.toString() : "null"}`,
      );
    }

    // #region agent log
    logDebug(
      "costingController.js:776",
      "Inventory transaction created",
      {
        transactionId: transaction._id,
        ingredientId: item.ingredientId,
        ingredientName: ingredient.name,
        cartId: purchase.cartId,
        purchaseId: purchase._id,
        qty: qtyInBaseUnit,
        costAllocated: transaction.costAllocated,
      },
      "B",
    );
    // #endregion
  }

  purchase.status = "received";
  purchase.receivedDate = new Date();
  purchase.receivedBy = userId;
  await purchase.save();

  if (purchasedIngredientIds.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    // #region agent log
    logDebug(
      "costingController.js:760",
      "Recalculating BOMs after purchase",
      {
        purchaseId: purchase._id,
        cartId: purchase.cartId,
        ingredientIds: purchasedIngredientIds,
      },
      "B",
    );
    // #endregion
    const recipeFilter = {
      "ingredients.ingredientId": { $in: purchasedIngredientIds },
    };

    if (purchase.cartId) {
      recipeFilter.$or = [
        { cartId: purchase.cartId },
        { cartId: null },
        { cartId: { $exists: false } },
      ];
    }

    const affectedRecipes = await Recipe.find(recipeFilter);

    // #region agent log
    logDebug(
      "costingController.js:768",
      "Found affected BOMs",
      {
        recipeCount: affectedRecipes.length,
        recipeIds: affectedRecipes.map((r) => r._id),
      },
      "B",
    );
    // #endregion

    for (const recipe of affectedRecipes) {
      const cartIdForRecalc = purchase.cartId || null;
      await recipe.calculateCost(cartIdForRecalc);
      await recipe.save();
      // #region agent log
      logDebug(
        "costingController.js:777",
        "BOM cost updated after purchase",
        {
          recipeId: recipe._id,
          recipeName: recipe.name,
          totalCost: recipe.totalCostCached,
          costPerPortion: recipe.costPerPortion,
          cartId: cartIdForRecalc,
        },
        "B",
      );
      // #endregion
    }
  }
};

exports.createPurchase = async (req, res) => {
  try {
    const { items, autoReceive, ...purchaseData } = req.body;

    const requestedAutoReceive = parseBooleanish(autoReceive);
    // Cart admin flow in Finances expects stock to be added immediately on create.
    const defaultAutoReceive =
      String(req.user?.role || "").trim().toLowerCase() === "admin";
    const shouldAutoReceive =
      requestedAutoReceive === null ? defaultAutoReceive : requestedAutoReceive;

    // Set outlet context based on user role
    const data = await setOutletContext(req.user, purchaseData);

    // Calculate totals
    let totalAmount = 0;
    const purchaseItems = [];

    for (const item of items) {
      const total = item.qty * item.unitPrice;
      totalAmount += total;
      const hasExplicitExpiryDate =
        item.expiryDate !== undefined &&
        item.expiryDate !== null &&
        item.expiryDate !== "";
      const parsedExpiryDate = parseOptionalDate(item.expiryDate);
      if (hasExplicitExpiryDate && !parsedExpiryDate) {
        throw new Error(`Invalid expiryDate for ingredient ${item.ingredientId}`);
      }
      purchaseItems.push({
        ingredientId: item.ingredientId,
        qty: item.qty,
        uom: item.uom,
        unitPrice: item.unitPrice,
        total,
        expiryDate: parsedExpiryDate,
      });
    }

    const purchase = new Purchase({
      ...data,
      items: purchaseItems,
      totalAmount,
      status: "created",
    });

    await purchase.save();

    if (shouldAutoReceive) {
      await processPurchaseReceipt({
        purchase,
        userId: req.user._id,
      });
    }

    await purchase.populate("supplierId", "name");
    await purchase.populate("items.ingredientId", "name uom");
    await purchase.populate("cartId", "name cafeName");

    res.status(201).json({ success: true, data: purchase });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

/**
 * @route   POST /api/costing-v2/purchases/:id/receive
 * @desc    Receive purchase and update inventory (FIFO)
 */
exports.receivePurchase = async (req, res) => {
  try {
    const purchase = await Purchase.findById(req.params.id);
    if (!purchase) {
      return res
        .status(404)
        .json({ success: false, message: "Purchase not found" });
    }

    // Validate outlet access
    if (!(await validateOutletAccess(req.user, purchase.cartId))) {
      return res
        .status(403)
        .json({ success: false, message: "Access denied to this purchase" });
    }

    if (purchase.status === "received") {
      return res
        .status(400)
        .json({ success: false, message: "Purchase already received" });
    }

    // Track which ingredients were purchased for BOM recalculation
    const purchasedIngredientIds = [];

    // Process each item: update weighted average cost and update inventory
    for (const item of purchase.items) {
      const ingredient = await Ingredient.findById(item.ingredientId);
      if (!ingredient) continue;

      const hasExplicitExpiryDate =
        item.expiryDate !== undefined &&
        item.expiryDate !== null &&
        item.expiryDate !== "";
      const parsedExpiryDate = parseOptionalDate(item.expiryDate);
      if (hasExplicitExpiryDate && !parsedExpiryDate) {
        throw new Error(`Invalid expiryDate for ingredient ${ingredient.name}`);
      }

      purchasedIngredientIds.push(item.ingredientId);

      // Convert to base unit
      const qtyInBaseUnit = safeConvertToBaseUnit(ingredient, item.qty, item.uom);

      // Calculate unit cost in base unit
      // Formula: unitCostInBaseUnit = unitPrice (per display unit) / conversionFactor (display units per base unit)
      // Example: If unitPrice is ₹608.26/kg and baseUnit is "g":
      //   convertToBaseUnit(1, "kg") = 1000 (grams in 1 kg)
      //   unitCostInBaseUnit = 608.26 / 1000 = 0.60826 per gram ✓
      const conversionFactor = safeConvertToBaseUnit(ingredient, 1, item.uom);
      const unitCostInBaseUnit = item.unitPrice / conversionFactor;

      // Validate the calculated cost is reasonable
      // For ingredients with baseUnit "g" or "ml", cost per base unit should typically be < 100
      // If it's > 100, it might indicate the calculation is wrong
      if ((ingredient.baseUnit === 'g' || ingredient.baseUnit === 'ml') && unitCostInBaseUnit > 100) {
        console.error(`[PURCHASE COST ERROR] ${ingredient.name}: Calculated cost per ${ingredient.baseUnit} is ₹${unitCostInBaseUnit.toFixed(6)}, which seems too high. Unit price: ₹${item.unitPrice}/${item.uom}, Conversion factor: ${conversionFactor}`);
      }

      // Always log purchase cost calculation for debugging
      console.log(`[PURCHASE] ${ingredient.name}: unitPrice=₹${item.unitPrice}/${item.uom}, baseUnit=${ingredient.baseUnit}, conversionFactor=${conversionFactor}, unitCostInBaseUnit=₹${unitCostInBaseUnit.toFixed(6)}/${ingredient.baseUnit}`);

      // WEIGHTED AVERAGE: Update stock with weighted average cost calculation
      // Formula: (Existing Stock Qty × Existing Avg Cost + New Purchase Qty × New Purchase Cost) / (Existing Stock Qty + New Purchase Qty)
      // Use cartId for stock update
      const cartId = purchase.cartId || null;

      // Log before update for debugging
      if (process.env.NODE_ENV === 'development') {
        console.log(`[PURCHASE RECEIVE] ${ingredient.name}: Updating stock - qtyInBaseUnit=${qtyInBaseUnit} ${ingredient.baseUnit}, purchasePrice=₹${unitCostInBaseUnit.toFixed(6)}/${ingredient.baseUnit}, cartId=${cartId}`);
      }

      // Update stock and calculate weighted average cost
      const stockUpdateResult = await WeightedAverageService.updateWeightedAverage(
        item.ingredientId,
        qtyInBaseUnit,
        unitCostInBaseUnit, // Purchase price per base unit
        cartId
      );

      // Log after update for debugging
      if (process.env.NODE_ENV === 'development') {
        console.log(`[PURCHASE RECEIVE] ${ingredient.name}: Stock updated - previousQty=${stockUpdateResult.previousQty}, previousAvgCost=₹${stockUpdateResult.previousAvgCost.toFixed(6)}, updatedQtyOnHand=${stockUpdateResult.updatedQtyOnHand} ${ingredient.baseUnit}, weightedAvgCost=₹${stockUpdateResult.newAverageCost.toFixed(6)}/${ingredient.baseUnit}`);
      }

      // Keep shelf-life source fields in sync with received purchases.
      // If no explicit expiry date is provided, fallback logic uses shelfTimeDays + lastReceivedAt.
      await Ingredient.findByIdAndUpdate(item.ingredientId, {
        $set: {
          lastReceivedAt: new Date(),
          expiryDate: parsedExpiryDate || null,
        },
      });

      // Calculate cost allocated using the actual purchase cost (not weighted average)
      // The transaction should record the actual cost of this purchase
      // The weighted average is used to update ingredient.currentCostPerBaseUnit
      // IMPORTANT: costAllocated = qtyInBaseUnit × unitCostInBaseUnit
      // This is the total cost for this purchase transaction
      // When calculating weighted average in inventory: weightedAvgCost = costAllocated / qtyInBaseUnit
      // This should equal unitCostInBaseUnit, ensuring consistency
      const costAllocated = qtyInBaseUnit * unitCostInBaseUnit;

      // Validate costAllocated calculation
      if (process.env.NODE_ENV === 'development') {
        const expectedCost = item.unitPrice * item.qty; // Total purchase cost
        const calculatedCost = costAllocated;
        if (Math.abs(expectedCost - calculatedCost) > 0.01) {
          console.warn(`[PURCHASE] ${ingredient.name}: Cost mismatch! Expected: ₹${expectedCost.toFixed(2)}, Calculated: ₹${calculatedCost.toFixed(2)}. qtyInBaseUnit=${qtyInBaseUnit}, unitCostInBaseUnit=${unitCostInBaseUnit.toFixed(6)}`);
        }
      }

      // Create inventory transaction
      // CRITICAL: Ensure qtyInBaseUnit is correctly calculated and stored
      // This is used for stock calculation in getIngredients
      // IMPORTANT: Store exact unitPrice to match purchase price in inventory
      // CRITICAL: Ensure cartId is stored correctly (ObjectId format)
      // Convert to ObjectId if it's a string to ensure consistent matching
      let transactionCartId = purchase.cartId || null;
      if (transactionCartId && mongoose.Types.ObjectId.isValid(transactionCartId)) {
        transactionCartId = new mongoose.Types.ObjectId(transactionCartId);
      }

      const transaction = new InventoryTransaction({
        ingredientId: item.ingredientId,
        type: "IN",
        qty: item.qty, // Original quantity (for display)
        uom: item.uom, // Original unit (for display)
        qtyInBaseUnit: qtyInBaseUnit, // Quantity in base unit (CRITICAL for stock calculation)
        refType: "purchase",
        refId: purchase._id,
        date: new Date(),
        costAllocated: costAllocated, // Total cost for this transaction
        unitPrice: item.unitPrice, // CRITICAL: Store exact purchase price per unit to match inventory display
        recordedBy: req.user._id,
        cartId: transactionCartId, // CRITICAL: Must match purchase.cartId for proper stock tracking (stored as ObjectId)
      });

      // Validate transaction before saving
      if (qtyInBaseUnit <= 0) {
        throw new Error(`Invalid qtyInBaseUnit for ${ingredient.name}: ${qtyInBaseUnit}. Original qty: ${item.qty} ${item.uom}`);
      }
      if (costAllocated < 0) {
        throw new Error(`Invalid costAllocated for ${ingredient.name}: ${costAllocated}`);
      }

      await transaction.save();

      // Log transaction creation for debugging
      if (process.env.NODE_ENV === 'development') {
        console.log(`[PURCHASE RECEIVE] ${ingredient.name}: Transaction created - qty=${item.qty} ${item.uom}, qtyInBaseUnit=${qtyInBaseUnit} ${ingredient.baseUnit}, costAllocated=₹${costAllocated.toFixed(2)}, unitPrice=₹${item.unitPrice}/${item.uom}, cartId=${transactionCartId ? transactionCartId.toString() : 'null'}`);
      }
      // #region agent log
      logDebug(
        "costingController.js:776",
        "Inventory transaction created",
        {
          transactionId: transaction._id,
          ingredientId: item.ingredientId,
          ingredientName: ingredient.name,
          cartId: purchase.cartId,
          purchaseId: purchase._id,
          qty: qtyInBaseUnit,
          costAllocated: transaction.costAllocated,
        },
        "B"
      );
      // #endregion
    }

    // Update purchase status
    purchase.status = "received";
    purchase.receivedDate = new Date();
    purchase.receivedBy = req.user._id;
    await purchase.save();

    // Recalculate costs for all BOMs that use the purchased ingredients
    // This ensures BOM costs are updated when purchases are received
    if (purchasedIngredientIds.length > 0) {
      // Small delay to ensure all transactions are committed to database
      // This prevents race conditions where BOM recalculation happens before transactions are visible
      await new Promise((resolve) => setTimeout(resolve, 100));
      // #region agent log
      logDebug(
        "costingController.js:760",
        "Recalculating BOMs after purchase",
        {
          purchaseId: purchase._id,
          cartId: purchase.cartId,
          ingredientIds: purchasedIngredientIds,
        },
        "B"
      );
      // #endregion
      // Find all recipes that use any of the purchased ingredients
      // For cart-specific purchases, also include global recipes (cartId: null) that might use these ingredients
      const recipeFilter = {
        "ingredients.ingredientId": { $in: purchasedIngredientIds },
      };

      // If this is a cart-specific purchase, also recalculate global recipes
      // This ensures global BOMs reflect the latest purchase prices
      if (purchase.cartId) {
        recipeFilter.$or = [
          { cartId: purchase.cartId }, // Cart-specific recipes
          { cartId: null }, // Global recipes
          { cartId: { $exists: false } }, // Legacy recipes
        ];
      }

      const affectedRecipes = await Recipe.find(recipeFilter);

      // #region agent log
      logDebug(
        "costingController.js:768",
        "Found affected BOMs",
        {
          recipeCount: affectedRecipes.length,
          recipeIds: affectedRecipes.map((r) => r._id),
        },
        "B"
      );
      // #endregion

      // Recalculate costs for each affected recipe
      for (const recipe of affectedRecipes) {
        // Use cartId from purchase to recalculate outlet-specific costs
        const cartIdForRecalc = purchase.cartId || null;
        await recipe.calculateCost(cartIdForRecalc);
        await recipe.save();
        // #region agent log
        logDebug(
          "costingController.js:777",
          "BOM cost updated after purchase",
          {
            recipeId: recipe._id,
            recipeName: recipe.name,
            totalCost: recipe.totalCostCached,
            costPerPortion: recipe.costPerPortion,
            cartId: cartIdForRecalc,
          },
          "B"
        );
        // #endregion
      }
    }

    await purchase.populate("supplierId", "name");
    await purchase.populate("items.ingredientId", "name uom");

    res.json({ success: true, data: purchase });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// ==================== INVENTORY ====================

/**
 * @route   POST /api/costing-v2/inventory/consume
 * @desc    Consume ingredient (for recipes or manual usage)
 */
exports.consumeInventory = async (req, res) => {
  try {
    const { ingredientId, qty, uom, refType, refId, cartId } = req.body;

    const ingredient = await Ingredient.findById(ingredientId);
    if (!ingredient) {
      return res
        .status(404)
        .json({ success: false, message: "Ingredient not found" });
    }

    // For cart admin, always use their own cartId
    // For franchise admin and super admin, use provided cartId or validate
    // For manager (mobile), get cartId from user or employee
    let finalOutletId = cartId;
    if (req.user.role === "admin") {
      // Cart admin - always use their own kiosk
      finalOutletId = req.user._id;
    } else if (req.user.role === "manager") {
      // Manager - use their cart (from user or employee)
      if (req.user.cartId) {
        finalOutletId = req.user.cartId;
      } else if (req.user.cafeId) {
        finalOutletId = req.user.cafeId;
      } else if (req.user.employeeId) {
        const employee = await require("../../models/employeeModel").findById(req.user.employeeId).lean();
        finalOutletId = employee?.cartId || employee?.cafeId;
      } else {
        const employee = await require("../../models/employeeModel").findOne({
          $or: [{ email: req.user.email?.toLowerCase() }, { userId: req.user._id }],
        }).lean();
        finalOutletId = employee?.cartId || employee?.cafeId;
      }
      if (!finalOutletId) {
        return res.status(400).json({ success: false, message: "No cart associated with manager" });
      }
    } else if (req.user.role === "franchise_admin") {
      // Franchise admin - must provide cartId
      if (!cartId) {
        return res.status(400).json({
          success: false,
          message: "cartId is required for franchise admin",
        });
      }
      if (!(await validateOutletAccess(req.user, cartId))) {
        return res
          .status(403)
          .json({ success: false, message: "Access denied to this kiosk" });
      }
      finalOutletId = cartId;
    } else if (req.user.role === "super_admin") {
      // Super admin - must provide cartId
      if (!cartId) {
        return res.status(400).json({
          success: false,
          message: "cartId is required for super admin",
        });
      }
      finalOutletId = cartId;
    }

    // Convert to base unit
    const qtyInBaseUnit = safeConvertToBaseUnit(ingredient, qty, uom);

    // Consume using weighted average
    const result = await WeightedAverageService.consume(
      ingredientId,
      qtyInBaseUnit,
      refType || "manual",
      refId || null,
      req.user._id,
      finalOutletId
    );

    // Create inventory transaction
    const transaction = new InventoryTransaction({
      ingredientId: ingredientId,
      type: "OUT",
      qty: qty,
      uom: uom,
      qtyInBaseUnit: qtyInBaseUnit,
      refType: refType || "manual",
      refId: refId || null,
      date: new Date(),
      costAllocated: result.costAllocated,
      recordedBy: req.user._id,
      cartId: finalOutletId,
    });
    await transaction.save();

    res.json({ success: true, data: { ...result, transaction } });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

/**
 * @route   POST /api/costing-v2/inventory/return
 * @desc    Return ingredient to inventory
 */
exports.returnToInventory = async (req, res) => {
  try {
    const { ingredientId, qty, uom, refType, refId, originalTransactionId, cartId, notes } = req.body;

    const ingredient = await Ingredient.findById(ingredientId);
    if (!ingredient) {
      return res
        .status(404)
        .json({ success: false, message: "Ingredient not found" });
    }

    // For cart admin, always use their own cartId
    // For franchise admin and super admin, use provided cartId or validate
    // For manager (mobile), get cartId from user or employee
    let finalOutletId = cartId;
    if (req.user.role === "admin") {
      // Cart admin - always use their own kiosk
      finalOutletId = req.user._id;
    } else if (req.user.role === "manager") {
      // Manager - use their cart (from user or employee)
      if (req.user.cartId) {
        finalOutletId = req.user.cartId;
      } else if (req.user.cafeId) {
        finalOutletId = req.user.cafeId;
      } else if (req.user.employeeId) {
        const employee = await require("../../models/employeeModel").findById(req.user.employeeId).lean();
        finalOutletId = employee?.cartId || employee?.cafeId;
      } else {
        const employee = await require("../../models/employeeModel").findOne({
          $or: [{ email: req.user.email?.toLowerCase() }, { userId: req.user._id }],
        }).lean();
        finalOutletId = employee?.cartId || employee?.cafeId;
      }
      if (!finalOutletId) {
        return res.status(400).json({ success: false, message: "No cart associated with manager" });
      }
    } else if (req.user.role === "franchise_admin") {
      // Franchise admin - must provide cartId
      if (!cartId) {
        return res.status(400).json({
          success: false,
          message: "cartId is required for franchise admin",
        });
      }
      if (!(await validateOutletAccess(req.user, cartId))) {
        return res
          .status(403)
          .json({ success: false, message: "Access denied to this kiosk" });
      }
      finalOutletId = cartId;
    } else if (req.user.role === "super_admin") {
      // Super admin - must provide cartId
      if (!cartId) {
        return res.status(400).json({
          success: false,
          message: "cartId is required for super admin",
        });
      }
      finalOutletId = cartId;
    }

    // Convert to base unit
    const qtyInBaseUnit = safeConvertToBaseUnit(ingredient, qty, uom);

    // Return to inventory using weighted average
    const result = await WeightedAverageService.returnToInventory(
      ingredientId,
      qtyInBaseUnit,
      refType || "manual",
      refId || null,
      req.user._id,
      finalOutletId
    );

    // Create inventory transaction
    const transaction = new InventoryTransaction({
      ingredientId: ingredientId,
      type: "RETURN",
      qty: qty,
      uom: uom,
      qtyInBaseUnit: qtyInBaseUnit,
      originalTransactionId: originalTransactionId || null,
      refType: refType || "manual",
      refId: refId || null,
      date: new Date(),
      costAllocated: result.costAllocated,
      notes: notes || "",
      recordedBy: req.user._id,
      cartId: finalOutletId,
    });
    await transaction.save();

    res.json({ success: true, data: { ...result, transaction } });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

/**
 * @route   POST /api/costing-v2/inventory/direct-purchase
 * @desc    Directly add stock with price (for mobile app/manual addition)
 */
exports.directPurchase = async (req, res) => {
  try {
    const { ingredientId, qty, uom, unitPrice, supplier, notes, cartId } = req.body;

    const ingredient = await Ingredient.findById(ingredientId);
    if (!ingredient) {
      return res
        .status(404)
        .json({ success: false, message: "Ingredient not found" });
    }

    // Determine outlet ID based on role (same logic as consumeInventory)
    let finalOutletId = cartId;
    if (req.user.role === "admin") {
      finalOutletId = req.user._id;
    } else if (req.user.role === "manager") {
      finalOutletId = await resolveUserCartId(req.user);
      if (!finalOutletId && cartId) {
        finalOutletId = cartId;
      }
      if (!finalOutletId) {
        return res.status(400).json({ success: false, message: "No cart associated with manager" });
      }
    } else if (req.user.role === "franchise_admin" || req.user.role === "super_admin") {
      if (!cartId) {
        return res.status(400).json({ success: false, message: "cartId is required" });
      }
      finalOutletId = cartId; // Assuming validation happens in middleware or trusted
    }

    // Validate inputs
    if (qty <= 0) return res.status(400).json({ success: false, message: "Quantity must be > 0" });
    if (unitPrice < 0) return res.status(400).json({ success: false, message: "Price cannot be negative" });

    // Convert to base unit
    const qtyInBaseUnit = safeConvertToBaseUnit(ingredient, qty, uom);

    // Calculate cost per base unit
    const conversionFactor = safeConvertToBaseUnit(ingredient, 1, uom);
    const unitCostInBaseUnit = unitPrice / conversionFactor;

    // Update Weighted Average
    const result = await WeightedAverageService.updateWeightedAverage(
      ingredientId,
      qtyInBaseUnit,
      unitCostInBaseUnit,
      finalOutletId
    );

    // Create Inventory Transaction
    // costAllocated = qtyInBaseUnit * unitCostInBaseUnit (should equal qty * unitPrice)
    const costAllocated = qtyInBaseUnit * unitCostInBaseUnit;

    const transaction = new InventoryTransaction({
      ingredientId,
      type: "IN",
      qty,
      uom,
      qtyInBaseUnit,
      unitPrice, // Store the price per UOM
      costAllocated,
      // Keep consistent with schema enum and weighted-average lookups.
      refType: "purchase",
      date: new Date(),
      notes: notes ? `${notes} (Supplier: ${supplier || 'N/A'})` : `Direct Purchase from ${supplier || 'N/A'}`,
      recordedBy: req.user._id,
      cartId: finalOutletId,
    });

    await transaction.save();

    res.json({ success: true, data: { ...result, transaction } });
  } catch (error) {
    console.error("[DIRECT_PURCHASE] Error:", error);
    res.status(400).json({ success: false, message: error.message });
  }
};

/**
 * @route   GET /api/costing-v2/inventory/transactions
 * @desc    Get inventory transactions
 */
exports.getInventoryTransactions = async (req, res) => {
  try {
    const { ingredientId, type, from, to, cartId } = req.query;
    const filter = {};

    if (ingredientId) filter.ingredientId = ingredientId;
    if (type) filter.type = type;
    if (from || to) {
      filter.date = {};
      if (from) filter.date.$gte = new Date(from);
      if (to) filter.date.$lte = new Date(to);
    }

    // Apply role-based filtering for cartId only (inventory transactions don't have franchiseId)
    if (req.user.role === "admin") {
      // Cart admin - only see their own kiosk's transactions
      filter.cartId = req.user._id;
    } else if (req.user.role === "franchise_admin") {
      // Franchise admin - can filter by specific outlet or see all their franchise outlets
      if (cartId) {
        // Validate outlet belongs to their franchise
        const outlet = await User.findById(cartId);
        if (
          !outlet ||
          outlet.franchiseId?.toString() !== req.user._id.toString()
        ) {
          return res.status(403).json({
            success: false,
            message: "Access denied: Kiosk does not belong to your franchise",
          });
        }
        filter.cartId = cartId;
      } else {
        // Get all kiosks under franchise
        const outlets = await User.find({
          role: "admin",
          franchiseId: req.user._id,
          isActive: true,
        }).select("_id");
        filter.cartId = { $in: outlets.map((o) => o._id) };
      }
    } else if (req.user.role === "manager") {
      const managerCartId = await resolveUserCartId(req.user);
      if (!managerCartId) {
        return res.status(403).json({
          success: false,
          message: "No cart associated with manager",
        });
      }
      filter.cartId = managerCartId;
    } else if (req.user.role === "super_admin") {
      // Super admin - can filter by outlet or see all
      if (cartId) {
        filter.cartId = cartId;
      }
      // If no cartId specified, show all transactions
    }

    const transactions = await InventoryTransaction.find(filter)
      .populate("ingredientId", "name uom category storageLocation")
      .populate("recordedBy", "name email")
      .populate("cartId", "name cafeName")
      .sort({ date: -1 })
      .limit(1000); // Pagination can be added later

    res.json({ success: true, data: transactions });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   GET /api/costing-v2/diagnose-consumption
 * @desc    Diagnostic endpoint for zero order consumption - returns order transaction count, sample orders, cart vs Finances menu coverage
 */
exports.diagnoseConsumption = async (req, res) => {
  try {
    const { cartId: queryCartId } = req.query;

    // Resolve target cartId(s) based on role
    let cartIds = [];
    if (req.user.role === "admin") {
      cartIds = [req.user._id];
    } else if (req.user.role === "franchise_admin") {
      if (queryCartId) {
        const outlet = await User.findById(queryCartId);
        if (!outlet || outlet.franchiseId?.toString() !== req.user._id.toString()) {
          return res.status(403).json({ success: false, message: "Outlet not in your franchise" });
        }
        cartIds = [queryCartId];
      } else {
        const outlets = await User.find({ role: "admin", franchiseId: req.user._id, isActive: true }).select("_id");
        cartIds = outlets.map((o) => o._id);
      }
    } else if (req.user.role === "super_admin") {
      if (queryCartId) {
        cartIds = [queryCartId];
      } else {
        const outlets = await User.find({ role: "admin", isActive: true }).select("_id").limit(100);
        cartIds = outlets.map((o) => o._id);
      }
    } else {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    const cartIdObjs = cartIds.map((id) => toObjectIdSafe(id)).filter(Boolean);
    if (cartIdObjs.length === 0) {
      return res.json({
        success: true,
        data: {
          orderTransactionCount: 0,
          orderTransactionsSample: [],
          ordersWithCartId: 0,
          ordersWithoutCartId: 0,
          ordersWithoutCartIdSample: [],
          cartMenuCount: 0,
          financesMenuCount: 0,
          financesMenuWithBom: 0,
          cartItemsMissingInFinances: [],
          message: "No outlets found for this user",
        },
      });
    }

    // Count order transactions for this outlet
    const orderTransactionCount = await InventoryTransaction.countDocuments({
      refType: "order",
      cartId: cartIdObjs.length === 1 ? cartIdObjs[0] : { $in: cartIdObjs },
    });

    const orderTransactionsSample = await InventoryTransaction.find({
      refType: "order",
      cartId: cartIdObjs.length === 1 ? cartIdObjs[0] : { $in: cartIdObjs },
    })
      .select("refId cartId date costAllocated")
      .sort({ date: -1 })
      .limit(5)
      .lean();

    // Sample orders with/without cartId
    const orderFilter = cartIdObjs.length === 1 ? { cartId: cartIdObjs[0] } : { cartId: { $in: cartIdObjs } };
    const ordersWithCartId = await Order.countDocuments(orderFilter);

    // Orders with no cartId (system-wide - potential consumption skip)
    const ordersWithoutCartId = await Order.countDocuments({
      $or: [{ cartId: null }, { cartId: { $exists: false } }],
    });

    const ordersWithoutCartIdSample = await Order.find({
      $or: [{ cartId: null }, { cartId: { $exists: false } }],
    })
      .select("_id status cartId franchiseId createdAt")
      .sort({ createdAt: -1 })
      .limit(5)
      .lean();

    // Cart menu vs Finances (MenuItemV2) coverage - use first cart for simplicity
    const targetCartId = cartIdObjs[0];
    const cartMenuItems = await OperationalMenuItem.find({
      $or: [{ cafeId: targetCartId }, { cartId: targetCartId }],
    })
      .select("name")
      .lean();

    const costingMenuItems = await MenuItem.find({
      $or: [{ cartId: targetCartId }, { cartId: null }],
    })
      .populate("recipeId", "name")
      .select("name defaultMenuItemName recipeId")
      .lean();

    const cartItemsMissingInFinances = cartMenuItems.filter((m) => {
      const n = (m.name || "").trim().toLowerCase();
      return !costingMenuItems.some(
        (c) =>
          (c.name || "").trim().toLowerCase() === n ||
          (c.defaultMenuItemName || "").trim().toLowerCase() === n
      );
    });

    const financesMenuWithBom = costingMenuItems.filter((m) => m.recipeId && m.recipeId._id).length;

    res.json({
      success: true,
      data: {
        orderTransactionCount,
        orderTransactionsSample,
        ordersWithCartId,
        ordersWithoutCartId,
        ordersWithoutCartIdSample,
        cartMenuCount: cartMenuItems.length,
        financesMenuCount: costingMenuItems.length,
        financesMenuWithBom,
        cartItemsMissingInFinances: cartItemsMissingInFinances.map((m) => m.name),
        cartIds: cartIds.map((id) => id.toString()),
      },
    });
  } catch (error) {
    console.error("[DIAGNOSE_CONSUMPTION] Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   GET /api/costing-v2/inventory
 * @desc    Get inventory items from costing-v2 ingredients for mobile app
 */
exports.getCostingInventory = async (req, res) => {
  try {
    // Get cartId - match inventory controller logic for consistency
    let cartId = null;
    if (["waiter", "cook", "captain", "manager"].includes(req.user?.role)) {
      // Mobile users - prioritize cartId, then cafeId (backward compat)
      if (req.user.cartId) {
        cartId = req.user.cartId;
      } else if (req.user.cafeId) {
        cartId = req.user.cafeId;
      } else {
        const employee = await Employee.findOne({
          $or: [
            { email: req.user.email?.toLowerCase() },
            { userId: req.user._id },
          ],
        }).lean();
        cartId = employee?.cartId || employee?.cafeId;
      }

      if (!cartId) {
        return res.status(403).json({
          success: false,
          message: "No cafe associated with this user",
        });
      }
    } else if (req.user.role === "admin") {
      cartId = req.user._id;
    }

    // Build filter for ingredients - match getIngredients: include shared (cartId=null)
    // so mobile sees same items as web costing-v2 Inventory page
    const filter = { isActive: true };
    if (cartId) {
      const cartIdObj = mongoose.Types.ObjectId.isValid(cartId)
        ? new mongoose.Types.ObjectId(cartId)
        : cartId;
      filter.$or = [
        { cartId: cartIdObj },
        { cartId: null },
        { cartId: { $exists: false } },
      ];
    }

    // Apply role-based filtering (includeShared for admin to match getIngredients)
    const shouldSkipOutletFilter =
      (req.user.role === "franchise_admin" ||
        req.user.role === "super_admin") &&
      !cartId;
    const costingFilter = await buildCostingQuery(req.user, filter, {
      skipOutletFilter: shouldSkipOutletFilter,
      includeShared: true,
    });

    // Get ingredients for this cart/cafe/kiosk
    let ingredients = await Ingredient.find(costingFilter)
      .select(
        "name category uom baseUnit qtyOnHand reorderLevel currentCostPerBaseUnit storageLocation updatedAt shelfTimeDays lastReceivedAt expiryDate isActive"
      )
      .sort({ category: 1, name: 1 })
      .lean();

    // CRITICAL: Recalculate qtyOnHand from transactions (match web getIngredients)
    // Web calculates stock from InventoryTransaction; raw Ingredient.qtyOnHand may be 0/stale
    if (cartId && ingredients.length > 0) {
      const cartObjectId = mongoose.Types.ObjectId.isValid(cartId)
        ? new mongoose.Types.ObjectId(cartId)
        : cartId;
      const allCartTransactions = await InventoryTransaction.find({
        cartId: cartObjectId,
      })
        .sort({ date: 1 })
        .lean();

      const ingredientIdSet = new Set(
        ingredients.map((ing) => (ing._id ? ing._id.toString() : null)).filter(Boolean)
      );
      const filteredTxns = allCartTransactions.filter((txn) => {
        if (!txn.ingredientId) return false;
        const id = txn.ingredientId.toString ? txn.ingredientId.toString() : String(txn.ingredientId);
        return ingredientIdSet.has(id);
      });

      const transactionsByIngredient = {};
      for (const txn of filteredTxns) {
        const ingId = txn.ingredientId ? txn.ingredientId.toString() : null;
        if (ingId) {
          if (!transactionsByIngredient[ingId]) transactionsByIngredient[ingId] = [];
          transactionsByIngredient[ingId].push(txn);
        }
      }

      for (const ingredient of ingredients) {
        const ingredientId = ingredient._id ? ingredient._id.toString() : null;
        const transactions = ingredientId ? transactionsByIngredient[ingredientId] || [] : [];

        if (transactions.length === 0) {
          ingredient.qtyOnHand = Number(ingredient.qtyOnHand) || 0;
          ingredient.currentCostPerBaseUnit =
            ingredient.qtyOnHand <= 0 ? 0 : Number(ingredient.currentCostPerBaseUnit) || 0;
          continue;
        }

        let stock = 0;
        let totalQty = 0;
        let totalValue = 0;
        let weightedAvgCost = 0;

        for (const txn of transactions) {
          let qty = Number(txn.qtyInBaseUnit);
          if (!qty || isNaN(qty)) {
            if (txn.qty && txn.uom) {
              try {
                qty = safeConvertToBaseUnit(ingredient, Number(txn.qty), txn.uom);
              } catch {
                qty = Number(txn.qty) || 0;
              }
            } else {
              qty = Number(txn.qty) || 0;
            }
          }

          if (txn.type === "IN" || txn.type === "RETURN") {
            stock += qty;
            let txnCostPerBaseUnit = 0;
            if (txn.unitPrice != null && txn.unitPrice > 0) {
              const cf = safeConvertToBaseUnit(ingredient, 1, txn.uom || ingredient.uom);
              txnCostPerBaseUnit = txn.unitPrice / cf;
            } else if (txn.costAllocated > 0 && qty > 0) {
              txnCostPerBaseUnit = txn.costAllocated / qty;
            }
            if (qty > 0 && txnCostPerBaseUnit > 0) {
              totalValue += qty * txnCostPerBaseUnit;
              totalQty += qty;
              weightedAvgCost = totalQty > 0 ? totalValue / totalQty : 0;
            }
          } else if (txn.type === "OUT" || txn.type === "WASTE") {
            stock -= qty;
            if (totalQty > 0 && weightedAvgCost > 0) {
              totalValue = Math.max(0, totalValue - qty * weightedAvgCost);
            }
            totalQty -= qty;
            if (totalQty < 0) {
              totalQty = 0;
              totalValue = 0;
              weightedAvgCost = 0;
            } else if (totalQty > 0) {
              weightedAvgCost = totalValue / totalQty;
            } else {
              weightedAvgCost = 0;
            }
          }
        }

        stock = Math.max(0, stock);
        if (stock <= 0) weightedAvgCost = 0;
        ingredient.qtyOnHand = Number(stock.toFixed(4));
        ingredient.currentCostPerBaseUnit = Number((weightedAvgCost || 0).toFixed(6));
      }
    }

    // Format ingredients as inventory items for the app (match web costing-v2 Inventory)
    const inventoryItems = ingredients.map((ing) => {
      const qtyOnHand = Number(ing.qtyOnHand) || 0;
      const weightedAvgCost = Number(ing.currentCostPerBaseUnit) || 0;
      const totalValue = qtyOnHand > 0 && weightedAvgCost > 0
        ? qtyOnHand * weightedAvgCost
        : 0;

      const shelfLife = resolveShelfLifeState({
        shelfTimeDays: ing.shelfTimeDays,
        lastReceivedAt: ing.lastReceivedAt,
        expiryDate: ing.expiryDate,
      });

      return {
        _id: ing._id,
        name: ing.name,
        category: ing.category,
        quantity: qtyOnHand,
        qtyOnHand: qtyOnHand,
        unit: ing.uom,
        uom: ing.uom,
        baseUnit:
          ing.baseUnit ||
          (["kg", "g"].includes(ing.uom)
            ? "g"
            : ["l", "ml"].includes(ing.uom)
              ? "ml"
              : "pcs"),
        minStockLevel: ing.reorderLevel || 0,
        reorderLevel: ing.reorderLevel || 0,
        unitPrice: weightedAvgCost,
        currentCostPerBaseUnit: weightedAvgCost,
        totalValue: Number(totalValue.toFixed(2)),
        totalValueDisplay: `₹${Math.round(totalValue)}`,
        shelfLifeDays: shelfLife.shelfDays,
        shelfTimeDays: shelfLife.shelfDays,
        shelfLifeText: shelfLife.shelfLifeText,
        shelfLifeStatus: shelfLife.shelfLifeStatus,
        shelfLifeRemainingMs: shelfLife.remainingMs,
        shelfLifeRemainingMinutes: shelfLife.remainingMinutes,
        shelfLifeDaysRemaining: shelfLife.daysRemaining,
        expiryAt: shelfLife.expiryAt ? shelfLife.expiryAt.toISOString() : null,
        expiryDate: ing.expiryDate || null,
        lastReceivedAt: ing.lastReceivedAt || null,
        location: ing.storageLocation || "Main Storage",
        storageLocation: ing.storageLocation || "Main Storage",
        updatedAt: ing.updatedAt
          ? ing.updatedAt.toISOString()
          : new Date().toISOString(),
        minStock: ing.reorderLevel || 0,
        ingredientId: ing._id,
        cafeId: cartId || ing.cartId,
        isActive: ing.isActive !== false,
      };
    });

    console.log(
      "[COSTING] getCostingInventory - Found items:",
      inventoryItems.length,
      "for cartId:",
      cartId
    );

    res.json({
      success: true,
      data: inventoryItems,
    });
  } catch (error) {
    console.error("[COSTING] Get inventory error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   GET /api/costing-v2/low-stock
 * @desc    Get ingredients below reorder level
 */
exports.getLowStock = async (req, res) => {
  try {
    // Apply role-based filtering
    // For cart admins, only show low stock items from their cart (filter by cartId)
    // For franchise/super admins, can see all low stock items or filter by cartId
    const shouldSkipOutletFilter =
      req.user.role === "franchise_admin" || req.user.role === "super_admin";
    const filter = await buildCostingQuery(
      req.user,
      { isActive: true },
      { skipOutletFilter: shouldSkipOutletFilter }
    );

    // Log filtering for debugging
    if (req.user.role === "admin") {
      console.log(
        "[GET_LOW_STOCK] Cart admin filter - cartId:",
        req.user._id.toString()
      );
    }

    const ingredients = await Ingredient.find(filter);
    const lowStock = ingredients.filter(
      (ing) => ing.qtyOnHand <= ing.reorderLevel
    );

    res.json({ success: true, data: lowStock });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ==================== WASTE ====================

/**
 * @route   POST /api/costing-v2/waste
 * @desc    Record waste
 */
exports.recordWaste = async (req, res) => {
  try {
    const { ingredientId, qty, uom, reason, reasonDetails, cartId } =
      req.body;

    const ingredient = await Ingredient.findById(ingredientId);
    if (!ingredient) {
      return res
        .status(404)
        .json({ success: false, message: "Ingredient not found" });
    }

    // For cart admin, always use their own cartId
    // For franchise admin and super admin, use provided cartId or validate
    let finalOutletId = cartId;
    if (req.user.role === "admin") {
      // Cart admin - always use their own kiosk
      finalOutletId = req.user._id;
    } else if (req.user.role === "manager") {
      // Manager - use their own cart
      finalOutletId = await resolveUserCartId(req.user);
      if (!finalOutletId) {
        return res.status(400).json({
          success: false,
          message: "No cart associated with manager",
        });
      }
    } else if (req.user.role === "franchise_admin") {
      // Franchise admin - must provide cartId
      if (!cartId) {
        return res.status(400).json({
          success: false,
          message: "cartId is required for franchise admin",
        });
      }
      if (!(await validateOutletAccess(req.user, cartId))) {
        return res
          .status(403)
          .json({ success: false, message: "Access denied to this kiosk" });
      }
      finalOutletId = cartId;
    } else if (req.user.role === "super_admin") {
      // Super admin - must provide cartId
      if (!cartId) {
        return res.status(400).json({
          success: false,
          message: "cartId is required for super admin",
        });
      }
      finalOutletId = cartId;
    }

    // Convert to base unit
    const qtyInBaseUnit = safeConvertToBaseUnit(ingredient, qty, uom);

    // Consume using weighted average to get cost
    // Allow negative stock for waste tracking (waste can exceed available stock for accounting purposes)
    const consumeResult = await WeightedAverageService.consume(
      ingredientId,
      qtyInBaseUnit,
      "waste",
      null,
      req.user._id,
      finalOutletId,
      true // allowNegativeStock = true for waste
    );

    // Create inventory transaction for waste
    // This is critical for inventory tracking and cost calculations
    const transaction = new InventoryTransaction({
      ingredientId,
      type: "WASTE",
      qty: qty, // Original quantity
      uom: uom, // Original unit
      qtyInBaseUnit: qtyInBaseUnit, // Quantity in base unit
      refType: "waste",
      refId: null, // Will link to waste record after creation
      date: new Date(),
      costAllocated: consumeResult.costAllocated,
      recordedBy: req.user._id,
      cartId: finalOutletId || null, // Use cartId for consistency
    });
    await transaction.save();

    // Get franchiseId for waste record
    let franchiseId = null;
    if (finalOutletId) {
      const outlet = await User.findById(finalOutletId);
      if (outlet) franchiseId = outlet.franchiseId;
    } else if (req.user.role === "franchise_admin") {
      franchiseId = req.user._id;
    }

    // Create waste record
    const waste = new Waste({
      ingredientId,
      qty: qtyInBaseUnit,
      uom: ingredient.baseUnit,
      reason,
      reasonDetails: reasonDetails || "",
      date: new Date(),
      costAllocated: consumeResult.costAllocated,
      recordedBy: req.user._id,
      cartId: finalOutletId || null, // Use cartId for consistency
    });

    await waste.save();

    // Update transaction with waste record ID
    transaction.refId = waste._id;
    await transaction.save();

    await waste.populate("ingredientId", "name uom");

    res.status(201).json({ success: true, data: waste });
  } catch (error) {
    console.error("[WASTE] Error recording waste:", error);
    res.status(400).json({ success: false, message: error.message });
  }
};

/**
 * @route   GET /api/costing-v2/waste
 * @desc    Get waste records
 */
exports.getWaste = async (req, res) => {
  try {
    const { ingredientId, from, to, cartId } = req.query;
    const filter = {};

    if (ingredientId) filter.ingredientId = ingredientId;
    if (from || to) {
      filter.date = {};
      if (from) filter.date.$gte = new Date(from);
      if (to) filter.date.$lte = new Date(to);
    }

    // Apply role-based filtering for cartId
    if (req.user.role === "admin") {
      // Cart admin - only see their own kiosk's waste records
      filter.cartId = req.user._id;
    } else if (req.user.role === "manager") {
      // Manager - only see their own kiosk's waste records
      const managerCartId = await resolveUserCartId(req.user);
      if (!managerCartId) {
        return res.status(403).json({
          success: false,
          message: "No cart associated with manager",
        });
      }
      filter.cartId = managerCartId;
    } else if (req.user.role === "franchise_admin") {
      // Franchise admin - can filter by specific outlet or see all their franchise outlets
      if (cartId) {
        // Validate outlet belongs to their franchise
        const outlet = await User.findById(cartId);
        if (
          !outlet ||
          outlet.franchiseId?.toString() !== req.user._id.toString()
        ) {
          return res.status(403).json({
            success: false,
            message: "Access denied: Kiosk does not belong to your franchise",
          });
        }
        filter.cartId = cartId;
      } else {
        // Get all kiosks under franchise
        const outlets = await User.find({
          role: "admin",
          franchiseId: req.user._id,
          isActive: true,
        }).select("_id");
        filter.cartId = { $in: outlets.map((o) => o._id) };
      }
    } else if (req.user.role === "super_admin") {
      // Super admin - can filter by outlet or see all
      if (cartId) {
        filter.cartId = cartId;
      }
      // If no cartId specified, show all waste records
    }

    const waste = await Waste.find(filter)
      .populate("ingredientId", "name uom")
      .populate("recordedBy", "name email")
      .populate("cartId", "name cafeName")
      .sort({ date: -1 });

    res.json({ success: true, data: waste });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ==================== RECIPES ====================

/**
 * @route   GET /api/costing-v2/recipes
 * @desc    Get all recipes
 */
exports.getRecipes = async (req, res) => {
  try {
    // #region agent log
    logDebug(
      "costingController.js:1176",
      "getRecipes called",
      { userId: req.user?._id, role: req.user?.role },
      "A"
    );
    // #endregion
    const { isActive, search, cartId } = req.query;
    const filter = {};

    if (isActive !== undefined) filter.isActive = isActive === "true";
    if (search) filter.name = { $regex: search, $options: "i" };
    // Only set cartId from cartId for franchise/super admins, not for cart admins
    // Cart admins should see both their own recipes (cartId = their _id) AND shared recipes (cartId = null)
    if (cartId && req.user.role !== "admin") {
      filter.cartId = cartId;
    }

    // Apply role-based filtering (recipes can be shared or cart-specific)
    // For cart admin: only show recipes for their own cart OR global recipes (cartId: null)
    // For franchise_admin: show recipes for their franchise carts OR global recipes
    // For super_admin: only show global BOMs (cartId: null) unless filtering by specific cartId
    let costingFilter = { ...filter };
    if (req.user.role === "admin") {
      console.log(`[GET_RECIPES] ========================================`);
      console.log(`[GET_RECIPES] CART ADMIN REQUEST - User ID: ${req.user._id}`);
      console.log(`[GET_RECIPES] ========================================`);

      // Cart admin: only their own cart's recipes OR global recipes (cartId: null)
      // Remove cartId from filter if it was set, as we'll use $or instead
      delete costingFilter.cartId;

      const userCartId = req.user._id;
      const userCartIdObj = mongoose.Types.ObjectId.isValid(userCartId)
        ? new mongoose.Types.ObjectId(userCartId)
        : userCartId;

      // Check database state
      const totalInDB = await Recipe.countDocuments({});
      const withCartIdNull = await Recipe.countDocuments({ cartId: null });
      const withCartIdUser = await Recipe.countDocuments({ cartId: userCartIdObj });
      const withNoCartId = await Recipe.countDocuments({ cartId: { $exists: false } });

      console.log(`[GET_RECIPES] ========== DATABASE STATE ==========`);
      console.log(`[GET_RECIPES] Total recipes in DB: ${totalInDB}`);
      console.log(`[GET_RECIPES] Recipes with cartId=null: ${withCartIdNull}`);
      console.log(`[GET_RECIPES] Recipes with cartId=${userCartIdObj}: ${withCartIdUser}`);
      console.log(`[GET_RECIPES] Recipes without cartId field: ${withNoCartId}`);
      console.log(`[GET_RECIPES] =====================================`);

      // Build base query for shared + cart-specific recipes
      // Use $or to get both shared (cartId: null) and cart-specific (cartId: userCartId) recipes
      const baseQuery = {
        $or: [
          { cartId: null },
          { cartId: userCartIdObj },
          { cartId: { $exists: false } }
        ]
      };

      // Apply isActive filter if provided
      if (filter.isActive !== undefined) {
        if (filter.isActive === true) {
          baseQuery.isActive = { $ne: false };
        } else {
          baseQuery.isActive = false;
        }
      }

      // Apply other filters (name/search)
      const otherFilters = {};
      if (filter.name) {
        if (filter.name.$regex) {
          otherFilters.name = filter.name;
        } else {
          otherFilters.name = { $regex: filter.name, $options: "i" };
        }
      }

      // Combine all filters
      if (Object.keys(otherFilters).length > 0) {
        costingFilter = {
          $and: [
            baseQuery,
            otherFilters
          ]
        };
      } else {
        costingFilter = baseQuery;
      }

      console.log(`[GET_RECIPES] Final query:`, JSON.stringify(costingFilter, null, 2));
    } else if (req.user.role === "franchise_admin") {
      // Franchise admin: recipes for their franchise carts OR global recipes
      const franchiseCarts = await User.find({
        role: "admin",
        franchiseId: req.user._id,
        isActive: true,
      }).select("_id");
      const cartIds = franchiseCarts.map((c) => c._id);
      // Remove cartId from filter if it was set, as we'll use $or instead
      delete costingFilter.cartId;
      costingFilter.$or = [
        { cartId: { $in: cartIds } },
        { cartId: null },
        { cartId: { $exists: false } },
      ];
      costingFilter.franchiseId = req.user._id;
    } else if (req.user.role === "super_admin") {
      // Super admin: only global BOMs (cartId: null) unless filtering by specific outlet
      if (!cartId) {
        costingFilter.cartId = null;
      } else {
        costingFilter.cartId = cartId;
      }
    }

    let recipes = await Recipe.find(costingFilter)
      .populate(
        "ingredients.ingredientId",
        "name uom baseUnit currentCostPerBaseUnit"
      )
      .populate("addonId", "name price")
      .populate("cartId", "name cafeName")
      .sort({ name: 1 })
      .lean(); // Use lean() for better performance

    // For Cart Admin, recalculate costs dynamically using their cartId
    // This ensures costs are based on outlet-specific purchases, not cached global values
    if (req.user.role === "admin") {
      console.log(`[GET_RECIPES] ✅ Query executed - Found ${recipes.length} recipes`);

      // Log sample results
      if (recipes.length > 0) {
        const userCartIdObj = mongoose.Types.ObjectId.isValid(req.user._id)
          ? new mongoose.Types.ObjectId(req.user._id)
          : req.user._id;

        console.log(`[GET_RECIPES] Sample recipes:`, recipes.slice(0, 5).map(rec => ({
          name: rec.name,
          cartId: rec.cartId ? (rec.cartId._id || rec.cartId).toString() : 'null',
          isActive: rec.isActive
        })));

        // Count shared vs cart-specific
        const sharedCount = recipes.filter(rec => !rec.cartId || rec.cartId === null).length;
        const cartSpecificCount = recipes.filter(rec => rec.cartId && rec.cartId.toString() === userCartIdObj.toString()).length;
        console.log(`[GET_RECIPES] Breakdown: ${sharedCount} shared + ${cartSpecificCount} cart-specific = ${recipes.length} total`);
      } else {
        console.error(`[GET_RECIPES] ❌ NO RECIPES FOUND!`);
        console.error(`[GET_RECIPES] Check if super admin has created recipes with cartId: null`);
      }

      // #region agent log
      logDebug(
        "costingController.js:1200",
        "Cart Admin - recalculating BOM costs",
        { cartId: req.user._id, recipeCount: recipes.length },
        "A"
      );
      // #endregion

      // Recalculate costs for each recipe
      // Convert lean objects back to Mongoose documents for calculateCost method
      const RecipeModel = Recipe;
      for (let i = 0; i < recipes.length; i++) {
        const recipeData = recipes[i];
        const recipe = new RecipeModel(recipeData);
        try {
          // Recalculate cost using Cart Admin's cartId
          await recipe.calculateCost(req.user._id);
          // Update the recipe data with recalculated costs
          recipes[i].totalCostCached = recipe.totalCostCached;
          recipes[i].costPerPortion = recipe.costPerPortion;
          recipes[i].lastCostUpdate = recipe.lastCostUpdate;
        } catch (calcError) {
          console.warn(
            `[GET_RECIPES] Cost recalculation failed for recipe ${recipe._id} (${recipe.name}): ${calcError.message}`
          );
          // Keep API resilient: return recipe with existing cached cost values.
          recipes[i].totalCostCached = Number(recipeData.totalCostCached || 0);
          recipes[i].costPerPortion = Number(recipeData.costPerPortion || 0);
          recipes[i].lastCostUpdate = recipeData.lastCostUpdate || null;
        }
        // #region agent log
        logDebug(
          "costingController.js:1205",
          "BOM cost recalculated",
          {
            recipeId: recipe._id,
            recipeName: recipe.name,
            totalCost: recipe.totalCostCached,
            costPerPortion: recipe.costPerPortion,
            cartId: req.user._id,
          },
          "A"
        );
        // #endregion
        // Don't save - just recalculate for display (saves are done on explicit recalculate action)
      }

      console.log(`[GET_RECIPES] ================================================`);
    }

    res.json({ success: true, data: recipes });
  } catch (error) {
    // #region agent log
    logDebug(
      "costingController.js:1212",
      "getRecipes error",
      { error: error.message },
      "A"
    );
    // #endregion
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   POST /api/costing-v2/recipes
 * @desc    Create recipe
 */
exports.createRecipe = async (req, res) => {
  try {
    // Set outlet context (recipes can be shared, so cartId is optional)
    const data = await setOutletContext(req.user, { ...req.body }, false);

    // Normalize name to prevent duplicates like "Tea" vs "tea" or extra spaces
    const rawName = typeof data.name === "string" ? data.name : "";
    data.name = rawName.trim().replace(/\s+/g, " ");
    data.nameNormalized = data.name.toLowerCase();
    if (data.addonId === "") data.addonId = null;

    // De-duplicate ingredient lines (same ingredient + same uom)
    if (Array.isArray(data.ingredients)) {
      const merged = new Map();
      for (const ing of data.ingredients) {
        if (!ing || !ing.ingredientId) continue;
        const uom = (ing.uom || "").toString().trim();
        const key = `${ing.ingredientId.toString()}::${uom}`;
        const qty = Number(ing.qty) || 0;
        if (!merged.has(key)) {
          merged.set(key, { ...ing, uom, qty });
        } else {
          const prev = merged.get(key);
          prev.qty = (Number(prev.qty) || 0) + qty;
          merged.set(key, prev);
        }
      }
      data.ingredients = Array.from(merged.values());
    }

    // Check for duplicate BOM name for the same cart before creating
    const existingRecipe = await Recipe.findOne({
      nameNormalized: data.nameNormalized,
      cartId: data.cartId || null,
    });

    if (existingRecipe) {
      const cartInfo = data.cartId ? " for this cart" : " (global BOM)";
      return res.status(400).json({
        success: false,
        message: `A BOM with the name "${data.name}" already exists${cartInfo}. Please use a different name or edit the existing BOM.`,
      });
    }

    const recipe = new Recipe(data);

    // Calculate cost - for Cart Admin, use their cartId to check cart-specific purchases
    const cartIdForCost =
      req.user.role === "admin" ? req.user._id : data.cartId || null;
    await recipe.calculateCost(cartIdForCost);
    await recipe.save();

    await recipe.populate(
      "ingredients.ingredientId",
      "name uom baseUnit currentCostPerBaseUnit"
    );
    await recipe.populate("addonId", "name price");
    await recipe.populate("cartId", "name cafeName");

    // Auto-link menu item if it exists (for cart admin)
    if (req.user.role === "admin" && data.cartId) {
      try {
        // Find menu item with matching name and cartId
        const menuItem = await MenuItem.findOne({
          name: recipe.name.trim(),
          cartId: data.cartId,
        });

        if (menuItem) {
          // Link the recipe to the menu item
          menuItem.recipeId = recipe._id;
          const cartIdForCost = req.user.role === "admin" ? req.user._id : (data.cartId || null);
          await recipe.calculateCost(cartIdForCost);
          await recipe.save();
          menuItem.calculateMetrics(recipe.costPerPortion);
          await menuItem.save();
          console.log(`[CREATE_RECIPE] Auto-linked recipe "${recipe.name}" to menu item ${menuItem._id}`);
        }
      } catch (linkError) {
        console.error("[CREATE_RECIPE] Error auto-linking menu item:", linkError);
        // Don't fail recipe creation if linking fails
      }
    }

    res.status(201).json({ success: true, data: recipe });
  } catch (error) {
    // Handle MongoDB duplicate key error with a user-friendly message
    if (error.code === 11000) {
      const duplicateField = Object.keys(error.keyPattern || {})[0];
      return res.status(400).json({
        success: false,
        message: `A BOM with this name already exists for this outlet. Please use a different name or edit the existing BOM.`,
      });
    }
    res.status(400).json({ success: false, message: error.message });
  }
};

/**
 * @route   PUT /api/costing-v2/recipes/:id
 * @desc    Update recipe
 */
exports.updateRecipe = async (req, res) => {
  try {
    const recipe = await Recipe.findById(req.params.id);
    if (!recipe) {
      return res
        .status(404)
        .json({ success: false, message: "Recipe not found" });
    }

    // Access control: Cart admin can only update their own cart's recipes
    if (req.user.role === "admin") {
      if (recipe.cartId && recipe.cartId.toString() !== req.user._id.toString()) {
        return res.status(403).json({
          success: false,
          message: "Access denied. You can only update recipes belonging to your cart.",
        });
      }
    } else if (req.user.role === "franchise_admin") {
      // Franchise admin can only update recipes from their franchise carts or franchise shared recipes
      if (recipe.cartId) {
        const cart = await User.findById(recipe.cartId);
        if (!cart || cart.franchiseId?.toString() !== req.user._id.toString()) {
          return res.status(403).json({
            success: false,
            message: "Access denied. You can only update recipes belonging to your franchise carts.",
          });
        }
      } else if (recipe.franchiseId && recipe.franchiseId.toString() !== req.user._id.toString()) {
        return res.status(403).json({
          success: false,
          message: "Access denied. You can only update recipes belonging to your franchise.",
        });
      }
    }

    // Prevent changing cartId/franchiseId from the client
    const updateBody = { ...req.body };
    delete updateBody.cartId;
    delete updateBody.franchiseId;

    // Normalize name and set nameNormalized for duplicate prevention
    if (typeof updateBody.name === "string") {
      updateBody.name = updateBody.name.trim().replace(/\s+/g, " ");
      updateBody.nameNormalized = updateBody.name.toLowerCase();

      // If renaming, ensure no duplicate exists for this outlet
      const duplicate = await Recipe.findOne({
        _id: { $ne: recipe._id },
        nameNormalized: updateBody.nameNormalized,
        cartId: recipe.cartId || null,
      });
      if (duplicate) {
        return res.status(400).json({
          success: false,
          message: `A BOM with the name "${updateBody.name}" already exists for this outlet. Please use a different name.`,
        });
      }
    }

    // De-duplicate ingredient lines (same ingredient + same uom)
    if (Array.isArray(updateBody.ingredients)) {
      const merged = new Map();
      for (const ing of updateBody.ingredients) {
        if (!ing || !ing.ingredientId) continue;
        const uom = (ing.uom || "").toString().trim();
        const key = `${ing.ingredientId.toString()}::${uom}`;
        const qty = Number(ing.qty) || 0;
        if (!merged.has(key)) {
          merged.set(key, { ...ing, uom, qty });
        } else {
          const prev = merged.get(key);
          prev.qty = (Number(prev.qty) || 0) + qty;
          merged.set(key, prev);
        }
      }
      updateBody.ingredients = Array.from(merged.values());
    }
    if (updateBody.addonId === "") {
      updateBody.addonId = null;
    }

    Object.assign(recipe, updateBody);

    // Recalculate cost - for Cart Admin, use their cartId to check cart-specific purchases
    const cartIdForCost =
      req.user.role === "admin"
        ? req.user._id
        : recipe.cartId || req.body.cartId || null;
    await recipe.calculateCost(cartIdForCost);
    await recipe.save();

    await recipe.populate(
      "ingredients.ingredientId",
      "name uom baseUnit currentCostPerBaseUnit"
    );
    await recipe.populate("addonId", "name price");

    // Update linked menu items
    await MenuItem.updateMany(
      { recipeId: recipe._id },
      { $set: { lastCostUpdate: new Date() } }
    );

    // Auto-link menu item if it exists and not already linked (for cart admin)
    if (req.user.role === "admin" && recipe.cartId) {
      try {
        // Find menu item with matching name and cartId that doesn't have a recipe linked
        const menuItem = await MenuItem.findOne({
          name: recipe.name.trim(),
          cartId: recipe.cartId,
          $or: [
            { recipeId: null },
            { recipeId: { $exists: false } }
          ]
        });

        if (menuItem) {
          // Link the recipe to the menu item
          menuItem.recipeId = recipe._id;
          menuItem.calculateMetrics(recipe.costPerPortion);
          await menuItem.save();
          console.log(`[UPDATE_RECIPE] Auto-linked recipe "${recipe.name}" to menu item ${menuItem._id}`);
        } else {
          // Check if there's a menu item with matching name that should be linked
          const existingMenuItem = await MenuItem.findOne({
            name: recipe.name.trim(),
            cartId: recipe.cartId,
          });

          if (existingMenuItem && existingMenuItem.recipeId?.toString() !== recipe._id.toString()) {
            // Update the existing menu item to link to this recipe
            existingMenuItem.recipeId = recipe._id;
            existingMenuItem.calculateMetrics(recipe.costPerPortion);
            await existingMenuItem.save();
            console.log(`[UPDATE_RECIPE] Updated menu item ${existingMenuItem._id} to link to recipe "${recipe.name}"`);
          }
        }
      } catch (linkError) {
        console.error("[UPDATE_RECIPE] Error auto-linking menu item:", linkError);
        // Don't fail recipe update if linking fails
      }
    }

    res.json({ success: true, data: recipe });
  } catch (error) {
    // Handle MongoDB duplicate key error with a user-friendly message
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message:
          "A BOM with this name already exists for this outlet. Please use a different name or edit the existing BOM.",
      });
    }
    res.status(400).json({ success: false, message: error.message });
  }
};

/**
 * @route   POST /api/costing-v2/recipes/:id/calculate-cost
 * @desc    Recalculate recipe cost
 */
exports.recalculateRecipeCost = async (req, res) => {
  try {
    const recipe = await Recipe.findById(req.params.id);
    if (!recipe) {
      return res
        .status(404)
        .json({ success: false, message: "Recipe not found" });
    }

    // Recalculate cost - for Cart Admin, use their cartId to check cart-specific purchases
    const cartIdForCost =
      req.user.role === "admin" ? req.user._id : recipe.cartId || null;
    await recipe.calculateCost(cartIdForCost);
    await recipe.save();

    // Update linked menu items
    const menuItems = await MenuItem.find({ recipeId: recipe._id });
    for (const menuItem of menuItems) {
      menuItem.calculateMetrics(recipe.costPerPortion);
      await menuItem.save();
    }

    await recipe.populate(
      "ingredients.ingredientId",
      "name uom baseUnit currentCostPerBaseUnit"
    );
    await recipe.populate("addonId", "name price");

    res.json({ success: true, data: recipe });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

/**
 * @route   DELETE /api/costing-v2/recipes/:id
 * @desc    Delete recipe
 */
exports.deleteRecipe = async (req, res) => {
  try {
    const recipe = await Recipe.findById(req.params.id);
    if (!recipe) {
      return res
        .status(404)
        .json({ success: false, message: "Recipe not found" });
    }

    // Access control: Cart admin can only delete their own cart's recipes
    if (req.user.role === "admin") {
      if (recipe.cartId && recipe.cartId.toString() !== req.user._id.toString()) {
        return res.status(403).json({
          success: false,
          message: "Access denied. You can only delete recipes belonging to your cart.",
        });
      }
    } else if (req.user.role === "franchise_admin") {
      // Franchise admin can only delete recipes from their franchise carts
      if (recipe.cartId) {
        const cart = await User.findById(recipe.cartId);
        if (!cart || cart.franchiseId?.toString() !== req.user._id.toString()) {
          return res.status(403).json({
            success: false,
            message: "Access denied. You can only delete recipes belonging to your franchise carts.",
          });
        }
      } else if (recipe.franchiseId && recipe.franchiseId.toString() !== req.user._id.toString()) {
        return res.status(403).json({
          success: false,
          message: "Access denied. You can only delete recipes belonging to your franchise.",
        });
      }
    }

    // Find all menu items linked to this recipe
    const linkedMenuItems = await MenuItem.find({ recipeId: recipe._id });

    // If there are linked menu items, unlink them (set recipeId to null and reset cost metrics)
    if (linkedMenuItems.length > 0) {
      for (const menuItem of linkedMenuItems) {
        try {
          menuItem.recipeId = null;
          menuItem.costPerPortion = 0;
          menuItem.foodCostPercent = 0;
          menuItem.contributionMargin = menuItem.sellingPrice; // Margin = selling price when no cost
          menuItem.lastCostUpdate = new Date();

          // Ensure cartId is present (required by schema)
          if (!menuItem.cartId) {
            if (recipe.cartId) {
              menuItem.cartId = recipe.cartId;
              console.log(
                `[RECIPE DELETE] Fixed missing cartId for menu item ${menuItem._id} using recipe.cartId`
              );
            } else {
              console.warn(
                `[RECIPE DELETE] Skipping MenuItemV2 update for ${menuItem._id}: missing cartId and recipe has no cartId`
              );
              continue; // Skip saving this invalid item
            }
          }

          await menuItem.save();
        } catch (err) {
          console.error(
            `[RECIPE DELETE] Failed to unlink menu item ${menuItem._id}:`,
            err.message
          );
          // Continue with other items despite error
        }
      }
      console.log(
        `[RECIPE DELETE] Unlinked ${linkedMenuItems.length} menu item(s) from recipe ${recipe.name}`
      );
    }

    // Delete the recipe
    await Recipe.findByIdAndDelete(req.params.id);

    res.json({
      success: true,
      message:
        linkedMenuItems.length > 0
          ? `Recipe deleted successfully. ${linkedMenuItems.length} menu item(s) have been unlinked.`
          : "Recipe deleted successfully",
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ==================== MENU ITEMS ====================

/**
 * @route   GET /api/costing-v2/menu-items
 * @desc    Get all menu items
 */
exports.getMenuItems = async (req, res) => {
  try {
    const { category, isActive, search, cartId } = req.query;
    const filter = {};

    if (category) filter.category = category;
    if (isActive !== undefined) filter.isActive = isActive === "true";
    if (search) filter.name = { $regex: search, $options: "i" };
    if (cartId) filter.cartId = cartId;

    // Apply role-based filtering (menu items are kiosk-specific)
    const costingFilter = await buildCostingQuery(req.user, filter);

    const menuItems = await MenuItem.find(costingFilter)
      .populate("recipeId", "name costPerPortion portions")
      .populate("cartId", "name cafeName")
      .sort({ category: 1, name: 1 });

    res.json({ success: true, data: menuItems });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   POST /api/costing-v2/menu-items
 * @desc    Create menu item
 */
exports.createMenuItem = async (req, res) => {
  try {
    // Convert empty strings to null for optional ObjectId fields
    const menuItemData = { ...req.body };
    if (
      menuItemData.recipeId === "" ||
      menuItemData.recipeId === null ||
      menuItemData.recipeId === undefined
    ) {
      menuItemData.recipeId = null;
    }

    const { recipeId, sellingPrice } = menuItemData;

    // Recipe is optional - if provided, validate it exists
    if (recipeId) {
      const recipe = await Recipe.findById(recipeId);
      if (!recipe) {
        return res
          .status(404)
          .json({ success: false, message: "Recipe not found" });
      }
    }

    // Set outlet context (menu items are kiosk-specific, outletRequired = true)
    // This ensures cartId and franchiseId are properly set
    const data = await setOutletContext(req.user, menuItemData, true);

    const menuItem = new MenuItem(data);

    // Set defaultMenuPath if default menu fields are provided
    if (
      menuItemData.defaultMenuFranchiseId &&
      menuItemData.defaultMenuCategoryName &&
      menuItemData.defaultMenuItemName
    ) {
      menuItem.defaultMenuPath = `${menuItemData.defaultMenuFranchiseId}/${menuItemData.defaultMenuCategoryName}/${menuItemData.defaultMenuItemName}`;
    }

    // Calculate metrics if recipe is provided
    if (recipeId) {
      const recipe = await Recipe.findById(recipeId);
      if (recipe) {
        // IMPORTANT: Recalculate recipe cost with correct cartId before using it
        // This ensures the cost matches the cart's purchase prices
        const cartIdForCost = req.user.role === "admin" ? req.user._id : (data.cartId || null);
        await recipe.calculateCost(cartIdForCost);
        await recipe.save();

        // Now use the recalculated cost for menu item metrics
        menuItem.calculateMetrics(recipe.costPerPortion);
      }
    } else {
      // No recipe - set default values
      menuItem.costPerPortion = 0;
      menuItem.foodCostPercent = 0;
      menuItem.contributionMargin = sellingPrice || 0;
    }

    await menuItem.save();

    await menuItem.populate("recipeId", "name costPerPortion portions");
    await menuItem.populate("cartId", "name cafeName");

    res.status(201).json({ success: true, data: menuItem });
  } catch (error) {
    console.error("[CREATE_MENU_ITEM] Error:", error);
    // Provide more detailed error message
    if (error.message.includes("required")) {
      return res.status(400).json({
        success: false,
        message: `Validation error: ${error.message}. Please ensure all required fields are provided.`
      });
    }
    res.status(400).json({ success: false, message: error.message });
  }
};

/**
 * @route   PUT /api/costing-v2/menu-items/:id
 * @desc    Update menu item
 */
exports.updateMenuItem = async (req, res) => {
  try {
    const menuItem = await MenuItem.findById(req.params.id);
    if (!menuItem) {
      return res
        .status(404)
        .json({ success: false, message: "Menu item not found" });
    }

    // Convert empty strings to null for optional ObjectId fields
    const updateData = { ...req.body };
    if (updateData.recipeId === "" || updateData.recipeId === null) {
      updateData.recipeId = null;
    }

    // Use recipeId from request body if provided, otherwise use existing recipeId
    const recipeIdToUse =
      updateData.recipeId !== undefined
        ? updateData.recipeId
        : menuItem.recipeId;

    // Validate recipe if provided
    if (recipeIdToUse) {
      const recipe = await Recipe.findById(recipeIdToUse);
      if (!recipe) {
        return res
          .status(404)
          .json({ success: false, message: "Recipe not found" });
      }
    }

    Object.assign(menuItem, updateData);

    // Ensure recipeId is set (can be null to unlink)
    menuItem.recipeId = recipeIdToUse || null;

    // Update defaultMenuPath if default menu fields are provided
    if (
      updateData.defaultMenuFranchiseId ||
      updateData.defaultMenuCategoryName ||
      updateData.defaultMenuItemName
    ) {
      const franchiseId =
        updateData.defaultMenuFranchiseId || menuItem.defaultMenuFranchiseId;
      const categoryName =
        updateData.defaultMenuCategoryName || menuItem.defaultMenuCategoryName;
      const itemName =
        updateData.defaultMenuItemName || menuItem.defaultMenuItemName;
      if (franchiseId && categoryName && itemName) {
        menuItem.defaultMenuPath = `${franchiseId}/${categoryName}/${itemName}`;
      }
    }

    // Calculate metrics if recipe is provided
    if (recipeIdToUse) {
      const recipe = await Recipe.findById(recipeIdToUse);
      if (recipe) {
        // IMPORTANT: Recalculate recipe cost with correct cartId before using it
        // This ensures the cost matches the cart's purchase prices
        const cartIdForCost = req.user.role === "admin" ? req.user._id : (menuItem.cartId || null);
        await recipe.calculateCost(cartIdForCost);
        await recipe.save();

        // Now use the recalculated cost for menu item metrics
        menuItem.calculateMetrics(recipe.costPerPortion);
      }
    } else {
      // No recipe - reset cost metrics
      menuItem.costPerPortion = 0;
      menuItem.foodCostPercent = 0;
      menuItem.contributionMargin = menuItem.sellingPrice || 0;
      menuItem.lastCostUpdate = new Date();
    }

    await menuItem.save();

    await menuItem.populate("recipeId", "name costPerPortion portions");

    res.json({ success: true, data: menuItem });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

/**
 * @route   DELETE /api/costing-v2/menu-items/:id
 * @desc    Delete menu item (cart admin only)
 */
exports.deleteMenuItem = async (req, res) => {
  try {
    // Only allow cart admin (admin role) to delete menu items
    if (req.user.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "Access denied. Only cart admin can delete menu items.",
      });
    }

    const menuItem = await MenuItem.findById(req.params.id);
    if (!menuItem) {
      return res
        .status(404)
        .json({ success: false, message: "Menu item not found" });
    }

    // Verify that the menu item belongs to the cart admin's outlet
    if (
      menuItem.cartId &&
      menuItem.cartId.toString() !== req.user._id.toString()
    ) {
      return res.status(403).json({
        success: false,
        message: "Access denied. You can only delete your own menu items.",
      });
    }

    await MenuItem.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: "Menu item deleted successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   GET /api/costing-v2/default-menu-items
 * @desc    Get default menu items for selection/import
 *          - Super admin: gets global default menu
 *          - Franchise admin: gets their franchise default menu
 *          - Cart admin: gets their cart menu items
 */
exports.getDefaultMenuItems = async (req, res) => {
  try {
    // For cart admin, get menu items from their operational menu (MenuItem with cafeId)
    if (req.user.role === "admin") {
      const userId = req.user._id;
      const userIdStr = userId.toString();

      // Cart admins use MenuItem model with cartId = their _id
      // Get menu items for this cart admin
      const operationalMenuItems = await OperationalMenuItem.find({
        $or: [
          { cartId: userId }, // New field name
          { cafeId: userId }  // Backward compatibility
        ]
      })
        .populate("category", "name")
        .sort({ sortOrder: 1, name: 1 })
        .lean();

      console.log(
        `[getDefaultMenuItems] Found ${operationalMenuItems.length} operational menu items for cart admin ${userId}`
      );

      // Get all categories for this cart admin to map IDs to names
      const categories = await MenuCategory.find({
        $or: [
          { cartId: userId }, // New field name
          { cafeId: userId }  // Backward compatibility
        ]
      })
        .select("_id name")
        .lean();
      const categoryMap = new Map();
      categories.forEach((cat) => {
        categoryMap.set(cat._id.toString(), cat.name);
      });

      // Format menu items to match default menu item structure
      const menuItems = operationalMenuItems.map((item) => {
        // Handle category - it might be populated (object) or just an ID
        let categoryName = "Uncategorized";
        if (item.category) {
          if (typeof item.category === "object" && item.category.name) {
            categoryName = item.category.name;
          } else {
            // Category is just an ID, look it up in the map
            const categoryId = item.category.toString();
            categoryName = categoryMap.get(categoryId) || categoryId;
          }
        }

        return {
          name: item.name,
          category: categoryName,
          price: item.price,
          description: item.description || "",
          image: item.image || "",
          franchiseId: req.user.franchiseId || null,
          defaultMenuPath: `cart/${userIdStr}/${categoryName}/${item.name}`,
        };
      });

      return res.json({ success: true, data: menuItems });
    }

    // For super admin and franchise admin, get from default menu
    // Get franchise ID based on user role
    let franchiseId = null;
    if (req.user.role === "franchise_admin") {
      franchiseId = req.user._id;
    } else if (req.user.role === "super_admin") {
      // Super admin can access global menu (franchiseId = null) or specific franchise menu
      franchiseId = req.query.franchiseId || null;
    } else if (req.query.franchiseId) {
      franchiseId = req.query.franchiseId;
    }

    const defaultMenu = await DefaultMenu.getDefaultMenu(franchiseId);

    if (!defaultMenu || !defaultMenu.categories) {
      return res.json({ success: true, data: [] });
    }

    // Flatten menu items with their category info
    const menuItems = [];
    defaultMenu.categories.forEach((category) => {
      if (category.items && category.items.length > 0) {
        category.items.forEach((item) => {
          const franchiseIdStr = franchiseId
            ? franchiseId.toString()
            : "global";
          menuItems.push({
            name: item.name,
            category: category.name,
            price: item.price,
            description: item.description || "",
            image: item.image || "",
            franchiseId: franchiseId,
            defaultMenuPath: `${franchiseIdStr}/${category.name}/${item.name}`,
          });
        });
      }
    });

    res.json({ success: true, data: menuItems });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   POST /api/costing-v2/menu-items/import-from-default
 * @desc    Import menu items from default menu to costing
 */
exports.importFromDefaultMenu = async (req, res) => {
  try {
    const { items, recipeId, cartId } = req.body; // items: array of {name, category, franchiseId}

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "Items array is required" });
    }

    // Set outlet context
    const outletData = await setOutletContext(req.user, { cartId });

    // Get default menu to fetch prices
    const franchiseId = items[0]?.franchiseId || null;
    const defaultMenu = await DefaultMenu.getDefaultMenu(franchiseId);

    const importedItems = [];
    const errors = [];

    for (const item of items) {
      try {
        // Find the item in default menu to get price
        let sellingPrice = item.price || 0;
        if (defaultMenu && defaultMenu.categories) {
          const category = defaultMenu.categories.find(
            (c) => c.name === item.category
          );
          if (category && category.items) {
            const defaultItem = category.items.find(
              (i) => i.name === item.name
            );
            if (defaultItem && defaultItem.price) {
              sellingPrice = defaultItem.price;
            }
          }
        }

        // Check if menu item already exists
        const existingItem = await MenuItem.findOne(
          recipeId
            ? {
              name: item.name,
              category: item.category,
              cartId: outletData.cartId,
              defaultMenuPath: item.defaultMenuPath,
            }
            : {
              name: item.name,
              category: item.category,
              cartId: outletData.cartId,
            }
        );

        if (existingItem) {
          errors.push({ item: item.name, error: "Already exists" });
          continue;
        }

        // Create new menu item
        // #region agent log
        fetch(
          "http://127.0.0.1:7242/ingest/660a5fbf-4359-420f-956f-3831103456fb",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sessionId: "debug-session",
              runId: "import-menu-pre",
              hypothesisId: "H1",
              location: "costingController.js:1680",
              message: "About to create menu item from default",
              data: {
                userRole: req.user.role,
                cartId: outletData.cartId,
                franchiseId: outletData.franchiseId,
                itemName: item.name,
                itemCategory: item.category,
                recipeId: recipeId || null,
              },
              timestamp: Date.now(),
            }),
          }
        ).catch(() => { });
        // #endregion agent log

        const menuItemData = {
          name: item.name,
          category: item.category,
          sellingPrice,
          cartId: outletData.cartId,
          franchiseId: outletData.franchiseId,
          defaultMenuFranchiseId: item.franchiseId || null,
          defaultMenuCategoryName: item.category,
          defaultMenuItemName: item.name,
          defaultMenuPath: item.defaultMenuPath,
        };

        if (recipeId) {
          menuItemData.recipeId = recipeId;
        }

        const menuItem = new MenuItem(menuItemData);

        // If a recipe is provided, use its costPerPortion for metrics.
        if (recipeId) {
          const recipe = await Recipe.findById(recipeId);
          if (recipe) {
            menuItem.calculateMetrics(recipe.costPerPortion);
          }
        }

        await menuItem.save();

        importedItems.push(menuItem);
      } catch (error) {
        errors.push({ item: item.name, error: error.message });
      }
    }

    res.json({
      success: true,
      data: {
        imported: importedItems.length,
        errors: errors.length,
        items: importedItems,
        errorDetails: errors,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   GET /api/costing-v2/outlets
 * @desc    Get available outlets/kiosks for the user
 */
exports.getOutlets = async (req, res) => {
  try {
    const outlets = await getAllowedOutlets(req.user);
    const outletDetails = await User.find({ _id: { $in: outlets } })
      .select("_id name cafeName email cartCode")
      .sort({ name: 1 });

    res.json({ success: true, data: outletDetails });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   GET /api/costing-v2/hierarchical-costing
 * @desc    Get hierarchical costing data (Franchise -> Kiosks) for super admin
 *          For franchise admin, returns their kiosks only
 */
exports.getHierarchicalCosting = async (req, res) => {
  try {
    // Super admin sees all franchises, franchise admin sees only their kiosks
    if (
      req.user.role !== "super_admin" &&
      req.user.role !== "franchise_admin"
    ) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    const { from, to, fromDate, toDate, error: dateRangeError } =
      resolveDateRangeFromQuery(req.query);
    if (dateRangeError) {
      return res.status(400).json({ success: false, message: dateRangeError });
    }

    let franchises = [];
    let kiosks = [];

    if (req.user.role === "super_admin") {
      // Super admin - get all franchises
      franchises = await User.find({ role: "franchise_admin", isActive: true })
        .select("_id name email franchiseCode")
        .sort({ name: 1 })
        .lean();

      // Get all kiosks
      kiosks = await User.find({ role: "admin", isActive: true })
        .select("_id name cafeName email franchiseId cartCode")
        .populate("franchiseId", "name")
        .sort({ cafeName: 1 })
        .lean();
    } else if (req.user.role === "franchise_admin") {
      // Franchise admin - only their own franchise
      const franchise = await User.findById(req.user._id)
        .select("_id name email franchiseCode")
        .lean();
      if (franchise) {
        franchises = [franchise];
      }

      // Get only kiosks under their franchise
      kiosks = await User.find({
        role: "admin",
        franchiseId: req.user._id,
        isActive: true,
      })
        .select("_id name cafeName email franchiseId cartCode")
        .populate("franchiseId", "name")
        .sort({ cafeName: 1 })
        .lean();
    }

    const hierarchicalData = [];

    for (const franchise of franchises) {
      const franchiseKiosks = kiosks.filter(
        (k) =>
          k.franchiseId &&
          k.franchiseId._id.toString() === franchise._id.toString()
      );

      const franchiseData = {
        franchiseId: franchise._id,
        franchiseName: franchise.name,
        franchiseCode: franchise.franchiseCode || "",
        kiosks: [],
        totals: {
          sales: 0,
          foodCost: 0,
          labourCost: 0,
          overheadCost: 0,
          expenseCost: 0,
          totalCost: 0,
          profit: 0,
          foodCostPercent: 0,
          profitMargin: 0,
        },
      };

      for (const kiosk of franchiseKiosks) {
        // Get P&L for this kiosk
        // Get food cost from inventory transactions
        // Use date field for transactions, ensure proper date filtering
        const transactionDateFilter = {};
        if (fromDate || toDate) {
          transactionDateFilter.date = {};
          if (fromDate) transactionDateFilter.date.$gte = fromDate;
          if (toDate) transactionDateFilter.date.$lte = toDate;
        }
        const kioskCartIdObj = toObjectIdSafe(kiosk._id) || kiosk._id;
        const kioskCartIdFilter = buildFlexibleCartIdFilter(kiosk._id);
        const consumptionTransactions = await InventoryTransaction.aggregate([
          {
            $match: {
              type: { $in: ["OUT", "WASTE"] },
              ...(kioskCartIdFilter ? { cartId: kioskCartIdFilter } : {}),
              ...transactionDateFilter,
            },
          },
          {
            $group: {
              _id: null,
              totalCost: { $sum: { $ifNull: ["$costAllocated", 0] } },
            },
          },
        ]);
        const foodCost = Number(
          (consumptionTransactions[0]?.totalCost || 0).toFixed(2)
        );

        // Get labour costs - filter by date range properly
        const labourFilter = { cartId: kioskCartIdObj };
        if (fromDate || toDate) {
          labourFilter.$or = [
            {
              periodFrom: { $lte: toDate || new Date("2099-12-31T23:59:59.999Z") },
              periodTo: { $gte: fromDate || new Date("1970-01-01T00:00:00.000Z") },
            },
          ];
        }
        const labourCosts = await LabourCost.find(labourFilter).lean();
        const labourCost = sumProratedPeriodAmount(labourCosts, fromDate, toDate);

        // Get overheads - same filter as labour
        const overheadFilter = { ...labourFilter };
        const overheads = await Overhead.find(overheadFilter).lean();
        const overheadCost = sumProratedPeriodAmount(overheads, fromDate, toDate);

        // Get expenses for this kiosk in the date range
        const expenseFilter = { cartId: kioskCartIdObj };
        if (fromDate || toDate) {
          expenseFilter.expenseDate = {};
          if (fromDate) expenseFilter.expenseDate.$gte = fromDate;
          if (toDate) expenseFilter.expenseDate.$lte = toDate;
        }
        const expenses = await CostingExpense.find(expenseFilter).lean();
        const expenseCost = Number(
          expenses
            .reduce((sum, e) => sum + (Number(e.amount) || 0), 0)
            .toFixed(2)
        );

        // Get sales from orders (use cartId, not cafeId)
        // Include "Exit" status for takeaway orders that are completed
        const orderFilter = buildSalesRecognizedOrderClause();
        if (kioskCartIdFilter) {
          orderFilter.cartId = kioskCartIdFilter;
        }
        if (fromDate || toDate) {
          orderFilter.createdAt = {};
          if (fromDate) orderFilter.createdAt.$gte = fromDate;
          if (toDate) orderFilter.createdAt.$lte = toDate;
        }
        // Use aggregation for accurate sales calculation
        const salesData = await Order.aggregate([
          { $match: orderFilter },
          {
            $unwind: {
              path: "$kotLines",
              preserveNullAndEmptyArrays: false, // Only include orders with kotLines
            },
          },
          {
            $group: {
              _id: null,
              totalSales: { $sum: { $ifNull: ["$kotLines.totalAmount", 0] } },
            },
          },
        ]);
        const sales = salesData[0]?.totalSales || 0;

        // Calculate totals with proper precision
        const totalCost = Number(
          (foodCost + labourCost + overheadCost + expenseCost).toFixed(2)
        );
        const profit = Number((sales - totalCost).toFixed(2));
        const foodCostPercent =
          sales > 0 ? Number(((foodCost / sales) * 100).toFixed(2)) : 0;
        const profitMargin =
          sales > 0 ? Number(((profit / sales) * 100).toFixed(2)) : 0;

        const kioskData = {
          kioskId: kiosk._id,
          kioskName: kiosk.cafeName || kiosk.name,
          kioskCode: kiosk.cartCode || kiosk._id.toString().slice(-8), // Use cartCode, fallback to last 8 chars of ID
          sales: Number(sales.toFixed(2)),
          foodCost: Number(foodCost.toFixed(2)),
          labourCost: Number(labourCost.toFixed(2)),
          overheadCost: Number(overheadCost.toFixed(2)),
          expenseCost: Number(expenseCost.toFixed(2)),
          totalCost: Number(totalCost.toFixed(2)),
          profit: Number(profit.toFixed(2)),
          foodCostPercent: Number(foodCostPercent.toFixed(2)),
          profitMargin: Number(profitMargin.toFixed(2)),
        };

        franchiseData.kiosks.push(kioskData);

        // Aggregate franchise totals with proper precision
        franchiseData.totals.sales = Number(
          (franchiseData.totals.sales + sales).toFixed(2)
        );
        franchiseData.totals.foodCost = Number(
          (franchiseData.totals.foodCost + foodCost).toFixed(2)
        );
        franchiseData.totals.labourCost = Number(
          (franchiseData.totals.labourCost + labourCost).toFixed(2)
        );
        franchiseData.totals.overheadCost = Number(
          (franchiseData.totals.overheadCost + overheadCost).toFixed(2)
        );
        franchiseData.totals.expenseCost = Number(
          ((franchiseData.totals.expenseCost || 0) + expenseCost).toFixed(2)
        );
        franchiseData.totals.totalCost = Number(
          (franchiseData.totals.totalCost + totalCost).toFixed(2)
        );
        franchiseData.totals.profit = Number(
          (franchiseData.totals.profit + profit).toFixed(2)
        );
      }

      // Calculate franchise-level percentages with proper precision
      if (franchiseData.totals.sales > 0) {
        franchiseData.totals.foodCostPercent = Number(
          (
            (franchiseData.totals.foodCost / franchiseData.totals.sales) *
            100
          ).toFixed(2)
        );
        franchiseData.totals.profitMargin = Number(
          (
            (franchiseData.totals.profit / franchiseData.totals.sales) *
            100
          ).toFixed(2)
        );
      }

      hierarchicalData.push(franchiseData);
    }

    // Calculate grand totals with proper precision
    const grandTotals = hierarchicalData.reduce(
      (acc, franchise) => ({
        sales: Number((acc.sales + franchise.totals.sales).toFixed(2)),
        foodCost: Number((acc.foodCost + franchise.totals.foodCost).toFixed(2)),
        labourCost: Number(
          (acc.labourCost + franchise.totals.labourCost).toFixed(2)
        ),
        overheadCost: Number(
          (acc.overheadCost + franchise.totals.overheadCost).toFixed(2)
        ),
        expenseCost: Number(
          (
            (acc.expenseCost || 0) + (franchise.totals.expenseCost || 0)
          ).toFixed(2)
        ),
        totalCost: Number(
          (acc.totalCost + franchise.totals.totalCost).toFixed(2)
        ),
        profit: Number((acc.profit + franchise.totals.profit).toFixed(2)),
      }),
      {
        sales: 0,
        foodCost: 0,
        labourCost: 0,
        overheadCost: 0,
        expenseCost: 0,
        totalCost: 0,
        profit: 0,
      }
    );

    if (grandTotals.sales > 0) {
      grandTotals.foodCostPercent = Number(
        ((grandTotals.foodCost / grandTotals.sales) * 100).toFixed(2)
      );
      grandTotals.profitMargin = Number(
        ((grandTotals.profit / grandTotals.sales) * 100).toFixed(2)
      );
    }

    res.json({
      success: true,
      data: {
        franchises: hierarchicalData,
        grandTotals,
        period: {
          from: from || null,
          to: to || null,
        },
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ==================== LABOUR & OVERHEAD ====================

/**
 * @route   GET /api/costing-v2/labour-costs
 * @desc    Get labour costs
 */
exports.getLabourCosts = async (req, res) => {
  try {
    const { from, to, cartId } = req.query;
    const filter = {};

    if (cartId) filter.cartId = cartId;
    if (from || to) {
      filter.$or = [
        {
          periodFrom: { $lte: new Date(to || "2099-12-31") },
          periodTo: { $gte: new Date(from || "1970-01-01") },
        },
      ];
    }

    // Apply role-based filtering
    const costingFilter = await buildCostingQuery(req.user, filter);

    const costs = await LabourCost.find(costingFilter)
      .populate("createdBy", "name email")
      .populate("cartId", "name cafeName")
      .sort({ periodFrom: -1 });

    res.json({ success: true, data: costs });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   POST /api/costing-v2/labour-costs
 * @desc    Create labour cost
 */
exports.createLabourCost = async (req, res) => {
  try {
    // Set outlet context
    const data = await setOutletContext(req.user, {
      ...req.body,
      createdBy: req.user._id,
    });
    const labourCost = new LabourCost(data);
    await labourCost.save();
    await labourCost.populate("cartId", "name cafeName");
    res.status(201).json({ success: true, data: labourCost });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

/**
 * @route   GET /api/costing-v2/overheads
 * @desc    Get overheads
 */
exports.getOverheads = async (req, res) => {
  try {
    const { from, to, cartId, category } = req.query;
    const filter = {};

    if (cartId) filter.cartId = cartId;
    if (category) filter.category = category;
    if (from || to) {
      filter.$or = [
        {
          periodFrom: { $lte: new Date(to || "2099-12-31") },
          periodTo: { $gte: new Date(from || "1970-01-01") },
        },
      ];
    }

    // Apply role-based filtering
    const costingFilter = await buildCostingQuery(req.user, filter);

    const overheads = await Overhead.find(costingFilter)
      .populate("createdBy", "name email")
      .populate("cartId", "name cafeName")
      .sort({ periodFrom: -1 });

    res.json({ success: true, data: overheads });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   POST /api/costing-v2/overheads
 * @desc    Create overhead
 */
exports.createOverhead = async (req, res) => {
  try {
    // Set outlet context
    const data = await setOutletContext(req.user, {
      ...req.body,
      createdBy: req.user._id,
    });
    const overhead = new Overhead(data);
    await overhead.save();
    await overhead.populate("cartId", "name cafeName");
    res.status(201).json({ success: true, data: overhead });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// ==================== REPORTS ====================

/**
 * @route   GET /api/costing-v2/reports/food-cost
 * @desc    Food Cost Report
 */
exports.getFoodCostReport = async (req, res) => {
  try {
    const { cartId } = req.query;
    const { from, to, fromDate, toDate, error: dateRangeError } =
      resolveDateRangeFromQuery(req.query);
    if (dateRangeError) {
      return res.status(400).json({ success: false, message: dateRangeError });
    }

    // Log user info for debugging
    console.log("[FOOD_COST_REPORT] User:", {
      userId: req.user._id,
      role: req.user.role,
      email: req.user.email,
      name: req.user.name,
    });

    // Build date filter for transactions (use date field, not createdAt)
    const transactionDateFilter = {};
    if (fromDate || toDate) {
      transactionDateFilter.date = {};
      if (fromDate) transactionDateFilter.date.$gte = fromDate;
      if (toDate) transactionDateFilter.date.$lte = toDate;
    }

    // Build outlet filter based on role (match both ObjectId and string cartId for type consistency)
    let transactionOutletFilter = {};

    if (req.user.role === "admin") {
      transactionOutletFilter.cartId = buildFlexibleCartIdFilter(req.user._id);
      console.log(
        "[FOOD_COST_REPORT] Cart admin filter - cartId:",
        transactionOutletFilter.cartId?.toString?.() || JSON.stringify(transactionOutletFilter.cartId)
      );
    } else if (req.user.role === "franchise_admin") {
      if (cartId) {
        const outlet = await User.findById(cartId);
        if (
          !outlet ||
          outlet.franchiseId?.toString() !== req.user._id.toString()
        ) {
          return res.status(403).json({
            success: false,
            message: "Access denied: Kiosk does not belong to your franchise",
          });
        }
        transactionOutletFilter.cartId = buildFlexibleCartIdFilter(cartId);
      } else {
        const outlets = await User.find({
          role: "admin",
          franchiseId: req.user._id,
          isActive: true,
        }).select("_id");
        transactionOutletFilter.cartId = {
          $in: flattenCartIdFilterValues(outlets.map((o) => o._id)),
        };
      }
    } else if (req.user.role === "super_admin") {
      if (cartId) {
        transactionOutletFilter.cartId = buildFlexibleCartIdFilter(cartId);
      }
    }

    // Get total food cost (from consumption transactions - InventoryTransactionV2 OUT/WASTE)
    const consumptionTransactions = await InventoryTransaction.aggregate([
      {
        $match: {
          type: { $in: ["OUT", "WASTE"] },
          ...transactionDateFilter,
          ...transactionOutletFilter,
        },
      },
      {
        $group: {
          _id: null,
          totalFoodCost: { $sum: "$costAllocated" },
        },
      },
    ]);

    // Get total sales (from orders - calculate from kotLines)
    const orderFilter = {};
    if (fromDate || toDate) {
      orderFilter.createdAt = {};
      if (fromDate) orderFilter.createdAt.$gte = fromDate;
      if (toDate) orderFilter.createdAt.$lte = toDate;
    }
    // Build order filter based on role (support both ObjectId and string cartId values)
    if (req.user.role === "admin") {
      orderFilter.cartId = buildFlexibleCartIdFilter(req.user._id);
    } else if (req.user.role === "franchise_admin") {
      if (cartId) {
        orderFilter.cartId = buildFlexibleCartIdFilter(cartId);
      } else {
        const outlets = await User.find({
          role: "admin",
          franchiseId: req.user._id,
          isActive: true,
        }).select("_id");
        orderFilter.cartId = {
          $in: flattenCartIdFilterValues(outlets.map((o) => o._id)),
        };
      }
    } else if (req.user.role === "super_admin") {
      if (cartId) {
        orderFilter.cartId = buildFlexibleCartIdFilter(cartId);
      }
    }

    // Include canonical PAID lifecycle + legacy paid/completed statuses for compatibility.
    Object.assign(orderFilter, buildSalesRecognizedOrderClause());

    // Calculate sales from kotLines (orders don't have top-level totalAmount)
    const salesData = await Order.aggregate([
      { $match: orderFilter },
      {
        $unwind: {
          path: "$kotLines",
          preserveNullAndEmptyArrays: false, // Only include orders with kotLines
        },
      },
      {
        $group: {
          _id: null,
          totalSales: { $sum: { $ifNull: ["$kotLines.totalAmount", 0] } },
        },
      },
    ]);

    const totalSales = Number((salesData[0]?.totalSales || 0).toFixed(2));
    const totalFoodCost = Number(
      (consumptionTransactions[0]?.totalFoodCost || 0).toFixed(2)
    );
    const matchCount = await InventoryTransaction.countDocuments({
      type: { $in: ["OUT", "WASTE"] },
      ...transactionDateFilter,
      ...transactionOutletFilter,
    });
    console.log(
      "[FOOD_COST_REPORT] Total sales:",
      totalSales,
      "Total food cost:",
      totalFoodCost,
      "Consumption transactions matched:",
      matchCount,
      "Order filter (cartId only):",
      orderFilter.cartId ? "set" : "all"
    );
    const zeroCostCount = await InventoryTransaction.countDocuments({
      type: { $in: ["OUT", "WASTE"] },
      costAllocated: 0,
      ...transactionDateFilter,
      ...transactionOutletFilter,
    });

    const foodCostPercent =
      totalSales > 0
        ? Number(((totalFoodCost / totalSales) * 100).toFixed(2))
        : 0;

    res.json({
      success: true,
      data: {
        totalFoodCost,
        totalSales,
        foodCostPercent:
          totalSales > 0
            ? Number(((totalFoodCost / totalSales) * 100).toFixed(2))
            : 0,
        period: {
          from: from || null,
          to: to || null,
        },
        meta: {
          transactionCount: matchCount, // Exposed for debugging "Zero Food Cost" issues
          zeroCostCount, // Start warning if most transactions have 0 cost
        }
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   GET /api/costing-v2/reports/menu-engineering
 * @desc    Menu Engineering Report
 */
exports.getMenuEngineeringReport = async (req, res) => {
  try {
    const { from, to, limit = 50, cartId } = req.query;
    const orderFilter = {};

    if (from || to) {
      orderFilter.createdAt = {};
      if (from) orderFilter.createdAt.$gte = new Date(from);
      if (to) orderFilter.createdAt.$lte = new Date(to);
    }
    Object.assign(orderFilter, buildSalesRecognizedOrderClause());

    // Build order filter based on role
    if (req.user.role === "admin") {
      // Cart admin - only their own kiosk (use cartId)
      orderFilter.cartId = req.user._id;
    } else if (req.user.role === "franchise_admin") {
      // Franchise admin - specific outlet or all their franchise outlets
      if (cartId) {
        orderFilter.cartId = cartId;
      } else {
        const outlets = await User.find({
          role: "admin",
          franchiseId: req.user._id,
          isActive: true,
        }).select("_id");
        const cartIds = outlets.map((o) => o._id);
        orderFilter.cartId = { $in: cartIds };
      }
    } else if (req.user.role === "super_admin") {
      // Super admin - specific outlet or all
      if (cartId) {
        orderFilter.cartId = cartId;
      }
    }

    // Build menu item filter based on role
    const menuItemFilter = { isActive: true };
    if (req.user.role === "admin") {
      // Cart admin - only their own kiosk's menu items
      menuItemFilter.cartId = req.user._id;
      console.log(
        "[MENU_ENGINEERING_REPORT] Cart admin filter - cartId:",
        req.user._id.toString()
      );
    } else if (req.user.role === "franchise_admin") {
      // Franchise admin - specific outlet or all their franchise outlets
      if (cartId) {
        const outlet = await User.findById(cartId);
        if (
          !outlet ||
          outlet.franchiseId?.toString() !== req.user._id.toString()
        ) {
          return res.status(403).json({
            success: false,
            message: "Access denied: Kiosk does not belong to your franchise",
          });
        }
        menuItemFilter.cartId = cartId;
      } else {
        const outlets = await User.find({
          role: "admin",
          franchiseId: req.user._id,
          isActive: true,
        }).select("_id");
        menuItemFilter.cartId = { $in: outlets.map((o) => o._id) };
      }
    } else if (req.user.role === "super_admin") {
      // Super admin - specific outlet or all
      if (cartId) {
        menuItemFilter.cartId = cartId;
      }
    }

    // Get menu items with sales data
    const menuItems = await MenuItem.find(menuItemFilter).populate(
      "recipeId",
      "name costPerPortion"
    );

    const menuEngineeringData = [];

    for (const menuItem of menuItems) {
      // Calculate revenue and quantity from kotLines.items
      const revenueData = await Order.aggregate([
        {
          $match: orderFilter,
        },
        {
          $unwind: "$kotLines",
        },
        {
          $unwind: "$kotLines.items",
        },
        {
          $match: {
            "kotLines.items.name": menuItem.name,
            "kotLines.items.returned": { $ne: true }, // Exclude returned items
          },
        },
        {
          $group: {
            _id: null,
            revenue: {
              $sum: {
                $multiply: [
                  "$kotLines.items.quantity",
                  "$kotLines.items.price",
                ],
              },
            },
            quantity: { $sum: "$kotLines.items.quantity" },
            orderCount: { $addToSet: "$_id" }, // Count unique orders
          },
        },
      ]);

      const revenue = revenueData[0]?.revenue || 0;
      const quantity = revenueData[0]?.quantity || 0;
      const salesCount = revenueData[0]?.orderCount?.length || 0; // Number of unique orders
      const cost = menuItem.costPerPortion * quantity;
      const margin = revenue - cost;
      const marginPercent = revenue > 0 ? (margin / revenue) * 100 : 0;

      menuEngineeringData.push({
        menuItemId: menuItem._id,
        name: menuItem.name,
        category: menuItem.category,
        sellingPrice: menuItem.sellingPrice,
        costPerPortion: menuItem.costPerPortion,
        quantitySold: quantity,
        revenue,
        cost,
        margin,
        marginPercent: Number(marginPercent.toFixed(2)),
        popularity: salesCount, // Number of orders containing this item
      });
    }

    // Sort by popularity (descending) and limit
    menuEngineeringData.sort((a, b) => b.popularity - a.popularity);
    const limited = menuEngineeringData.slice(0, parseInt(limit));

    res.json({ success: true, data: limited });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   GET /api/costing-v2/reports/supplier-price-history
 * @desc    Supplier Price History Report
 */
exports.getSupplierPriceHistory = async (req, res) => {
  try {
    const { supplierId, ingredientId, cartId } = req.query;
    const filter = { status: "received" };

    if (supplierId) filter.supplierId = supplierId;

    // Apply role-based outlet filtering
    if (req.user.role === "admin") {
      // Cart admin - only their own kiosk
      filter.cartId = req.user._id;
      console.log(
        "[SUPPLIER_PRICE_HISTORY] Cart admin filter - cartId:",
        req.user._id.toString()
      );
    } else if (req.user.role === "franchise_admin") {
      // Franchise admin - specific outlet or all their franchise outlets
      if (cartId) {
        const outlet = await User.findById(cartId);
        if (
          !outlet ||
          outlet.franchiseId?.toString() !== req.user._id.toString()
        ) {
          return res.status(403).json({
            success: false,
            message: "Access denied: Kiosk does not belong to your franchise",
          });
        }
        filter.cartId = cartId;
      } else {
        const outlets = await User.find({
          role: "admin",
          franchiseId: req.user._id,
          isActive: true,
        }).select("_id");
        filter.cartId = { $in: outlets.map((o) => o._id) };
      }
    } else if (req.user.role === "super_admin") {
      // Super admin - specific outlet or all
      if (cartId) {
        filter.cartId = cartId;
      }
    }

    const purchases = await Purchase.find(filter)
      .populate("supplierId", "name")
      .populate("items.ingredientId", "name uom")
      .sort({ date: -1 });

    const priceHistory = [];

    for (const purchase of purchases) {
      // Skip legacy or incomplete records without a supplier
      if (!purchase.supplierId) {
        console.warn(
          "[SUPPLIER_PRICE_HISTORY] Skipping purchase without supplierId:",
          purchase._id?.toString?.() || purchase._id
        );
        continue;
      }

      for (const item of purchase.items || []) {
        // Skip items without a linked ingredient (legacy/incomplete data)
        if (!item.ingredientId) {
          console.warn(
            "[SUPPLIER_PRICE_HISTORY] Skipping item without ingredientId in purchase:",
            purchase._id?.toString?.() || purchase._id
          );
          continue;
        }

        if (ingredientId && item.ingredientId.toString() !== ingredientId)
          continue;

        priceHistory.push({
          date: purchase.date,
          supplierId: purchase.supplierId._id,
          supplierName: purchase.supplierId.name,
          ingredientId: item.ingredientId._id,
          ingredientName: item.ingredientId.name,
          qty: item.qty,
          uom: item.uom,
          unitPrice: item.unitPrice,
          total: item.total,
        });
      }
    }

    res.json({ success: true, data: priceHistory });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   GET /api/costing-v2/reports/pnl
 * @desc    Profit & Loss Report
 */
exports.getPnLReport = async (req, res) => {
  try {
    const { cartId } = req.query;
    const { from, to, fromDate, toDate, error: dateRangeError } =
      resolveDateRangeFromQuery(req.query);
    if (dateRangeError) {
      return res.status(400).json({ success: false, message: dateRangeError });
    }

    // Log user info for debugging
    console.log("[PNL_REPORT] User:", {
      userId: req.user._id,
      role: req.user.role,
      email: req.user.email,
      name: req.user.name,
    });

    // Build date filter for transactions (use date field, not createdAt)
    const transactionDateFilter = {};
    if (fromDate || toDate) {
      transactionDateFilter.date = {};
      if (fromDate) transactionDateFilter.date.$gte = fromDate;
      if (toDate) transactionDateFilter.date.$lte = toDate;
    }

    // Build outlet filter based on role (support both ObjectId and string cartId values)
    let transactionOutletFilter = {};
    if (req.user.role === "admin") {
      transactionOutletFilter.cartId = buildFlexibleCartIdFilter(req.user._id);
      console.log("[PNL_REPORT] Cart admin filter - cartId:", transactionOutletFilter.cartId?.toString());
    } else if (req.user.role === "franchise_admin") {
      if (cartId) {
        const outlet = await User.findById(cartId);
        if (
          !outlet ||
          outlet.franchiseId?.toString() !== req.user._id.toString()
        ) {
          return res.status(403).json({
            success: false,
            message: "Access denied: Kiosk does not belong to your franchise",
          });
        }
        transactionOutletFilter.cartId = buildFlexibleCartIdFilter(cartId);
      } else {
        const outlets = await User.find({
          role: "admin",
          franchiseId: req.user._id,
          isActive: true,
        }).select("_id");
        transactionOutletFilter.cartId = {
          $in: flattenCartIdFilterValues(outlets.map((o) => o._id)),
        };
      }
    } else if (req.user.role === "super_admin") {
      if (cartId) {
        transactionOutletFilter.cartId = buildFlexibleCartIdFilter(cartId);
      }
    }

    // Get total food cost (from consumption transactions - InventoryTransactionV2 OUT/WASTE)
    const consumptionTransactions = await InventoryTransaction.aggregate([
      {
        $match: {
          type: { $in: ["OUT", "WASTE"] },
          ...transactionDateFilter,
          ...transactionOutletFilter,
        },
      },
      {
        $group: {
          _id: null,
          totalFoodCost: { $sum: "$costAllocated" },
        },
      },
    ]);

    const foodCost = Number(
      (consumptionTransactions[0]?.totalFoodCost || 0).toFixed(2)
    );
    console.log(
      "[PNL_REPORT] Total food cost:",
      foodCost,
      "Transaction filter (cartId):",
      transactionOutletFilter.cartId ? "set" : "all"
    );

    // Get total sales (from orders - calculate from kotLines)
    const orderFilter = {};
    if (fromDate || toDate) {
      orderFilter.createdAt = {};
      if (fromDate) orderFilter.createdAt.$gte = fromDate;
      if (toDate) orderFilter.createdAt.$lte = toDate;
    }

    // Build order filter based on role (support both ObjectId and string cartId values)
    if (req.user.role === "admin") {
      orderFilter.cartId = buildFlexibleCartIdFilter(req.user._id);
    } else if (req.user.role === "franchise_admin") {
      if (cartId) {
        orderFilter.cartId = buildFlexibleCartIdFilter(cartId);
      } else {
        const outlets = await User.find({
          role: "admin",
          franchiseId: req.user._id,
          isActive: true,
        }).select("_id");
        orderFilter.cartId = {
          $in: flattenCartIdFilterValues(outlets.map((o) => o._id)),
        };
      }
    } else if (req.user.role === "super_admin") {
      if (cartId) {
        orderFilter.cartId = buildFlexibleCartIdFilter(cartId);
      }
    }

    // Include canonical PAID lifecycle + legacy paid/completed statuses for compatibility.
    Object.assign(orderFilter, buildSalesRecognizedOrderClause());
    const salesData = await Order.aggregate([
      { $match: orderFilter },
      {
        $unwind: {
          path: "$kotLines",
          preserveNullAndEmptyArrays: false, // Only include orders with kotLines
        },
      },
      {
        $group: {
          _id: null,
          totalSales: { $sum: { $ifNull: ["$kotLines.totalAmount", 0] } },
        },
      },
    ]);

    const totalSales = Number((salesData[0]?.totalSales || 0).toFixed(2));
    console.log(
      "[PNL_REPORT] Total sales:",
      totalSales,
      "Order filter:",
      JSON.stringify(orderFilter)
    );

    // Get labour costs
    const labourFilter = {};
    if (req.user.role === "admin") {
      // Cart admin - only their own kiosk
      labourFilter.cartId = req.user._id;
      console.log(
        "[PNL_REPORT] Cart admin labour filter - cartId:",
        req.user._id.toString()
      );
    } else if (req.user.role === "franchise_admin") {
      // Franchise admin - specific outlet or all their franchise outlets
      if (cartId) {
        labourFilter.cartId = cartId;
      } else {
        const outlets = await User.find({
          role: "admin",
          franchiseId: req.user._id,
          isActive: true,
        }).select("_id");
        labourFilter.cartId = { $in: outlets.map((o) => o._id) };
      }
    } else if (req.user.role === "super_admin") {
      // Super admin - specific outlet or all
      if (cartId) {
        labourFilter.cartId = cartId;
      }
    }

    if (fromDate || toDate) {
      labourFilter.$or = [
        {
          periodFrom: { $lte: toDate || new Date("2099-12-31T23:59:59.999Z") },
          periodTo: { $gte: fromDate || new Date("1970-01-01T00:00:00.000Z") },
        },
      ];
    }

    const labourCosts = await LabourCost.find(labourFilter).lean();
    const totalLabour = sumProratedPeriodAmount(labourCosts, fromDate, toDate);
    console.log(
      "[PNL_REPORT] Total labour:",
      totalLabour,
      "Labour filter:",
      JSON.stringify(labourFilter),
      "Count:",
      labourCosts.length
    );

    // Get overheads (same filter as labour)
    const overheads = await Overhead.find(labourFilter).lean();
    const totalOverhead = sumProratedPeriodAmount(overheads, fromDate, toDate);
    console.log(
      "[PNL_REPORT] Total overhead:",
      totalOverhead,
      "Overhead count:",
      overheads.length
    );

    // Get expenses
    const expenseFilter = {};
    if (req.user.role === "admin") {
      // Cart admin - only their own kiosk
      expenseFilter.cartId = req.user._id;
      console.log(
        "[PNL_REPORT] Cart admin expense filter - cartId:",
        req.user._id.toString()
      );
    } else if (req.user.role === "franchise_admin") {
      // Franchise admin - specific outlet or all their franchise outlets
      if (cartId) {
        expenseFilter.cartId = cartId;
      } else {
        const outlets = await User.find({
          role: "admin",
          franchiseId: req.user._id,
          isActive: true,
        }).select("_id");
        expenseFilter.cartId = { $in: outlets.map((o) => o._id) };
      }
    } else if (req.user.role === "super_admin") {
      // Super admin - specific outlet or all
      if (cartId) {
        expenseFilter.cartId = cartId;
      }
    }

    if (fromDate || toDate) {
      expenseFilter.expenseDate = {};
      if (fromDate) expenseFilter.expenseDate.$gte = fromDate;
      if (toDate) expenseFilter.expenseDate.$lte = toDate;
    }

    const expenses = await CostingExpense.find(expenseFilter).lean();
    const totalExpenses = Number(
      expenses.reduce((sum, e) => sum + (Number(e.amount) || 0), 0).toFixed(2)
    );
    console.log(
      "[PNL_REPORT] Total expenses:",
      totalExpenses,
      "Expense filter:",
      JSON.stringify(expenseFilter),
      "Count:",
      expenses.length
    );

    // Calculate P&L with proper precision
    const totalCosts = Number(
      (foodCost + totalLabour + totalOverhead + totalExpenses).toFixed(2)
    );
    const profit = Number((totalSales - totalCosts).toFixed(2));
    const profitMargin =
      totalSales > 0 ? Number(((profit / totalSales) * 100).toFixed(2)) : 0;

    res.json({
      success: true,
      data: {
        period: { from: from || null, to: to || null },
        sales: Number(totalSales.toFixed(2)),
        costs: {
          foodCost: Number(foodCost.toFixed(2)),
          labour: Number(totalLabour.toFixed(2)),
          overhead: Number(totalOverhead.toFixed(2)),
          expenses: Number(totalExpenses.toFixed(2)),
          total: Number(totalCosts.toFixed(2)),
        },
        profit: Number(profit.toFixed(2)),
        profitMargin: Number(profitMargin.toFixed(2)),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ==================== EXPENSES ====================

/**
 * @route   GET /api/costing-v2/expenses
 * @desc    Get all expenses with filters
 */
exports.getExpenses = async (req, res) => {
  try {
    const { from, to, category, cartId, search } = req.query;
    const query = await buildCostingQuery(req.user, {});

    if (cartId) {
      const hasAccess = await validateOutletAccess(req.user, cartId);
      if (!hasAccess) {
        return res
          .status(403)
          .json({ success: false, message: "Access denied to this outlet" });
      }
      query.cartId = cartId;
    }

    if (from || to) {
      query.expenseDate = {};
      if (from) query.expenseDate.$gte = new Date(from);
      if (to) {
        const toDate = new Date(to);
        toDate.setHours(23, 59, 59, 999);
        query.expenseDate.$lte = toDate;
      }
    }

    if (category) query.category = category;
    if (search) {
      query.$or = [
        { description: { $regex: search, $options: "i" } },
        { vendor: { $regex: search, $options: "i" } },
        { invoiceNumber: { $regex: search, $options: "i" } },
      ];
    }

    const expenses = await CostingExpense.find(query)
      .sort({ expenseDate: -1 })
      .populate("createdBy", "name email")
      .lean();

    res.json({ success: true, data: expenses });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   POST /api/costing-v2/expenses
 * @desc    Create expense
 */
exports.createExpense = async (req, res) => {
  try {
    // setOutletContext is async, so we need to await it
    const expenseData = await setOutletContext(req.user, req.body, true);
    expenseData.createdBy = req.user._id;

    // Ensure expenseDate is a Date object
    if (!expenseData.expenseDate) {
      expenseData.expenseDate = new Date();
    } else if (typeof expenseData.expenseDate === "string") {
      expenseData.expenseDate = new Date(expenseData.expenseDate);
    }

    // Ensure amount is a number
    if (expenseData.amount) {
      expenseData.amount = Number(expenseData.amount);
    }

    // Ensure category is provided
    if (!expenseData.category) {
      return res.status(400).json({
        success: false,
        message: "Category is required",
      });
    }

    const expense = new CostingExpense(expenseData);
    await expense.save();

    res.status(201).json({ success: true, data: expense });
  } catch (error) {
    console.error("[COSTING] Create expense error:", error);
    res.status(400).json({ success: false, message: error.message });
  }
};

/**
 * @route   PUT /api/costing-v2/expenses/:id
 * @desc    Update expense
 */
exports.updateExpense = async (req, res) => {
  try {
    const expense = await CostingExpense.findById(req.params.id);
    if (!expense) {
      return res
        .status(404)
        .json({ success: false, message: "Expense not found" });
    }

    // Validate access (validateOutletAccess is async)
    const hasAccess = await validateOutletAccess(req.user, expense.cartId);
    if (!hasAccess) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    // Update fields with proper type conversion
    if (req.body.expenseDate && typeof req.body.expenseDate === "string") {
      req.body.expenseDate = new Date(req.body.expenseDate);
    }
    if (req.body.amount) {
      req.body.amount = Number(req.body.amount);
    }

    Object.assign(expense, req.body);
    await expense.save();

    res.json({ success: true, data: expense });
  } catch (error) {
    console.error("[COSTING] Update expense error:", error);
    res.status(400).json({ success: false, message: error.message });
  }
};

/**
 * @route   DELETE /api/costing-v2/expenses/:id
 * @desc    Delete expense
 */
exports.deleteExpense = async (req, res) => {
  try {
    const expense = await CostingExpense.findById(req.params.id);
    if (!expense) {
      return res
        .status(404)
        .json({ success: false, message: "Expense not found" });
    }

    // Validate access (validateOutletAccess is async)
    const hasAccess = await validateOutletAccess(req.user, expense.cartId);
    if (!hasAccess) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    await CostingExpense.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: "Expense deleted successfully" });
  } catch (error) {
    console.error("[COSTING] Delete expense error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   GET /api/costing-v2/expenses/summary
 * @desc    Get expense summary by category and period
 */
exports.getExpenseSummary = async (req, res) => {
  try {
    const { from, to, cartId } = req.query;
    const query = await buildCostingQuery(req.user, {});

    if (cartId) {
      const hasAccess = await validateOutletAccess(req.user, cartId);
      if (!hasAccess) {
        return res
          .status(403)
          .json({ success: false, message: "Access denied to this outlet" });
      }
      query.cartId = cartId;
    }

    if (from || to) {
      query.expenseDate = {};
      if (from) query.expenseDate.$gte = new Date(from);
      if (to) {
        const toDate = new Date(to);
        toDate.setHours(23, 59, 59, 999);
        query.expenseDate.$lte = toDate;
      }
    }

    const expenses = await CostingExpense.find(query).lean();

    // Group by category
    const categorySummary = {};
    let totalAmount = 0;

    expenses.forEach((expense) => {
      const cat = expense.category || "miscellaneous";
      if (!categorySummary[cat]) {
        categorySummary[cat] = {
          category: cat,
          count: 0,
          total: 0,
        };
      }
      categorySummary[cat].count += 1;
      categorySummary[cat].total += expense.amount || 0;
      totalAmount += expense.amount || 0;
    });

    // Convert to array and sort by total
    const summaryArray = Object.values(categorySummary).sort(
      (a, b) => b.total - a.total
    );

    res.json({
      success: true,
      data: {
        summary: summaryArray,
        total: totalAmount,
        count: expenses.length,
        period: { from, to },
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   GET /api/costing-v2/expense-categories
 * @desc    Get all expense categories
 */
exports.getExpenseCategories = async (req, res) => {
  try {
    const query = { isActive: true };
    const categories = await CostingExpenseCategory.find(query)
      .sort({ name: 1 })
      .lean();
    res.json({ success: true, data: categories });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   POST /api/costing-v2/expense-categories
 * @desc    Create expense category
 */
exports.createExpenseCategory = async (req, res) => {
  try {
    const categoryData = {
      ...req.body,
      createdBy: req.user._id,
    };

    if (!categoryData.code) {
      categoryData.code = categoryData.name.toUpperCase().replace(/\s+/g, "_");
    }

    const category = new CostingExpenseCategory(categoryData);
    await category.save();

    res.status(201).json({ success: true, data: category });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

/**
 * @route   POST /api/costing-v2/menu-items/sync-from-default
 * @desc    Sync costing menu items with default menu (update prices)
 */
exports.syncMenuItemsFromDefault = async (req, res) => {
  try {
    const { franchiseId, cartId: bodyCartId } = req.body;
    const {
      syncDefaultMenuToCosting,
    } = require("../../services/costing-v2/syncDefaultMenuToCosting");

    // For cart admin, sync from their MenuItem collection (cart menu)
    let targetFranchiseId = franchiseId;
    let cartId = bodyCartId || null;
    let targetOutletId = cartId;

    if (req.user.role === "admin") {
      // Cart admin: sync from MenuItem collection (cart menu)
      cartId = req.user._id;
      // If cartId not provided, use cart admin's own kiosk ID
      if (!targetOutletId) {
        targetOutletId = req.user._id;
      }
    } else if (req.user.role === "franchise_admin") {
      targetFranchiseId = req.user._id;
    } else if (req.user.role === "super_admin" && !franchiseId) {
      targetFranchiseId = null; // Global menu
    }

    const syncResult = await syncDefaultMenuToCosting(
      targetFranchiseId,
      cartId
    );

    res.json({
      success: syncResult.success,
      data: {
        updated: syncResult.updated || 0,
        notFound: syncResult.notFound || 0,
        errors: syncResult.errors || [],
        message:
          syncResult.error ||
          `Successfully synced ${syncResult.updated || 0} menu items`,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   POST /api/costing-v2/menu-items/link-matching-boms
 * @desc    Bulk link menu items without recipeId to matching BOMs by name
 */
exports.linkMatchingBoms = async (req, res) => {
  try {
    const { cartId: bodyCartId } = req.body;
    let cartId = bodyCartId;

    if (req.user.role === "admin") {
      cartId = req.user._id;
    } else if (req.user.role === "franchise_admin" && !cartId) {
      return res.status(400).json({
        success: false,
        message: "Franchise admin must provide cartId",
      });
    }

    const MenuItemV2 = require("../../models/costing-v2/menuItemModel");
    const RecipeV2 = require("../../models/costing-v2/recipeModel");

    const filter = {
      $or: [{ recipeId: null }, { recipeId: { $exists: false } }],
      isActive: true,
    };
    if (cartId) filter.cartId = cartId;

    const menuItemsWithoutRecipe = await MenuItemV2.find(filter).lean();
    let linked = 0;
    const errors = [];

    for (const mi of menuItemsWithoutRecipe) {
      try {
        const nameNorm = (mi.name || "").trim().replace(/\s+/g, " ").toLowerCase();
        if (!nameNorm) continue;

        const nameRegex = new RegExp(
          `^${(mi.name || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
          "i"
        );

        const matchingRecipe = await RecipeV2.findOne({
          isActive: true,
          $and: [
            {
              $or: [
                { nameNormalized: nameNorm },
                { name: { $regex: nameRegex } },
              ],
            },
            {
              $or: [
                { cartId: mi.cartId },
                { cartId: null, franchiseId: mi.franchiseId },
                { franchiseId: mi.franchiseId },
                { cartId: null, franchiseId: null },
                { cartId: { $exists: false }, franchiseId: { $exists: false } },
              ],
            },
          ],
        });

        if (matchingRecipe) {
          await MenuItemV2.updateOne(
            { _id: mi._id },
            { $set: { recipeId: matchingRecipe._id } }
          );
          linked++;
        }
      } catch (err) {
        errors.push({ item: mi.name, error: err.message });
      }
    }

    res.json({
      success: true,
      data: {
        linked,
        totalWithoutRecipe: menuItemsWithoutRecipe.length,
        errors: errors.length > 0 ? errors : undefined,
        message: `Linked ${linked} menu item(s) to matching BOMs`,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Internal function to push ingredients and BOMs to cart admins
 * @param {String|ObjectId} cartId - Optional: specific cart admin ID, or null for all
 * @returns {Promise<Object>} Results object
 */
const pushToCartAdminsInternal = async (cartId = null) => {
  // ⚠️⚠️⚠️ DISABLED: This function creates cart-specific copies of shared ingredients and BOMs
  // NEW APPROACH: All ingredients and BOMs are SHARED (cartId: null) by default
  // Cart admins can see all shared data without need for cart-specific copies
  // This prevents duplicates and ensures data consistency

  const targetCartId = cartId || null;
  const cartFilter = {
    role: "admin",
    isActive: { $ne: false },
  };
  if (targetCartId) {
    cartFilter._id = mongoose.Types.ObjectId.isValid(targetCartId)
      ? new mongoose.Types.ObjectId(targetCartId)
      : targetCartId;
  }

  const [cartAdmins, sharedIngredientCount, sharedRecipeCount] =
    await Promise.all([
      User.find(cartFilter)
        .select("_id name cartName cartCode email")
        .lean(),
      Ingredient.countDocuments({
        cartId: null,
        isActive: { $ne: false },
      }),
      Recipe.countDocuments({
        cartId: null,
        isActive: { $ne: false },
      }),
    ]);

  if (targetCartId && cartAdmins.length === 0) {
    throw new Error("Cart admin not found");
  }

  console.log(
    `[PUSH_TO_CART_ADMINS_INTERNAL] Shared mode active - no copy push required. Targets: ${cartAdmins.length}, shared ingredients: ${sharedIngredientCount}, shared BOMs: ${sharedRecipeCount}`
  );

  return {
    success: true,
    message:
      "Shared mode active. Cart admins automatically read shared ingredients/BOMs (no duplication).",
    data: {
      ingredients: { created: 0, updated: 0, skipped: 0 },
      recipes: { created: 0, updated: 0, skipped: 0 },
      cartAdmins: cartAdmins.map((cartAdmin) => ({
        cartAdminId: cartAdmin._id.toString(),
        cartAdminName: cartAdmin.name || cartAdmin.cartName || "Unknown",
        cartCode: cartAdmin.cartCode || null,
        ingredients: { created: 0, updated: 0, skipped: 0 },
        recipes: { created: 0, updated: 0, skipped: 0 },
        mode: "shared",
      })),
      shared: {
        mode: "shared",
        ingredients: sharedIngredientCount,
        recipes: sharedRecipeCount,
      },
    },
  };

  /* DISABLED CODE - Kept for reference
  console.log(`[PUSH_TO_CART_ADMINS_INTERNAL] Starting push - cartId: ${cartId || 'ALL'}`);
  
  // Get all super admin ingredients (cartId: null)
  const superAdminIngredients = await Ingredient.find({
    cartId: null,
    isActive: true,
  }).lean();
  
  console.log(`[PUSH_TO_CART_ADMINS_INTERNAL] Found ${superAdminIngredients.length} super admin ingredients to push`);
  
  if (superAdminIngredients.length === 0) {
    console.warn(`[PUSH_TO_CART_ADMINS_INTERNAL] ⚠️ No super admin ingredients found! Super admin must create ingredients first.`);
  }

  // Get all super admin recipes/BOMs (cartId: null)
  const superAdminRecipes = await Recipe.find({
    cartId: null,
    isActive: true,
  })
    .populate("ingredients.ingredientId", "name uom baseUnit")
    .lean();
  
  console.log(`[PUSH_TO_CART_ADMINS_INTERNAL] Found ${superAdminRecipes.length} super admin recipes to push`);

  // Get target cart admins
  let cartAdmins = [];
  if (cartId) {
    // Push to specific cart admin
    const cartAdmin = await User.findById(cartId);
    if (!cartAdmin || cartAdmin.role !== "admin") {
      throw new Error("Cart admin not found");
    }
    cartAdmins = [cartAdmin];
    console.log(`[PUSH_TO_CART_ADMINS_INTERNAL] Pushing to specific cart admin: ${cartAdmin.name || cartAdmin.cartName} (${cartAdmin._id})`);
  } else {
    // Push to all cart admins
    cartAdmins = await User.find({ role: "admin", isActive: { $ne: false } });
    console.log(`[PUSH_TO_CART_ADMINS_INTERNAL] Pushing to ${cartAdmins.length} cart admins`);
  }
  
  if (superAdminIngredients.length === 0 && superAdminRecipes.length === 0) {
    return {
      success: true,
      message: `No super admin ingredients or recipes to push. Super admin must create them first.`,
      data: {
        ingredients: { created: 0, updated: 0, skipped: 0 },
        recipes: { created: 0, updated: 0, skipped: 0 },
        cartAdmins: cartAdmins.map(ca => ({
          cartAdminId: ca._id.toString(),
          cartAdminName: ca.name || ca.cartName || "Unknown",
          ingredients: { created: 0, updated: 0, skipped: 0 },
          recipes: { created: 0, updated: 0, skipped: 0 },
        })),
      },
    };
  }

  const results = {
    ingredients: { created: 0, updated: 0, skipped: 0 },
    recipes: { created: 0, updated: 0, skipped: 0 },
    cartAdmins: [],
  };

  // Process each cart admin
  for (const cartAdmin of cartAdmins) {
    const cartAdminId = cartAdmin._id;
    const cartAdminFranchiseId = cartAdmin.franchiseId;
    const cartAdminResult = {
      cartAdminId: cartAdminId.toString(),
      cartAdminName: cartAdmin.name || cartAdmin.cartName || "Unknown",
      ingredients: { created: 0, updated: 0, skipped: 0 },
      recipes: { created: 0, updated: 0, skipped: 0 },
    };

    // Push ingredients
    console.log(`[PUSH_TO_CART_ADMINS] Processing ${superAdminIngredients.length} ingredients for cart admin: ${cartAdminResult.cartAdminName} (${cartAdminId})`);
    
    for (const superIngredient of superAdminIngredients) {
        try {
          console.log(`[PUSH_TO_CART_ADMINS] Processing ingredient: ${superIngredient.name}`);
          
          // Check if cart admin already has this ingredient (by name and cartId)
          let existingIngredient = await Ingredient.findOne({
            name: superIngredient.name,
            cartId: cartAdminId,
          });

          console.log(`[PUSH_TO_CART_ADMINS] Existing cart-specific ingredient: ${existingIngredient ? existingIngredient._id : 'none'}`);

          // Also check for shared ingredient (cartId: null) with same name
          // This handles cases where a shared ingredient exists and we need to make it cart-specific
          if (!existingIngredient) {
            const sharedIngredient = await Ingredient.findOne({
              name: superIngredient.name,
              cartId: null,
            });
            
            console.log(`[PUSH_TO_CART_ADMINS] Shared ingredient found: ${sharedIngredient ? sharedIngredient._id : 'none'}`);
            
            if (sharedIngredient) {
              // Update shared ingredient to be cart-specific
              existingIngredient = sharedIngredient;
            }
          }

          if (existingIngredient) {
            console.log(`[PUSH_TO_CART_ADMINS] Updating existing ingredient: ${existingIngredient._id}`);
            // Update existing ingredient with super admin data, but preserve cart admin's inventory data
            const updateData = {
              category: superIngredient.category,
              storageLocation: superIngredient.storageLocation,
              uom: superIngredient.uom,
              baseUnit: superIngredient.baseUnit,
              conversionFactors: superIngredient.conversionFactors,
              shelfTimeDays: superIngredient.shelfTimeDays,
              // Set cartId to make it cart-specific (if it was shared)
              cartId: cartAdminId,
              franchiseId: cartAdminFranchiseId,
              // Preserve cart admin's own data:
              // - qtyOnHand (keep existing)
              // - reorderLevel (keep existing)
              // - currentCostPerBaseUnit (keep existing - from their purchases)
              // - fifoLayers (keep existing)
              // - preferredSupplierId (keep existing)
              isActive: superIngredient.isActive,
            };

            const updated = await Ingredient.findByIdAndUpdate(
              existingIngredient._id,
              updateData,
              {
                runValidators: true,
                new: true
              }
            );
            
            console.log(`[PUSH_TO_CART_ADMINS] ✅ Updated ingredient: ${updated.name} (ID: ${updated._id}, cartId: ${updated.cartId})`);
            cartAdminResult.ingredients.updated++;
            results.ingredients.updated++;
          } else {
            // Create new ingredient for cart admin
            console.log(`[PUSH_TO_CART_ADMINS] Creating new ingredient: ${superIngredient.name}`);
            
            const newIngredient = new Ingredient({
              name: superIngredient.name,
              category: superIngredient.category,
              storageLocation: superIngredient.storageLocation,
              uom: superIngredient.uom,
              baseUnit: superIngredient.baseUnit,
              conversionFactors: superIngredient.conversionFactors,
              reorderLevel: superIngredient.reorderLevel || 0,
              shelfTimeDays: superIngredient.shelfTimeDays,
              currentCostPerBaseUnit: 0, // Will be set when cart admin makes purchases
              qtyOnHand: 0, // Cart admin starts with 0 inventory
              fifoLayers: [], // Empty FIFO layers
              isActive: superIngredient.isActive,
              cartId: cartAdminId,
              franchiseId: cartAdminFranchiseId,
            });

            await newIngredient.save();
            console.log(`[PUSH_TO_CART_ADMINS] ✅ Created ingredient: ${newIngredient.name} (ID: ${newIngredient._id}, cartId: ${newIngredient.cartId})`);
            cartAdminResult.ingredients.created++;
            results.ingredients.created++;
          }
        } catch (error) {
          console.error(`[PUSH_TO_CART_ADMINS] ❌ Error processing ingredient "${superIngredient.name}":`, error.message);
          console.error(`[PUSH_TO_CART_ADMINS] Error stack:`, error.stack);
          
          // Handle duplicate key error gracefully
          if (error.code === 11000) {
            console.log(`[PUSH_TO_CART_ADMINS] Duplicate key error - trying to find and update existing ingredient`);
            // Duplicate key error - ingredient with same name already exists
            // Try to find and update it instead
            const duplicateIngredient = await Ingredient.findOne({
              name: superIngredient.name,
              $or: [
                { cartId: cartAdminId },
                { cartId: null },
              ],
            });
            
            if (duplicateIngredient) {
              console.log(`[PUSH_TO_CART_ADMINS] Found duplicate ingredient: ${duplicateIngredient._id}, updating...`);
              const updateData = {
                category: superIngredient.category,
                storageLocation: superIngredient.storageLocation,
                uom: superIngredient.uom,
                baseUnit: superIngredient.baseUnit,
                conversionFactors: superIngredient.conversionFactors,
                shelfTimeDays: superIngredient.shelfTimeDays,
                cartId: cartAdminId,
                franchiseId: cartAdminFranchiseId,
                isActive: superIngredient.isActive,
              };
              
              await Ingredient.findByIdAndUpdate(
                duplicateIngredient._id,
                updateData,
                { runValidators: true }
              );
              console.log(`[PUSH_TO_CART_ADMINS] ✅ Resolved duplicate - updated ingredient: ${duplicateIngredient._id}`);
              cartAdminResult.ingredients.updated++;
              results.ingredients.updated++;
            } else {
              // Skip if we can't resolve the conflict
              cartAdminResult.ingredients.skipped++;
              results.ingredients.skipped++;
              console.warn(`[PUSH_TO_CART_ADMINS] ⚠️ Skipped ingredient "${superIngredient.name}" for cart ${cartAdminId} due to duplicate key conflict: ${error.message}`);
            }
          } else {
            // Re-throw if it's not a duplicate key error
            console.error(`[PUSH_TO_CART_ADMINS] ❌ Non-duplicate error, re-throwing:`, error);
            throw error;
          }
        }
      }
      
      console.log(`[PUSH_TO_CART_ADMINS] ✅ Finished pushing ingredients for ${cartAdminResult.cartAdminName}: ${cartAdminResult.ingredients.created} created, ${cartAdminResult.ingredients.updated} updated, ${cartAdminResult.ingredients.skipped} skipped`);

    // Push recipes/BOMs
    for (const superRecipe of superAdminRecipes) {
      // Check if cart admin already has this recipe (by name)
      const existingRecipe = await Recipe.findOne({
        name: superRecipe.name,
        cartId: cartAdminId,
      });

      if (existingRecipe) {
        // Update existing recipe with super admin data
        // Map ingredient IDs from super admin to cart admin ingredients
        const mappedIngredients = [];
        for (const superIngredient of superRecipe.ingredients || []) {
          if (superIngredient.ingredientId) {
            // Get ingredient name - handle both populated and non-populated cases
            let ingredientName = null;
            if (
              typeof superIngredient.ingredientId === "object" &&
              superIngredient.ingredientId.name
            ) {
              // Populated ingredient
              ingredientName = superIngredient.ingredientId.name;
            } else {
              // Not populated - fetch the ingredient to get name
              const superIngredientDoc = await Ingredient.findById(
                superIngredient.ingredientId
              );
              if (superIngredientDoc) {
                ingredientName = superIngredientDoc.name;
              }
            }

            if (ingredientName) {
              // Find corresponding ingredient in cart admin's ingredients by name
              const cartAdminIngredient = await Ingredient.findOne({
                name: ingredientName,
                cartId: cartAdminId,
              });

              if (cartAdminIngredient) {
                mappedIngredients.push({
                  ingredientId: cartAdminIngredient._id,
                  qty: superIngredient.qty,
                  uom: superIngredient.uom,
                });
              }
            }
          }
        }

        const updateData = {
          yieldPercent: superRecipe.yieldPercent,
          portions: superRecipe.portions,
          instructions: superRecipe.instructions,
          ingredients: mappedIngredients,
          isActive: superRecipe.isActive,
        };

        await Recipe.findByIdAndUpdate(existingRecipe._id, updateData, {
          runValidators: true,
        });

        // Recalculate cost for updated recipe
        const updatedRecipe = await Recipe.findById(existingRecipe._id);
        if (updatedRecipe) {
          await updatedRecipe.calculateCost(cartAdminId.toString());
          await updatedRecipe.save();
        }

        cartAdminResult.recipes.updated++;
        results.recipes.updated++;
      } else {
        // Create new recipe for cart admin
        // Map ingredient IDs from super admin to cart admin ingredients
        const mappedIngredients = [];
        for (const superIngredient of superRecipe.ingredients || []) {
          if (superIngredient.ingredientId) {
            // Get ingredient name - handle both populated and non-populated cases
            let ingredientName = null;
            if (
              typeof superIngredient.ingredientId === "object" &&
              superIngredient.ingredientId.name
            ) {
              // Populated ingredient
              ingredientName = superIngredient.ingredientId.name;
            } else {
              // Not populated - fetch the ingredient to get name
              const superIngredientDoc = await Ingredient.findById(
                superIngredient.ingredientId
              );
              if (superIngredientDoc) {
                ingredientName = superIngredientDoc.name;
              }
            }

            if (ingredientName) {
              // Find corresponding ingredient in cart admin's ingredients by name
              const cartAdminIngredient = await Ingredient.findOne({
                name: ingredientName,
                cartId: cartAdminId,
              });

              if (cartAdminIngredient) {
                mappedIngredients.push({
                  ingredientId: cartAdminIngredient._id,
                  qty: superIngredient.qty,
                  uom: superIngredient.uom,
                });
              }
            }
          }
        }

        if (mappedIngredients.length > 0) {
          const newRecipe = new Recipe({
            name: superRecipe.name,
            yieldPercent: superRecipe.yieldPercent,
            portions: superRecipe.portions,
            instructions: superRecipe.instructions,
            ingredients: mappedIngredients,
            isActive: superRecipe.isActive,
            cartId: cartAdminId,
            franchiseId: cartAdminFranchiseId,
          });

          await newRecipe.save();

          // Calculate cost for new recipe
          await newRecipe.calculateCost(cartAdminId.toString());
          await newRecipe.save();

          cartAdminResult.recipes.created++;
          results.recipes.created++;
        } else {
          // Skip if no matching ingredients found
          cartAdminResult.recipes.skipped++;
          results.recipes.skipped++;
        }
      }
    }

    results.cartAdmins.push(cartAdminResult);
  }

  console.log(`[PUSH_TO_CART_ADMINS_INTERNAL] ========================================`);
  console.log(`[PUSH_TO_CART_ADMINS_INTERNAL] ✅ Push completed!`);
  console.log(`[PUSH_TO_CART_ADMINS_INTERNAL] Total ingredients: ${results.ingredients.created} created, ${results.ingredients.updated} updated, ${results.ingredients.skipped} skipped`);
  console.log(`[PUSH_TO_CART_ADMINS_INTERNAL] Total recipes: ${results.recipes.created} created, ${results.recipes.updated} updated, ${results.recipes.skipped} skipped`);
  console.log(`[PUSH_TO_CART_ADMINS_INTERNAL] Cart admins processed: ${results.cartAdmins.length}`);
  console.log(`[PUSH_TO_CART_ADMINS_INTERNAL] ========================================`);

  return {
    success: true,
    message: `Successfully pushed data to ${cartAdmins.length} cart admin(s)`,
    data: results,
  };
  */  // End of disabled code
};

/**
 * @route   POST /api/costing-v2/push-to-cart-admins
 * @desc    Push super admin ingredients and BOMs to cart admins
 * @access  Super Admin only
 */
exports.pushToCartAdmins = async (req, res) => {
  try {
    // Only super admin can push
    if (req.user.role !== "super_admin") {
      return res.status(403).json({
        success: false,
        message:
          "Access denied. Only super admin can push data to cart admins.",
      });
    }

    const { cartId, outletId } = req.body || {};
    const targetCartId = cartId || outletId || null; // outletId kept for backward compatibility

    const result = await pushToCartAdminsInternal(targetCartId);
    res.json(result);
  } catch (error) {
    console.error("[PUSH_TO_CART_ADMINS] Error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to push data to cart admins",
    });
  }
};

// Export internal function for use in other controllers
exports.pushToCartAdminsInternal = pushToCartAdminsInternal;

/**
 * @route   GET /api/costing-v2/ingredients/debug
 * @desc    Debug endpoint to check ingredient database state
 * @access  Admin only
 */
exports.debugIngredients = async (req, res) => {
  try {
    if (req.user.role !== "admin" && req.user.role !== "super_admin") {
      return res.status(403).json({
        success: false,
        message: "Access denied",
      });
    }

    const userId = req.user._id;
    const userCartId = mongoose.Types.ObjectId.isValid(userId)
      ? new mongoose.Types.ObjectId(userId)
      : userId;

    // Get counts
    const totalCount = await Ingredient.countDocuments({});
    const cartSpecificCount = await Ingredient.countDocuments({ cartId: userCartId });
    const sharedCount = await Ingredient.countDocuments({ cartId: null });
    const noCartIdCount = await Ingredient.countDocuments({ cartId: { $exists: false } });
    const withOtherCartId = await Ingredient.countDocuments({
      cartId: { $ne: null, $exists: true, $ne: userCartId }
    });
    const superAdminCount = await Ingredient.countDocuments({ cartId: null, isActive: true });

    // Get ALL ingredients to see their cartId values
    const allIngredients = await Ingredient.find({})
      .select('name cartId isActive createdAt')
      .lean()
      .limit(50); // Limit to 50 for performance

    // Group by cartId
    const byCartId = {};
    allIngredients.forEach(ing => {
      const cartIdKey = ing.cartId ? ing.cartId.toString() : 'null';
      if (!byCartId[cartIdKey]) {
        byCartId[cartIdKey] = [];
      }
      byCartId[cartIdKey].push({
        name: ing.name,
        isActive: ing.isActive,
        createdAt: ing.createdAt
      });
    });

    // Get sample ingredients
    const cartSpecific = await Ingredient.find({ cartId: userCartId }).limit(5).select('name cartId isActive').lean();
    const shared = await Ingredient.find({ cartId: null }).limit(5).select('name cartId isActive').lean();
    const withOtherCartIds = await Ingredient.find({
      cartId: { $ne: null, $exists: true, $ne: userCartId }
    }).limit(10).select('name cartId isActive').lean();

    // Test the query that should be used
    const testQuery = {
      $or: [
        { cartId: userCartId, isActive: true },
        { cartId: null, isActive: true },
        { cartId: { $exists: false }, isActive: true }
      ],
    };
    const testCount = await Ingredient.countDocuments(testQuery);
    const testResults = await Ingredient.find(testQuery).limit(10).select('name cartId isActive').lean();

    res.json({
      success: true,
      data: {
        user: {
          id: userId.toString(),
          role: req.user.role,
          cartId: userCartId.toString(),
        },
        counts: {
          total: totalCount,
          cartSpecific: cartSpecificCount,
          shared: sharedCount,
          noCartId: noCartIdCount,
          withOtherCartId: withOtherCartId,
          superAdminActive: superAdminCount,
          testQuery: testCount,
        },
        issue: sharedCount === 0
          ? "⚠️ NO SHARED INGREDIENTS (cartId: null) FOUND! Super admin must create ingredients with cartId: null for cart admins to see them."
          : testCount === 0 && req.user.role === "admin"
            ? "⚠️ Query returns 0 ingredients even though shared ingredients exist. Check isActive filter."
            : "✅ OK",
        samples: {
          cartSpecific: cartSpecific.map(i => ({
            name: i.name,
            cartId: i.cartId ? i.cartId.toString() : null,
            isActive: i.isActive,
          })),
          shared: shared.map(i => ({
            name: i.name,
            cartId: i.cartId ? i.cartId.toString() : null,
            isActive: i.isActive,
          })),
          withOtherCartIds: withOtherCartIds.map(i => ({
            name: i.name,
            cartId: i.cartId ? i.cartId.toString() : 'OTHER',
            isActive: i.isActive,
          })),
        },
        allIngredientsByCartId: byCartId,
        testQuery: {
          query: testQuery,
          count: testCount,
          results: testResults.map(i => ({
            name: i.name,
            cartId: i.cartId ? i.cartId.toString() : null,
            isActive: i.isActive,
          })),
        },
        fix: sharedCount === 0
          ? "To fix: Super admin should create ingredients. They will automatically have cartId: null. Or run MongoDB command: db.ingredientv2s.updateMany({ cartId: { $ne: null } }, { $set: { cartId: null } })"
          : null,
      },
    });
  } catch (error) {
    console.error("[DEBUG_INGREDIENTS] Error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to debug ingredients",
    });
  }
};
