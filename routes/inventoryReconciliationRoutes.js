const express = require("express");
const { protect, authorize } = require("../middleware/authMiddleware");
const service = require("../services/inventoryReconciliationService");
const router = express.Router();

router.use(protect, authorize(["super_admin", "franchise_admin", "admin", "cart_admin"]));
const fail = (res, error) => res.status(error.statusCode || 500).json({
  success: false, message: error.statusCode ? error.message : "Reconciliation failed",
});
router.get("/", async (req, res) => {
  try {
    res.json({ success: true, ...(await service.getReconciliation({ user: req.user,
      franchiseAdminId: req.query.franchiseAdminId, cartId: req.query.cartId })) });
  } catch (error) { fail(res, error); }
});
router.post("/", async (req, res) => {
  try {
    const result = await service.submitReconciliation({ user: req.user,
      franchiseAdminId: req.body.franchiseAdminId, cartId: req.body.cartId,
      items: req.body.items, note: req.body.note, finalize: req.body.finalize === true });
    if (result.completed) {
      const io = req.app.get("io");
      const emit = req.app.get("emitToFranchise");
      if (io && emit) emit(io, String(result.franchiseAdminId), "feature:updated",
        { featureKey: "inventory", refetch: true });
    }
    res.json({ success: true, ...result });
  } catch (error) { fail(res, error); }
});
module.exports = router;
