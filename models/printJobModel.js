const mongoose = require("mongoose");

const printJobSchema = new mongoose.Schema(
  {
    printKey: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    orderId: {
      type: String,
      required: true,
      index: true,
    },
    cartId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    docType: {
      type: String,
      enum: ["KOT", "BILL"],
      required: true,
      index: true,
    },
    printerId: {
      type: String,
      default: "default",
      index: true,
    },
    orderVersion: {
      type: String,
      default: "",
    },
    status: {
      type: String,
      enum: ["PENDING", "SUCCESS", "FAILED"],
      default: "PENDING",
      index: true,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    completedAt: {
      type: Date,
      default: null,
    },
    errorMessage: {
      type: String,
      default: "",
    },
  },
  { timestamps: true },
);

printJobSchema.index({ orderId: 1, docType: 1, createdAt: -1 });
printJobSchema.index({ cartId: 1, docType: 1, createdAt: -1 });

module.exports = mongoose.model("PrintJob", printJobSchema);
