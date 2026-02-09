const mongoose = require("mongoose");
const Addon = require("./models/addonModel");
const Cart = require("./models/cartModel");
const User = require("./models/userModel");

require("dotenv").config();

const mongoUri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/terra-cart";

async function diagnoseAddonIssue() {
  try {
    await mongoose.connect(mongoUri);
    console.log("Connected to DB\n");

    // The cart being accessed from the logs
    const cartDocId = "696ddefc0ce4e226390e21c2";
    
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`📋 CART ANALYSIS`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    
    // 1. Get cart info
    const cart = await Cart.findById(cartDocId);
    if (!cart) {
      console.log("❌ Cart not found!");
      return;
    }
    
    console.log(`Cart Name: ${cart.name || 'Unnamed'}`);
    console.log(`Cart Document ID: ${cartDocId}`);
    console.log(`Cart Admin ID: ${cart.cartAdminId}`);
    
    // 2. Get admin info
    const admin = await User.findById(cart.cartAdminId);
    if (admin) {
      console.log(`Admin Name: ${admin.name}`);
      console.log(`Admin Email: ${admin.email}`);
      console.log(`Admin Role: ${admin.role}`);
    }
    
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`🔍 ADD-ONS ANALYSIS`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    
    // 3. Find add-ons for this cart admin
    const addonsForAdmin = await Addon.find({ cartId: cart.cartAdminId });
    console.log(`\nAdd-ons linked to this Cart Admin (${cart.cartAdminId}):`);
    if (addonsForAdmin.length === 0) {
      console.log("❌ NO ADD-ONS FOUND FOR THIS ADMIN\n");
    } else {
      addonsForAdmin.forEach((a, i) => {
        console.log(`  ${i + 1}. "${a.name}" - Price: ₹${a.price}, Available: ${a.isAvailable}`);
      });
    }
    
    // 4. Find ALL add-ons in the system
    const allAddons = await Addon.find({});
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`📊 ALL ADD-ONS IN DATABASE (${allAddons.length} total)`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    
    for (const addon of allAddons) {
      const owner = await User.findById(addon.cartId);
      const matchesCurrentCart = addon.cartId.toString() === cart.cartAdminId.toString();
      
      console.log(`${matchesCurrentCart ? '✅' : '❌'} "${addon.name}"`);
      console.log(`   Owner: ${owner ? owner.name : 'Unknown'} (${addon.cartId})`);
      console.log(`   Price: ₹${addon.price}, Available: ${addon.isAvailable}`);
      console.log(`   ${matchesCurrentCart ? '👉 SHOULD APPEAR' : '🚫 BELONGS TO DIFFERENT CART'}\n`);
    }
    
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`💡 SOLUTION`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    
    if (addonsForAdmin.length === 0) {
      console.log(`\n⚠️  The cart you're accessing has NO add-ons configured.`);
      console.log(`\nTo fix this:`);
      console.log(`1. Log in to the Admin Panel as: ${admin ? admin.email : 'the cart owner'}`);
      console.log(`2. Go to "Global Add-ons" page`);
      console.log(`3. Create add-ons (e.g., "Extra Cheese", "Napkins", etc.)`);
      console.log(`4. Refresh the customer frontend\n`);
    } else {
      console.log(`\n✅ This cart has ${addonsForAdmin.length} add-on(s) configured.`);
      console.log(`The add-ons should appear on the frontend.\n`);
    }

  } catch (err) {
    console.error("Error:", err);
  } finally {
    await mongoose.disconnect();
  }
}

diagnoseAddonIssue();
