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
    query.cafeId = user._id;
  } else if (user.role === "franchise_admin") {
    query.franchiseId = user._id;
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
    
    console.log("[CUSTOMER] Query for getAllCustomers:", JSON.stringify(query, null, 2));
    console.log("[CUSTOMER] User role:", req.user?.role, "User ID:", req.user?._id);
    
    const customers = await Customer.find(query)
      .sort(sort)
      .select("-ratings") // Don't send full ratings array initially
      .lean();
    
    console.log("[CUSTOMER] Found customers:", customers.length);
    if (customers.length > 0) {
      console.log("[CUSTOMER] Sample customer:", {
        name: customers[0].name,
        phone: customers[0].phone,
        email: customers[0].email,
        cafeId: customers[0].cafeId,
      });
    }
    
    // Add summary statistics
    const customersWithStats = customers.map(customer => ({
      ...customer,
      totalRatings: customer.ratings?.length || 0,
      latestRating: customer.ratings && customer.ratings.length > 0 
        ? customer.ratings[customer.ratings.length - 1].rating 
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

