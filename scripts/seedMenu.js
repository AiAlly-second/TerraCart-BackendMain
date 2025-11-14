const path = require("path");
const dotenv = require("dotenv");
const connectDB = require("../config/db");
const MenuCategory = require("../models/menuCategoryModel");
const { MenuItem } = require("../models/menuItemModel");

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const seedCatalog = [
  {
    name: "Street Snacks",
    description: "Favourite Indian street food staples, perfect for a quick bite.",
    sortOrder: 1,
    isActive: true,
    items: [
      {
        name: "Mumbai Vada Pav",
        description: "Buttery ladi pav stuffed with spiced potato fritter, served with chutneys.",
        price: 45,
        image:
          "https://images.unsplash.com/photo-1633432666601-1fa7f4ff64c4?auto=format&fit=crop&w=800&q=80",
        spiceLevel: "MEDIUM",
        isAvailable: true,
        tags: ["vegetarian", "street-food"],
      },
      {
        name: "Punjabi Samosa Chaat",
        description: "Crispy samosa topped with curd, chutneys and crunchy sev.",
        price: 95,
        image:
          "https://images.unsplash.com/photo-1618512496248-0baaae45d818?auto=format&fit=crop&w=800&q=80",
        spiceLevel: "MEDIUM",
        isAvailable: true,
        tags: ["vegetarian"],
      },
      {
        name: "Paneer Kathi Roll",
        description: "Soft roomali roti filled with tandoori paneer, peppers and mint chutney.",
        price: 165,
        image:
          "https://images.unsplash.com/photo-1597676071890-b90e42fb3ab4?auto=format&fit=crop&w=800&q=80",
        spiceLevel: "HOT",
        isAvailable: true,
        tags: ["paneer"],
      },
    ],
  },
  {
    name: "North Indian Curries",
    description: "Rich, slow cooked curries inspired by the north of India.",
    sortOrder: 2,
    isActive: true,
    items: [
      {
        name: "Paneer Butter Masala",
        description: "Cottage cheese simmered in velvety tomato-butter gravy.",
        price: 280,
        image:
          "https://images.unsplash.com/photo-1604908177636-45e883dafe14?auto=format&fit=crop&w=800&q=80",
        spiceLevel: "MILD",
        isAvailable: true,
        tags: ["paneer", "gluten-free"],
      },
      {
        name: "Amritsari Chole",
        description: "Punjab-style chickpeas cooked with blend of whole spices.",
        price: 210,
        image:
          "https://images.unsplash.com/photo-1504674900247-0877df9cc836?auto=format&fit=crop&w=800&q=80",
        spiceLevel: "MEDIUM",
        isAvailable: true,
        tags: ["vegan", "protein-rich"],
      },
      {
        name: "Dal Tadka",
        description: "Yellow lentils tempered with ghee, cumin, garlic and chillies.",
        price: 190,
        image:
          "https://images.unsplash.com/photo-1562967916-eb82221dfb36?auto=format&fit=crop&w=800&q=80",
        spiceLevel: "MEDIUM",
        isAvailable: true,
        tags: ["gluten-free", "protein-rich"],
      },
    ],
  },
  {
    name: "Breads & Rice",
    description: "Freshly baked breads and fragrant rice staples to complete the meal.",
    sortOrder: 3,
    isActive: true,
    items: [
      {
        name: "Garlic Butter Naan",
        description: "Fluffy tandoor-baked naan brushed with garlic butter.",
        price: 55,
        image:
          "https://images.unsplash.com/photo-1548946526-f69e2424cf45?auto=format&fit=crop&w=800&q=80",
        spiceLevel: "NONE",
        isAvailable: true,
        tags: ["bread"],
      },
      {
        name: "Tandoori Roti",
        description: "Whole-wheat roti cooked in a clay oven for smoky flavour.",
        price: 35,
        image:
          "https://images.unsplash.com/photo-1525755662778-989d0524087e?auto=format&fit=crop&w=800&q=80",
        spiceLevel: "NONE",
        isAvailable: true,
        tags: ["bread", "vegan"],
      },
      {
        name: "Veg Dum Biryani",
        description: "Layered basmati rice cooked on dum with seasonal vegetables.",
        price: 240,
        image:
          "https://images.unsplash.com/photo-1601050690597-df2411e7f1fb?auto=format&fit=crop&w=800&q=80",
        spiceLevel: "MEDIUM",
        isAvailable: true,
        tags: ["gluten-free"],
      },
    ],
  },
  {
    name: "Regional Specials",
    description: "Chef’s curated favourites from across the country.",
    sortOrder: 4,
    isActive: true,
    items: [
      {
        name: "Hyderabadi Chicken 65",
        description: "Crispy, fiery fried chicken tossed with curry leaves and chillies.",
        price: 265,
        image:
          "https://images.unsplash.com/photo-1612874472173-62c91e1882b7?auto=format&fit=crop&w=800&q=80",
        spiceLevel: "HOT",
        isAvailable: true,
        tags: ["non-vegetarian", "spicy"],
      },
      {
        name: "Goan Fish Curry",
        description: "Coastal fish cooked in coconut, kokum and aromatic spices.",
        price: 320,
        image:
          "https://images.unsplash.com/photo-1512058564366-18510be2db19?auto=format&fit=crop&w=800&q=80",
        spiceLevel: "MEDIUM",
        isAvailable: true,
        tags: ["seafood", "gluten-free"],
      },
      {
        name: "Kerala Parotta Combo",
        description: "Flaky parottas served with vegetable stew and coconut chutney.",
        price: 210,
        image:
          "https://images.unsplash.com/photo-1623689046244-cd827872e252?auto=format&fit=crop&w=800&q=80",
        spiceLevel: "MILD",
        isAvailable: true,
        tags: ["vegetarian"],
      },
    ],
  },
  {
    name: "Desserts & Beverages",
    description: "Sweet endings and refreshing beverages to complete your meal.",
    sortOrder: 5,
    isActive: true,
    items: [
      {
        name: "Classic Gulab Jamun",
        description: "Soft khoya dumplings soaked in saffron cardamom syrup.",
        price: 110,
        image:
          "https://images.unsplash.com/photo-1603899129807-3b5c9b35c97e?auto=format&fit=crop&w=800&q=80",
        spiceLevel: "NONE",
        isAvailable: true,
        tags: ["dessert"],
      },
      {
        name: "Kulfi Falooda",
        description: "Saffron kulfi served with falooda sev, basil seeds and rose syrup.",
        price: 160,
        image:
          "https://images.unsplash.com/photo-1612874742349-e06c61a4c9b8?auto=format&fit=crop&w=800&q=80",
        spiceLevel: "NONE",
        isAvailable: true,
        tags: ["dessert"],
      },
      {
        name: "Masala Chaas",
        description: "Refreshing buttermilk spiked with roasted cumin and mint.",
        price: 60,
        image:
          "https://images.unsplash.com/photo-1515003197210-e0cd71810b5f?auto=format&fit=crop&w=800&q=80",
        spiceLevel: "MILD",
        isAvailable: true,
        tags: ["beverage"],
      },
    ],
  },
];

const seedMenu = async () => {
  try {
    await connectDB();
    console.log("🌱 Connected to MongoDB");

    for (const categoryData of seedCatalog) {
      const { items, ...categoryFields } = categoryData;
      let categoryDoc = await MenuCategory.findOne({ name: categoryFields.name });

      if (categoryDoc) {
        Object.assign(categoryDoc, categoryFields);
        await categoryDoc.save();
        console.log(`✅ Updated category: ${categoryDoc.name}`);
      } else {
        categoryDoc = await MenuCategory.create(categoryFields);
        console.log(`✅ Created category: ${categoryDoc.name}`);
      }

      for (const itemData of items) {
        const query = { category: categoryDoc._id, name: itemData.name };
        const update = {
          ...itemData,
          category: categoryDoc._id,
        };
        await MenuItem.findOneAndUpdate(query, update, {
          upsert: true,
          new: true,
          setDefaultsOnInsert: true,
        });
        console.log(`   • synced item: ${itemData.name}`);
      }
    }

    console.log("🎉 Menu seeding completed.");
    process.exit(0);
  } catch (err) {
    console.error("❌ Menu seeding failed", err);
    process.exit(1);
  }
};

seedMenu();



