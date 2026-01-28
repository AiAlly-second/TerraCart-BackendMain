const mongoose = require('mongoose');

const printQueueSchema = new mongoose.Schema({
  orderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order',
    required: true,
    index: true
  },
  kotIndex: {
    type: Number,
    required: true,
    default: 0
  },
  orderData: {
    type: Object,
    required: true
  },
  kotData: {
    type: Object,
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'printed', 'failed'],
    default: 'pending',
    index: true
  },
  cartId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true
  },
  printedAt: {
    type: Date
  },
  printedBy: {
    type: String
  },
  error: {
    type: String
  }
}, {
  timestamps: true
});

// Compound indexes
printQueueSchema.index({ cartId: 1, status: 1, createdAt: -1 });
printQueueSchema.index({ orderId: 1, kotIndex: 1 }, { unique: true });

module.exports = mongoose.model('PrintQueue', printQueueSchema);
