const mongoose = require("mongoose");

/**
 * Purchase Model - v2
 * Handles Purchase Orders and Purchase Receipts
 */
const purchaseSchema = new mongoose.Schema(
  {
    purchaseOrderNo: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
    },
    supplierId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Supplier",
      required: true,
    },
    date: {
      type: Date,
      required: true,
      default: Date.now,
    },
    invoiceNo: {
      type: String,
      trim: true,
    },
    status: {
      type: String,
      enum: ["created", "received", "cancelled"],
      default: "created",
    },
    items: [
      {
        ingredientId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "IngredientV2",
          required: true,
        },
        qty: { type: Number, required: true, min: 0 },
        uom: { type: String, required: true },
        unitPrice: { type: Number, required: true, min: 0 },
        total: { type: Number, required: true, min: 0 },
        // Optional explicit expiry date for this purchase line.
        expiryDate: { type: Date, default: null },
      },
    ],
    totalAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    receivedDate: {
      type: Date,
      default: null,
    },
    receivedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    notes: {
      type: String,
      default: "",
    },
    cartId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true, // Required - purchases are always for a specific cart
    },
    franchiseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
purchaseSchema.index({ supplierId: 1, date: -1 });
purchaseSchema.index({ status: 1 });
purchaseSchema.index({ date: -1 });
purchaseSchema.index({ cartId: 1 });

// Auto-generate PO number
purchaseSchema.pre("save", async function (next) {
  if (!this.purchaseOrderNo && this.status === "created") {
    const count = await this.constructor.countDocuments();
    this.purchaseOrderNo = `PO-${Date.now()}-${count + 1}`;
  }
  next();
});

module.exports = mongoose.model("Purchase", purchaseSchema);
