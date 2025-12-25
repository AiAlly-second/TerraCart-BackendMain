const mongoose = require("mongoose");

const inventoryItemSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    description: {
      type: String,
      trim: true,
      default: "",
    },
    category: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    unit: {
      type: String,
      required: true,
      enum: ["kg", "g", "L", "mL", "piece", "pack", "box", "bottle", "dozen"],
      default: "piece",
    },
    quantity: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    minStockLevel: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    maxStockLevel: {
      type: Number,
      min: 0,
    },
    unitPrice: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    supplier: {
      type: String,
      trim: true,
    },
    supplierContact: {
      type: String,
      trim: true,
    },
    location: {
      type: String,
      trim: true,
      default: "Main Storage",
    },
    expiryDate: {
      type: Date,
    },
    batchNumber: {
      type: String,
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    notes: {
      type: String,
      trim: true,
    },
    // Cart admin association for data isolation (changed from cafeId to cartId)
    cartId: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: "User", 
      index: true 
    },
    franchiseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    // Link to costing-v2 ingredient
    ingredientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "IngredientV2",
      default: null,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Index for efficient queries
inventoryItemSchema.index({ name: 1, category: 1 });
inventoryItemSchema.index({ cartId: 1, isActive: 1 }); // Changed from cafeId to cartId

// Virtual for stock status
inventoryItemSchema.virtual("stockStatus").get(function () {
  if (this.quantity === 0) return "out_of_stock";
  if (this.quantity <= this.minStockLevel) return "low_stock";
  if (this.maxStockLevel && this.quantity >= this.maxStockLevel) return "over_stock";
  return "in_stock";
});

const InventoryItem = mongoose.model("InventoryItem", inventoryItemSchema);

module.exports = InventoryItem;











