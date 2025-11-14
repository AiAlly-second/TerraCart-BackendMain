const mongoose = require("mongoose");

/* ---------- sub-schemas ---------- */
const itemSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    quantity: { type: Number, required: true, min: 1 },
    price: { type: Number, required: true, min: 0 },
    returned: { type: Boolean, default: false },
  },
  { _id: false }
);

const kotLineSchema = new mongoose.Schema(
  {
    items:        { type: [itemSchema], required: true },
    subtotal:     { type: Number, required: true },
    gst:          { type: Number, required: true },
    totalAmount:  { type: Number, required: true },
    createdAt:    { type: Date,   default: Date.now }
  },
  { _id: false }
);

/* ---------- order schema ---------- */
const orderSchema = new mongoose.Schema(
  {
    _id:         { type: String }, // add this line
    tableNumber: { type: String },
    table:       { type: mongoose.Schema.Types.ObjectId, ref: "Table" },
    serviceType: {
      type: String,
      enum: ["DINE_IN", "TAKEAWAY"],
      default: "DINE_IN",
    },
    kotLines:    { type: [kotLineSchema], default: [] },
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
      ],
      default: "Pending",
    },
    paidAt: Date,
    returnedAt: Date,
    autoReleasedAt: Date,
    sessionToken: { type: String, index: true, sparse: true }, // Session token for dine-in orders
    // Cafe admin association for data isolation
    cafeId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    // Franchise association - orders belong to franchises through cafes
    franchiseId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
  },
  { timestamps: true }
);


module.exports = mongoose.model("Order", orderSchema);
