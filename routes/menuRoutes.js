const express = require("express");
const { protect, authorize } = require("../middleware/authMiddleware");
const {
  getPublicMenu,
  listMenu,
  createCategory,
  updateCategory,
  deleteCategory,
  createItem,
  updateItem,
  updateItemAvailability,
  deleteItem,
  SPICE_LEVELS,
  uploadMenuImage,
} = require("../controllers/menuController");

const router = express.Router();

// Public routes (no auth required)
router.get("/public", getPublicMenu);
router.get("/meta/spice-levels", (_req, res) => {
  res.json({ spiceLevels: SPICE_LEVELS });
});

// Protected routes (require authentication)
router.use(protect);
router.use(authorize(["admin", "franchise_admin", "super_admin"]));

// Menu list - filtered by cafeId for cart admins
router.get("/", listMenu);

// Category management
router.post("/categories", createCategory);
router.patch("/categories/:id", updateCategory);
router.delete("/categories/:id", deleteCategory);

// Item management
router.post("/items", createItem);
router.patch("/items/:id", updateItem);
router.patch("/items/:id/availability", updateItemAvailability);
router.delete("/items/:id", deleteItem);
router.post("/uploads", uploadMenuImage);

module.exports = router;

