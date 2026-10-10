const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const service = require('../services/dailyReports/settings');
const router = express.Router();
router.use(protect);
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.use(async (req, res, next) => {
  try { req.reportScope = await service.scope(req.user, req.query.cartId); next(); }
  catch (e) { res.status(e.statusCode || 403).json({ message: e.message, code: e.code || 'REPORT_ACCESS_DENIED' }); }
});
const handle = work => async (req, res) => {
  try { res.json({ success: true, data: await work(req) }); }
  catch (e) { res.status(e.statusCode || 500).json({ message: e.statusCode ? e.message : 'Daily report operation failed', code: e.code || 'REPORT_OPERATION_FAILED' }); }
};
router.get('/', handle(req => service.get(req.reportScope)));
router.put('/', handle(req => service.update(req.reportScope, req.user._id, req.body)));
router.post('/recipients', handle(req => service.add(req.reportScope, req.user._id, req.body)));
router.delete('/recipients/:id', handle(req => service.remove(req.reportScope, req.user._id, req.params.id, Number(req.query.version))));
router.post('/preview', handle(req => service.preview(req.reportScope)));
router.post('/test', handle(req => service.test(req.reportScope, req.user._id, req.body)));
router.get('/history', handle(req => service.history(req.reportScope)));
module.exports = router;
