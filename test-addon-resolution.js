const mongoose = require("mongoose");
const Addon = require("./models/addonModel");
const Cart = require("./models/cartModel");
const User = require("./models/userModel");
const Table = require("./models/tableModel");

require("dotenv").config();

const mongoUri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/terra-cart";

async function runTest() {
  try {
    await mongoose.connect(mongoUri);
    console.log("Connected to DB");

    // 1. Find ANY available Addon
    const addon = await Addon.findOne({ isAvailable: true });
    if (!addon) {
      console.log("❌ No Available Add-ons found in DB! Admin needs to create one.");
      return;
    }
    console.log(`✅ Found Add-on: "${addon.name}" (ID: ${addon._id})`);
    console.log(`   - Linked cartId (User ID): ${addon.cartId}`);

    // 2. Find the User (Cart Admin) who owns this addon
    const adminUser = await User.findById(addon.cartId);
    if (!adminUser) {
      console.log("❌ Add-on owner (User) not found!");
      return;
    }
    console.log(`✅ Found Admin User: ${adminUser.name} (${adminUser._id})`);

    // 3. Find a Cart Document owned by this Admin
    const cartDoc = await Cart.findOne({ cartAdminId: adminUser._id });
    if (!cartDoc) {
      console.log("❌ No Cart Document found for this Admin!");
      return;
    }
    console.log(`✅ Found Cart Document: ${cartDoc.name || 'Unnamed'} (${cartDoc._id})`);

    // 4. Simulate getPublicAddons logic with CART DOCUMENT ID
    console.log("\n--- Simulating API Call with CART DOCUMENT ID ---");
    const targetCartId = cartDoc._id.toString();
    console.log(`Querying with cartId = ${targetCartId}`);

    // LOGIC FROM CONTROLLER (Simplified for test)
    let solvedCartId = targetCartId;
    if (mongoose.Types.ObjectId.isValid(targetCartId)) {
        const c = await Cart.findById(targetCartId).select("cartAdminId").lean();
        if (c && c.cartAdminId) {
            console.log(`   [Logic] Resolved Cart Doc ID to Admin ID: ${c.cartAdminId}`);
            solvedCartId = c.cartAdminId.toString();
        }
    }

    const idsToMatch = [];
    if (mongoose.Types.ObjectId.isValid(solvedCartId)) idsToMatch.push(new mongoose.Types.ObjectId(solvedCartId));
    if (targetCartId !== solvedCartId && mongoose.Types.ObjectId.isValid(targetCartId)) idsToMatch.push(new mongoose.Types.ObjectId(targetCartId));

    console.log(`   [Logic] IDs to match in DB:`, idsToMatch);

    const addonsFound = await Addon.find({
        cartId: { $in: idsToMatch },
        $or: [{ isAvailable: true }, { isAvailable: { $exists: false } }]
    });

    if (addonsFound.length > 0) {
        console.log(`✅ SUCCESS: Found ${addonsFound.length} add-ons using Cart Document ID.`);
    } else {
        console.log(`❌ FAILURE: Did not find add-ons using Cart Document ID.`);
    }

    // 5. Check Table logic
    console.log("\n--- Checking Table Logic ---");
    const table = await Table.findOne({ cartId: { $in: [cartDoc._id, adminUser._id] } });
    if (table) {
        console.log(`Found Table ${table.tableNumber} linked to ${table.cartId}`);
    } else {
        console.log("No table found linked to this cart/admin.");
    }

  } catch (err) {
    console.error(err);
  } finally {
    await mongoose.disconnect();
  }
}

runTest();
