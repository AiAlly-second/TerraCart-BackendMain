const mongoose = require("mongoose");

const outletOPEXSchema = new mongoose.Schema(
  {
    outletOpexId: {
      type: String,
      unique: true,
      required: true,
      trim: true,
    },
    franchiseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    costCategory: {
      type: String,
      required: true,
      enum: [
        "Salary",
        "Electricity",
        "Water",
        "Gas",
        "Cleaning",
        "Licensing",
        "AMC",
        "Rent",
        "Insurance",
        "Marketing",
        "Maintenance",
        "Other",
      ],
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    periodStartDate: {
      type: Date,
      required: true,
      index: true,
    },
    periodEndDate: {
      type: Date,
      required: true,
      index: true,
    },
    description: {
      type: String,
      default: "",
    },
    invoicePath: {
      type: String,
      default: null,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes for efficient queries
outletOPEXSchema.index({ franchiseId: 1, periodStartDate: -1 });
outletOPEXSchema.index({ costCategory: 1 });
outletOPEXSchema.index({ periodStartDate: -1, periodEndDate: -1 });

// Auto-generate outletOpexId before save
outletOPEXSchema.pre("save", async function (next) {
  if (!this.outletOpexId) {
    try {
      const count = await this.constructor.countDocuments();
      this.outletOpexId = `OPEX-${Date.now()}-${count + 1}`;
    } catch (error) {
      // Fallback if countDocuments fails
      this.outletOpexId = `OPEX-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    }
  }
  next();
});

module.exports = mongoose.model("OutletOPEX", outletOPEXSchema);


