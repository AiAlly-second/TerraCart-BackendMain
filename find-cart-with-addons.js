const mongoose = require("mongoose");
const Cart = require("./models/cartModel");
const User = require("./models/userModel");

require("dotenv").config();

const mongoUri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/terra-cart";

async function findCartWithAddons() {
  try {
    await mongoose.connect(mongoUri);
    console.log("Connected to DB");

    // Admin who has add-ons
    const adminWithAddons = "6929a028012403b42b92c83f";
    
    console.log(`Looking for Cart owned by admin: ${adminWithAddons}`);
    
    const cart = await Cart.findOne({ cartAdminId: adminWithAddons });
    
    if (cart) {
      console.log(`\n✅ Found Cart with Add-ons:`);
      console.log(`   Cart Name: ${cart.name || 'Unnamed'}`);
      console.log(`   Cart Document ID: ${cart._id}`);
      console.log(`\n🔗 Use this URL to test:`);
      console.log(`   http://localhost:5173/?cart=${cart._id}`);
    } else {
      console.log("❌ No cart found for this admin.");
    }

  } catch (err) {
    console.error(err);
  } finally {
    await mongoose.disconnect();
  }
}

findCartWithAddons();
