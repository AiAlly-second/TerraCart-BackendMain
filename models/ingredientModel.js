const mongoose = require("mongoose");

const ingredientSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      unique: true,
    },
    unit: {
      type: String,
      required: true,
      enum: ["kg", "g", "l", "ml", "pcs", "pack", "box", "bottle", "dozen"],
    },
    // UOM (Unit of Measure) - alias for unit
    uom: {
      type: String,
      enum: ["kg", "g", "l", "ml", "pcs", "pack", "box", "bottle", "dozen"],
    },
    costPerUnit: {
      type: Number,
      required: true,
      min: 0,
    },
    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    lastUpdatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    lastUpdatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// Set UOM to match unit before save
ingredientSchema.pre("save", function (next) {
  if (!this.uom) {
    this.uom = this.unit;
  }
  next();
});

// Note: name field has unique: true which automatically creates an index

module.exports = mongoose.model("Ingredient", ingredientSchema);




