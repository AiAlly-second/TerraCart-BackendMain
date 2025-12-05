const mongoose = require("mongoose");

const outletAssetSchema = new mongoose.Schema(
  {
    assetId: {
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
    assetType: {
      type: String,
      required: true,
      enum: [
        "Kiosk",
        "POS",
        "Freezer",
        "Oven",
        "Refrigerator",
        "Furniture",
        "Equipment",
        "Vehicle",
        "Technology",
        "Other",
      ],
    },
    assetName: {
      type: String,
      required: true,
      trim: true,
    },
    purchaseCost: {
      type: Number,
      required: true,
      min: 0,
    },
    purchaseDate: {
      type: Date,
      required: true,
      index: true,
    },
    usefulLifeMonths: {
      type: Number,
      required: true,
      min: 1,
      default: 60, // 5 years default
    },
    currentValue: {
      type: Number,
      default: 0,
      min: 0,
    },
    depreciationMethod: {
      type: String,
      enum: ["straight_line", "declining_balance"],
      default: "straight_line",
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
outletAssetSchema.index({ franchiseId: 1, purchaseDate: -1 });
outletAssetSchema.index({ assetType: 1 });

// Auto-generate assetId before save
outletAssetSchema.pre("save", async function (next) {
  if (!this.assetId) {
    try {
      const count = await this.constructor.countDocuments();
      this.assetId = `AST-${Date.now()}-${count + 1}`;
    } catch (error) {
      // Fallback if countDocuments fails
      this.assetId = `AST-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    }
  }
  // Calculate current value based on depreciation
  if (this.purchaseDate && this.usefulLifeMonths) {
    const monthsSincePurchase = getMonthsSince(this.purchaseDate);
    const depreciationRate = monthsSincePurchase / this.usefulLifeMonths;
    
    if (depreciationRate >= 1) {
      this.currentValue = 0; // Fully depreciated
    } else {
      if (this.depreciationMethod === "straight_line") {
        this.currentValue = this.purchaseCost * (1 - depreciationRate);
      } else {
        // Declining balance (simplified)
        const annualRate = 1 / (this.usefulLifeMonths / 12);
        this.currentValue = this.purchaseCost * Math.pow(1 - annualRate, monthsSincePurchase / 12);
      }
    }
  } else {
    this.currentValue = this.purchaseCost;
  }
  next();
});

// Helper function to calculate months since a date
function getMonthsSince(date) {
  const now = new Date();
  const purchase = new Date(date);
  const months = (now.getFullYear() - purchase.getFullYear()) * 12 + (now.getMonth() - purchase.getMonth());
  return Math.max(0, months);
}

// Virtual for monthly depreciation amount
outletAssetSchema.virtual("monthlyDepreciation").get(function () {
  if (this.usefulLifeMonths > 0) {
    return this.purchaseCost / this.usefulLifeMonths;
  }
  return 0;
});

// Method to calculate depreciation for a specific period
outletAssetSchema.methods.calculateDepreciation = function (startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const monthsInPeriod = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth()) + 1;
  
  if (this.usefulLifeMonths <= 0) return 0;
  
  const monthlyDepreciation = this.purchaseCost / this.usefulLifeMonths;
  const monthsSincePurchase = getMonthsSince(this.purchaseDate);
  
  // Check if asset is still within useful life
  if (monthsSincePurchase >= this.usefulLifeMonths) return 0;
  
  // Calculate how many months of depreciation fall within the period
  const periodStart = Math.max(0, monthsSincePurchase - monthsInPeriod);
  const periodEnd = monthsSincePurchase;
  const applicableMonths = Math.min(monthsInPeriod, periodEnd - periodStart);
  
  return monthlyDepreciation * applicableMonths;
};

module.exports = mongoose.model("OutletAsset", outletAssetSchema);


