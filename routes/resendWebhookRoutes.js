const express = require('express');
const provider = require('../services/dailyReports/provider');
const worker = require('../services/dailyReports/worker');
const router = express.Router();
router.post('/', express.raw({ type: 'application/json', limit: '256kb' }), async (req, res) => {
  let event;
  try { if (!Buffer.isBuffer(req.body)) throw new Error('RAW_BODY_REQUIRED'); event = provider.verify(req.body, req.headers); }
  catch { return res.status(400).json({ message: 'Invalid webhook signature' }); }
  try { await worker.receiveEvent(event, req.headers['svix-id']); res.status(200).json({ received: true }); }
  catch { res.status(503).json({ message: 'Webhook could not be persisted; retry required' }); }
});
module.exports = router;
