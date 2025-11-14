const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: {
      type: String,
      enum: ["super_admin", "franchise_admin", "admin", "employee", "customer"],
      default: "customer",
    },
    // Cafe admin specific fields
    location: { type: String },
    phone: { type: String },
    address: { type: String },
    cafeName: { type: String },
    isApproved: { type: Boolean, default: false },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    approvedAt: { type: Date },
    // Franchise relationship - cafe admins belong to a franchise
    franchiseId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    // Active/Inactive status for franchises (default: true for new franchises)
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

// Hash password before saving
userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) {
    return next();
  }
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Method to compare password
userSchema.methods.matchPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model("User", userSchema);
