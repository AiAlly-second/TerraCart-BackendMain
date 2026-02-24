const express = require("express");
const { protect, authorize, optionalProtect } = require("../middleware/authMiddleware");
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

router.get("/public", optionalProtect, getPublicMenu);
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

// Handle GET requests to /uploads (common mistake - this is a POST-only endpoint)
router.get("/uploads", (req, res) => {
  return res.status(400).json({ 
    message: "This endpoint is for uploading images (POST only). If you're seeing this in an image src, the image URL in the database is incorrect. Please re-upload the image.",
    hint: "Use POST /api/menu/uploads with form-data containing 'image' field to upload."
  });
});

router.post("/uploads", uploadMenuImage);

module.exports = router;

