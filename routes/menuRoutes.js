const express = require("express");
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

router.get("/public", getPublicMenu);
router.get("/", listMenu);

router.post("/categories", createCategory);
router.patch("/categories/:id", updateCategory);
router.delete("/categories/:id", deleteCategory);

router.post("/items", createItem);
router.patch("/items/:id", updateItem);
router.patch("/items/:id/availability", updateItemAvailability);
router.delete("/items/:id", deleteItem);
router.post("/uploads", uploadMenuImage);

router.get("/meta/spice-levels", (_req, res) => {
  res.json({ spiceLevels: SPICE_LEVELS });
});

module.exports = router;

