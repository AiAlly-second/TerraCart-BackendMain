const mongoose = require("mongoose");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const MenuCategory = require("../models/menuCategoryModel");
const { MenuItem, SPICE_LEVELS } = require("../models/menuItemModel");

const buildCategoryWithItems = (categories, itemsByCategory) =>
  categories.map((category) => ({
    ...category,
    items: itemsByCategory[category._id.toString()] || [],
  }));

exports.getPublicMenu = async (_req, res) => {
  try {
    const categories = await MenuCategory.find({ isActive: true })
      .sort({ sortOrder: 1, name: 1 })
      .lean();

    const categoryIds = categories.map((cat) => cat._id);

    const items = await MenuItem.find({
      category: { $in: categoryIds },
      isAvailable: true,
    })
      .sort({ sortOrder: 1, name: 1 })
      .lean();

    const itemsByCategory = items.reduce((acc, item) => {
      const key = item.category.toString();
      if (!acc[key]) acc[key] = [];
      acc[key].push(item);
      return acc;
    }, {});

    return res.json(buildCategoryWithItems(categories, itemsByCategory));
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

exports.listMenu = async (req, res) => {
  try {
    // Filter by cafeId if user is cafe admin
    const cafeId = req.user && req.user.role === "admin" ? req.user._id : null;
    const categoryQuery = {};
    const itemQuery = {};
    
    if (cafeId) {
      categoryQuery.cafeId = cafeId;
      itemQuery.cafeId = cafeId;
    }
    
    const categories = await MenuCategory.find(categoryQuery)
      .sort({ sortOrder: 1, name: 1 })
      .lean();
    const categoryIds = categories.map((cat) => cat._id);
    
    if (categoryIds.length > 0) {
      itemQuery.category = { $in: categoryIds };
    } else {
      itemQuery.category = { $in: [] }; // No categories, so no items
    }
    
    const items = await MenuItem.find(itemQuery)
      .sort({ sortOrder: 1, name: 1 })
      .lean();

    const itemsByCategory = items.reduce((acc, item) => {
      const key = item.category.toString();
      if (!acc[key]) acc[key] = [];
      acc[key].push(item);
      return acc;
    }, {});

    return res.json(buildCategoryWithItems(categories, itemsByCategory));
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

exports.createCategory = async (req, res) => {
  try {
    const { name, description, icon, sortOrder, isActive = true } = req.body || {};
    if (!name) {
      return res.status(400).json({ message: "Category name is required" });
    }

    // Set cafeId if user is cafe admin
    const cafeId = req.user && req.user.role === "admin" ? req.user._id : null;

    const category = await MenuCategory.create({
      name,
      description,
      icon,
      sortOrder,
      isActive,
      cafeId: cafeId,
    });

    return res.status(201).json(category);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

exports.updateCategory = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid category id" });
    }

    const allowed = ["name", "description", "icon", "sortOrder", "isActive"];
    const updates = {};
    allowed.forEach((key) => {
      if (key in req.body) updates[key] = req.body[key];
    });

    const category = await MenuCategory.findByIdAndUpdate(id, updates, {
      new: true,
    }).lean();

    if (!category) {
      return res.status(404).json({ message: "Category not found" });
    }

    return res.json(category);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

exports.deleteCategory = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid category id" });
    }

    const hasItems = await MenuItem.exists({ category: id });
    if (hasItems) {
      return res.status(409).json({
        message: "Cannot delete category while items exist. Remove items first.",
      });
    }

    const category = await MenuCategory.findByIdAndDelete(id);
    if (!category) {
      return res.status(404).json({ message: "Category not found" });
    }

    return res.json({ message: "Category deleted" });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

exports.createItem = async (req, res) => {
  try {
    const {
      categoryId,
      name,
      description,
      price,
      image,
      isAvailable = true,
      isFeatured = false,
      spiceLevel = "NONE",
      sortOrder,
      tags,
      allergens,
      calories,
    } = req.body || {};

    if (!categoryId || !mongoose.Types.ObjectId.isValid(categoryId)) {
      return res.status(400).json({ message: "Valid categoryId is required" });
    }
    if (!name) {
      return res.status(400).json({ message: "Item name is required" });
    }
    if (price === undefined || price === null) {
      return res.status(400).json({ message: "Item price is required" });
    }
    if (!SPICE_LEVELS.includes(spiceLevel)) {
      return res
        .status(400)
        .json({ message: `Spice level must be one of ${SPICE_LEVELS.join(", ")}` });
    }

    const category = await MenuCategory.findById(categoryId);
    if (!category) {
      return res.status(404).json({ message: "Parent category not found" });
    }

    // Set cafeId if user is cafe admin, and verify category belongs to same cafe
    const cafeId = req.user && req.user.role === "admin" ? req.user._id : null;
    if (cafeId && category.cafeId && category.cafeId.toString() !== cafeId.toString()) {
      return res.status(403).json({ message: "Category does not belong to your cafe" });
    }
    const finalCafeId = cafeId || category.cafeId || null;

    const item = await MenuItem.create({
      category: categoryId,
      name,
      description,
      price,
      image,
      isAvailable,
      isFeatured,
      spiceLevel,
      sortOrder,
      tags,
      allergens,
      calories,
      cafeId: finalCafeId,
    });

    return res.status(201).json(item);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ message: "Duplicate menu item name within category" });
    }
    return res.status(500).json({ message: err.message });
  }
};

exports.updateItem = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid item id" });
    }

    const allowed = [
      "name",
      "description",
      "price",
      "image",
      "isAvailable",
      "isFeatured",
      "spiceLevel",
      "sortOrder",
      "tags",
      "allergens",
      "calories",
      "categoryId",
    ];
    const updates = {};
    for (const key of allowed) {
      if (key in req.body) {
        if (key === "categoryId") {
          if (!mongoose.Types.ObjectId.isValid(req.body[key])) {
            return res.status(400).json({ message: "Invalid categoryId" });
          }
          updates.category = req.body[key];
        } else {
          updates[key] = req.body[key];
        }
      }
    }

    if (updates.spiceLevel && !SPICE_LEVELS.includes(updates.spiceLevel)) {
      return res
        .status(400)
        .json({ message: `Spice level must be one of ${SPICE_LEVELS.join(", ")}` });
    }

    const item = await MenuItem.findByIdAndUpdate(id, updates, {
      new: true,
      runValidators: true,
    }).lean();

    if (!item) {
      return res.status(404).json({ message: "Menu item not found" });
    }

    return res.json(item);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ message: "Duplicate menu item name within category" });
    }
    return res.status(500).json({ message: err.message });
  }
};

exports.updateItemAvailability = async (req, res) => {
  try {
    const { id } = req.params;
    const { isAvailable } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid item id" });
    }
    if (typeof isAvailable !== "boolean") {
      return res.status(400).json({ message: "isAvailable boolean is required" });
    }

    const item = await MenuItem.findByIdAndUpdate(
      id,
      { isAvailable },
      { new: true, runValidators: true }
    ).lean();

    if (!item) {
      return res.status(404).json({ message: "Menu item not found" });
    }

    return res.json(item);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

exports.deleteItem = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid item id" });
    }

    const item = await MenuItem.findByIdAndDelete(id);
    if (!item) {
      return res.status(404).json({ message: "Menu item not found" });
    }

    // After deletion update category counts indirectly
    return res.json({ message: "Menu item deleted" });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

exports.SPICE_LEVELS = SPICE_LEVELS;

const uploadsDir = path.join(__dirname, "..", "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const ext = path.extname(file.originalname) || ".jpg";
    cb(null, `${unique}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      cb(new Error("Only image uploads are allowed"));
    } else {
      cb(null, true);
    }
  },
});

exports.uploadMenuImage = [
  upload.single("image"),
  (req, res) => {
    if (!req.file) {
      return res.status(400).json({ message: "No image uploaded" });
    }
    const fileUrl = `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`;
    return res.status(201).json({
      url: fileUrl,
      filename: req.file.filename,
      size: req.file.size,
    });
  },
];

