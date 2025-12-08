const mongoose = require("mongoose");
const Order = require("../models/orderModel");
const Counter = require("../models/countermodel");
const { Table } = require("../models/tableModel");
const { Payment } = require("../models/paymentModel");
const Customer = require("../models/customerModel");
const { printKOT } = require("../services/kotPrinter");
const {
  consumeIngredientsForOrder,
} = require("../services/costing-v2/orderConsumptionService");

// Money helpers
const toPaise = (n) => Math.round(Number(n) * 100);
const toRupees = (p) => Number((p / 100).toFixed(2));

// Build KOT
function buildKot(items) {
  // Validate items before processing
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("Items array is required and must not be empty");
  }

  const lines = items.map((it, index) => {
    // Validate each item
    if (!it || typeof it !== "object") {
      throw new Error(`Item at index ${index} is invalid: must be an object`);
    }
    if (!it.name || typeof it.name !== "string" || it.name.trim() === "") {
      throw new Error(`Item at index ${index} is missing or has invalid name`);
    }
    const quantity = Number(it.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error(
        `Item at index ${index} (${it.name}) has invalid quantity: ${it.quantity}`
      );
    }
    const price = Number(it.price);
    if (!Number.isFinite(price) || price < 0) {
      throw new Error(
        `Item at index ${index} (${it.name}) has invalid price: ${it.price}`
      );
    }

    return {
      name: String(it.name).trim(),
      quantity: quantity,
      price: toPaise(price),
      returned: Boolean(it.returned),
    };
  });

  const subtotalP = lines.reduce((s, it) => s + it.price * it.quantity, 0);
  const gstP = Math.round(subtotalP * 0.05); // 5% GST
  const totalP = subtotalP + gstP;

  return {
    items: lines,
    subtotal: toRupees(subtotalP),
    gst: toRupees(gstP),
    totalAmount: toRupees(totalP),
  };
}

function getOrderBillAmount(order) {
  if (!order?.kotLines?.length) return 0;
  const latestKot = order.kotLines[order.kotLines.length - 1];
  const amount =
    Number(latestKot?.totalAmount ?? latestKot?.subtotal ?? 0) || 0;
  return amount > 0 ? amount : 0;
}

async function ensurePaymentRecord(order, options = {}) {
  if (!order?._id) return null;
  const amount = getOrderBillAmount(order);
  if (amount <= 0) {
    return { payment: null, created: false };
  }

  let payment = await Payment.findOne({ orderId: order._id });
  let created = false;
  if (!payment) {
    payment = await Payment.create({
      orderId: order._id,
      amount,
      method: options.method || "CASH",
      status: options.status || "PAID",
      description: options.description || "Payment settled by admin",
      paidAt: options.status === "PAID" ? new Date() : undefined,
    });
    created = true;
  } else {
    let mutate = false;
    if (payment.amount !== amount) {
      payment.amount = amount;
      mutate = true;
    }
    if (options.status === "PAID" && payment.status !== "PAID") {
      payment.status = "PAID";
      payment.paidAt = new Date();
      mutate = true;
    }
    if (options.method && payment.method !== options.method) {
      payment.method = options.method;
      mutate = true;
    }
    if (options.description && payment.description !== options.description) {
      payment.description = options.description;
      mutate = true;
    }
    if (mutate) {
      await payment.save();
    }
  }

  return { payment, created };
}

function formatPaymentPayload(payment) {
  const plain = payment?.toObject ? payment.toObject() : payment;
  if (!plain) return null;
  return {
    id: plain._id || plain.id,
    orderId: plain.orderId,
    amount: plain.amount,
    method: plain.method,
    status: plain.status,
    description: plain.description,
    upiPayload: plain.upiPayload,
    paymentUrl: plain.paymentUrl,
    providerReference: plain.providerReference,
    metadata: plain.metadata,
    createdAt: plain.createdAt,
    updatedAt: plain.updatedAt,
    paidAt: plain.paidAt,
    cancelledAt: plain.cancelledAt,
    cancellationReason: plain.cancellationReason,
  };
}

// Order status transitions
// DINE_IN flow: Pending -> Confirmed -> Preparing -> Ready -> Served -> Paid
// TAKEAWAY flow: Pending/Accept -> Being Prepared -> Completed -> Paid -> Exit
const transitions = {
  // DINE_IN statuses
  Pending: new Set(["Confirmed", "Cancelled", "Accept"]), // Allow Accept for takeaway
  Confirmed: new Set(["Preparing", "Cancelled"]),
  Preparing: new Set(["Ready", "Cancelled"]),
  Ready: new Set(["Served", "Cancelled"]),
  Served: new Set(["Paid", "Cancelled"]), // Removed Finalized - goes directly to Paid
  Finalized: new Set(["Paid", "Cancelled"]), // Keep for existing orders that are already Finalized
  Paid: new Set(["Returned"]),
  Cancelled: new Set([]),
  Returned: new Set([]),
  // TAKEAWAY statuses
  Accept: new Set(["Being Prepared", "BeingPrepared", "Cancelled"]),
  Accepted: new Set(["Being Prepared", "BeingPrepared", "Cancelled"]),
  "Being Prepared": new Set(["Completed", "Cancelled"]),
  BeingPrepared: new Set(["Completed", "Cancelled"]),
  Completed: new Set(["Paid", "Cancelled"]),
  Exit: new Set([]), // Final status for takeaway
};

// ---------------- CREATE ORDER ----------------
async function releaseTableForOrder(order, io, emitToCafe = null) {
  try {
    if (!order?.table) return;
    const tableId = order.table._id || order.table;
    const table = await Table.findById(tableId);
    if (!table) return;

    const oldStatus = table.status;
    table.status = "AVAILABLE";
    table.currentOrder = null;
    table.set("sessionToken", undefined);
    table.lastAssignedAt = null;
    await table.save();

    // Emit socket event for table status update
    if (io && table.cartId && emitToCafe) {
      emitToCafe(io, table.cartId.toString(), "table:status:updated", {
        id: table._id,
        number: table.number,
        status: table.status,
        currentOrder: null,
      });
    }

    // Notify next person in waitlist when table becomes available
    if (io) {
      const { notifyNextWaitlist } = require("./waitlistController");
      await notifyNextWaitlist(tableId, io);
    }

    console.log(
      `[TABLE] Released table ${table.number} (${table._id}) - Status: ${oldStatus} → AVAILABLE`
    );
  } catch (err) {
    console.error("Failed to release table", err);
  }
}

const createOrder = async (req, res) => {
  console.log("[ORDER] createOrder called", {
    hasUser: !!req.user,
    userRole: req.user?.role,
    userId: req.user?._id?.toString(),
  });
  try {
    const {
      items,
      serviceType = "DINE_IN",
      tableId,
      sessionToken,
      customerName,
      customerMobile,
      customerEmail,
      cartId: requestCartId, // Accept cartId from request body (for takeaway orders from customer frontend)
    } = req.body;
    let { tableNumber } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "No items supplied" });
    }

    const isTableService =
      serviceType === "DINE_IN" || serviceType === "TAKEAWAY";
    if (!isTableService) {
      return res.status(400).json({ message: "Invalid service type" });
    }

    let tableDoc = null;
    const isTakeaway = serviceType === "TAKEAWAY";

    // For TAKEAWAY orders, skip all table-related logic
    if (!isTakeaway) {
      // DINE_IN orders require table and session token
      if (!sessionToken) {
        return res.status(400).json({
          message: "Session token is required for dine-in orders",
        });
      }

      if (!tableId && !tableNumber) {
        return res
          .status(400)
          .json({ message: "Table selection is required for dine-in orders" });
      }

      if (tableId) {
        tableDoc = await Table.findById(tableId);
      } else if (tableNumber) {
        const numeric = Number(tableNumber);
        if (!Number.isNaN(numeric)) {
          tableDoc = await Table.findOne({ number: numeric });
        }
      }

      if (!tableDoc) {
        return res.status(404).json({ message: "Table record not found" });
      }

      if (tableDoc.sessionToken && tableDoc.sessionToken !== sessionToken) {
        return res.status(403).json({
          message: "This table is currently assigned to another guest.",
        });
      }

      tableNumber =
        tableNumber || String(tableDoc.number ?? tableDoc.tableNumber);
      if (!tableNumber) {
        tableNumber = String(tableDoc.number || "");
      }

      if (!tableDoc.sessionToken) {
        tableDoc.sessionToken = sessionToken;
      }
    } else {
      // For TAKEAWAY orders, set tableNumber to "TAKEAWAY" and skip table assignment
      tableNumber = "TAKEAWAY";
    }

    // Build KOT with error handling
    let kot;
    try {
      kot = buildKot(items);
      console.log("[ORDER] KOT built successfully:", {
        itemsCount: kot.items.length,
        subtotal: kot.subtotal,
        gst: kot.gst,
        totalAmount: kot.totalAmount,
      });
    } catch (kotError) {
      console.error("[ORDER] Failed to build KOT:", kotError);
      return res.status(400).json({
        message: `Invalid order items: ${kotError.message}`,
        error: kotError.message,
      });
    }

    // Generate custom order ID
    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10).replace(/-/g, ""); // YYYYMMDD

    // Find today's counter
    let counter = await Counter.findOneAndUpdate(
      { date: dateStr },
      { $inc: { seq: 1 } },
      { new: true, upsert: true }
    );

    const seqStr = String(counter.seq).padStart(3, "0");
    const orderId = `ORD-${dateStr}${seqStr}`;

    // Set cartId: priority 1) from authenticated cafe admin, 2) from request body (for takeaway from customer frontend), 3) from table's cartId (for dine-in only), 4) from first active cafe (for takeaway fallback)
    let cartId = null;
    if (req.user && req.user.role === "admin" && req.user._id) {
      cartId = req.user._id;
      console.log(
        "[ORDER] Using cartId from authenticated user:",
        cartId.toString()
      );
    } else if (isTakeaway && requestCartId) {
      // For takeaway orders, use cartId from request body (sent by customer frontend)
      // Validate that the cartId exists and is an active admin
      const User = require("../models/userModel");
      const cartAdmin = await User.findById(requestCartId)
        .select("_id franchiseId role isActive isApproved")
        .lean();
      if (cartAdmin && cartAdmin.role === "admin" && cartAdmin.isActive && cartAdmin.isApproved) {
        cartId = requestCartId;
        console.log(
          "[ORDER] Using cartId from request body for takeaway:",
          cartId.toString()
        );
      } else {
        console.warn(
          `[ORDER] WARNING: Invalid cartId in request (${requestCartId}). Cart admin not found or not active/approved. Falling back to first active cafe.`
        );
        // Fall through to fallback logic below
      }
    } else if (!isTakeaway && tableDoc && tableDoc.cartId) {
      cartId = tableDoc.cartId;
      console.log("[ORDER] Using cartId from table:", cartId.toString());
    }
    
    // Fallback: For takeaway orders without cartId, get the first active cafe admin
    if (isTakeaway && !cartId) {
      const User = require("../models/userModel");
      const firstCafe = await User.findOne({
        role: "admin",
        isActive: true,
        isApproved: true,
      })
        .select("_id franchiseId")
        .lean();
      if (firstCafe) {
        cartId = firstCafe._id;
        console.log(
          "[ORDER] Using cartId from first active cafe for takeaway (fallback):",
          cartId.toString()
        );
      } else {
        console.warn(
          "[ORDER] WARNING: No active cafe admin found for takeaway order. Order will be created without cartId."
        );
        // Allow order to be created without cartId - it will be visible to super admin only
      }
    }

    // Set franchiseId: priority 1) from authenticated cafe admin's franchise, 2) from table's franchiseId, 3) from cafe's franchise
    let franchiseId = null;
    if (req.user && req.user.role === "admin" && req.user.franchiseId) {
      franchiseId = req.user.franchiseId;
    } else if (!isTakeaway && tableDoc && tableDoc.franchiseId) {
      franchiseId = tableDoc.franchiseId;
    } else if (cartId) {
      // If we have cartId but no franchiseId, get it from the cafe admin user
      const User = require("../models/userModel");
      const cafeAdmin = await User.findById(cartId)
        .select("franchiseId")
        .lean();
      if (cafeAdmin && cafeAdmin.franchiseId) {
        franchiseId = cafeAdmin.franchiseId;
      }
    }

    const orderData = {
      _id: orderId,
      tableNumber: String(tableNumber),
      table: isTakeaway ? null : tableDoc?._id || null, // No table for takeaway
      serviceType,
      sessionToken: isTakeaway ? undefined : sessionToken, // No session token needed for takeaway
      kotLines: [kot],
      status: "Confirmed",
    };

    // Only set cartId and franchiseId if they exist (they're optional in the schema)
    if (cartId) {
      orderData.cartId = cartId;
    }
    if (franchiseId) {
      orderData.franchiseId = franchiseId;
    }

    // Add customer information for takeaway orders only
    if (isTakeaway) {
      if (customerName && customerName.trim())
        orderData.customerName = customerName.trim();
      if (customerMobile && customerMobile.trim())
        orderData.customerMobile = customerMobile.trim();
      if (customerEmail && customerEmail.trim())
        orderData.customerEmail = customerEmail.trim();
    }

    // Log order data before creation for debugging
    console.log("[ORDER] Attempting to create order with data:", {
      orderId,
      serviceType,
      tableNumber,
      cartId: cartId ? cartId.toString() : "null",
      franchiseId: franchiseId ? franchiseId.toString() : "null",
      kotLinesCount: orderData.kotLines?.length || 0,
      customerInfo: isTakeaway
        ? {
            name: orderData.customerName || "not provided",
            mobile: orderData.customerMobile || "not provided",
            email: orderData.customerEmail || "not provided",
          }
        : "N/A (DINE_IN)",
    });

    let order;
    try {
      order = await Order.create(orderData);
    } catch (createError) {
      console.error("[ORDER] Failed to create order:", createError);
      console.error(
        "[ORDER] Order data that failed:",
        JSON.stringify(orderData, null, 2)
      );
      return res.status(400).json({
        message: `Failed to create order: ${createError.message}`,
        error: createError.message,
        details: createError.errors || "Unknown error",
      });
    }

    // Log order creation with franchise info for debugging
    console.log(`[ORDER] Successfully created order ${orderId}:`, {
      cartId: cartId ? cartId.toString() : "none",
      franchiseId: franchiseId ? franchiseId.toString() : "none",
      serviceType,
      tableNumber,
    });

    // Only update table status for dine-in orders
    if (!isTakeaway && tableDoc) {
      tableDoc.status = "OCCUPIED";
      tableDoc.currentOrder = order._id;
      tableDoc.lastAssignedAt = new Date();
      await tableDoc.save();
    }

    // Create or update customer record for takeaway orders (non-blocking)
    if (
      isTakeaway &&
      (customerName || customerMobile || customerEmail) &&
      cartId
    ) {
      console.log("[ORDER] Starting customer creation process:", {
        orderId,
        isTakeaway,
        hasCustomerName: !!customerName,
        hasCustomerMobile: !!customerMobile,
        hasCustomerEmail: !!customerEmail,
        cartId: cartId ? cartId.toString() : "null",
        franchiseId: franchiseId ? franchiseId.toString() : "null",
      });
      
      // Run asynchronously so it doesn't block order creation
      (async () => {
        try {
          // Helper function to normalize phone number
          const normalizePhone = (phone) => {
            if (!phone) return null;
            // Remove all non-digit characters
            return phone.replace(/\D/g, "");
          };

          const normalizedPhone = customerMobile ? normalizePhone(customerMobile) : null;
          const normalizedEmail = customerEmail ? customerEmail.trim().toLowerCase() : null;

          console.log("[ORDER] Customer data normalized:", {
            normalizedPhone,
            normalizedEmail,
            customerName: customerName?.trim(),
          });

          // Phone or email is required to create customer
          if (!normalizedPhone && !normalizedEmail) {
            console.log("[ORDER] Skipping customer creation - no phone or email provided");
            return;
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

          // Filter by cafeId to ensure customer belongs to the right cafe
          // Customer model uses cafeId (not cartId)
          if (cartId) {
            const mongoose = require("mongoose");
            const cafeIdValue = cartId._id || cartId;
            // Ensure cafeId is ObjectId for proper matching
            const cafeIdObj = mongoose.Types.ObjectId.isValid(cafeIdValue) 
              ? (typeof cafeIdValue === 'string' ? new mongoose.Types.ObjectId(cafeIdValue) : cafeIdValue)
              : cafeIdValue;
            
            console.log("[ORDER] Setting cafeId for customer query:", {
              cartId: cartId.toString(),
              cafeIdValue: cafeIdValue.toString(),
              cafeIdObj: cafeIdObj.toString(),
              cafeIdType: typeof cafeIdObj,
            });
            
            if (query.$or) {
              // If we have $or, wrap it in $and with cafeId filter
              query = {
                $and: [
                  { $or: query.$or },
                  { cafeId: cafeIdObj }
                ]
              };
            } else {
              query.cafeId = cafeIdObj;
            }
          }

          console.log("[ORDER] Customer search query:", JSON.stringify(query, null, 2));

          // Try to find existing customer
          let customer = await Customer.findOne(query);
          const orderTotal = kot.totalAmount || 0;
          
          console.log("[ORDER] Customer lookup result:", {
            found: !!customer,
            customerId: customer?._id?.toString(),
            customerName: customer?.name,
            customerCafeId: customer?.cafeId?.toString(),
          });

          if (customer) {
            // Update existing customer
            let updated = false;

            // Update name if provided and different
            if (customerName && customerName.trim() && customer.name !== customerName.trim()) {
              customer.name = customerName.trim();
              updated = true;
            }

            // Update email if provided and different
            if (normalizedEmail && (!customer.email || customer.email !== normalizedEmail)) {
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
            if (normalizedPhone && customer.phone && customer.phone.startsWith("email-")) {
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
            customer.totalSpent = (customer.totalSpent || 0) + orderTotal;
            customer.lastOrderId = order._id;
            updated = true;

            if (updated) {
              await customer.save();
            }

            console.log(
              `✅ [ORDER] Updated customer record: ${customer.name} (${customer.phone || customer.email}) - Visit #${customer.visitCount} for order ${orderId}`
            );
          } else {
            // Create new customer record
            // Phone is required in schema, so use a placeholder if only email provided
            const phoneForNewCustomer = normalizedPhone || `email-${Date.now()}`;

            // Ensure cartId is converted to ObjectId for cafeId
            const cafeIdValue = cartId._id || cartId;
            const franchiseIdValue = franchiseId ? (franchiseId._id || franchiseId) : null;
            
            // Convert to ObjectId if they're strings (mongoose is already imported at top)
            const cafeIdObj = mongoose.Types.ObjectId.isValid(cafeIdValue) 
              ? (typeof cafeIdValue === 'string' ? new mongoose.Types.ObjectId(cafeIdValue) : cafeIdValue)
              : cafeIdValue;
            const franchiseIdObj = franchiseIdValue && mongoose.Types.ObjectId.isValid(franchiseIdValue)
              ? (typeof franchiseIdValue === 'string' ? new mongoose.Types.ObjectId(franchiseIdValue) : franchiseIdValue)
              : franchiseIdValue;
            
            console.log("[ORDER] ObjectId conversion:", {
              originalCartId: cartId.toString(),
              cafeIdValue: cafeIdValue.toString(),
              cafeIdObj: cafeIdObj.toString(),
              franchiseIdObj: franchiseIdObj?.toString() || "null",
            });

            const newCustomerData = {
              name: customerName ? customerName.trim() : "Guest",
              email: normalizedEmail || null,
              phone: phoneForNewCustomer,
              cafeId: cafeIdObj, // Customer model uses cafeId (not cartId)
              franchiseId: franchiseIdObj,
              visitCount: 1,
              firstVisitAt: new Date(),
              lastVisitAt: new Date(),
              totalSpent: orderTotal,
              lastOrderId: order._id,
              ratings: [],
              averageRating: 0,
            };

            console.log("[ORDER] Creating new customer with data:", {
              name: newCustomerData.name,
              phone: newCustomerData.phone,
              email: newCustomerData.email,
              cafeId: newCustomerData.cafeId?.toString(),
              franchiseId: newCustomerData.franchiseId?.toString(),
              cafeIdType: typeof newCustomerData.cafeId,
            });

            try {
              customer = await Customer.create(newCustomerData);
              console.log(
                `✅ [ORDER] Created new customer record: ${customer.name} (${customer.phone || customer.email}) for order ${orderId}`
              );
              console.log("[ORDER] Created customer details:", {
                customerId: customer._id.toString(),
                cafeId: customer.cafeId?.toString(),
                franchiseId: customer.franchiseId?.toString(),
                phone: customer.phone,
                email: customer.email,
              });
              
              // Verify customer was created correctly
              const verifyCustomer = await Customer.findById(customer._id).lean();
              if (verifyCustomer) {
                console.log("[ORDER] Customer verification - Customer exists in database:", {
                  id: verifyCustomer._id.toString(),
                  cafeId: verifyCustomer.cafeId?.toString(),
                  name: verifyCustomer.name,
                  phone: verifyCustomer.phone,
                  email: verifyCustomer.email,
                });
                
                // Test query that customer management panel would use
                const testQuery = { cafeId: cafeIdObj };
                const testCustomers = await Customer.find(testQuery).limit(1).lean();
                console.log("[ORDER] Test query for customer management panel:", {
                  query: { cafeId: cafeIdObj.toString() },
                  foundCustomers: testCustomers.length,
                  sampleCustomer: testCustomers[0] ? {
                    id: testCustomers[0]._id.toString(),
                    name: testCustomers[0].name,
                    cafeId: testCustomers[0].cafeId?.toString(),
                  } : null,
                });
              } else {
                console.error("[ORDER] Customer verification FAILED - Customer not found after creation!");
              }
            } catch (createError) {
              console.error("[ORDER] Error creating customer:", createError);
              console.error("[ORDER] Customer creation error details:", {
                message: createError.message,
                name: createError.name,
                code: createError.code,
                errors: createError.errors,
              });
              throw createError; // Re-throw to be caught by outer catch
            }
          }
        } catch (customerError) {
          // Log error but don't fail the order creation
          console.error(
            "[ORDER] Failed to create/update customer record:",
            customerError
          );
          console.error("[ORDER] Customer error stack:", customerError.stack);
          console.error("[ORDER] Customer error details:", {
            message: customerError.message,
            name: customerError.name,
            code: customerError.code,
          });
        }
      })();
    } else {
      console.log("[ORDER] Skipping customer creation - conditions not met:", {
        isTakeaway,
        hasCustomerInfo: !!(customerName || customerMobile || customerEmail),
        hasCartId: !!cartId,
      });
    }

    // Emit socket event to cafe room
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    if (order.cartId) {
      emitToCafe(io, order.cartId.toString(), "order:created", order);
      emitToCafe(io, order.cartId.toString(), "newOrder", order); // Legacy support
      emitToCafe(io, order.cartId.toString(), "kot:created", order); // KOT created
    }

    // Print KOT to printer (non-blocking)
    printKOT(order, kot, 0).catch((err) => {
      console.error("[ORDER] Failed to print KOT:", err);
    });

    return res.status(201).json(order);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ---------------- ADD KOT ----------------
const addKot = async (req, res) => {
  console.log("[ORDER] addKot called - no auth required");
  console.log("[ORDER] addKot - Order ID:", req.params.id);
  console.log(
    "[ORDER] addKot - Request body:",
    JSON.stringify(req.body, null, 2)
  );
  try {
    const { items } = req.body;

    // Enhanced validation with detailed error messages
    if (!items) {
      console.error("[ORDER] addKot - Missing items field in request body");
      return res
        .status(400)
        .json({ message: "No items field supplied in request body" });
    }
    if (!Array.isArray(items)) {
      console.error(
        "[ORDER] addKot - Items is not an array:",
        typeof items,
        items
      );
      return res
        .status(400)
        .json({ message: `Items must be an array, received: ${typeof items}` });
    }
    if (items.length === 0) {
      console.error("[ORDER] addKot - Items array is empty");
      return res.status(400).json({
        message:
          "Items array is empty. Please add at least one item to the order.",
      });
    }

    const order = await Order.findById(req.params.id);
    if (!order) {
      console.error("[ORDER] addKot - Order not found:", req.params.id);
      return res.status(404).json({ message: "Order not found" });
    }

    // Define statuses that allow adding KOTs
    // For takeaway orders, allow more statuses (customers can add items even if preparing)
    // For dine-in orders, also allow more statuses for flexibility
    const allowedStatusesForKot = [
      "Pending",
      "Confirmed",
      "Preparing",
      "Ready",
    ];

    // Never allow adding KOTs to these final statuses
    const blockedStatuses = [
      "Cancelled",
      "Returned",
      "Paid",
      "Served",
      "Finalized",
    ];

    if (blockedStatuses.includes(order.status)) {
      console.error(
        "[ORDER] addKot - Order is in a final status that blocks KOTs:",
        order.status
      );
      return res.status(400).json({
        message: `Cannot add items to order with status: ${
          order.status
        }. Order is already ${order.status.toLowerCase()}.`,
        currentStatus: order.status,
      });
    }

    if (!allowedStatusesForKot.includes(order.status)) {
      console.error(
        "[ORDER] addKot - Order status does not allow adding KOTs:",
        order.status
      );
      return res.status(400).json({
        message: `Order is not open for adding items. Current status: ${order.status}. Please contact staff if you need to modify your order.`,
        currentStatus: order.status,
        allowedStatuses: allowedStatusesForKot,
      });
    }

    // Ensure cartId and franchiseId are set if missing (for orders created before fix)
    let needsSave = false;

    // For dine-in orders, get cartId/franchiseId from table
    if ((!order.cartId || !order.franchiseId) && order.table) {
      const tableDoc = await Table.findById(order.table);
      if (tableDoc) {
        if (!order.cartId && tableDoc.cartId) {
          order.cartId = tableDoc.cartId;
          needsSave = true;
        }
        if (!order.franchiseId && tableDoc.franchiseId) {
          order.franchiseId = tableDoc.franchiseId;
          needsSave = true;
        }
      }
    }

    // For takeaway orders without cartId/franchiseId, assign from first active cafe
    if (
      order.serviceType === "TAKEAWAY" &&
      (!order.cartId || !order.franchiseId)
    ) {
      const User = require("../models/userModel");
      if (!order.cartId) {
        const firstCafe = await User.findOne({
          role: "admin",
          isActive: true,
          isApproved: true,
        })
          .select("_id franchiseId")
          .lean();
        if (firstCafe) {
          order.cartId = firstCafe._id;
          needsSave = true;
          // Also set franchiseId if we have it
          if (!order.franchiseId && firstCafe.franchiseId) {
            order.franchiseId = firstCafe.franchiseId;
          }
        }
      } else if (!order.franchiseId && order.cartId) {
        // If we have cartId but no franchiseId, get it from cafe admin
        const cafeAdmin = await User.findById(order.cartId)
          .select("franchiseId")
          .lean();
        if (cafeAdmin && cafeAdmin.franchiseId) {
          order.franchiseId = cafeAdmin.franchiseId;
          needsSave = true;
        }
      }
    }

    // If we still don't have franchiseId but have cartId, get it from cafe admin
    if (!order.franchiseId && order.cartId) {
      const User = require("../models/userModel");
      const cafeAdmin = await User.findById(order.cartId)
        .select("franchiseId")
        .lean();
      if (cafeAdmin && cafeAdmin.franchiseId) {
        order.franchiseId = cafeAdmin.franchiseId;
        needsSave = true;
      }
    }

    if (needsSave) {
      console.log("[ORDER] addKot - Updating order with cartId/franchiseId:", {
        orderId: order._id,
        cartId: order.cartId ? order.cartId.toString() : "none",
        franchiseId: order.franchiseId ? order.franchiseId.toString() : "none",
      });
      await order.save();
    }

    // Build KOT with error handling
    let newKot;
    try {
      newKot = buildKot(items);
      console.log("[ORDER] addKot - KOT built successfully:", {
        itemsCount: newKot.items.length,
        subtotal: newKot.subtotal,
        gst: newKot.gst,
        totalAmount: newKot.totalAmount,
      });
    } catch (kotError) {
      console.error("[ORDER] addKot - Failed to build KOT:", kotError);
      return res.status(400).json({
        message: `Invalid order items: ${kotError.message}`,
        error: kotError.message,
      });
    }

    order.kotLines.push(newKot);
    try {
      await order.save();
      console.log("[ORDER] addKot - Order updated successfully:", order._id);
    } catch (saveError) {
      console.error("[ORDER] addKot - Failed to save order:", saveError);
      return res.status(400).json({
        message: `Failed to save order: ${saveError.message}`,
        error: saveError.message,
      });
    }

    // Update customer record for takeaway orders (non-blocking)
    if (
      order.serviceType === "TAKEAWAY" &&
      (order.customerName || order.customerMobile || order.customerEmail) &&
      order.cartId
    ) {
      // Run asynchronously so it doesn't block order update
      (async () => {
        try {
          // Helper function to normalize phone number
          const normalizePhone = (phone) => {
            if (!phone) return null;
            // Remove all non-digit characters
            return phone.replace(/\D/g, "");
          };

          const normalizedPhone = order.customerMobile ? normalizePhone(order.customerMobile) : null;
          const normalizedEmail = order.customerEmail ? order.customerEmail.trim().toLowerCase() : null;

          // Phone or email is required to find customer
          if (!normalizedPhone && !normalizedEmail) {
            console.log("[ORDER] addKot - Skipping customer update - no phone or email");
            return;
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

          // Filter by cafeId to ensure customer belongs to the right cafe
          // Customer model uses cafeId (not cartId)
          if (order.cartId) {
            const cafeIdValue = order.cartId._id || order.cartId;
            if (query.$or) {
              // If we have $or, wrap it in $and with cafeId filter
              query = {
                $and: [
                  { $or: query.$or },
                  { cafeId: cafeIdValue }
                ]
              };
            } else {
              query.cafeId = cafeIdValue;
            }
          }

          const customer = await Customer.findOne(query);
          const newKotTotal = newKot.totalAmount || 0;

          if (customer) {
            // Update existing customer's total spent
            customer.totalSpent = (customer.totalSpent || 0) + newKotTotal;
            customer.lastOrderId = order._id;
            customer.lastVisitAt = new Date();
            await customer.save();
            console.log(
              `✅ [ORDER] addKot - Updated customer record: ${customer.name} (${customer.phone || customer.email}) for order ${order._id}`
            );
          } else {
            console.log(
              `[ORDER] addKot - Customer not found for order ${order._id} (phone: ${normalizedPhone || "N/A"}, email: ${normalizedEmail || "N/A"})`
            );
          }
        } catch (customerError) {
          // Log error but don't fail the order update
          console.error(
            "[ORDER] addKot - Failed to update customer record:",
            customerError
          );
        }
      })();
    }

    // Emit socket event to cafe room
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    if (order.cartId) {
      emitToCafe(io, order.cartId.toString(), "order:status:updated", order);
      emitToCafe(io, order.cartId.toString(), "orderUpdated", order); // Legacy support
      emitToCafe(io, order.cartId.toString(), "kot:status:updated", order); // KOT updated
    }

    // Print new KOT to printer (non-blocking)
    const kotIndex = order.kotLines.length - 1;
    printKOT(order, newKot, kotIndex).catch((err) => {
      console.error("[ORDER] Failed to print KOT:", err);
    });

    return res.json(order);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ---------------- FINALIZE ORDER ----------------
const finalizeOrder = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) {
      console.log("Order not found:", req.params.id);
      return res.status(404).json({ message: "Order not found" });
    }

    console.log("Attempting to finalize order:", {
      orderId: order._id,
      currentStatus: order.status,
      allowedTransitions: Array.from(transitions[order.status] || []),
    });

    if (!transitions[order.status]?.has("Finalized")) {
      console.log("Invalid transition:", {
        from: order.status,
        to: "Finalized",
        allowedTransitions: Array.from(transitions[order.status] || []),
      });
      return res.status(400).json({
        message: `Cannot finalize from ${order.status}. Order must be in 'Served' state.`,
        currentStatus: order.status,
        allowedTransitions: Array.from(transitions[order.status] || []),
      });
    }

    order.status = "Finalized";
    await order.save();

    // Release table when order is finalized
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    await releaseTableForOrder(order, io, emitToCafe);

    // Emit socket event to cafe room
    if (order.cartId) {
      emitToCafe(io, order.cartId.toString(), "order:status:updated", order);
      emitToCafe(io, order.cartId.toString(), "orderUpdated", order); // Legacy support
      emitToCafe(io, order.cartId.toString(), "kot:status:updated", order); // KOT updated
    }

    return res.json(order);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ---------------- GET ORDERS ----------------
// IMPORTANT: This function returns ALL orders permanently - no date filtering or time limits
// Orders are stored permanently in the database and will never be automatically deleted
// CRITICAL: Each cart admin must only see their own orders (filtered by cartId)
const getOrders = async (req, res) => {
  try {
    const query = {};

    // Filter orders based on user role:
    // - Cart admin (admin): ONLY see orders from their cart (cartId matches their _id) - CRITICAL FOR DATA ISOLATION
    // - Franchise admin: only orders from cafes under their franchise (franchiseId matches their _id)
    // - Mobile users (waiter, cook, captain, manager): ONLY see orders from their assigned cart/kiosk
    // - Super admin: all orders (no filter - they see everything)
    if (req.user && req.user.role === "admin" && req.user._id) {
      // CRITICAL: Cart admin - ONLY see orders from their own cart
      // This ensures complete data isolation between carts
      query.cartId = req.user._id;
      console.log(
        `[GET_ORDERS] Cart admin ${req.user._id} - filtering by cartId: ${req.user._id}`
      );
    } else if (
      req.user &&
      req.user.role === "franchise_admin" &&
      req.user._id
    ) {
      // Franchise admin - only see orders from cafes under their franchise
      query.franchiseId = req.user._id;
      console.log(
        `[GET_ORDERS] Franchise admin ${req.user._id} - filtering by franchiseId: ${req.user._id}`
      );
    } else if (
      req.user &&
      ["waiter", "cook", "captain", "manager"].includes(req.user.role)
    ) {
      // Mobile users - ONLY see orders from their assigned cart/kiosk
      // Use cafeId from req.user (populated by middleware)
      if (req.user.cafeId) {
        query.cartId = req.user.cafeId;
        console.log(
          `[GET_ORDERS] Mobile user ${req.user._id} (${req.user.role}) - filtering by cartId: ${req.user.cafeId}`
        );
      } else {
        // If cafeId not set, return empty array (should not happen if middleware works correctly)
        console.warn(
          `[GET_ORDERS] Mobile user ${req.user._id} has no cafeId - returning empty array`
        );
        return res.json([]);
      }
    }
    // For super_admin, no query-level restriction (see all orders)

    // Fetch ALL orders - no date filtering, no limits, permanent storage
    // Add limit to prevent infinite queries (max 10000 orders at once)
    const orders = await Order.find(query)
      .sort({ createdAt: -1 }) // Sort by newest first
      .limit(10000) // Safety limit to prevent infinite queries
      .populate("table")
      .lean();

    // Ensure franchiseId is set for orders that have cartId but missing franchiseId
    const User = require("../models/userModel");
    for (const order of orders) {
      if (!order.franchiseId && order.cartId) {
        try {
          const cartId = order.cartId.toString
            ? order.cartId.toString()
            : order.cartId;
          const cafe = await User.findById(cartId).select("franchiseId").lean();
          if (cafe && cafe.franchiseId) {
            order.franchiseId = cafe.franchiseId;
            // Update order in database (non-blocking)
            Order.findByIdAndUpdate(order._id, {
              franchiseId: cafe.franchiseId,
            }).catch((err) => {
              console.warn(
                `[GET_ORDERS] Failed to update order ${order._id} franchiseId:`,
                err.message
              );
            });
          }
        } catch (err) {
          console.warn(
            `[GET_ORDERS] Error fetching franchiseId for order ${order._id}:`,
            err.message
          );
        }
      }
    }

    return res.json(orders);
  } catch (err) {
    console.error("[GET_ORDERS] Error:", err);
    return res.status(500).json({ message: err.message });
  }
};

// ---------------- GET ORDER BY ID ----------------
const getOrderById = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id).populate("table").lean();
    if (!order) return res.status(404).json({ message: "Order not found" });

    // Ensure franchiseId is set if missing (for old orders)
    if (!order.franchiseId && order.cartId) {
      const User = require("../models/userModel");
      const cafe = await User.findById(order.cartId)
        .select("franchiseId")
        .lean();
      if (cafe && cafe.franchiseId) {
        // Update order with franchiseId (non-blocking)
        Order.findByIdAndUpdate(req.params.id, {
          franchiseId: cafe.franchiseId,
        }).catch((err) => {
          console.warn(
            `[INVOICE] Failed to update order franchiseId:`,
            err.message
          );
        });
        order.franchiseId = cafe.franchiseId;
      }
    }

    // Check access permissions based on user role:
    // - Cafe admin: can only access orders from their cafe
    // - Franchise admin: can only access orders from cafes under their franchise
    // - Mobile users (waiter, cook, captain, manager): can only access orders from their assigned cart/kiosk
    // - Super admin: can access all orders
    // - Public (no auth): can access orders (for frontend customers)
    if (req.user && req.user.role === "admin" && req.user._id) {
      // Cafe admin - check if order belongs to their cafe
      if (
        !order.cartId ||
        order.cartId.toString() !== req.user._id.toString()
      ) {
        return res
          .status(403)
          .json({ message: "Order does not belong to your cafe" });
      }
    } else if (
      req.user &&
      req.user.role === "franchise_admin" &&
      req.user._id
    ) {
      // Franchise admin - check if order belongs to their franchise
      if (
        !order.franchiseId ||
        order.franchiseId.toString() !== req.user._id.toString()
      ) {
        return res
          .status(403)
          .json({ message: "Order does not belong to your franchise" });
      }
    } else if (
      req.user &&
      ["waiter", "cook", "captain", "manager"].includes(req.user.role)
    ) {
      // Mobile users - check if order belongs to their assigned cart/kiosk
      if (!req.user.cafeId) {
        return res
          .status(403)
          .json({ message: "No cart/kiosk assigned to your account" });
      }
      if (
        !order.cartId ||
        order.cartId.toString() !== req.user.cafeId.toString()
      ) {
        return res
          .status(403)
          .json({ message: "Order does not belong to your cart/kiosk" });
      }
    }
    // For super_admin, no restriction (they can see all orders)

    // Populate franchise GST number if franchiseId exists
    if (order.franchiseId) {
      const User = require("../models/userModel");
      const franchiseId = order.franchiseId.toString
        ? order.franchiseId.toString()
        : order.franchiseId;
      console.log(`[INVOICE] Fetching franchise data for ID: ${franchiseId}`);

      const franchise = await User.findById(franchiseId)
        .select("gstNumber name address")
        .lean();
      if (franchise) {
        order.franchise = {
          gstNumber: franchise.gstNumber,
          name: franchise.name,
          address: franchise.address,
        };
        console.log(`[INVOICE] Franchise data loaded:`, {
          name: franchise.name,
          gstNumber: franchise.gstNumber,
          hasAddress: !!franchise.address,
        });
      } else {
        console.warn(`[INVOICE] Franchise not found for ID: ${franchiseId}`);
      }
    } else {
      console.warn(`[INVOICE] Order ${order._id} has no franchiseId`);
    }

    // Populate cafe address if cartId exists
    if (order.cartId) {
      const User = require("../models/userModel");
      const cartId = order.cartId.toString
        ? order.cartId.toString()
        : order.cartId;
      console.log(`[INVOICE] Fetching cafe data for ID: ${cartId}`);

      const cafe = await User.findById(cartId)
        .select("address cartName location name")
        .lean();
      if (cafe) {
        order.cafe = {
          address: cafe.address || cafe.location,
          cartName: cafe.cartName || cafe.name,
        };
        console.log(`[INVOICE] Cafe data loaded:`, {
          cartName: order.cafe.cartName,
          address: order.cafe.address,
        });
      } else {
        console.warn(`[INVOICE] Cafe not found for ID: ${cartId}`);
      }
    } else {
      console.warn(`[INVOICE] Order ${order._id} has no cartId`);
    }

    return res.json(order);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ---------------- ADD ITEMS TO ORDER (ADMIN) ----------------
const addItemsToOrder = async (req, res) => {
  try {
    const { items } = req.body;
    const orderId = req.params.id;

    // Validate items
    if (!items) {
      return res
        .status(400)
        .json({ message: "No items field supplied in request body" });
    }
    if (!Array.isArray(items)) {
      return res
        .status(400)
        .json({ message: `Items must be an array, received: ${typeof items}` });
    }
    if (items.length === 0) {
      return res.status(400).json({
        message: "Items array is empty. Please add at least one item.",
      });
    }

    // Find the order
    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    // Check access permissions
    if (req.user && req.user.role === "admin" && req.user._id) {
      // Cafe admin:
      // - For DINE_IN orders, enforce strict cart ownership
      // - For TAKEAWAY orders, allow modification even if cartId is missing/mismatched
      if (order.serviceType !== "TAKEAWAY") {
        if (
          !order.cartId ||
          order.cartId.toString() !== req.user._id.toString()
        ) {
          return res
            .status(403)
            .json({ message: "Order does not belong to your cafe" });
        }
      }
    } else if (
      req.user &&
      req.user.role === "franchise_admin" &&
      req.user._id
    ) {
      if (
        !order.franchiseId ||
        order.franchiseId.toString() !== req.user._id.toString()
      ) {
        return res
          .status(403)
          .json({ message: "Order does not belong to your franchise" });
      }
    } else if (
      req.user &&
      ["waiter", "cook", "captain", "manager"].includes(req.user.role)
    ) {
      // Mobile users - can only add items to orders from their assigned cart/kiosk
      if (!req.user.cafeId) {
        return res
          .status(403)
          .json({ message: "No cart/kiosk assigned to your account" });
      }
      if (
        !order.cartId ||
        order.cartId.toString() !== req.user.cafeId.toString()
      ) {
        return res
          .status(403)
          .json({ message: "Order does not belong to your cart/kiosk" });
      }
    }

    // Check if order can be modified - only allow adding items until payment is done
    // Block adding items to Paid, Cancelled, or Returned orders
    if (["Paid", "Cancelled", "Returned"].includes(order.status)) {
      return res.status(400).json({
        message: `Cannot add items to order with status: ${order.status}. Items can only be added to unpaid orders.`,
        currentStatus: order.status,
      });
    }

    // Build new KOT with the items
    let newKot;
    try {
      newKot = buildKot(items);
      console.log("[ORDER] addItemsToOrder - KOT built successfully:", {
        itemsCount: newKot.items.length,
        subtotal: newKot.subtotal,
        gst: newKot.gst,
        totalAmount: newKot.totalAmount,
      });
    } catch (kotError) {
      console.error("[ORDER] addItemsToOrder - Failed to build KOT:", kotError);
      return res.status(400).json({
        message: `Invalid order items: ${kotError.message}`,
        error: kotError.message,
      });
    }

    // Add the new KOT to the order
    order.kotLines.push(newKot);

    try {
      await order.save();
      console.log(
        "[ORDER] addItemsToOrder - Order updated successfully:",
        order._id
      );
    } catch (saveError) {
      console.error(
        "[ORDER] addItemsToOrder - Failed to save order:",
        saveError
      );
      return res.status(400).json({
        message: `Failed to save order: ${saveError.message}`,
        error: saveError.message,
      });
    }

    // Emit socket event for real-time update
    // Emit socket event to cafe room
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    if (order.cartId) {
      emitToCafe(io, order.cartId.toString(), "order:status:updated", order);
      emitToCafe(io, order.cartId.toString(), "orderUpdated", order); // Legacy support
      emitToCafe(io, order.cartId.toString(), "kot:status:updated", order); // KOT updated
    }

    // Print new KOT to printer (non-blocking)
    const kotIndex = order.kotLines.length - 1;
    printKOT(order, newKot, kotIndex).catch((err) => {
      console.error("[ORDER] Failed to print KOT:", err);
    });

    return res.json(order);
  } catch (err) {
    console.error("[ORDER] addItemsToOrder - Error:", err);
    return res.status(500).json({ message: err.message });
  }
};

// ---------------- UPDATE ORDER STATUS ----------------
const updateOrderStatus = async (req, res) => {
  try {
    const { status } = req.body;
    if (!status) return res.status(400).json({ message: "Status required" });

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: "Order not found" });

    // Check access permissions based on admin role:
    // - Cafe admin: for DINE_IN, enforce cart ownership; for TAKEAWAY, allow flexible control
    // - Franchise admin: can only update orders from cafes under their franchise
    // - Super admin: can update all orders
    if (req.user && req.user.role === "admin" && req.user._id) {
      // Cafe admin - only enforce cartId check for dine-in orders
      if (order.serviceType !== "TAKEAWAY") {
        if (
          !order.cartId ||
          order.cartId.toString() !== req.user._id.toString()
        ) {
          return res
            .status(403)
            .json({ message: "Order does not belong to your cafe" });
        }
      }
    } else if (
      req.user &&
      req.user.role === "franchise_admin" &&
      req.user._id
    ) {
      // Franchise admin - check if order belongs to their franchise
      if (
        !order.franchiseId ||
        order.franchiseId.toString() !== req.user._id.toString()
      ) {
        return res
          .status(403)
          .json({ message: "Order does not belong to your franchise" });
      }
    }
    // For super_admin, no restriction (they can update all orders)

    // ADMIN FLEXIBLE STATUS CHANGES: Allow admins to change status to any valid status
    // This gives admins full control over order status regardless of normal flow
    // Include both DINE_IN and TAKEAWAY statuses
    const validStatuses = [
      "Pending",
      "Confirmed",
      "Preparing",
      "Ready",
      "Served",
      "Finalized",
      "Paid",
      "Cancelled",
      "Returned",
      // TAKEAWAY statuses
      "Accept",
      "Accepted",
      "Being Prepared",
      "BeingPrepared",
      "Completed",
      "Exit",
    ];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        message: `Invalid status: ${status}`,
        validStatuses,
      });
    }

    // For non-admin users, validate status transitions based on service type
    if (
      req.user &&
      !["admin", "franchise_admin", "super_admin"].includes(req.user.role)
    ) {
      const currentStatus = order.status;
      const allowedTransitions = transitions[currentStatus] || new Set();

      // Normalize status names for comparison (handle "Being Prepared" vs "BeingPrepared")
      const normalizedStatus =
        status === "Being Prepared" ? "BeingPrepared" : status;
      const normalizedCurrent =
        currentStatus === "Being Prepared" ? "BeingPrepared" : currentStatus;

      // Check if transition is allowed
      if (
        !allowedTransitions.has(status) &&
        !allowedTransitions.has(normalizedStatus)
      ) {
        // Special handling: Allow "Accept" -> "Being Prepared" for takeaway orders starting from Pending
        if (
          order.serviceType === "TAKEAWAY" &&
          (currentStatus === "Pending" ||
            currentStatus === "Accept" ||
            currentStatus === "Accepted") &&
          (status === "Being Prepared" || status === "BeingPrepared")
        ) {
          // Allow this transition
        } else {
          return res.status(400).json({
            message: `Invalid status transition from ${currentStatus} to ${status}`,
            currentStatus,
            requestedStatus: status,
            allowedTransitions: Array.from(allowedTransitions),
          });
        }
      }
    }

    // Log the status change (admin has full control)
    console.log("Status update (admin flexible):", {
      orderId: order._id,
      serviceType: order.serviceType,
      currentStatus: order.status,
      requestedStatus: status,
      isAdmin: !!req.user,
    });

    const io = req.app.get("io");

    order.status = status;
    if (status === "Paid") {
      order.paidAt = new Date();
    } else if (status === "Returned") {
      order.returnedAt = new Date();
      order.paidAt = null;
      if (Array.isArray(order.kotLines)) {
        order.kotLines.forEach((kot, index) => {
          const kotLine = order.kotLines[index];
          const items = Array.isArray(kotLine.items) ? kotLine.items : [];
          kotLine.items = items.map((item) => {
            const plainItem = item?.toObject ? item.toObject() : item;
            return {
              ...plainItem,
              returned: true,
            };
          });
          kotLine.subtotal = 0;
          kotLine.gst = 0;
          kotLine.totalAmount = 0;
        });
      }
      order.markModified("kotLines");
    }

    await order.save();

    // Automatically consume ingredients when order is marked as Ready, Paid, or Finalized
    // This ensures ingredients are consumed when order is sold, even if it skips "Ready" status
    const shouldConsumeIngredients =
      (status === "Ready" || status === "Paid" || status === "Finalized") &&
      req.user;

    if (shouldConsumeIngredients) {
      try {
        console.log(
          `[COSTING] Order ${order._id} marked as ${status} - consuming ingredients...`
        );
        console.log(`[COSTING] Order details:`, {
          orderId: order._id,
          cartId: order.cartId,
          cafeId: order.cafeId,
          kotLinesCount: order.kotLines?.length || 0,
          itemsCount:
            order.kotLines?.reduce(
              (sum, kot) => sum + (kot.items?.length || 0),
              0
            ) || 0,
        });

        // Ensure order is populated before consumption
        const orderForConsumption = await Order.findById(order._id).lean();
        if (!orderForConsumption) {
          console.error(`[COSTING] Order ${order._id} not found after save`);
          return;
        }

        const consumptionResult = await consumeIngredientsForOrder(
          orderForConsumption,
          req.user._id
        );
        if (consumptionResult.success) {
          console.log(
            `[COSTING] ✅ Successfully consumed ingredients for order ${order._id}`
          );
          if (consumptionResult.summary) {
            console.log(`[COSTING] Consumption summary:`, {
              itemsProcessed: consumptionResult.summary.itemsProcessed,
              ingredientsConsumed:
                consumptionResult.summary.ingredientsConsumed.length,
              totalCost: consumptionResult.summary.totalCost,
              errors: consumptionResult.summary.errors.length,
            });
            if (consumptionResult.summary.errors.length > 0) {
              console.warn(
                `[COSTING] ⚠️ Consumption errors:`,
                consumptionResult.summary.errors
              );
            }
          }
        } else {
          console.warn(
            `[COSTING] ❌ Failed to consume ingredients for order ${order._id}:`,
            consumptionResult.error || consumptionResult.message
          );
          if (consumptionResult.summary?.errors) {
            console.warn(`[COSTING] Errors:`, consumptionResult.summary.errors);
          }
          // Don't fail the order status update if consumption fails - log warning only
        }
      } catch (consumptionError) {
        console.error(
          `[COSTING] ❌ Error consuming ingredients for order ${order._id}:`,
          consumptionError
        );
        console.error(`[COSTING] Error stack:`, consumptionError.stack);
        // Don't fail the order status update if consumption fails - log error only
      }
    }

    if (status === "Paid") {
      const { payment, created } = await ensurePaymentRecord(order, {
        status: "PAID",
        method: "CASH",
        description: "Payment recorded via admin panel",
      });
      if (payment && io) {
        const payload = formatPaymentPayload(payment);
        if (payload) {
          io.emit(created ? "paymentCreated" : "paymentUpdated", payload);
        }
      }
    }

    if (status === "Returned") {
      const payments = await Payment.find({ orderId: order._id });
      for (const payment of payments) {
        payment.status = "CANCELLED";
        payment.cancelledAt = new Date();
        payment.cancellationReason = "Order returned";
        await payment.save();
        if (io) {
          const payload = formatPaymentPayload(payment);
          if (payload) {
            io.emit("paymentUpdated", payload);
          }
        }
      }
    }

    // Release table for final statuses (Paid, Cancelled, Returned, Finalized)
    const emitToCafe = req.app.get("emitToCafe");
    if (["Paid", "Cancelled", "Returned", "Finalized"].includes(status)) {
      await releaseTableForOrder(order, io, emitToCafe);
    }

    // Emit socket event to cafe room
    if (order.cartId) {
      emitToCafe(io, order.cartId.toString(), "order:status:updated", order);
      emitToCafe(io, order.cartId.toString(), "orderUpdated", order); // Legacy support
    }

    console.log("Status updated successfully:", order._id, "→", status);
    return res.json(order);
  } catch (err) {
    console.error("Status update error:", err);
    return res.status(500).json({ message: err.message });
  }
};

// ---------------- CUSTOMER CANCEL/RETURN ORDER ----------------
const cancelOrderByCustomer = async (req, res) => {
  try {
    const { status, sessionToken } = req.body;
    const orderId = req.params.id;

    if (!status) return res.status(400).json({ message: "Status required" });
    if (status !== "Cancelled" && status !== "Returned") {
      return res.status(400).json({
        message: "Only Cancelled or Returned status allowed for customers",
      });
    }

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ message: "Order not found" });

    // Verify sessionToken for dine-in orders
    if (order.serviceType === "DINE_IN") {
      if (!sessionToken) {
        return res.status(401).json({ message: "Not authorized, no token" });
      }

      // Check sessionToken matches order's sessionToken or table's sessionToken
      let tokenMatches = false;
      if (order.sessionToken === sessionToken) {
        tokenMatches = true;
      } else if (order.table) {
        const table = await Table.findById(order.table);
        if (table && table.sessionToken === sessionToken) {
          tokenMatches = true;
        }
      }

      if (!tokenMatches) {
        return res
          .status(403)
          .json({ message: "Not authorized, invalid token" });
      }
    }
    // For takeaway orders, allow cancellation without sessionToken verification

    // Check if status transition is allowed
    const allowedStatuses =
      status === "Cancelled"
        ? [
            "Pending",
            "Confirmed",
            "Preparing",
            "Ready",
            "Served",
            "Finalized",
            "Completed",
          ]
        : ["Paid"];

    if (!allowedStatuses.includes(order.status)) {
      return res.status(400).json({
        message: `Cannot ${status.toLowerCase()} order with status ${
          order.status
        }`,
        currentStatus: order.status,
        allowedStatuses,
      });
    }

    const io = req.app.get("io");

    order.status = status;
    if (status === "Returned") {
      order.returnedAt = new Date();
      order.paidAt = null;
      if (Array.isArray(order.kotLines)) {
        order.kotLines.forEach((kot, index) => {
          const kotLine = order.kotLines[index];
          const items = Array.isArray(kotLine.items) ? kotLine.items : [];
          kotLine.items = items.map((item) => {
            const plainItem = item?.toObject ? item.toObject() : item;
            return {
              ...plainItem,
              returned: true,
            };
          });
          kotLine.subtotal = 0;
          kotLine.gst = 0;
          kotLine.totalAmount = 0;
        });
      }
      order.markModified("kotLines");

      // Cancel associated payments
      const payments = await Payment.find({ orderId: order._id });
      for (const payment of payments) {
        payment.status = "CANCELLED";
        payment.cancelledAt = new Date();
        payment.cancellationReason = "Order returned";
        await payment.save();
        if (io) {
          const payload = formatPaymentPayload(payment);
          if (payload) {
            io.emit("paymentUpdated", payload);
          }
        }
      }
    }

    await order.save();

    // Release table if order is cancelled or returned
    const emitToCafe = req.app.get("emitToCafe");
    if (["Cancelled", "Returned"].includes(status)) {
      await releaseTableForOrder(order, io, emitToCafe);
    }

    // Emit socket event to cafe room
    if (order.cartId) {
      emitToCafe(io, order.cartId.toString(), "order:status:updated", order);
      emitToCafe(io, order.cartId.toString(), "orderUpdated", order); // Legacy support
    }

    return res.json(order);
  } catch (err) {
    console.error("Customer cancel/return error:", err);
    return res.status(500).json({ message: err.message });
  }
};

// ---------------- CUSTOMER CONFIRM PAYMENT ----------------
const confirmPaymentByCustomer = async (req, res) => {
  try {
    const { sessionToken, paymentMethod } = req.body;
    const orderId = req.params.id;

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ message: "Order not found" });

    // Verify sessionToken for dine-in orders
    if (order.serviceType === "DINE_IN") {
      if (!sessionToken) {
        return res.status(401).json({ message: "Not authorized, no token" });
      }

      // Check sessionToken matches order's sessionToken or table's sessionToken
      let tokenMatches = false;
      if (order.sessionToken === sessionToken) {
        tokenMatches = true;
      } else if (order.table) {
        const table = await Table.findById(order.table);
        if (table && table.sessionToken === sessionToken) {
          tokenMatches = true;
        }
      }

      if (!tokenMatches) {
        return res
          .status(403)
          .json({ message: "Not authorized, invalid token" });
      }
    }

    // Check if order can be confirmed as paid (must be Finalized or Completed)
    const allowedStatuses = ["Finalized", "Completed"];

    if (!allowedStatuses.includes(order.status)) {
      return res.status(400).json({
        message: `Cannot confirm payment for order with status ${order.status}. Order must be Finalized or Completed.`,
        currentStatus: order.status,
        allowedStatuses,
      });
    }

    // Check if already paid
    if (order.status === "Paid") {
      return res
        .status(400)
        .json({ message: "Order is already marked as paid" });
    }

    const io = req.app.get("io");

    // Update order status to Paid
    order.status = "Paid";
    order.paidAt = new Date();
    await order.save();

    // Create or update payment record
    const { payment, created } = await ensurePaymentRecord(order, {
      status: "PAID",
      method: paymentMethod || "CASH",
      description: "Payment confirmed by customer",
    });

    if (payment && io) {
      const payload = formatPaymentPayload(payment);
      if (payload) {
        io.emit(created ? "paymentCreated" : "paymentUpdated", payload);
      }
    }

    // Emit socket event to cafe room
    const emitToCafe = req.app.get("emitToCafe");

    // Release table
    await releaseTableForOrder(order, io, emitToCafe);
    if (order.cartId) {
      emitToCafe(io, order.cartId.toString(), "order:status:updated", order);
      emitToCafe(io, order.cartId.toString(), "orderUpdated", order); // Legacy support
    }

    console.log("Payment confirmed by customer:", order._id);
    return res.json(order);
  } catch (err) {
    console.error("Customer confirm payment error:", err);
    return res.status(500).json({ message: err.message });
  }
};

// ---------------- DELETE ORDER ----------------
// DISABLED: Orders are stored permanently and should never be deleted
// This function is kept for emergency use only but is disabled by default
const deleteOrder = async (req, res) => {
  // Orders are stored permanently - deletion is disabled
  return res.status(403).json({
    message:
      "Order deletion is disabled. Orders are stored permanently with no time limit.",
  });

  /* DISABLED CODE - Keep for reference only
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: "Order not found" });

    // Check access permissions
    if (req.user && req.user.role === "admin" && req.user._id) {
      if (!order.cartId || order.cartId.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: "Order does not belong to your cafe" });
      }
    } else if (req.user && req.user.role === "franchise_admin" && req.user._id) {
      if (!order.franchiseId || order.franchiseId.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: "Order does not belong to your franchise" });
      }
    }

    const isPaidOrder = order.status === "Paid";
    const orderAmount = getOrderBillAmount(order);

    // For paid orders, we need to handle revenue adjustment
    if (isPaidOrder) {
      // Find and update/cancel the payment record
      const payment = await Payment.findOne({ orderId: order._id });
      if (payment) {
        // Mark payment as cancelled with reason
        payment.status = "CANCELLED";
        payment.cancelledAt = new Date();
        payment.cancellationReason = "Order deleted by admin";
        await payment.save();

        // Emit payment update event
        const io = req.app.get("io");
        if (io) {
          const payload = formatPaymentPayload(payment);
          if (payload) {
            io.emit("paymentUpdated", payload);
          }
        }
      }

      // Note: Revenue calculations are dynamic and based on current paid orders
      // When a paid order is deleted, it will automatically be excluded from future revenue calculations
      // No need to manually adjust revenue history - it's calculated on-demand from existing paid orders
    }

    // Release table if it's a dine-in order
    const io = req.app.get("io");
    await releaseTableForOrder(order, io);

    // Emit socket event before deletion
    const emitToCafe = req.app.get("emitToCafe");
    if (order.cartId) {
      emitToCafe(io, order.cartId.toString(), "order:deleted", { id: req.params.id });
      emitToCafe(io, order.cartId.toString(), "orderDeleted", { id: req.params.id }); // Legacy support
    }
    
    // Delete the order
    await Order.findByIdAndDelete(req.params.id);

    return res.json({ 
      message: isPaidOrder 
        ? `Order deleted successfully. Revenue calculations will automatically exclude this order.`
        : "Order deleted successfully",
      wasPaid: isPaidOrder,
      orderAmount: isPaidOrder ? orderAmount : 0
    });
  } catch (err) {
    console.error('Delete order error:', err);
    return res.status(500).json({ message: err.message });
  }
  */
};

// ---------------- PARTIAL RETURN ITEMS ----------------
const returnItems = async (req, res) => {
  try {
    const { itemIds } = req.body; // Array of item identifiers: [{ kotIndex, itemIndex }]

    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      return res
        .status(400)
        .json({ message: "Please select at least one item to return" });
    }

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: "Order not found" });

    // Check access permissions
    if (req.user && req.user.role === "admin" && req.user._id) {
      if (
        !order.cartId ||
        order.cartId.toString() !== req.user._id.toString()
      ) {
        return res
          .status(403)
          .json({ message: "Order does not belong to your cafe" });
      }
    } else if (
      req.user &&
      req.user.role === "franchise_admin" &&
      req.user._id
    ) {
      if (
        !order.franchiseId ||
        order.franchiseId.toString() !== req.user._id.toString()
      ) {
        return res
          .status(403)
          .json({ message: "Order does not belong to your franchise" });
      }
    }

    // Check if order can be modified (admin can remove items from any status except Cancelled/Returned)
    if (["Cancelled", "Returned"].includes(order.status)) {
      return res.status(400).json({
        message: `Cannot remove items from order with status ${
          order.status
        }. Order is already ${order.status.toLowerCase()}.`,
      });
    }

    // Mark selected items as returned
    let totalReturnedAmount = 0;
    const kotLines = Array.isArray(order.kotLines) ? order.kotLines : [];

    itemIds.forEach(({ kotIndex, itemIndex }) => {
      if (
        kotLines[kotIndex] &&
        kotLines[kotIndex].items &&
        kotLines[kotIndex].items[itemIndex]
      ) {
        const item = kotLines[kotIndex].items[itemIndex];
        if (!item.returned) {
          item.returned = true;
          // Calculate returned amount
          const itemPrice = toRupees(item.price || 0);
          totalReturnedAmount += itemPrice * (item.quantity || 1);
        }
      }
    });

    // Recalculate KOT totals
    kotLines.forEach((kot, kotIdx) => {
      const items = Array.isArray(kot.items) ? kot.items : [];
      let subtotalP = 0;

      items.forEach((item) => {
        if (!item.returned) {
          subtotalP += (item.price || 0) * (item.quantity || 1);
        }
      });

      const gstP = Math.round(subtotalP * 0.05);
      const totalP = subtotalP + gstP;

      kot.subtotal = toRupees(subtotalP);
      kot.gst = toRupees(gstP);
      kot.totalAmount = toRupees(totalP);
    });

    order.kotLines = kotLines;
    order.markModified("kotLines");

    // If all items are returned, mark order as Returned
    const allItemsReturned = kotLines.every((kot) => {
      const items = Array.isArray(kot.items) ? kot.items : [];
      return items.length > 0 && items.every((item) => item.returned);
    });

    if (allItemsReturned) {
      order.status = "Returned";
      order.returnedAt = new Date();

      // Cancel associated payments
      const payments = await Payment.find({ orderId: order._id });
      for (const payment of payments) {
        payment.status = "CANCELLED";
        payment.cancelledAt = new Date();
        payment.cancellationReason = "Order returned";
        await payment.save();
      }
    }

    await order.save();

    // Emit socket event to cafe room
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");

    // Release table if order is fully returned
    if (order.status === "Returned") {
      await releaseTableForOrder(order, io, emitToCafe);
    }
    if (io && order.cartId) {
      emitToCafe(io, order.cartId.toString(), "order:status:updated", order);
      emitToCafe(io, order.cartId.toString(), "orderUpdated", order); // Legacy support
    }

    res.json({
      message: `${itemIds.length} item(s) returned successfully`,
      order,
      returnedAmount: totalReturnedAmount,
      allItemsReturned,
    });
  } catch (err) {
    console.error("Return items error:", err);
    return res.status(500).json({ message: err.message });
  }
};

// ---------------- CONVERT DINE-IN TO TAKEAWAY ----------------
const convertToTakeaway = async (req, res) => {
  try {
    const { itemIds } = req.body; // Optional: array of item identifiers for paid orders
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: "Order not found" });

    // Check access permissions
    if (req.user && req.user.role === "admin" && req.user._id) {
      if (
        !order.cartId ||
        order.cartId.toString() !== req.user._id.toString()
      ) {
        return res
          .status(403)
          .json({ message: "Order does not belong to your cafe" });
      }
    } else if (
      req.user &&
      req.user.role === "franchise_admin" &&
      req.user._id
    ) {
      if (
        !order.franchiseId ||
        order.franchiseId.toString() !== req.user._id.toString()
      ) {
        return res
          .status(403)
          .json({ message: "Order does not belong to your franchise" });
      }
    }

    // Only allow conversion for dine-in orders
    if (order.serviceType !== "DINE_IN") {
      return res.status(400).json({
        message: `Cannot convert order. Current service type is ${order.serviceType}. Only DINE_IN orders can be converted.`,
      });
    }

    // Check if order can be converted (not cancelled or returned)
    if (["Cancelled", "Returned"].includes(order.status)) {
      return res.status(400).json({
        message: `Cannot convert order with status ${order.status}`,
      });
    }

    // For orders with item selection (both paid and unpaid), mark items as takeaway in the same order
    if (
      Array.isArray(itemIds) &&
      itemIds.length > 0
    ) {
      // Get selected items from the order
      const kotLines = Array.isArray(order.kotLines) ? order.kotLines : [];
      const selectedItems = [];

      itemIds.forEach(({ kotIndex, itemIndex }) => {
        if (
          kotLines[kotIndex] &&
          kotLines[kotIndex].items &&
          kotLines[kotIndex].items[itemIndex]
        ) {
          const item = kotLines[kotIndex].items[itemIndex];
          if (!item.returned && !item.convertedToTakeaway) {
            // Convert price from paise to rupees (buildKot expects rupees and will convert back to paise)
            const priceInRupees = toRupees(item.price || 0);
            selectedItems.push({
              name: item.name,
              quantity: item.quantity,
              price: priceInRupees, // Pass price in rupees, buildKot will convert to paise
            });
          }
        }
      });

      if (selectedItems.length === 0) {
        return res
          .status(400)
          .json({ message: "No valid items selected for takeaway conversion" });
      }

      // Mark selected items as converted to takeaway in the original order
      // Keep them in the same order, just mark them as takeaway
      itemIds.forEach(({ kotIndex, itemIndex }) => {
        if (
          kotLines[kotIndex] &&
          kotLines[kotIndex].items &&
          kotLines[kotIndex].items[itemIndex]
        ) {
          const item = kotLines[kotIndex].items[itemIndex];
          if (!item.returned) {
            // Mark item as takeaway but keep it in calculations
            item.convertedToTakeaway = true;
          }
        }
      });

      // Recalculate KOT totals for original order (include takeaway items, exclude only returned items)
      kotLines.forEach((kot, kotIdx) => {
        const items = Array.isArray(kot.items) ? kot.items : [];
        let subtotalP = 0;

        items.forEach((item) => {
          // Include takeaway items in calculations, only exclude returned items
          if (!item.returned) {
            subtotalP += (item.price || 0) * (item.quantity || 1);
          }
        });

        const gstP = Math.round(subtotalP * 0.05);
        const totalP = subtotalP + gstP;

        kot.subtotal = toRupees(subtotalP);
        kot.gst = toRupees(gstP);
        kot.totalAmount = toRupees(totalP);
      });

      order.kotLines = kotLines;
      order.markModified("kotLines");

      // Update payment record for original order if it exists (for paid orders)
      if (order.status === "Paid") {
        const originalOrderAmount = getOrderBillAmount(order);
        const originalPayment = await Payment.findOne({ orderId: order._id });
        if (originalPayment) {
          originalPayment.amount = originalOrderAmount;
          await originalPayment.save();

          const io = req.app.get("io");
          if (io) {
            const payload = formatPaymentPayload(originalPayment);
            if (payload) {
              io.emit("paymentUpdated", payload);
            }
          }
        }
      }

      // Save the updated original order
      await order.save();

      // Emit socket events to cafe room
      const io = req.app.get("io");
      const emitToCafe = req.app.get("emitToCafe");
      if (io && order.cartId) {
        emitToCafe(
          io,
          order.cartId.toString(),
          "order:status:updated",
          order
        );
        emitToCafe(io, order.cartId.toString(), "orderUpdated", order); // Legacy support
      }

      return res.json({
        message: `${selectedItems.length} item(s) marked as takeaway successfully. Items remain in the same dine-in order.`,
        order: order,
      });
    }

    // If no itemIds provided, return error (we don't convert entire order anymore)
    return res.status(400).json({
      message: "Please specify which items to mark as takeaway. Use itemIds array in request body.",
    });
  } catch (err) {
    console.error("Convert to takeaway error:", err);
    return res.status(500).json({ message: err.message });
  }
};

module.exports = {
  createOrder,
  addKot,
  addItemsToOrder,
  finalizeOrder,
  getOrders,
  getOrderById,
  updateOrderStatus,
  cancelOrderByCustomer,
  confirmPaymentByCustomer,
  deleteOrder,
  releaseTableForOrder,
  returnItems,
  convertToTakeaway,
};
