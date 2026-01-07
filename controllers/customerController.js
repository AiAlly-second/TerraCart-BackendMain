const mongoose = require("mongoose");
const Customer = require("../models/customerModel");
const Feedback = require("../models/feedbackModel");
const Order = require("../models/orderModel");

// Helper: sync customers from existing orders when Customer collection is empty for a cafe/franchise
// This is mainly to backfill legacy data so cart admins can see customers from past orders (including takeaways)
const syncCustomersFromOrders = async (user) => {
  try {
    const hierarchyQuery = {};
    let orderQuery = {};

    if (!user) return 0;

    if (user.role === "admin") {
      // Cart admin – use their _id as cartId
      const userId = user._id?._id || user._id;
      const cartId = mongoose.Types.ObjectId.isValid(userId)
        ? new mongoose.Types.ObjectId(userId)
        : userId;
      orderQuery.cartId = cartId;
      hierarchyQuery.cartId = cartId; // Customer model uses cartId, not cafeId
    } else if (user.role === "franchise_admin") {
      // Franchise admin – use their _id as franchiseId
      const userId = user._id?._id || user._id;
      const franchiseId = mongoose.Types.ObjectId.isValid(userId)
        ? new mongoose.Types.ObjectId(userId)
        : userId;
      orderQuery.franchiseId = franchiseId;
      hierarchyQuery.franchiseId = franchiseId;
    } else {
      // Super admin or other roles – do not auto-sync
      return 0;
    }

    console.log(
      "[CUSTOMER_SYNC] Starting syncCustomersFromOrders for user:",
      user.role,
      user._id?.toString?.() || user._id
    );

    const orders = await Order.find(orderQuery)
      .select(
        "_id createdAt cartId franchiseId customerName customerMobile customerEmail kotLines"
      )
      .lean();

    console.log("[CUSTOMER_SYNC] Found orders for sync:", orders.length);

    if (!orders || orders.length === 0) {
      return 0;
    }

    // Build aggregated customer records from orders
    const customerMap = new Map();

    const normalizePhone = (phone) => {
      if (!phone) return null;
      return String(phone).replace(/\D/g, "");
    };

    for (const order of orders) {
      const phone = normalizePhone(order.customerMobile);
      const email = order.customerEmail
        ? String(order.customerEmail).trim().toLowerCase()
        : null;

      // Require at least one identifier
      if (!phone && !email) continue;

      const key = `${phone || ""}|${email || ""}`;

      const latestKot =
        order.kotLines && order.kotLines.length > 0
          ? order.kotLines[order.kotLines.length - 1]
          : null;
      const orderTotal = latestKot?.totalAmount || 0;

      const cartIdVal = order.cartId ? order.cartId._id || order.cartId : null;
      const franchiseIdVal = order.franchiseId
        ? order.franchiseId._id || order.franchiseId
        : null;

      if (!customerMap.has(key)) {
        customerMap.set(key, {
          name: order.customerName
            ? String(order.customerName).trim()
            : "Guest",
          email: email || null,
          phone: phone || (email ? `email-${Date.now()}` : null),
          cartId: cartIdVal, // Customer model uses cartId, not cafeId
          franchiseId: franchiseIdVal,
          visitCount: 1,
          firstVisitAt: order.createdAt || new Date(),
          lastVisitAt: order.createdAt || new Date(),
          totalSpent: orderTotal,
          lastOrderId: order._id,
          ratings: [],
          averageRating: 0,
        });
      } else {
        const existing = customerMap.get(key);
        existing.visitCount = (existing.visitCount || 0) + 1;
        existing.totalSpent = (existing.totalSpent || 0) + orderTotal;
        if (
          order.createdAt &&
          new Date(order.createdAt) > new Date(existing.lastVisitAt)
        ) {
          existing.lastVisitAt = order.createdAt;
          existing.lastOrderId = order._id;
        }
        customerMap.set(key, existing);
      }
    }

    const customersToInsert = Array.from(customerMap.values()).map((c) => {
      const doc = { ...c };
      // Ensure ObjectId types where appropriate
      // Customer model uses cartId, not cafeId
      if (doc.cartId && mongoose.Types.ObjectId.isValid(doc.cartId)) {
        doc.cartId =
          typeof doc.cartId === "string"
            ? new mongoose.Types.ObjectId(doc.cartId)
            : doc.cartId;
      }
      if (doc.franchiseId && mongoose.Types.ObjectId.isValid(doc.franchiseId)) {
        doc.franchiseId =
          typeof doc.franchiseId === "string"
            ? new mongoose.Types.ObjectId(doc.franchiseId)
            : doc.franchiseId;
      }
      if (!doc.phone && doc.email) {
        doc.phone = `email-${Date.now()}`;
      }
      return doc;
    });

    if (!customersToInsert.length) {
      console.log(
        "[CUSTOMER_SYNC] No usable customer data found in orders for sync"
      );
      return 0;
    }

    console.log(
      "[CUSTOMER_SYNC] Inserting customers from order:",
      customersToInsert.length
    );

    // Use ordered:false to continue on duplicates if any
    await Customer.insertMany(customersToInsert, { ordered: false });

    return customersToInsert.length;
  } catch (err) {
    console.error("[CUSTOMER_SYNC] Error syncing customers from orders:", err);
    return 0;
  }
};

// Helper function to build query based on user role
// CRITICAL: Cart admins must only see their own data (filtered by cartId)
const buildHierarchyQuery = (user) => {
  const query = {};
  if (user.role === "admin") {
    // CRITICAL: Customer model uses cartId (not cafeId)
    // Cart admin's _id should match the cartId in customer records
    // Convert user._id to ObjectId for proper matching
    const userId = user._id._id || user._id;
    query.cartId = mongoose.Types.ObjectId.isValid(userId)
      ? new mongoose.Types.ObjectId(userId)
      : userId;
  } else if (user.role === "franchise_admin") {
    const userId = user._id._id || user._id;
    query.franchiseId = mongoose.Types.ObjectId.isValid(userId)
      ? new mongoose.Types.ObjectId(userId)
      : userId;
  }
  // Super admin sees all (no filter)
  return query;
};

// Get all customers with statistics
exports.getAllCustomers = async (req, res) => {
  try {
    const hierarchyQuery = buildHierarchyQuery(req.user);
    const { search, sortBy = "lastVisitAt", sortOrder = "desc" } = req.query;

    // Build the final query
    let query = {};

    // Start with hierarchy query (cartId or franchiseId filter)
    if (Object.keys(hierarchyQuery).length > 0) {
      query = { ...hierarchyQuery };
    }

    // Add search filter if provided - combine with hierarchy using $and
    if (search && search.trim()) {
      const searchConditions = [
        { name: { $regex: search.trim(), $options: "i" } },
        { email: { $regex: search.trim(), $options: "i" } },
        { phone: { $regex: search.trim().replace(/\D/g, ""), $options: "i" } }, // Normalize phone for search
      ];

      if (Object.keys(hierarchyQuery).length > 0) {
        // Combine hierarchy filter with search using $and
        query = {
          $and: [hierarchyQuery, { $or: searchConditions }],
        };
      } else {
        // No hierarchy filter (super admin) - just use search
        query.$or = searchConditions;
      }
    }

    // Build sort object
    const sort = {};
    sort[sortBy] = sortOrder === "asc" ? 1 : -1;

    // Convert ObjectIds in query to proper ObjectId types for aggregation
    const aggregationQuery = JSON.parse(JSON.stringify(query)); // Deep clone

    // Helper to convert ObjectId strings to ObjectId objects
    const convertToObjectId = (value) => {
      if (!value) return value;
      if (mongoose.Types.ObjectId.isValid(value)) {
        return new mongoose.Types.ObjectId(value);
      }
      return value;
    };

    // Convert cartId and franchiseId in query
    // Customer model uses cartId, not cafeId
    if (aggregationQuery.cartId) {
      aggregationQuery.cartId = convertToObjectId(aggregationQuery.cartId);
    }
    // Support old cafeId field for backward compatibility
    if (aggregationQuery.cafeId) {
      aggregationQuery.cafeId = convertToObjectId(aggregationQuery.cafeId);
    }
    if (aggregationQuery.franchiseId) {
      aggregationQuery.franchiseId = convertToObjectId(
        aggregationQuery.franchiseId
      );
    }

    // Convert ObjectIds in $and conditions
    if (aggregationQuery.$and) {
      aggregationQuery.$and = aggregationQuery.$and.map((condition) => {
        const newCondition = { ...condition };
        // Support both cartId (new) and cafeId (old) for backward compatibility
        if (condition.cartId) {
          newCondition.cartId = convertToObjectId(condition.cartId);
        }
        if (condition.cafeId) {
          newCondition.cafeId = convertToObjectId(condition.cafeId);
        }
        if (condition.franchiseId) {
          newCondition.franchiseId = convertToObjectId(condition.franchiseId);
        }
        // Handle nested $or conditions
        if (condition.$or) {
          newCondition.$or = condition.$or;
        }
        return newCondition;
      });
    }

    console.log(
      "[CUSTOMER] Query for getAllCustomers:",
      JSON.stringify(query, null, 2)
    );
    console.log(
      "[CUSTOMER] Aggregation query (with ObjectIds):",
      JSON.stringify(aggregationQuery, null, 2)
    );
    console.log(
      "[CUSTOMER] User role:",
      req.user?.role,
      "User ID:",
      req.user?._id
    );
    console.log(
      "[CUSTOMER] User ID type:",
      typeof req.user?._id,
      "Value:",
      req.user?._id
    );

    // First, let's check if ANY customers exist with this cartId (for debugging)
    const userIdForTest = req.user?._id?._id || req.user?._id;
    const testCartId = mongoose.Types.ObjectId.isValid(userIdForTest)
      ? new mongoose.Types.ObjectId(userIdForTest)
      : userIdForTest;

    // Test 1: Count all customers with this cartId (support both cartId and cafeId for backward compatibility)
    const testCount = await Customer.countDocuments({ 
      $or: [
        { cartId: testCartId },
        { cafeId: testCartId } // Old format
      ]
    });
    console.log(
      "[CUSTOMER] DEBUG - Total customers with cartId matching user._id:",
      testCount
    );
    console.log("[CUSTOMER] DEBUG - testCartId:", testCartId?.toString());

    // Test 2: Count all customers (no filter)
    const totalCustomers = await Customer.countDocuments({});
    console.log(
      "[CUSTOMER] DEBUG - Total customers in database:",
      totalCustomers
    );

    // Test 3: Get sample customers with this cartId
    if (testCount > 0) {
      const sampleCustomers = await Customer.find({ 
        $or: [
          { cartId: testCartId },
          { cafeId: testCartId } // Old format
        ]
      })
        .limit(3)
        .lean();
      console.log(
        "[CUSTOMER] DEBUG - Sample customers in DB:",
        sampleCustomers.map((c) => ({
          _id: c._id.toString(),
          name: c.name,
          phone: c.phone,
          email: c.email,
          cartId: c.cartId ? c.cartId.toString() : null,
          cafeId: c.cafeId ? c.cafeId.toString() : null, // Old format
          cartIdType: c.cartId ? typeof c.cartId : "null",
          ratingsCount: c.ratings?.length || 0,
          averageRating: c.averageRating,
        }))
      );
    } else {
      // If no customers found, check if there are customers with different cafeId formats
      const allCustomersSample = await Customer.find({}).limit(5).lean();
      console.log(
        "[CUSTOMER] DEBUG - Sample of ALL customers (any cafeId):",
        allCustomersSample.map((c) => ({
          _id: c._id.toString(),
          name: c.name,
          cafeId: c.cafeId ? c.cafeId.toString() : null,
          cafeIdType: c.cafeId ? typeof c.cafeId : "null",
        }))
      );
    }

    // Helper to run aggregation with ratings count
    const runAggregation = async () => {
      try {
        const result = await Customer.aggregate([
          { $match: aggregationQuery },
          {
            $project: {
              name: 1,
              email: 1,
              phone: 1,
              visitCount: 1,
              firstVisitAt: 1,
              lastVisitAt: 1,
              averageRating: 1,
              totalSpent: 1,
              lastOrderId: 1,
              cafeId: 1,
              franchiseId: 1,
              createdAt: 1,
              updatedAt: 1,
              totalRatings: { $size: { $ifNull: ["$ratings", []] } },
              latestRating: {
                $cond: {
                  if: { $gt: [{ $size: { $ifNull: ["$ratings", []] } }, 0] },
                  then: { $arrayElemAt: ["$ratings.rating", -1] },
                  else: null,
                },
              },
            },
          },
          { $sort: sort },
        ]);
        return result;
      } catch (aggError) {
        console.error("[CUSTOMER] Aggregation error:", aggError);
        // Fallback to regular find if aggregation fails
        console.log("[CUSTOMER] Falling back to regular find() query");
        const customers = await Customer.find(query).sort(sort).lean();
        return customers.map((c) => ({
          ...c,
          totalRatings: c.ratings?.length || 0,
          latestRating:
            c.ratings && c.ratings.length > 0
              ? c.ratings[c.ratings.length - 1].rating
              : null,
        }));
      }
    };

    // Fetch customers with ratings count using aggregation
    let customersWithRatingsCount = await runAggregation();

    // If no customers found for this cafe/franchise, try to backfill from orders
    if (
      customersWithRatingsCount.length === 0 &&
      (req.user?.role === "admin" || req.user?.role === "franchise_admin")
    ) {
      console.log(
        "[CUSTOMER] No customers found for this cafe/franchise, attempting sync from orders..."
      );
      const createdCount = await syncCustomersFromOrders(req.user);
      console.log(
        "[CUSTOMER] syncCustomersFromOrders created customers:",
        createdCount
      );
      if (createdCount > 0) {
        // Re-run aggregation to pick up newly created customers
        customersWithRatingsCount = await runAggregation();
      }
    }

    console.log(
      "[CUSTOMER] Found customers:",
      customersWithRatingsCount.length
    );
    if (customersWithRatingsCount.length > 0) {
      console.log("[CUSTOMER] Sample customer:", {
        name: customersWithRatingsCount[0].name,
        phone: customersWithRatingsCount[0].phone,
        email: customersWithRatingsCount[0].email,
        cartId: customersWithRatingsCount[0].cartId || customersWithRatingsCount[0].cafeId, // Support both cartId and cafeId
        totalRatings: customersWithRatingsCount[0].totalRatings,
        averageRating: customersWithRatingsCount[0].averageRating,
      });
    }

    // Convert ObjectIds to strings for JSON serialization
    const customersWithStats = customersWithRatingsCount.map((customer) => ({
      ...customer,
      _id: customer._id.toString(),
      cartId: customer.cartId ? customer.cartId.toString() : null,
      cafeId: customer.cafeId ? customer.cafeId.toString() : null, // Old format for backward compatibility
      franchiseId: customer.franchiseId
        ? customer.franchiseId.toString()
        : null,
      lastOrderId: customer.lastOrderId
        ? customer.lastOrderId.toString()
        : null,
    }));

    return res.json({
      customers: customersWithStats,
      total: customersWithStats.length,
    });
  } catch (err) {
    console.error("Error fetching customers:", err);
    return res.status(500).json({ message: err.message });
  }
};

// Get single customer with full details
exports.getCustomer = async (req, res) => {
  try {
    const { id } = req.params;
    const query = { _id: id, ...buildHierarchyQuery(req.user) };

    const customer = await Customer.findOne(query)
      .populate("lastOrderId", "_id status createdAt")
      .lean();

    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }

    // Get all feedbacks for this customer
    const feedbacks = await Feedback.find({
      customerPhone: customer.phone,
      ...buildHierarchyQuery(req.user),
    })
      .populate("tableId", "number name")
      .sort({ createdAt: -1 })
      .lean();

    // Get all orders for this customer
    const orders = await Order.find({
      $or: [
        { customerPhone: customer.phone },
        { customerEmail: customer.email },
      ],
      ...buildHierarchyQuery(req.user),
    })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();

    // Calculate total spent
    const totalSpent = orders.reduce((sum, order) => {
      const latestKot =
        order.kotLines && order.kotLines.length > 0
          ? order.kotLines[order.kotLines.length - 1]
          : null;
      return sum + (latestKot?.totalAmount || 0);
    }, 0);

    // Update customer totalSpent if different
    if (customer.totalSpent !== totalSpent) {
      await Customer.findByIdAndUpdate(id, { totalSpent });
      customer.totalSpent = totalSpent;
    }

    return res.json({
      ...customer,
      feedbacks,
      orders: orders.slice(0, 10), // Return last 10 orders
      totalOrders: orders.length,
      totalSpent,
    });
  } catch (err) {
    console.error("Error fetching customer:", err);
    return res.status(500).json({ message: err.message });
  }
};

// Get customer statistics
exports.getCustomerStats = async (req, res) => {
  try {
    const query = buildHierarchyQuery(req.user);

    const customers = await Customer.find(query).lean();

    const stats = {
      totalCustomers: customers.length,
      totalVisits: customers.reduce((sum, c) => sum + (c.visitCount || 0), 0),
      averageVisits:
        customers.length > 0
          ? (
              customers.reduce((sum, c) => sum + (c.visitCount || 0), 0) /
              customers.length
            ).toFixed(2)
          : 0,
      averageRating: 0,
      customersWithRatings: 0,
      ratingDistribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
      topCustomers: [],
    };

    let totalRating = 0;
    let ratingCount = 0;

    customers.forEach((customer) => {
      if (customer.ratings && customer.ratings.length > 0) {
        stats.customersWithRatings++;
        customer.ratings.forEach((rating) => {
          totalRating += rating.rating;
          ratingCount++;
          stats.ratingDistribution[rating.rating]++;
        });
      }
    });

    if (ratingCount > 0) {
      stats.averageRating = (totalRating / ratingCount).toFixed(2);
    }

    // Get top customers by visit count
    stats.topCustomers = customers
      .sort((a, b) => (b.visitCount || 0) - (a.visitCount || 0))
      .slice(0, 10)
      .map((c) => ({
        name: c.name,
        phone: c.phone,
        visitCount: c.visitCount || 0,
        averageRating: c.averageRating || 0,
        totalRatings: c.ratings?.length || 0,
      }));

    return res.json(stats);
  } catch (err) {
    console.error("Error fetching customer stats:", err);
    return res.status(500).json({ message: err.message });
  }
};

// Search customers
exports.searchCustomers = async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 2) {
      return res.json({ customers: [] });
    }

    const hierarchyQuery = buildHierarchyQuery(req.user);
    const searchConditions = [
      { name: { $regex: q, $options: "i" } },
      { email: { $regex: q, $options: "i" } },
      { phone: { $regex: q.replace(/\D/g, ""), $options: "i" } },
    ];

    // Combine hierarchy query with search using $and
    const query = {};
    if (Object.keys(hierarchyQuery).length > 0) {
      query.$and = [hierarchyQuery, { $or: searchConditions }];
    } else {
      // No hierarchy filter (super admin) - just use search
      query.$or = searchConditions;
    }

    const customers = await Customer.find(query)
      .select("name email phone visitCount averageRating")
      .sort({ lastVisitAt: -1 })
      .limit(20)
      .lean();

    return res.json({ customers });
  } catch (err) {
    console.error("Error searching customers:", err);
    return res.status(500).json({ message: err.message });
  }
};
