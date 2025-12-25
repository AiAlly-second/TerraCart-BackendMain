const mongoose = require("mongoose");

/* ---------- sub-schemas ---------- */
const itemSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    quantity: { type: Number, required: true, min: 1 },
    price: { type: Number, required: true, min: 0 },
    returned: { type: Boolean, default: false },
    convertedToTakeaway: { type: Boolean, default: false },
  },
  { _id: false }
);

const kotLineSchema = new mongoose.Schema(
  {
    items: { type: [itemSchema], required: true },
    subtotal: { type: Number, required: true },
    gst: { type: Number, required: true },
    totalAmount: { type: Number, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

/* ---------- order schema ---------- */
const orderSchema = new mongoose.Schema(
  {
    _id: { type: String }, // add this line
    tableNumber: { type: String },
    table: { type: mongoose.Schema.Types.ObjectId, ref: "Table" },
    serviceType: {
      type: String,
      enum: ["DINE_IN", "TAKEAWAY", "PICKUP", "DELIVERY"],
      default: "DINE_IN",
    },
    // Order fulfillment type (for TAKEAWAY service type)
    orderType: {
      type: String,
      enum: ["PICKUP", "DELIVERY"],
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
    // Special instructions/notes from customer
    specialInstructions: { type: String },
    kotLines: { type: [kotLineSchema], default: [] },
    status: {
      type: String,
      enum: [
        "Pending",
        "Confirmed",
        "Preparing",
        "Ready",
        "Served",
        "Finalized",
        "Paid",
        "Cancelled",
        "Returned",
        // Takeaway-specific statuses
        "Accept",
        "Accepted",
        "Being Prepared",
        "BeingPrepared",
        "Completed",
        "Exit",
      ],
      default: "Pending",
    },
    paidAt: Date,
    returnedAt: Date,
    autoReleasedAt: Date,
    sessionToken: { type: String, index: true, sparse: true }, // Session token for dine-in orders
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

module.exports = mongoose.model("Order", orderSchema);
