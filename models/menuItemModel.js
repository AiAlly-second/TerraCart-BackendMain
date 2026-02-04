const mongoose = require("mongoose");

const SPICE_LEVELS = ["NONE", "MILD", "MEDIUM", "HOT", "EXTREME"];

const menuItemSchema = new mongoose.Schema(
  {
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MenuCategory",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
      default: "",
    },
    price: {
      type: Number,
      required: true,
      min: 0,
    },
    image: {
      type: String,
      trim: true,
    },
    isAvailable: {
      type: Boolean,
      default: true,
      index: true,
    },
    isFeatured: {
      type: Boolean,
      default: false,
    },
    spiceLevel: {
      type: String,
      enum: SPICE_LEVELS,
      default: "NONE",
    },
    sortOrder: {
      type: Number,
      default: 0,
    },
    tags: {
      type: [String],
      default: [],
    },
    allergens: {
      type: [String],
      default: [],
    },
    calories: {
      type: Number,
      min: 0,
    },
    // Extras/Add-ons for this menu item
    extras: [
      {
        name: {
          type: String,
          required: true,
          trim: true,
        },
        price: {
          type: Number,
          required: true,
          min: 0,
        },
        isAvailable: {
          type: Boolean,
          default: true,
        },
        sortOrder: {
          type: Number,
          default: 0,
        },
      },
    ],
    // Cart admin association for data isolation (changed from cafeId to cartId)
    cartId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
  },
  {
    timestamps: true,
  }
);

menuItemSchema.index({ category: 1, name: 1 }, { unique: true });

const MenuItem = mongoose.model("MenuItem", menuItemSchema);

module.exports = {
  MenuItem,
  SPICE_LEVELS,
};



