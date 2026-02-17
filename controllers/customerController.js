const mongoose = require("mongoose");
const Customer = require("../models/customerModel");
const Feedback = require("../models/feedbackModel");
const Order = require("../models/orderModel");

const toObjectIdIfValid = (value) => {
  if (!value) return value;
  return mongoose.Types.ObjectId.isValid(value)
    ? new mongoose.Types.ObjectId(value)
    : value;
};

const normalizePhone = (phone) => {
  if (!phone) return null;
  const normalized = String(phone).replace(/\D/g, "");
  return normalized || null;
};

const normalizeEmail = (email) => {
  if (!email) return null;
  const normalized = String(email).trim().toLowerCase();
  return normalized || null;
};

const isPlaceholderPhone = (phone) => {
  if (!phone) return false;
  return String(phone).trim().toLowerCase().startsWith("email-");
};

const toTimestamp = (value) => {
  if (!value) return 0;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
};

const toUniqueStringList = (values = []) =>
  Array.from(
    new Set(
      (values || [])
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  );

const escapeRegex = (value) =>
  String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const extractOrderId = (value) => {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  if (value?._id) return String(value._id).trim();
  return String(value).trim();
};

const pickBetterName = (currentName, candidateName) => {
  const current = String(currentName || "").trim();
  const candidate = String(candidateName || "").trim();

  if (!candidate) return current;
  if (!current) return candidate;

  const currentIsGuest = current.toLowerCase() === "guest";
  const candidateIsGuest = candidate.toLowerCase() === "guest";

  if (currentIsGuest && !candidateIsGuest) return candidate;
  return current;
};

const getIdentityKeysForCustomer = (customer) => {
  const keys = [];
  const normalizedPhone = normalizePhone(customer?.phone);
  const normalizedEmail = normalizeEmail(customer?.email);
  const normalizedName = String(customer?.name || "").trim().toLowerCase();

  if (normalizedPhone && !isPlaceholderPhone(customer?.phone)) {
    keys.push(`phone:${normalizedPhone}`);
  }
  if (normalizedEmail) {
    keys.push(`email:${normalizedEmail}`);
  }
  if (!keys.length && normalizedName && normalizedName !== "guest") {
    keys.push(`name:${normalizedName}`);
  }
  if (!keys.length && customer?._id) {
    keys.push(`id:${String(customer._id)}`);
  }

  return keys;
};

const mergeUniqueRatings = (...ratingLists) => {
  const merged = new Map();

  const getRatingKey = (rating = {}) => {
    if (rating?.feedbackId) {
      return `feedback:${String(rating.feedbackId)}`;
    }

    const orderId = rating?.orderId ? String(rating.orderId) : "";
    const ratingValue = Number(rating?.rating || 0);
    const comments = String(rating?.comments || "").trim().toLowerCase();
    const createdAt = toTimestamp(rating?.createdAt);

    if (orderId || ratingValue || comments) {
      return `order:${orderId}|rating:${ratingValue}|comments:${comments}|at:${createdAt}`;
    }
    return null;
  };

  ratingLists.forEach((ratingList) => {
    (ratingList || []).forEach((rating) => {
      if (!rating) return;
      const key = getRatingKey(rating) || `anon:${merged.size}`;
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, { ...rating });
        return;
      }

      if (toTimestamp(rating.createdAt) > toTimestamp(existing.createdAt)) {
        merged.set(key, { ...existing, ...rating });
      }
    });
  });

  return Array.from(merged.values()).sort(
    (left, right) => toTimestamp(right?.createdAt) - toTimestamp(left?.createdAt),
  );
};

const mergeDuplicateCustomersForPanel = (customers = []) => {
  if (!Array.isArray(customers) || customers.length <= 1) {
    return Array.isArray(customers) ? customers : [];
  }

  const groups = new Map();
  const identityToGroup = new Map();

  const relinkGroup = (sourceGroupId, targetGroupId) => {
    if (!sourceGroupId || !targetGroupId || sourceGroupId === targetGroupId) {
      return;
    }

    const sourceGroup = groups.get(sourceGroupId) || [];
    const targetGroup = groups.get(targetGroupId) || [];
    groups.set(targetGroupId, [...targetGroup, ...sourceGroup]);
    groups.delete(sourceGroupId);

    for (const [identityKey, groupId] of identityToGroup.entries()) {
      if (groupId === sourceGroupId) {
        identityToGroup.set(identityKey, targetGroupId);
      }
    }
  };

  customers.forEach((customer) => {
    const identityKeys = getIdentityKeysForCustomer(customer);
    const existingGroupIds = toUniqueStringList(
      identityKeys.map((identityKey) => identityToGroup.get(identityKey)),
    );

    const groupId =
      existingGroupIds[0] || `group:${String(customer?._id || groups.size)}`;
    if (!groups.has(groupId)) {
      groups.set(groupId, []);
    }

    existingGroupIds.slice(1).forEach((otherGroupId) => {
      relinkGroup(otherGroupId, groupId);
    });

    groups.set(groupId, [...(groups.get(groupId) || []), customer]);
    identityKeys.forEach((identityKey) => identityToGroup.set(identityKey, groupId));
  });

  return Array.from(groups.values())
    .map((groupRecords) => {
      const records = (groupRecords || []).filter(Boolean);
      if (!records.length) return null;
      if (records.length === 1) return records[0];

      const sortedRecords = [...records].sort((left, right) => {
        const lastVisitDiff =
          toTimestamp(right?.lastVisitAt) - toTimestamp(left?.lastVisitAt);
        if (lastVisitDiff !== 0) return lastVisitDiff;
        return (
          toTimestamp(right?.updatedAt || right?.createdAt) -
          toTimestamp(left?.updatedAt || left?.createdAt)
        );
      });

      const primary = { ...sortedRecords[0] };
      const mergedRatings = mergeUniqueRatings(
        ...sortedRecords.map((record) => record?.ratings || []),
      );

      let name = String(primary?.name || "").trim() || "Guest";
      let phone = primary?.phone || null;
      let email = normalizeEmail(primary?.email) || null;
      let visitCount = Number(primary?.visitCount || 0);
      let totalSpent = Number(primary?.totalSpent || 0);
      let firstVisitAt = primary?.firstVisitAt || null;
      let lastVisitAt = primary?.lastVisitAt || null;
      let lastOrderId = primary?.lastOrderId || null;
      let cartId = primary?.cartId || primary?.cafeId || null;
      let cafeId = primary?.cafeId || primary?.cartId || null;
      let franchiseId = primary?.franchiseId || null;
      let latestRating = primary?.latestRating ?? null;

      let totalRatingsFromRows = Number(
        primary?.totalRatings ??
          (Array.isArray(primary?.ratings) ? primary.ratings.length : 0),
      );
      let weightedRatingSum =
        Number(primary?.averageRating || 0) * totalRatingsFromRows;

      for (let index = 1; index < sortedRecords.length; index += 1) {
        const record = sortedRecords[index];
        if (!record) continue;

        name = pickBetterName(name, record.name);

        const recordPhone = record.phone || null;
        const hasCurrentRealPhone = phone && !isPlaceholderPhone(phone);
        const hasRecordRealPhone = recordPhone && !isPlaceholderPhone(recordPhone);
        if ((!hasCurrentRealPhone && hasRecordRealPhone) || (!phone && recordPhone)) {
          phone = recordPhone;
        }

        const recordEmail = normalizeEmail(record.email) || null;
        if (!email && recordEmail) {
          email = recordEmail;
        }

        visitCount += Number(record.visitCount || 0);
        totalSpent += Number(record.totalSpent || 0);

        const recordFirstVisitTs = toTimestamp(record.firstVisitAt);
        const currentFirstVisitTs = toTimestamp(firstVisitAt);
        if (
          recordFirstVisitTs &&
          (!currentFirstVisitTs || recordFirstVisitTs < currentFirstVisitTs)
        ) {
          firstVisitAt = record.firstVisitAt;
        }

        const recordLastVisitTs = toTimestamp(record.lastVisitAt);
        const currentLastVisitTs = toTimestamp(lastVisitAt);
        if (recordLastVisitTs > currentLastVisitTs) {
          lastVisitAt = record.lastVisitAt;
          lastOrderId = record.lastOrderId || lastOrderId;
          if (record.latestRating !== undefined && record.latestRating !== null) {
            latestRating = record.latestRating;
          }
        }

        cartId = cartId || record.cartId || record.cafeId || null;
        cafeId = cafeId || record.cafeId || record.cartId || null;
        franchiseId = franchiseId || record.franchiseId || null;

        const recordTotalRatings = Number(
          record?.totalRatings ??
            (Array.isArray(record?.ratings) ? record.ratings.length : 0),
        );
        totalRatingsFromRows += recordTotalRatings;
        weightedRatingSum += Number(record?.averageRating || 0) * recordTotalRatings;
      }

      let totalRatings = totalRatingsFromRows;
      let averageRating = Number(primary?.averageRating || 0);

      if (mergedRatings.length > 0) {
        totalRatings = mergedRatings.length;
        averageRating = Number(
          (
            mergedRatings.reduce(
              (sum, rating) => sum + (Number(rating?.rating) || 0),
              0,
            ) / mergedRatings.length
          ).toFixed(2),
        );
      } else if (totalRatingsFromRows > 0) {
        averageRating = Number((weightedRatingSum / totalRatingsFromRows).toFixed(2));
      }

      return {
        ...primary,
        name: name || "Guest",
        phone: phone || primary.phone || null,
        email: email || primary.email || null,
        visitCount,
        totalSpent,
        firstVisitAt,
        lastVisitAt,
        lastOrderId,
        cartId,
        cafeId,
        franchiseId,
        ratings: mergedRatings.length > 0 ? mergedRatings : primary.ratings,
        totalRatings,
        latestRating,
        averageRating,
        mergedCustomerIds: sortedRecords.map((record) => String(record._id)),
      };
    })
    .filter(Boolean);
};

const sortCustomersForPanel = (
  customers = [],
  sortBy = "lastVisitAt",
  sortOrder = "desc",
) => {
  const direction = sortOrder === "asc" ? 1 : -1;

  return [...(customers || [])].sort((left, right) => {
    if (sortBy === "name") {
      return (
        String(left?.name || "").localeCompare(String(right?.name || "")) *
        direction
      );
    }

    if (["lastVisitAt", "firstVisitAt", "createdAt", "updatedAt"].includes(sortBy)) {
      return (toTimestamp(left?.[sortBy]) - toTimestamp(right?.[sortBy])) * direction;
    }

    const leftValue = Number(left?.[sortBy] || 0);
    const rightValue = Number(right?.[sortBy] || 0);
    return (leftValue - rightValue) * direction;
  });
};

const buildCustomerLookupQuery = ({ phone, email, cartId, franchiseId }) => {
  const normalizedPhone = normalizePhone(phone);
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedPhone && !normalizedEmail) return null;

  let query;
  if (normalizedPhone && normalizedEmail) {
    query = {
      $or: [{ phone: normalizedPhone }, { email: normalizedEmail }],
    };
  } else if (normalizedPhone) {
    query = { phone: normalizedPhone };
  } else {
    query = { email: normalizedEmail };
  }

  const resolvedCartId = toObjectIdIfValid(cartId?._id || cartId);
  const resolvedFranchiseId = toObjectIdIfValid(
    franchiseId?._id || franchiseId,
  );

  if (resolvedCartId) {
    const cartScope = {
      $or: [{ cartId: resolvedCartId }, { cafeId: resolvedCartId }],
    };
    if (query.$or) {
      return {
        $and: [{ $or: query.$or }, cartScope],
      };
    }
    return {
      $and: [query, cartScope],
    };
  }

  if (resolvedFranchiseId) {
    if (query.$or) {
      return {
        $and: [{ $or: query.$or }, { franchiseId: resolvedFranchiseId }],
      };
    }
    return {
      ...query,
      franchiseId: resolvedFranchiseId,
    };
  }

  return query;
};

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
    const userId = user._id._id || user._id;
    const cartId = toObjectIdIfValid(userId);
    // Support both cartId (new) and cafeId (legacy) data.
    query.$or = [{ cartId }, { cafeId: cartId }];
  } else if (user.role === "franchise_admin") {
    const userId = user._id._id || user._id;
    query.franchiseId = toObjectIdIfValid(userId);
  }
  // Super admin sees all (no filter)
  return query;
};

const buildOrderScopeQuery = (user) => {
  if (!user) return {};

  const userId = user._id?._id || user._id;
  if (user.role === "admin") {
    return { cartId: toObjectIdIfValid(userId) };
  }
  if (user.role === "franchise_admin") {
    return { franchiseId: toObjectIdIfValid(userId) };
  }
  return {};
};

const mergeUniqueDocsById = (...docLists) => {
  const merged = new Map();
  docLists.forEach((docList) => {
    (docList || []).forEach((doc) => {
      if (!doc?._id) return;
      const key = String(doc._id);
      if (!merged.has(key)) {
        merged.set(key, doc);
      }
    });
  });
  return Array.from(merged.values());
};

const syncCustomersFromFeedback = async (user) => {
  try {
    if (!user) return 0;
    if (user.role !== "admin" && user.role !== "franchise_admin") return 0;

    const hierarchyQuery = buildHierarchyQuery(user);
    const orderScopeQuery = buildOrderScopeQuery(user);
    const feedbackSelectFields =
      "_id orderId overallRating orderFeedback overallExperience customerName customerEmail customerPhone cartId franchiseId createdAt";

    const scopedOrders = await Order.find(orderScopeQuery)
      .select(
        "_id createdAt cartId franchiseId customerName customerMobile customerEmail",
      )
      .lean();

    const scopedOrderIds = scopedOrders
      .map((order) => (order?._id ? String(order._id).trim() : ""))
      .filter(Boolean);

    const [feedbacksByHierarchy, feedbacksByScopedOrders] = await Promise.all([
      Feedback.find(hierarchyQuery).select(feedbackSelectFields).lean(),
      scopedOrderIds.length > 0
        ? Feedback.find({ orderId: { $in: scopedOrderIds } })
            .select(feedbackSelectFields)
            .lean()
        : Promise.resolve([]),
    ]);

    const feedbacks = mergeUniqueDocsById(
      feedbacksByHierarchy,
      feedbacksByScopedOrders,
    );

    if (!feedbacks.length) {
      return 0;
    }

    const ordersById = new Map(
      scopedOrders.map((order) => [String(order._id), order]),
    );

    const feedbackOrderIds = Array.from(
      new Set(
        feedbacks
          .map((fb) => (fb?.orderId ? String(fb.orderId).trim() : ""))
          .filter(Boolean),
      ),
    );

    const missingOrderIds = feedbackOrderIds.filter(
      (orderId) => !ordersById.has(orderId),
    );
    if (missingOrderIds.length > 0) {
      const extraOrderQuery = { _id: { $in: missingOrderIds } };
      if (Object.keys(orderScopeQuery).length > 0) {
        Object.assign(extraOrderQuery, orderScopeQuery);
      }
      const extraOrders = await Order.find(extraOrderQuery)
        .select(
          "_id createdAt cartId franchiseId customerName customerMobile customerEmail",
        )
        .lean();
      extraOrders.forEach((order) => {
        ordersById.set(String(order._id), order);
      });
    }

    let updatedCustomers = 0;
    const userScopeCartId =
      user.role === "admin" ? toObjectIdIfValid(user._id?._id || user._id) : null;
    const userScopeFranchiseId =
      user.role === "franchise_admin"
        ? toObjectIdIfValid(user._id?._id || user._id)
        : null;

    for (const feedback of feedbacks) {
      const linkedOrder = feedback.orderId
        ? ordersById.get(String(feedback.orderId))
        : null;

      const phone =
        normalizePhone(feedback.customerPhone) ||
        normalizePhone(linkedOrder?.customerMobile);
      const email =
        normalizeEmail(feedback.customerEmail) ||
        normalizeEmail(linkedOrder?.customerEmail);
      const name =
        String(
          feedback.customerName || linkedOrder?.customerName || "Guest",
        ).trim() || "Guest";
      const fallbackOrderId = feedback?.orderId
        ? String(feedback.orderId).trim()
        : "";
      const normalizedName = String(name || "").trim();

      const resolvedCartId =
        feedback.cartId ||
        linkedOrder?.cartId ||
        userScopeCartId ||
        null;
      const resolvedFranchiseId =
        feedback.franchiseId ||
        linkedOrder?.franchiseId ||
        userScopeFranchiseId ||
        null;
      const resolvedCartIdObj = toObjectIdIfValid(
        resolvedCartId?._id || resolvedCartId,
      );
      const resolvedFranchiseIdObj = toObjectIdIfValid(
        resolvedFranchiseId?._id || resolvedFranchiseId,
      );

      const lookupQuery = buildCustomerLookupQuery({
        phone,
        email,
        cartId: resolvedCartIdObj,
        franchiseId: resolvedFranchiseIdObj,
      });

      if (!lookupQuery && !fallbackOrderId && !normalizedName) {
        continue;
      }

      let customer = lookupQuery ? await Customer.findOne(lookupQuery) : null;
      if (!customer) {
        const fallbackConditions = [];
        if (fallbackOrderId) {
          fallbackConditions.push({ lastOrderId: fallbackOrderId });
          fallbackConditions.push({ "ratings.orderId": fallbackOrderId });
        } else if (normalizedName && normalizedName.toLowerCase() !== "guest") {
          fallbackConditions.push({
            name: { $regex: new RegExp(`^${escapeRegex(normalizedName)}$`, "i") },
          });
        }

        if (fallbackConditions.length > 0) {
          const fallbackAnd = [{ $or: fallbackConditions }];
          if (resolvedCartIdObj) {
            fallbackAnd.push({
              $or: [{ cartId: resolvedCartIdObj }, { cafeId: resolvedCartIdObj }],
            });
          } else if (resolvedFranchiseIdObj) {
            fallbackAnd.push({ franchiseId: resolvedFranchiseIdObj });
          }

          const fallbackQuery =
            fallbackAnd.length === 1 ? fallbackAnd[0] : { $and: fallbackAnd };
          customer = await Customer.findOne(fallbackQuery);
        }
      }

      let shouldSave = false;

      if (!customer) {
        customer = new Customer({
          name,
          email: email || null,
          phone: phone || (email ? `email-${Date.now()}` : null),
          cartId: resolvedCartIdObj,
          franchiseId: resolvedFranchiseIdObj,
          visitCount: 1,
          firstVisitAt: linkedOrder?.createdAt || feedback.createdAt || new Date(),
          lastVisitAt: linkedOrder?.createdAt || feedback.createdAt || new Date(),
          ratings: [],
          averageRating: 0,
          lastOrderId: fallbackOrderId || linkedOrder?._id || null,
        });
        shouldSave = true;
      } else {
        if (name && customer.name !== name) {
          customer.name = name;
          shouldSave = true;
        }
        if (email && customer.email !== email) {
          customer.email = email;
          shouldSave = true;
        }
        if (phone) {
          const currentPhone = normalizePhone(customer.phone);
          if (!currentPhone || currentPhone !== phone) {
            customer.phone = phone;
            shouldSave = true;
          }
        }
        if (!customer.cartId && resolvedCartIdObj) {
          customer.cartId = resolvedCartIdObj;
          shouldSave = true;
        }
        if (!customer.franchiseId && resolvedFranchiseIdObj) {
          customer.franchiseId = resolvedFranchiseIdObj;
          shouldSave = true;
        }
      }

      const ratingValue = Number(feedback.overallRating);
      if (Number.isFinite(ratingValue) && ratingValue >= 1 && ratingValue <= 5) {
        const feedbackId = String(feedback._id);
        const existingRating = (customer.ratings || []).some((rating) => {
          if (rating?.feedbackId) {
            return String(rating.feedbackId) === feedbackId;
          }
          if (feedback.orderId && rating?.orderId) {
            const sameOrder = String(rating.orderId) === String(feedback.orderId);
            const sameRating = Number(rating.rating) === ratingValue;
            const sameComment =
              String(rating.comments || "").trim() ===
              String(
                feedback.orderFeedback?.comments ||
                  feedback.overallExperience?.overallComments ||
                  "",
              ).trim();
            return sameOrder && sameRating && sameComment;
          }
          return false;
        });

        if (!existingRating) {
          customer.ratings.push({
            rating: ratingValue,
            feedbackId: feedback._id,
            orderId: feedback.orderId || linkedOrder?._id || null,
            createdAt: feedback.createdAt || new Date(),
            comments:
              feedback.orderFeedback?.comments ||
              feedback.overallExperience?.overallComments ||
              null,
            foodQuality: feedback.orderFeedback?.foodQuality || null,
            serviceSpeed: feedback.orderFeedback?.serviceSpeed || null,
            orderAccuracy: feedback.orderFeedback?.orderAccuracy || null,
            ambiance: feedback.overallExperience?.ambiance || null,
            cleanliness: feedback.overallExperience?.cleanliness || null,
            staffBehavior: feedback.overallExperience?.staffBehavior || null,
            valueForMoney: feedback.overallExperience?.valueForMoney || null,
          });
          shouldSave = true;
        }
      }

      if (fallbackOrderId && customer.lastOrderId !== fallbackOrderId) {
        customer.lastOrderId = fallbackOrderId;
        shouldSave = true;
      }

      const latestVisitAt = linkedOrder?.createdAt || feedback.createdAt || null;
      if (latestVisitAt) {
        if (!customer.lastVisitAt || new Date(latestVisitAt) > new Date(customer.lastVisitAt)) {
          customer.lastVisitAt = latestVisitAt;
          shouldSave = true;
        }
        if (!customer.firstVisitAt) {
          customer.firstVisitAt = latestVisitAt;
          shouldSave = true;
        }
      }

      if (!customer.visitCount || customer.visitCount < 1) {
        customer.visitCount = 1;
        shouldSave = true;
      }

      if (shouldSave) {
        await customer.save();
        updatedCustomers += 1;
      }
    }

    return updatedCustomers;
  } catch (err) {
    console.error("[CUSTOMER_SYNC] Error syncing customers from feedback:", err);
    return 0;
  }
};

// Get all customers with statistics
exports.getAllCustomers = async (req, res) => {
  try {
    const hierarchyQuery = buildHierarchyQuery(req.user);
    const {
      search,
      sortBy = "lastVisitAt",
      sortOrder = "desc",
      includeAllSources = "false",
    } = req.query;
    const includeAllSourcesFlag =
      String(includeAllSources).toLowerCase() === "true";

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

    // Query already uses ObjectIds where needed; keep regex/search conditions intact.
    const aggregationQuery = query;

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
              cartId: 1,
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

    if (
      includeAllSourcesFlag &&
      (req.user?.role === "admin" || req.user?.role === "franchise_admin")
    ) {
      const syncedFromFeedback = await syncCustomersFromFeedback(req.user);
      if (syncedFromFeedback > 0) {
        console.log(
          "[CUSTOMER] syncCustomersFromFeedback updated customers:",
          syncedFromFeedback,
        );
        customersWithRatingsCount = await runAggregation();
      }
    }

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

    customersWithRatingsCount = sortCustomersForPanel(
      mergeDuplicateCustomersForPanel(customersWithRatingsCount),
      sortBy,
      sortOrder,
    );

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
    const hierarchyQuery = buildHierarchyQuery(req.user);
    const query = { _id: id, ...hierarchyQuery };

    const customer = await Customer.findOne(query)
      .populate("lastOrderId", "_id status createdAt")
      .lean();

    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }

    const combineWithHierarchy = (identityConditions) => {
      if (!identityConditions.length) return null;
      if (Object.keys(hierarchyQuery).length > 0) {
        return { $and: [hierarchyQuery, { $or: identityConditions }] };
      }
      return { $or: identityConditions };
    };

    const identityPhones = new Set();
    const identityEmails = new Set();
    const appendIdentity = ({ phone, email }) => {
      const normalizedPhone = normalizePhone(phone);
      if (normalizedPhone && !isPlaceholderPhone(phone)) {
        identityPhones.add(normalizedPhone);
      }

      const normalizedEmail = normalizeEmail(email);
      if (normalizedEmail) {
        identityEmails.add(normalizedEmail);
      }
    };

    appendIdentity({ phone: customer.phone, email: customer.email });

    let fallbackOrder = null;
    if (
      identityPhones.size === 0 &&
      identityEmails.size === 0 &&
      customer.lastOrderId
    ) {
      fallbackOrder = await Order.findById(extractOrderId(customer.lastOrderId))
        .select("_id customerMobile customerEmail")
        .lean();

      if (fallbackOrder) {
        appendIdentity({
          phone: fallbackOrder.customerMobile,
          email: fallbackOrder.customerEmail,
        });
      }
    }

    const duplicateIdentityConditions = [];
    identityPhones.forEach((phone) => {
      duplicateIdentityConditions.push({ phone });
      duplicateIdentityConditions.push({ phone: { $regex: new RegExp(`${phone}$`) } });
    });
    identityEmails.forEach((email) => {
      duplicateIdentityConditions.push({ email });
    });
    if (!duplicateIdentityConditions.length) {
      const normalizedCustomerName = String(customer?.name || "").trim();
      if (normalizedCustomerName && normalizedCustomerName.toLowerCase() !== "guest") {
        duplicateIdentityConditions.push({
          name: {
            $regex: new RegExp(`^${escapeRegex(normalizedCustomerName)}$`, "i"),
          },
        });
      }
    }

    const relatedCustomers = [customer];
    if (duplicateIdentityConditions.length > 0) {
      const siblingQuery =
        Object.keys(hierarchyQuery).length > 0
          ? {
              $and: [
                hierarchyQuery,
                { _id: { $ne: customer._id } },
                { $or: duplicateIdentityConditions },
              ],
            }
          : { _id: { $ne: customer._id }, $or: duplicateIdentityConditions };

      const siblingCustomers = await Customer.find(siblingQuery).lean();
      siblingCustomers.forEach((sibling) => {
        relatedCustomers.push(sibling);
        appendIdentity({ phone: sibling.phone, email: sibling.email });
      });
    }

    const relatedCustomerOrderIds = toUniqueStringList(
      relatedCustomers
        .map((relatedCustomer) => extractOrderId(relatedCustomer?.lastOrderId))
        .filter(Boolean),
    );

    const orderIdentityConditions = [];
    identityPhones.forEach((phone) => {
      const phoneSuffixRegex = new RegExp(`${phone}$`);
      orderIdentityConditions.push({ customerMobile: phone });
      orderIdentityConditions.push({ customerPhone: phone });
      orderIdentityConditions.push({ customerMobile: { $regex: phoneSuffixRegex } });
      orderIdentityConditions.push({ customerPhone: { $regex: phoneSuffixRegex } });
    });
    identityEmails.forEach((email) => {
      orderIdentityConditions.push({ customerEmail: email });
    });
    if (relatedCustomerOrderIds.length > 0) {
      orderIdentityConditions.push({ _id: { $in: relatedCustomerOrderIds } });
    }

    const orderQuery = combineWithHierarchy(orderIdentityConditions);
    const orders = await Order.find(orderQuery || { _id: null })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    const relatedOrderIds = toUniqueStringList([
      ...orders.map((order) => (order?._id ? String(order._id) : "")),
      ...relatedCustomerOrderIds,
    ]);

    const relatedNames = toUniqueStringList(
      relatedCustomers
        .map((relatedCustomer) => String(relatedCustomer?.name || "").trim())
        .filter((name) => name && name.toLowerCase() !== "guest"),
    );

    const feedbackIdentityConditions = [];
    identityPhones.forEach((phone) => {
      feedbackIdentityConditions.push({ customerPhone: phone });
      feedbackIdentityConditions.push({ customerPhone: { $regex: new RegExp(`${phone}$`) } });
    });
    identityEmails.forEach((email) => {
      feedbackIdentityConditions.push({ customerEmail: email });
    });
    if (!feedbackIdentityConditions.length && relatedNames.length > 0) {
      feedbackIdentityConditions.push({ customerName: { $in: relatedNames } });
    }

    const feedbackQuery = combineWithHierarchy(feedbackIdentityConditions);
    const [feedbacksByIdentity, feedbacksByOrders] = await Promise.all([
      Feedback.find(feedbackQuery || { _id: null })
        .populate("tableId", "number name")
        .sort({ createdAt: -1 })
        .lean(),
      relatedOrderIds.length > 0
        ? Feedback.find({ orderId: { $in: relatedOrderIds } })
            .populate("tableId", "number name")
            .sort({ createdAt: -1 })
            .lean()
        : Promise.resolve([]),
    ]);

    const feedbacks = mergeUniqueDocsById(feedbacksByIdentity, feedbacksByOrders).sort(
      (left, right) => toTimestamp(right?.createdAt) - toTimestamp(left?.createdAt),
    );

    const customerRatings = mergeUniqueRatings(
      ...relatedCustomers.map((relatedCustomer) =>
        Array.isArray(relatedCustomer?.ratings) ? relatedCustomer.ratings : [],
      ),
    );

    const feedbackDerivedRatings = feedbacks
      .map((feedback) => {
        const ratingValue = Number(feedback?.overallRating);
        if (!Number.isFinite(ratingValue) || ratingValue < 1 || ratingValue > 5) {
          return null;
        }

        return {
          rating: ratingValue,
          feedbackId: feedback._id,
          orderId: feedback.orderId || null,
          createdAt: feedback.createdAt || new Date(),
          comments:
            feedback.orderFeedback?.comments ||
            feedback.overallExperience?.overallComments ||
            null,
          foodQuality: feedback.orderFeedback?.foodQuality || null,
          serviceSpeed: feedback.orderFeedback?.serviceSpeed || null,
          orderAccuracy: feedback.orderFeedback?.orderAccuracy || null,
          ambiance: feedback.overallExperience?.ambiance || null,
          cleanliness: feedback.overallExperience?.cleanliness || null,
          staffBehavior: feedback.overallExperience?.staffBehavior || null,
          valueForMoney: feedback.overallExperience?.valueForMoney || null,
        };
      })
      .filter(Boolean);

    const mergedRatings = mergeUniqueRatings(customerRatings, feedbackDerivedRatings);
    const mergedAverageRating =
      mergedRatings.length > 0
        ? Number(
            (
              mergedRatings.reduce(
                (sum, rating) => sum + (Number(rating.rating) || 0),
                0,
              ) / mergedRatings.length
            ).toFixed(2),
          )
        : Number(customer.averageRating || 0);

    const mergedVisitCount = relatedCustomers.reduce(
      (sum, relatedCustomer) => sum + (Number(relatedCustomer?.visitCount) || 0),
      0,
    );

    const mergedFirstVisitAt = relatedCustomers
      .map((relatedCustomer) => relatedCustomer?.firstVisitAt)
      .filter(Boolean)
      .reduce((earliest, candidate) => {
        if (!earliest) return candidate;
        return toTimestamp(candidate) < toTimestamp(earliest) ? candidate : earliest;
      }, customer.firstVisitAt || null);

    const mergedLastVisitAt = relatedCustomers
      .map((relatedCustomer) => relatedCustomer?.lastVisitAt)
      .filter(Boolean)
      .reduce((latest, candidate) => {
        if (!latest) return candidate;
        return toTimestamp(candidate) > toTimestamp(latest) ? candidate : latest;
      }, customer.lastVisitAt || null);

    const mergedLastOrderId = extractOrderId(
      [...relatedCustomers]
        .sort(
          (left, right) =>
            toTimestamp(right?.lastVisitAt) - toTimestamp(left?.lastVisitAt),
        )
        .map((relatedCustomer) => extractOrderId(relatedCustomer?.lastOrderId))
        .find(Boolean) || customer.lastOrderId,
    );

    const mergedName = relatedCustomers.reduce(
      (name, relatedCustomer) => pickBetterName(name, relatedCustomer?.name),
      customer.name || "Guest",
    );

    const mergedPhone =
      relatedCustomers
        .map((relatedCustomer) => relatedCustomer?.phone)
        .find((phone) => phone && !isPlaceholderPhone(phone)) ||
      customer.phone ||
      null;

    const mergedEmail =
      relatedCustomers
        .map((relatedCustomer) => normalizeEmail(relatedCustomer?.email))
        .find(Boolean) ||
      normalizeEmail(customer.email) ||
      null;

    // Calculate total spent from all related orders.
    const totalSpent = orders.reduce((sum, order) => {
      const latestKot =
        order.kotLines && order.kotLines.length > 0
          ? order.kotLines[order.kotLines.length - 1]
          : null;
      return sum + (latestKot?.totalAmount || 0);
    }, 0);

    const updatePayload = {};
    if (
      mergedRatings.length !== (customer.ratings?.length || 0) ||
      Number(customer.averageRating || 0) !== mergedAverageRating
    ) {
      updatePayload.ratings = mergedRatings;
      updatePayload.averageRating = mergedAverageRating;
    }

    if (Number(customer.totalSpent || 0) !== Number(totalSpent || 0)) {
      updatePayload.totalSpent = totalSpent;
    }

    if (!customer.email && mergedEmail) {
      updatePayload.email = mergedEmail;
    }

    if (
      (!customer.phone || isPlaceholderPhone(customer.phone)) &&
      mergedPhone &&
      !isPlaceholderPhone(mergedPhone)
    ) {
      updatePayload.phone = mergedPhone;
    }

    const betterName = pickBetterName(customer.name, mergedName);
    if (betterName && betterName !== customer.name) {
      updatePayload.name = betterName;
    }

    if (
      mergedLastOrderId &&
      extractOrderId(customer.lastOrderId) !== mergedLastOrderId
    ) {
      updatePayload.lastOrderId = mergedLastOrderId;
    }

    if (
      mergedFirstVisitAt &&
      toTimestamp(mergedFirstVisitAt) !== toTimestamp(customer.firstVisitAt)
    ) {
      updatePayload.firstVisitAt = mergedFirstVisitAt;
    }

    if (
      mergedLastVisitAt &&
      toTimestamp(mergedLastVisitAt) !== toTimestamp(customer.lastVisitAt)
    ) {
      updatePayload.lastVisitAt = mergedLastVisitAt;
    }

    if (mergedVisitCount > Number(customer.visitCount || 0)) {
      updatePayload.visitCount = mergedVisitCount;
    }

    if (Object.keys(updatePayload).length > 0) {
      await Customer.findByIdAndUpdate(id, updatePayload);
    }

    const responseCustomer = {
      ...customer,
      ...updatePayload,
      name: updatePayload.name || mergedName || customer.name,
      phone: updatePayload.phone || mergedPhone || customer.phone || null,
      email: updatePayload.email || mergedEmail || customer.email || null,
      visitCount: Math.max(
        Number(updatePayload.visitCount || 0),
        Number(mergedVisitCount || 0),
        Number(customer.visitCount || 0),
      ),
      firstVisitAt:
        updatePayload.firstVisitAt || mergedFirstVisitAt || customer.firstVisitAt,
      lastVisitAt:
        updatePayload.lastVisitAt || mergedLastVisitAt || customer.lastVisitAt,
      lastOrderId:
        updatePayload.lastOrderId ||
        mergedLastOrderId ||
        extractOrderId(customer.lastOrderId) ||
        null,
      ratings: mergedRatings,
      averageRating: mergedAverageRating,
      totalSpent,
    };

    return res.json({
      ...responseCustomer,
      feedbacks,
      orders: orders.slice(0, 10), // Return last 10 orders
      totalOrders: orders.length,
      totalSpent,
      mergedCustomerIds: relatedCustomers.map((relatedCustomer) =>
        String(relatedCustomer._id),
      ),
    });
  } catch (err) {
    console.error("Error fetching customer:", err);
    return res.status(500).json({ message: err.message });
  }
};

// Get customer statistics
exports.getCustomerStats = async (req, res) => {
  try {
    if (req.user?.role === "admin" || req.user?.role === "franchise_admin") {
      await syncCustomersFromFeedback(req.user);
    }

    const query = buildHierarchyQuery(req.user);

    const customers = await Customer.find(query).lean();
    const mergedCustomers = mergeDuplicateCustomersForPanel(customers);

    const stats = {
      totalCustomers: mergedCustomers.length,
      totalVisits: mergedCustomers.reduce((sum, c) => sum + (c.visitCount || 0), 0),
      averageVisits:
        mergedCustomers.length > 0
          ? (
              mergedCustomers.reduce((sum, c) => sum + (c.visitCount || 0), 0) /
              mergedCustomers.length
            ).toFixed(2)
          : 0,
      averageRating: 0,
      customersWithRatings: 0,
      ratingDistribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
      topCustomers: [],
    };

    let totalRating = 0;
    let ratingCount = 0;

    mergedCustomers.forEach((customer) => {
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
    stats.topCustomers = mergedCustomers
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

    const mergedCustomers = mergeDuplicateCustomersForPanel(customers).slice(0, 20);

    return res.json({ customers: mergedCustomers });
  } catch (err) {
    console.error("Error searching customers:", err);
    return res.status(500).json({ message: err.message });
  }
};
