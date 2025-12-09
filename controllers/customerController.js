const mongoose = require("mongoose");
const Customer = require("../models/customerModel");
const Feedback = require("../models/feedbackModel");
const Order = require("../models/orderModel");

// Helper function to build query based on user role
// CRITICAL: Cart admins must only see their own data (filtered by cafeId)
const buildHierarchyQuery = (user) => {
  const query = {};
  if (user.role === "admin") {
    // CRITICAL: Customer model uses cafeId (not cartId)
    // Cart admin's _id should match the cafeId in customer records
    // Convert user._id to ObjectId for proper matching
    const userId = user._id._id || user._id;
    query.cafeId = mongoose.Types.ObjectId.isValid(userId) 
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
    
    // Start with hierarchy query (cafeId or franchiseId filter)
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
          $and: [
            hierarchyQuery,
            { $or: searchConditions }
          ]
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
    
    // Convert cafeId and franchiseId in query
    if (aggregationQuery.cafeId) {
      aggregationQuery.cafeId = convertToObjectId(aggregationQuery.cafeId);
    }
    if (aggregationQuery.franchiseId) {
      aggregationQuery.franchiseId = convertToObjectId(aggregationQuery.franchiseId);
    }
    
    // Convert ObjectIds in $and conditions
    if (aggregationQuery.$and) {
      aggregationQuery.$and = aggregationQuery.$and.map(condition => {
        const newCondition = { ...condition };
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
    
    console.log("[CUSTOMER] Query for getAllCustomers:", JSON.stringify(query, null, 2));
    console.log("[CUSTOMER] Aggregation query (with ObjectIds):", JSON.stringify(aggregationQuery, null, 2));
    console.log("[CUSTOMER] User role:", req.user?.role, "User ID:", req.user?._id);
    console.log("[CUSTOMER] User ID type:", typeof req.user?._id, "Value:", req.user?._id);
    
    // First, let's check if ANY customers exist with this cafeId (for debugging)
    const userIdForTest = req.user?._id?._id || req.user?._id;
    const testCafeId = mongoose.Types.ObjectId.isValid(userIdForTest) 
      ? new mongoose.Types.ObjectId(userIdForTest) 
      : userIdForTest;
    
    // Test 1: Count all customers with this cafeId
    const testCount = await Customer.countDocuments({ cafeId: testCafeId });
    console.log("[CUSTOMER] DEBUG - Total customers with cafeId matching user._id:", testCount);
    console.log("[CUSTOMER] DEBUG - testCafeId:", testCafeId?.toString());
    
    // Test 2: Count all customers (no filter)
    const totalCustomers = await Customer.countDocuments({});
    console.log("[CUSTOMER] DEBUG - Total customers in database:", totalCustomers);
    
    // Test 3: Get sample customers with this cafeId
    if (testCount > 0) {
      const sampleCustomers = await Customer.find({ cafeId: testCafeId }).limit(3).lean();
      console.log("[CUSTOMER] DEBUG - Sample customers in DB:", sampleCustomers.map(c => ({
        _id: c._id.toString(),
        name: c.name,
        phone: c.phone,
        email: c.email,
        cafeId: c.cafeId ? c.cafeId.toString() : null,
        cafeIdType: c.cafeId ? typeof c.cafeId : 'null',
        ratingsCount: c.ratings?.length || 0,
        averageRating: c.averageRating,
      })));
    } else {
      // If no customers found, check if there are customers with different cafeId formats
      const allCustomersSample = await Customer.find({}).limit(5).lean();
      console.log("[CUSTOMER] DEBUG - Sample of ALL customers (any cafeId):", allCustomersSample.map(c => ({
        _id: c._id.toString(),
        name: c.name,
        cafeId: c.cafeId ? c.cafeId.toString() : null,
        cafeIdType: c.cafeId ? typeof c.cafeId : 'null',
      })));
    }
    
    // Fetch customers with ratings count using aggregation
    let customersWithRatingsCount;
    try {
      customersWithRatingsCount = await Customer.aggregate([
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
              else: null
            }
          }
        }
      },
      { $sort: sort }
      ]);
    } catch (aggError) {
      console.error("[CUSTOMER] Aggregation error:", aggError);
      // Fallback to regular find if aggregation fails
      console.log("[CUSTOMER] Falling back to regular find() query");
      const customers = await Customer.find(query)
        .sort(sort)
        .lean();
      customersWithRatingsCount = customers.map(c => ({
        ...c,
        totalRatings: c.ratings?.length || 0,
        latestRating: c.ratings && c.ratings.length > 0 
          ? c.ratings[c.ratings.length - 1].rating 
          : null,
      }));
    }
    
    console.log("[CUSTOMER] Found customers:", customersWithRatingsCount.length);
    if (customersWithRatingsCount.length > 0) {
      console.log("[CUSTOMER] Sample customer:", {
        name: customersWithRatingsCount[0].name,
        phone: customersWithRatingsCount[0].phone,
        email: customersWithRatingsCount[0].email,
        cafeId: customersWithRatingsCount[0].cafeId,
        totalRatings: customersWithRatingsCount[0].totalRatings,
        averageRating: customersWithRatingsCount[0].averageRating,
      });
    }
    
    // Convert ObjectIds to strings for JSON serialization
    const customersWithStats = customersWithRatingsCount.map(customer => ({
      ...customer,
      _id: customer._id.toString(),
      cafeId: customer.cafeId ? customer.cafeId.toString() : null,
      franchiseId: customer.franchiseId ? customer.franchiseId.toString() : null,
      lastOrderId: customer.lastOrderId ? customer.lastOrderId.toString() : null,
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
      const latestKot = order.kotLines && order.kotLines.length > 0 
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
      averageVisits: customers.length > 0 
        ? (customers.reduce((sum, c) => sum + (c.visitCount || 0), 0) / customers.length).toFixed(2)
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
      .map(c => ({
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
      query.$and = [
        hierarchyQuery,
        { $or: searchConditions }
      ];
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

