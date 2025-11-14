const express = require("express");
const {
  joinWaitlist,
  getWaitlistStatus,
  cancelWaitlistEntry,
  seatWaitlistEntry,
  listWaitlistForTable,
  notifyNextWaitlistRoute,
  notifyWaitlistEntry,
} = require("../controllers/waitlistController");

const router = express.Router();

router.post("/", joinWaitlist);
router.get("/status", getWaitlistStatus);
router.delete("/:token", cancelWaitlistEntry);
router.patch("/:token/seat", seatWaitlistEntry);
router.get("/table/:id", listWaitlistForTable);
router.post("/table/:id/notify-next", notifyNextWaitlistRoute);
router.patch("/:token/notify", notifyWaitlistEntry);

module.exports = router;

