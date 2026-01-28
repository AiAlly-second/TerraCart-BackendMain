const PrintQueue = require('../models/printQueueModel');
const Order = require('../models/orderModel');

// Get pending print jobs
exports.getPending = async (req, res) => {
  try {
    const { cartId } = req.query;
    
    const query = { status: 'pending' };
    
    // Filter by cart if provided
    if (cartId) {
      query.cartId = cartId;
    } else if (req.user.role === 'admin') {
      query.cartId = req.user._id;
    }

    const pendingJobs = await PrintQueue.find(query)
      .sort({ createdAt: 1 }) // Oldest first
      .limit(50)
      .lean();

    // Format response
    const formatted = pendingJobs.map(job => ({
      _id: job._id,
      order: job.orderData,
      kot: job.kotData,
      kotIndex: job.kotIndex,
      createdAt: job.createdAt
    }));

    res.json(formatted);
  } catch (error) {
    console.error('Get pending print jobs error:', error);
    res.status(500).json({ message: error.message });
  }
};

// Mark as printed
exports.markPrinted = async (req, res) => {
  try {
    const { id } = req.params;

    const job = await PrintQueue.findById(id);
    
    if (!job) {
      return res.status(404).json({ message: 'Print job not found' });
    }

    job.status = 'printed';
    job.printedAt = new Date();
    job.printedBy = req.user?._id || 'mobile-agent';
    
    await job.save();

    res.json({
      success: true,
      message: 'Marked as printed',
      job
    });
  } catch (error) {
    console.error('Mark printed error:', error);
    res.status(500).json({ message: error.message });
  }
};

// Add to print queue (called when creating KOT)
exports.addToQueue = async (req, res) => {
  try {
    const { orderId, kotIndex, orderData, kotData, cartId } = req.body;

    // Check if already in queue
    const existing = await PrintQueue.findOne({ orderId, kotIndex });
    
    if (existing) {
      return res.json({
        success: true,
        message: 'Already in queue',
        job: existing
      });
    }

    // Create new print job
    const job = await PrintQueue.create({
      orderId,
      kotIndex: kotIndex || 0,
      orderData,
      kotData,
      cartId: cartId || req.user._id,
      status: 'pending'
    });

    res.status(201).json({
      success: true,
      message: 'Added to print queue',
      job
    });
  } catch (error) {
    console.error('Add to queue error:', error);
    res.status(500).json({ message: error.message });
  }
};

// Get all print jobs (for admin)
exports.getAll = async (req, res) => {
  try {
    const { status, cartId } = req.query;
    
    const query = {};
    
    if (status) {
      query.status = status;
    }
    
    if (cartId) {
      query.cartId = cartId;
    } else if (req.user.role === 'admin') {
      query.cartId = req.user._id;
    }

    const jobs = await PrintQueue.find(query)
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    res.json(jobs);
  } catch (error) {
    console.error('Get all print jobs error:', error);
    res.status(500).json({ message: error.message });
  }
};

// Delete old printed jobs (cleanup)
exports.cleanup = async (req, res) => {
  try {
    const daysAgo = parseInt(req.query.days) || 7;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysAgo);

    const result = await PrintQueue.deleteMany({
      status: 'printed',
      printedAt: { $lt: cutoffDate }
    });

    res.json({
      success: true,
      message: `Deleted ${result.deletedCount} old print jobs`,
      deletedCount: result.deletedCount
    });
  } catch (error) {
    console.error('Cleanup error:', error);
    res.status(500).json({ message: error.message });
  }
};
