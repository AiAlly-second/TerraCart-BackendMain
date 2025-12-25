const mongoose = require("mongoose");
const crypto = require("crypto");

const generateSlug = (name) => {
  const base =
    name
      ?.toString()
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)+/g, "") || "category";
  return `${base}-${crypto.randomBytes(3).toString("hex")}`;
};

const menuCategorySchema = new mongoose.Schema(
  {
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
    slug: {
      type: String,
      unique: true,
      index: true,
    },
    icon: {
      type: String,
      trim: true,
    },
    sortOrder: {
      type: Number,
      default: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    // Cart admin association for data isolation (changed from cafeId to cartId)
    cartId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
  },
  {
    timestamps: true,
  }
);

menuCategorySchema.pre("save", function categorySlugGenerator(next) {
  if (!this.slug) {
    this.slug = generateSlug(this.name);
  }
  next();
});

const MenuCategory = mongoose.model("MenuCategory", menuCategorySchema);

module.exports = MenuCategory;



