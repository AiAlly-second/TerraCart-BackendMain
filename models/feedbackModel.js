const mongoose = require("mongoose");

const feedbackSchema = new mongoose.Schema(
  {
    // Order-specific feedback
    orderId: { type: String, ref: "Order", index: true },
    tableId: { type: mongoose.Schema.Types.ObjectId, ref: "Table", index: true },
    
    // Overall satisfaction rating (1-5 stars)
    overallRating: {
      type: Number,
      min: 1,
      max: 5,
      required: true,
    },
    
    // Order-specific feedback
    orderFeedback: {
      foodQuality: { type: Number, min: 1, max: 5 },
      serviceSpeed: { type: Number, min: 1, max: 5 },
      orderAccuracy: { type: Number, min: 1, max: 5 },
      comments: { type: String },
    },
    
    // Overall experience feedback
    overallExperience: {
      ambiance: { type: Number, min: 1, max: 5 },
      cleanliness: { type: Number, min: 1, max: 5 },
      staffBehavior: { type: Number, min: 1, max: 5 },
      valueForMoney: { type: Number, min: 1, max: 5 },
      overallComments: { type: String },
    },
    
    // Customer information (optional)
    customerName: { type: String },
    customerEmail: { type: String },
    customerPhone: { type: String },
    
    // Hierarchy relationships
    cartId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true }, // Changed from cafeId to cartId
    franchiseId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Feedback", feedbackSchema);













