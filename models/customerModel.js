const mongoose = require("mongoose");

const customerSchema = new mongoose.Schema(
  {
    // Customer identification (unique by phone or email)
    name: { type: String, required: true, trim: true },
    email: { 
      type: String, 
      trim: true, 
      lowercase: true,
      sparse: true // Allow multiple nulls
    },
    phone: { 
      type: String, 
      required: false, // Made optional to support email-only customers
      trim: true,
      sparse: true // Allow multiple nulls
    },
    
    // Visit tracking
    visitCount: { type: Number, default: 1 },
    firstVisitAt: { type: Date, default: Date.now },
    lastVisitAt: { type: Date, default: Date.now },
    
    // All ratings (preserved - never removed)
    ratings: [{
      rating: { type: Number, min: 1, max: 5, required: true },
      feedbackId: { type: mongoose.Schema.Types.ObjectId, ref: "Feedback" },
      orderId: { type: String, ref: "Order" },
      createdAt: { type: Date, default: Date.now },
      comments: { type: String },
      // Detailed ratings
      foodQuality: { type: Number, min: 1, max: 5 },
      serviceSpeed: { type: Number, min: 1, max: 5 },
      orderAccuracy: { type: Number, min: 1, max: 5 },
      ambiance: { type: Number, min: 1, max: 5 },
      cleanliness: { type: Number, min: 1, max: 5 },
      staffBehavior: { type: Number, min: 1, max: 5 },
      valueForMoney: { type: Number, min: 1, max: 5 },
    }],
    
    // Calculated average (for quick access)
    averageRating: { type: Number, default: 0, min: 0, max: 5 },
    
    // Hierarchy relationships
    cartId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true }, // Changed from cafeId to cartId
    franchiseId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    
    // Additional info
    totalSpent: { type: Number, default: 0 }, // Total amount spent across all orders
    lastOrderId: { type: String, ref: "Order" },
  },
  { timestamps: true }
);

// Indexes for fast lookup by customer within cart or franchise
customerSchema.index({ cartId: 1, phone: 1 });
customerSchema.index({ franchiseId: 1, phone: 1 });

// Method to update average rating
customerSchema.methods.updateAverageRating = function() {
  if (this.ratings && this.ratings.length > 0) {
    const sum = this.ratings.reduce((acc, r) => acc + r.rating, 0);
    this.averageRating = (sum / this.ratings.length).toFixed(2);
  } else {
    this.averageRating = 0;
  }
};

// Method to increment visit
customerSchema.methods.incrementVisit = function() {
  this.visitCount = (this.visitCount || 0) + 1;
  this.lastVisitAt = new Date();
  if (!this.firstVisitAt) {
    this.firstVisitAt = new Date();
  }
};

// Pre-save hook to update average rating
customerSchema.pre('save', function(next) {
  this.updateAverageRating();
  next();
});

module.exports = mongoose.model("Customer", customerSchema);

