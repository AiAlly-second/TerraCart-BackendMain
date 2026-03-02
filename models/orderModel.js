const mongoose = require("mongoose");
const {
  CANONICAL_LIFECYCLE_STATUSES,
  applyLifecycleFields,
} = require("../utils/orderLifecycle");
const {
  ORDER_STATUS_VALUES,
  PAYMENT_STATUS_VALUES,
} = require("../utils/orderContract");

const normalizeServiceType = (value) => {
  const token = String(value || "")
    .trim()
    .toUpperCase();
  if (token === "DELIVERY") return "DELIVERY";
  if (token === "PICKUP") return "TAKEAWAY"; // legacy alias
  if (token === "TAKEAWAY") return "TAKEAWAY";
  return "DINE_IN";
};

const normalizeOrderType = (value, serviceType) => {
  const token = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/\s+/g, "-");
  if (token === "delivery") return "delivery";
  if (token === "pickup") return "takeaway"; // legacy alias
  if (token === "takeaway") return "takeaway";
  if (token === "dine-in" || token === "dinein") return "dine-in";

  const normalizedServiceType = normalizeServiceType(serviceType);
  if (normalizedServiceType === "DELIVERY") return "delivery";
  if (normalizedServiceType === "TAKEAWAY") return "takeaway";
  return "dine-in";
};

/* ---------- sub-schemas ---------- */
const itemSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    quantity: { type: Number, required: true, min: 1 },
    price: { type: Number, required: true, min: 0 },
    returned: { type: Boolean, default: false },
    note: { type: String, trim: true, default: "" },
    specialInstructions: { type: String, trim: true, default: "" },
    convertedToTakeaway: { type: Boolean, default: false },
    // Optional: Finances MenuItemV2 ID for reliable consumption matching (pass-through from frontend)
    menuItemId: { type: mongoose.Schema.Types.ObjectId, ref: "MenuItemV2", default: null },
    costingMenuItemId: { type: mongoose.Schema.Types.ObjectId, ref: "MenuItemV2", default: null },
    // Extras/add-ons selected for this item
    extras: [
      {
        name: { type: String, required: true },
        price: { type: Number, required: true, min: 0 },
      },
    ],
  },
  { _id: false }
);

const kotLineSchema = new mongoose.Schema(
  {
    kotNumber: { type: Number, min: 1 },
    items: { type: [itemSchema], required: true },
    subtotal: { type: Number, required: true },
    gst: { type: Number, required: true },
    totalAmount: { type: Number, required: true },
    createdAt: { type: Date, default: Date.now },
    isPrinted: { type: Boolean, default: false },
    printAttemptCount: { type: Number, default: 0, min: 0 },
    lastPrintStatus: {
      type: String,
      enum: ["pending", "queued", "success", "failed"],
      default: "pending",
    },
    lastPrintMessage: { type: String, default: "" },
    lastPrintRequestedAt: { type: Date, default: null },
    lastPrintedAt: { type: Date, default: null },
    lastPrinterResponse: { type: String, default: "" },
    // Agent-print idempotency: per-KOT claim/complete on order
    printKey: { type: String, default: "" },
    printStatus: {
      type: String,
      enum: ["pending", "claimed", "printed", "failed"],
      default: "pending",
    },
    claimedBy: { type: String, default: "" },
    claimedAt: { type: Date, default: null },
    printedAt: { type: Date, default: null },
    lastPrintError: { type: String, default: "" },
  },
  { _id: false }
);

/* ---------- order schema ---------- */
const orderSchema = new mongoose.Schema(
  {
    _id: { type: String }, // add this line
    tableNumber: { type: String },
    // Global add-ons selected for this order
    selectedAddons: [
      {
        addonId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Addon",
        },
        name: { type: String, required: true },
        price: { type: Number, required: true, min: 0 },
        quantity: { type: Number, min: 1, default: 1 },
      },
    ],
    table: { type: mongoose.Schema.Types.ObjectId, ref: "Table" },
    serviceType: {
      type: String,
      enum: ["DINE_IN", "TAKEAWAY", "DELIVERY"],
      default: "DINE_IN",
    },
    // Canonical order type for cross-platform API consistency.
    orderType: {
      type: String,
      enum: ["dine-in", "takeaway", "delivery"],
    },
    // Customer information for takeaway/pickup/delivery orders
    customerName: { type: String },
    customerMobile: { type: String },
    customerEmail: { type: String },
    // Customer location for delivery/pickup
    customerLocation: {
      latitude: { type: Number },
      longitude: { type: Number },
      address: { type: String }, // Full address string
    },
    // Pickup location (cart address)
    pickupLocation: {
      address: { type: String },
      coordinates: {
        latitude: { type: Number },
        longitude: { type: Number },
      },
    },
    // Delivery information
    deliveryInfo: {
      distance: { type: Number }, // Distance in km
      deliveryCharge: { type: Number, default: 0 }, // Delivery charge in rupees
      estimatedTime: { type: Number }, // Estimated delivery time in minutes
    },
    // QR source context (kept flexible for future QR types/locations)
    sourceQrType: {
      type: String,
      trim: true,
      default: "TABLE",
      uppercase: true,
    },
    // Generic QR context support for table/takeaway/delivery/future custom locations.
    sourceQrContext: {
      type: String,
      trim: true,
      default: null,
    },
    // Identity for anonymous customer sessions (web/app QR visitors).
    anonymousSessionId: {
      type: String,
      trim: true,
      default: null,
      index: true,
      sparse: true,
    },
    // Snapshot of Office QR display name at order time
    officeName: { type: String, trim: true },
    // Extra fixed delivery charge configured on OFFICE QR (if any)
    officeDeliveryCharge: { type: Number, default: 0, min: 0 },
    officePaymentMode: {
      type: String,
      enum: ["ONLINE", "COD", "BOTH", null],
      default: null,
    },
    // Special instructions/notes from customer
    specialInstructions: { type: String },
    kotLines: { type: [kotLineSchema], default: [] },
    status: {
      type: String,
      enum: ORDER_STATUS_VALUES,
      default: "NEW",
    },
    // Canonical lifecycle state for cross-platform UI/status consistency.
    lifecycleStatus: {
      type: String,
      enum: CANONICAL_LIFECYCLE_STATUSES,
      default: "NEW",
      index: true,
    },
    // Explicit payment flag to keep "paid" independent from legacy status naming.
    isPaid: {
      type: Boolean,
      default: false,
      index: true,
    },
    // Payment tracking (separate from order status)
    paymentStatus: {
      type: String,
      enum: PAYMENT_STATUS_VALUES,
      default: "PENDING",
    },
    paymentMode: {
      type: String,
      enum: ["CASH", "ONLINE", "CARD", null],
      default: null,
    },
    // When true, order must remain pending until payment is confirmed.
    // Used for customer-selected online-first flows.
    paymentRequiredBeforeProceeding: {
      type: Boolean,
      default: false,
    },
    // Inventory tracking - prevents double deduction
    inventoryDeducted: {
      type: Boolean,
      default: false,
    },
    inventoryDeductedAt: {
      type: Date,
      default: null,
    },
    paidAt: Date,
    returnedAt: Date,
    autoReleasedAt: Date,
    sessionToken: { type: String, index: true, sparse: true }, // Session token for dine-in orders
    // Client-generated key to make create-order requests idempotent.
    idempotencyKey: { type: String, index: true, sparse: true },
    // Simple sequential token for takeaway orders (1, 2, 3, etc.) - unique per cart
    takeawayToken: { type: Number, index: true, sparse: true },
    // Cart admin association for data isolation
    cartId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    // Franchise association - orders belong to franchises through carts
    franchiseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    cancellationReason: { type: String },
    printStatus: {
      kotPrinted: { type: Boolean, default: false },
      billPrinted: { type: Boolean, default: false },
      lastPrintedKotIndex: { type: Number, default: -1 },
    },
    // Idempotency keys already consumed by add-kot requests.
    kotRequestKeys: { type: [String], default: [] },
    // First-come-first-serve order acceptance (TAKEAWAY/PICKUP/DELIVERY)
    acceptedBy: {
      employeeId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },
      employeeName: { type: String },
      employeeRole: { type: String },
      disability: {
        hasDisability: { type: Boolean, default: false },
        type: { type: String },
      },
      acceptedAt: { type: Date, default: Date.now },
    },
  },
  { timestamps: true }
);

// Performance indexes for faster queries
// Compound index for filtering orders by cart and status (most common query)
orderSchema.index({ cartId: 1, status: 1, createdAt: -1 });
// Compound index for filtering by franchise and status
orderSchema.index({ franchiseId: 1, status: 1, createdAt: -1 });
// Index for status-based queries
orderSchema.index({ status: 1, createdAt: -1 });
// Index for date-based queries
orderSchema.index({ createdAt: -1 });
// Compound index for cart and date queries
orderSchema.index({ cartId: 1, createdAt: -1 });
// Index for service type queries
orderSchema.index({ cartId: 1, serviceType: 1, status: 1 });
// Prevent duplicate order creation when the same client request is retried.
orderSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });
orderSchema.index({ cartId: 1, lifecycleStatus: 1, createdAt: -1 });
orderSchema.index({ cartId: 1, status: 1, paymentStatus: 1, createdAt: -1 });

orderSchema.pre("validate", function lifecycleStatusSync(next) {
  this.serviceType = normalizeServiceType(this.serviceType);
  this.orderType = normalizeOrderType(this.orderType, this.serviceType);
  applyLifecycleFields(this, {
    status: this.status,
    paymentStatus: this.paymentStatus,
    isPaid: this.isPaid,
  });
  next();
});

module.exports = mongoose.model("Order", orderSchema);
