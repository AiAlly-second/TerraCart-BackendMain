const mongoose = require("mongoose");
const Feedback = require("../models/feedbackModel");
const Customer = require("../models/customerModel");
const Order = require("../models/orderModel");

const toObjectIdIfValid = (value) => {
  if (!value) return value;
  return mongoose.Types.ObjectId.isValid(value)
    ? new mongoose.Types.ObjectId(value)
    : value;
};

// Helper function to build query based on user role
// CRITICAL: Cart admins must only see their own data (filtered by cartId)
const buildHierarchyQuery = (user) => {
  const query = {};
  if (user.role === "admin") {
    // CRITICAL: Cart admin - ONLY see feedback from their own cart
    // Support both cartId (new) and cafeId (legacy) feedback docs.
    const cartId = toObjectIdIfValid(user._id?._id || user._id);
    query.$or = [{ cartId }, { cafeId: cartId }];
    console.log(
      `[FEEDBACK_QUERY] Cart admin ${user._id} - filtering by cartId/cafeId: ${cartId}`
    );
  } else if (user.role === "franchise_admin") {
    // Franchise admin - see feedback from all carts under their franchise
    query.franchiseId = toObjectIdIfValid(user._id?._id || user._id);
  }
  return query;
};

// Helper function to normalize phone number
const normalizePhone = (phone) => {
  if (!phone) return null;
  // Remove all non-digit characters
  return phone.replace(/\D/g, "");
};

// Helper function to find or create customer
const findOrCreateCustomer = async (customerData, cafeId, franchiseId) => {
  const { name, email, phone } = customerData;

  // Phone or email is required (at least one)
  if (!phone && !email) {
    throw new Error("Phone number or email is required to track customer");
  }

  const normalizedPhone = phone ? normalizePhone(phone) : null;
  const normalizedEmail = email ? email.trim().toLowerCase() : null;

  if (phone && !normalizedPhone) {
    throw new Error("Invalid phone number");
  }

  if (email && !normalizedEmail) {
    throw new Error("Invalid email address");
  }

  // Build search query - match by phone (primary) or email (secondary)
  let query = {};

  if (normalizedPhone && normalizedEmail) {
    // Both phone and email provided - search by either
    query = {
      $or: [{ phone: normalizedPhone }, { email: normalizedEmail }],
    };
  } else if (normalizedPhone) {
    // Only phone provided
    query = { phone: normalizedPhone };
  } else if (normalizedEmail) {
    // Only email provided
    query = { email: normalizedEmail };
  }

  // Also filter by cart/franchise to avoid cross-cart matches
  // Customer model uses cartId (not cafeId)
  if (cafeId) {
    const cartIdValue = cafeId._id || cafeId; // cafeId variable contains cartId value
    // Convert to ObjectId if it's a string
    const cartIdObj = mongoose.Types.ObjectId.isValid(cartIdValue) 
      ? new mongoose.Types.ObjectId(cartIdValue) 
      : cartIdValue;
    const cartScopeCondition = {
      $or: [{ cartId: cartIdObj }, { cafeId: cartIdObj }],
    };
    
    // Remove $or from top level if it exists and move to $and
    if (query.$or) {
      const orCondition = query.$or;
      query = {
        $and: [
        { $or: orCondition },
        cartScopeCondition,
      ],
      };
    } else {
      query = {
        $and: [query, cartScopeCondition],
      };
    }
  } else if (franchiseId) {
    const franchiseIdValue = franchiseId._id || franchiseId;
    const franchiseIdObj = mongoose.Types.ObjectId.isValid(franchiseIdValue) 
      ? new mongoose.Types.ObjectId(franchiseIdValue) 
      : franchiseIdValue;
    
    if (query.$or) {
      const orCondition = query.$or;
      delete query.$or;
      query.$and = [
        { $or: orCondition },
        { franchiseId: franchiseIdObj }
      ];
    } else {
      query.franchiseId = franchiseIdObj;
    }
  }

  // Try to find existing customer
  console.log(`[FEEDBACK] Customer search query:`, JSON.stringify(query, null, 2));
  let customer = await Customer.findOne(query);
  console.log(`[FEEDBACK] Customer lookup result:`, customer ? {
    found: true,
    customerId: customer._id.toString(),
    name: customer.name,
    phone: customer.phone,
    email: customer.email,
    cartId: customer.cartId ? customer.cartId.toString() : null,
  } : { found: false });

  if (customer) {
    // Customer exists - update info if needed and increment visit
    let updated = false;

    // Update name if provided and different
    if (name && name.trim() && customer.name !== name.trim()) {
      customer.name = name.trim();
      updated = true;
    }

    // Update email if provided and different
    if (
      normalizedEmail &&
      (!customer.email || customer.email !== normalizedEmail)
    ) {
      customer.email = normalizedEmail;
      updated = true;
    }

    // Update phone if provided and different (and not a placeholder)
    if (
      normalizedPhone &&
      customer.phone &&
      !customer.phone.startsWith("email-") &&
      customer.phone !== normalizedPhone
    ) {
      customer.phone = normalizedPhone;
      updated = true;
    }

    // If customer has placeholder phone but now has real phone, update it
    if (
      normalizedPhone &&
      customer.phone &&
      customer.phone.startsWith("email-")
    ) {
      customer.phone = normalizedPhone;
      updated = true;
    }

    // If customer has no phone but now has one, update it
    if (normalizedPhone && !customer.phone) {
      customer.phone = normalizedPhone;
      updated = true;
    }

    // Increment visit count
    customer.incrementVisit();
    updated = true;

    if (updated) {
      await customer.save();
    }

    const identifier =
      customer.phone && !customer.phone.startsWith("email-")
        ? customer.phone
        : customer.email || "Unknown";
    console.log(
      `✅ Found existing customer: ${customer.name} (${identifier}) - Visit #${customer.visitCount}`
    );
  } else {
    // Create new customer
    // Phone is required in schema, so use a placeholder if only email provided
    const phoneForNewCustomer = normalizedPhone || `email-${Date.now()}`;

    // Customer model uses cartId (not cafeId)
    const cafeIdValue = cafeId ? (cafeId._id || cafeId) : null;
    const cafeIdObj = cafeIdValue && mongoose.Types.ObjectId.isValid(cafeIdValue) 
      ? new mongoose.Types.ObjectId(cafeIdValue) 
      : cafeIdValue;
    
    const franchiseIdValue = franchiseId ? (franchiseId._id || franchiseId) : null;
    const franchiseIdObj = franchiseIdValue && mongoose.Types.ObjectId.isValid(franchiseIdValue) 
      ? new mongoose.Types.ObjectId(franchiseIdValue) 
      : franchiseIdValue;
    
    customer = await Customer.create({
      name: name ? name.trim() : "Guest",
      email: normalizedEmail || null,
      phone: phoneForNewCustomer,
      cartId: cafeIdObj, // Customer model uses cartId
      franchiseId: franchiseIdObj,
      visitCount: 1,
      firstVisitAt: new Date(),
      lastVisitAt: new Date(),
      ratings: [],
      averageRating: 0,
    });

    console.log(
      `✅ Created new customer: ${customer.name} (${
        customer.phone || customer.email
      })`
    );
  }

  return customer;
};

// Get all feedback
exports.getAllFeedback = async (req, res) => {
  try {
    const query = buildHierarchyQuery(req.user);
    const feedbacks = await Feedback.find(query)
      .populate("tableId", "number name")
      .sort({ createdAt: -1 });
    return res.json(feedbacks);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Get single feedback
exports.getFeedback = async (req, res) => {
  try {
    const { id } = req.params;
    const query = { _id: id, ...buildHierarchyQuery(req.user) };
    const feedback = await Feedback.findOne(query).populate(
      "tableId",
      "number name"
    );

    if (!feedback) {
      return res.status(404).json({ message: "Feedback not found" });
    }
    return res.json(feedback);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Create feedback with customer tracking
exports.createFeedback = async (req, res) => {
  try {
    const feedbackData = { ...req.body };
    let cafeId = null;
    let franchiseId = null;
    let customer = null;
    let resolvedOrder = null;

    // If orderId is provided, fetch order to get cafeId, franchiseId, and tableId
    if (feedbackData.orderId) {
      try {
        // Order._id is a String, not ObjectId, so use findById with the string directly
        resolvedOrder = await Order.findById(feedbackData.orderId);
        if (resolvedOrder) {
          // Order model uses cartId, and feedback model also uses cartId
          // Map cartId to cartId for feedback
          feedbackData.cartId = resolvedOrder.cartId
            ? resolvedOrder.cartId._id || resolvedOrder.cartId
            : null;
          feedbackData.franchiseId = resolvedOrder.franchiseId
            ? resolvedOrder.franchiseId._id || resolvedOrder.franchiseId
            : null;
          cafeId = feedbackData.cartId; // Keep cafeId variable for customer lookup (Customer model uses cartId)
          franchiseId = feedbackData.franchiseId;
          if (resolvedOrder.table && !feedbackData.tableId) {
            feedbackData.tableId = resolvedOrder.table._id || resolvedOrder.table;
          }
          console.log(`✅ Found order ${feedbackData.orderId} - cafeId: ${cafeId}, franchiseId: ${franchiseId}`);
        } else {
          console.warn(`Order not found for orderId: ${feedbackData.orderId}`);
        }
      } catch (orderErr) {
        console.error("Error fetching order:", orderErr);
        // Continue without order data - feedback can still be created
      }
    }

    // Set hierarchy relationships if table is provided (but order wasn't)
    if (feedbackData.tableId && !feedbackData.cartId) {
      try {
        const Table = require("../models/tableModel");
        const tableIdObj = mongoose.Types.ObjectId.isValid(feedbackData.tableId)
          ? new mongoose.Types.ObjectId(feedbackData.tableId)
          : feedbackData.tableId;

        const table = await Table.findById(tableIdObj);
        if (table) {
          const tableCartId = table.cartId || table.cafeId; // Table model uses cartId
          feedbackData.cartId = tableCartId
            ? (tableCartId._id || tableCartId)
            : null;
          feedbackData.franchiseId = table.franchiseId
            ? (table.franchiseId._id || table.franchiseId)
            : null;
          cafeId = feedbackData.cartId; // Keep cafeId variable for customer lookup (Customer model uses cartId)
          franchiseId = feedbackData.franchiseId;
          console.log(`✅ Found table ${feedbackData.tableId} - cartId: ${feedbackData.cartId}, franchiseId: ${franchiseId}`);
        } else {
          console.warn(`Table not found for tableId: ${feedbackData.tableId}`);
        }
      } catch (tableErr) {
        console.error("Error fetching table:", tableErr);
        // Continue without table data
      }
    }

    // Extract customer information
    const customerInfo = {
      name: feedbackData.customerName || req.body.name,
      email: feedbackData.customerEmail || req.body.email,
      phone: feedbackData.customerPhone || req.body.phone,
    };

    // Fallback customer identity from order when feedback form omits contact fields.
    if (resolvedOrder) {
      if (!customerInfo.name && resolvedOrder.customerName) {
        customerInfo.name = resolvedOrder.customerName;
      }
      if (!customerInfo.email && resolvedOrder.customerEmail) {
        customerInfo.email = resolvedOrder.customerEmail;
      }
      if (!customerInfo.phone && resolvedOrder.customerMobile) {
        customerInfo.phone = resolvedOrder.customerMobile;
      }
    }

    if (customerInfo.name && !feedbackData.customerName) {
      feedbackData.customerName = String(customerInfo.name).trim();
    }

    if (customerInfo.email) {
      const normalizedEmail = String(customerInfo.email).trim().toLowerCase();
      customerInfo.email = normalizedEmail || null;
      if (normalizedEmail) {
        feedbackData.customerEmail = normalizedEmail;
      }
    }

    if (customerInfo.phone) {
      const normalizedPhone = normalizePhone(String(customerInfo.phone));
      customerInfo.phone = normalizedPhone || null;
      if (normalizedPhone) {
        feedbackData.customerPhone = normalizedPhone;
      }
    }

    // If customer info is provided (phone OR email), find or create customer
    if (customerInfo.phone || customerInfo.email) {
      try {
        console.log(`[FEEDBACK] Attempting to find/create customer:`, {
          name: customerInfo.name,
          phone: customerInfo.phone,
          email: customerInfo.email,
          cafeId: cafeId ? (cafeId.toString ? cafeId.toString() : cafeId) : null,
          franchiseId: franchiseId ? (franchiseId.toString ? franchiseId.toString() : franchiseId) : null,
        });
        
        customer = await findOrCreateCustomer(
          customerInfo,
          cafeId,
          franchiseId
        );
        
        console.log(`[FEEDBACK] Customer found/created:`, {
          customerId: customer._id.toString(),
          name: customer.name,
          phone: customer.phone,
          email: customer.email,
          cafeId: customer.cafeId ? customer.cafeId.toString() : null,
          currentRatingsCount: customer.ratings?.length || 0,
        });

        // If cartId was not set from order/table, try to get it from existing customer
        if (!feedbackData.cartId && customer && customer.cartId) {
          feedbackData.cartId = customer.cartId._id || customer.cartId;
          cafeId = feedbackData.cartId; // Keep cafeId variable for customer lookup
          if (customer.franchiseId) {
            feedbackData.franchiseId = customer.franchiseId._id || customer.franchiseId;
            franchiseId = feedbackData.franchiseId;
          }
          console.log(`✅ Set cafeId from existing customer: ${cafeId}`);
        }

        // Prepare rating data to add to customer
        const ratingData = {
          rating: feedbackData.overallRating,
          feedbackId: null, // Will be set after feedback is created
          orderId: feedbackData.orderId || null,
          createdAt: new Date(),
          comments:
            feedbackData.orderFeedback?.comments ||
            feedbackData.overallExperience?.overallComments ||
            null,
          foodQuality: feedbackData.orderFeedback?.foodQuality || null,
          serviceSpeed: feedbackData.orderFeedback?.serviceSpeed || null,
          orderAccuracy: feedbackData.orderFeedback?.orderAccuracy || null,
          ambiance: feedbackData.overallExperience?.ambiance || null,
          cleanliness: feedbackData.overallExperience?.cleanliness || null,
          staffBehavior: feedbackData.overallExperience?.staffBehavior || null,
          valueForMoney: feedbackData.overallExperience?.valueForMoney || null,
        };

        // Add rating to customer (preserve all previous ratings)
        customer.ratings.push(ratingData);
        customer.updateAverageRating();

        // Update last order if provided
        if (feedbackData.orderId) {
          customer.lastOrderId = feedbackData.orderId;
        }

        await customer.save();
        console.log(
          `✅ Added rating to customer ${customer.name} - Total ratings: ${customer.ratings.length}`
        );
      } catch (customerErr) {
        console.error("Error processing customer:", customerErr);
        // Continue with feedback creation even if customer processing fails
      }
    }

    // CRITICAL: Ensure cartId is set before creating feedback
    // If still not set, try to get it from customer (if customer exists and has cartId)
    if (!feedbackData.cartId && customer && customer.cartId) {
      feedbackData.cartId = customer.cartId._id || customer.cartId;
      cafeId = feedbackData.cartId; // Keep cafeId variable for customer lookup
      if (customer.franchiseId) {
        feedbackData.franchiseId = customer.franchiseId._id || customer.franchiseId;
        franchiseId = feedbackData.franchiseId;
      }
      console.log(`✅ Set cafeId from customer record: ${cafeId}`);
    }
    
    // Warn if cartId is still not set - feedback won't show in admin panel for specific carts
    if (!feedbackData.cartId) {
      console.warn(
        `⚠️ WARNING: Feedback created without cartId! OrderId: ${feedbackData.orderId || "N/A"}, ` +
        `TableId: ${feedbackData.tableId || "N/A"}, ` +
        `Customer: ${customer ? `${customer.name} (${customer.phone || customer.email})` : "N/A"}. ` +
        `This feedback will only be visible to super admin. Customer ratings may not be linked correctly.`
      );
    } else {
      console.log(`✅ Feedback will be created with cartId: ${feedbackData.cartId}`);
    }

    // Validate required fields before creating feedback
    if (!feedbackData.overallRating) {
      return res.status(400).json({ message: "Overall rating is required" });
    }

    // Ensure overallRating is a number between 1 and 5
    const overallRating = Number(feedbackData.overallRating);
    if (isNaN(overallRating) || overallRating < 1 || overallRating > 5) {
      return res
        .status(400)
        .json({ message: "Overall rating must be between 1 and 5" });
    }
    feedbackData.overallRating = overallRating;

    // Create feedback
    const feedback = await Feedback.create(feedbackData);

    // Update customer rating with feedback ID
    if (customer && customer.ratings.length > 0) {
      const lastRating = customer.ratings[customer.ratings.length - 1];
      if (!lastRating.feedbackId) {
        lastRating.feedbackId = feedback._id;
        await customer.save();
      }
    }

    await feedback.populate("tableId", "number name");

    // Include customer info in response
    const response = feedback.toObject();
    if (customer) {
      response.customer = {
        _id: customer._id,
        name: customer.name,
        email: customer.email,
        phone: customer.phone,
        visitCount: customer.visitCount,
        averageRating: customer.averageRating,
        totalRatings: customer.ratings.length,
      };
    }

    return res.status(201).json(response);
  } catch (err) {
    console.error("Error creating feedback:", err);
    return res.status(500).json({ message: err.message });
  }
};

// Get feedback statistics
exports.getFeedbackStats = async (req, res) => {
  try {
    const query = buildHierarchyQuery(req.user);
    const feedbacks = await Feedback.find(query);

    const stats = {
      total: feedbacks.length,
      averageRating: 0,
      ratingDistribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
      averageFoodQuality: 0,
      averageServiceSpeed: 0,
      averageOrderAccuracy: 0,
      averageAmbiance: 0,
      averageCleanliness: 0,
      averageStaffBehavior: 0,
      averageValueForMoney: 0,
    };

    if (feedbacks.length > 0) {
      let totalRating = 0;
      let totalFoodQuality = 0;
      let totalServiceSpeed = 0;
      let totalOrderAccuracy = 0;
      let totalAmbiance = 0;
      let totalCleanliness = 0;
      let totalStaffBehavior = 0;
      let totalValueForMoney = 0;

      let foodQualityCount = 0;
      let serviceSpeedCount = 0;
      let orderAccuracyCount = 0;
      let ambianceCount = 0;
      let cleanlinessCount = 0;
      let staffBehaviorCount = 0;
      let valueForMoneyCount = 0;

      feedbacks.forEach((fb) => {
        totalRating += fb.overallRating;
        stats.ratingDistribution[fb.overallRating]++;

        if (fb.orderFeedback?.foodQuality) {
          totalFoodQuality += fb.orderFeedback.foodQuality;
          foodQualityCount++;
        }
        if (fb.orderFeedback?.serviceSpeed) {
          totalServiceSpeed += fb.orderFeedback.serviceSpeed;
          serviceSpeedCount++;
        }
        if (fb.orderFeedback?.orderAccuracy) {
          totalOrderAccuracy += fb.orderFeedback.orderAccuracy;
          orderAccuracyCount++;
        }
        if (fb.overallExperience?.ambiance) {
          totalAmbiance += fb.overallExperience.ambiance;
          ambianceCount++;
        }
        if (fb.overallExperience?.cleanliness) {
          totalCleanliness += fb.overallExperience.cleanliness;
          cleanlinessCount++;
        }
        if (fb.overallExperience?.staffBehavior) {
          totalStaffBehavior += fb.overallExperience.staffBehavior;
          staffBehaviorCount++;
        }
        if (fb.overallExperience?.valueForMoney) {
          totalValueForMoney += fb.overallExperience.valueForMoney;
          valueForMoneyCount++;
        }
      });

      stats.averageRating = (totalRating / feedbacks.length).toFixed(2);
      stats.averageFoodQuality =
        foodQualityCount > 0
          ? (totalFoodQuality / foodQualityCount).toFixed(2)
          : 0;
      stats.averageServiceSpeed =
        serviceSpeedCount > 0
          ? (totalServiceSpeed / serviceSpeedCount).toFixed(2)
          : 0;
      stats.averageOrderAccuracy =
        orderAccuracyCount > 0
          ? (totalOrderAccuracy / orderAccuracyCount).toFixed(2)
          : 0;
      stats.averageAmbiance =
        ambianceCount > 0 ? (totalAmbiance / ambianceCount).toFixed(2) : 0;
      stats.averageCleanliness =
        cleanlinessCount > 0
          ? (totalCleanliness / cleanlinessCount).toFixed(2)
          : 0;
      stats.averageStaffBehavior =
        staffBehaviorCount > 0
          ? (totalStaffBehavior / staffBehaviorCount).toFixed(2)
          : 0;
      stats.averageValueForMoney =
        valueForMoneyCount > 0
          ? (totalValueForMoney / valueForMoneyCount).toFixed(2)
          : 0;
    }

    return res.json(stats);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};
