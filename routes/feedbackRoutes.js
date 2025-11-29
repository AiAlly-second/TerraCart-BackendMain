const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const {
  getAllFeedback,
  getFeedback,
  createFeedback,
  getFeedbackStats,
} = require("../controllers/feedbackController");

// Public route for customers to submit feedback (no authentication required)
router.post("/public", createFeedback);

// Protected routes for admin (require authentication)
router.use(protect); // All routes below require authentication

router.get("/", getAllFeedback);
router.get("/stats", getFeedbackStats);
router.get("/:id", getFeedback);
router.post("/", createFeedback);

module.exports = router;



