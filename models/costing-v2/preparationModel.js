const mongoose = require("mongoose");

/**
 * Preparation Model
 * Tracks kitchen preparations where chefs issue ingredients and can return unused portions
 */
const preparationSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: "",
    },
    status: {
      type: String,
      enum: ["active", "completed", "cancelled"],
      default: "active",
    },
    startedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    completedAt: {
      type: Date,
      default: null,
    },
    // Ingredients issued for this preparation
    issuedIngredients: [
      {
        ingredientId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "IngredientV2",
          required: true,
        },
        qty: {
          type: Number,
          required: true,
          min: 0,
        },
        uom: {
          type: String,
          required: true,
        },
        qtyInBaseUnit: {
          type: Number,
          required: true,
        },
        transactionId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "InventoryTransactionV2",
          required: true,
        },
        costAllocated: {
          type: Number,
          default: 0,
        },
      },
    ],
    // Ingredients returned (unused portions)
    returnedIngredients: [
      {
        ingredientId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "IngredientV2",
          required: true,
        },
        qty: {
          type: Number,
          required: true,
          min: 0,
        },
        uom: {
          type: String,
          required: true,
        },
        qtyInBaseUnit: {
          type: Number,
          required: true,
        },
        transactionId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "InventoryTransactionV2",
          required: true,
        },
        originalTransactionId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "InventoryTransactionV2",
          required: true,
        },
        costAllocated: {
          type: Number,
          default: 0,
        },
        notes: {
          type: String,
          default: "",
        },
      },
    ],
    notes: {
      type: String,
      default: "",
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    cartId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    franchiseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
preparationSchema.index({ cartId: 1, status: 1 });
preparationSchema.index({ createdBy: 1 });
preparationSchema.index({ startedAt: -1 });

module.exports = mongoose.model("Preparation", preparationSchema);



