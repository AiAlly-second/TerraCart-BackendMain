const mongoose = require("mongoose");
const User = require("./models/userModel");
const Addon = require("./models/addonModel");

require("dotenv").config();

const mongoUri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/terra-cart";

async function checkFranchiseRelationship() {
  try {
    await mongoose.connect(mongoUri);
    console.log("Connected to DB\n");

    // The cart admin being accessed
    const currentCartAdminId = "695e0e7e15da89dfa1d6d80a";
    // The cart admin who owns the add-ons
    const addonOwnerCartAdminId = "6929a028012403b42b92c83f";
    
    const currentAdmin = await User.findById(currentCartAdminId);
    const addonOwner = await User.findById(addonOwnerCartAdminId);
    
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`🔍 FRANCHISE RELATIONSHIP CHECK`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    
    console.log(`Current Cart Admin (accessing customer site):`);
    console.log(`  Name: ${currentAdmin.name}`);
    console.log(`  ID: ${currentCartAdminId}`);
    console.log(`  Franchise ID: ${currentAdmin.franchiseId || 'None'}\n`);
    
    console.log(`Add-on Owner (created the add-ons):`);
    console.log(`  Name: ${addonOwner.name}`);
    console.log(`  ID: ${addonOwnerCartAdminId}`);
    console.log(`  Franchise ID: ${addonOwner.franchiseId || 'None'}\n`);
    
    const addons = await Addon.find({ cartId: addonOwnerCartAdminId });
    console.log(`Add-ons in database (${addons.length}):`);
    addons.forEach(a => {
      console.log(`  - "${a.name}" (franchiseId: ${a.franchiseId || 'None'})`);
    });
    
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`💡 DIAGNOSIS`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    
    const sameFranchise = currentAdmin.franchiseId && addonOwner.franchiseId && 
                          currentAdmin.franchiseId.toString() === addonOwner.franchiseId.toString();
    
    if (sameFranchise) {
      console.log(`✅ SAME FRANCHISE - Add-ons should potentially be shared.`);
      console.log(`\nThe system can be modified to share add-ons within a franchise.`);
    } else if (!currentAdmin.franchiseId && !addonOwner.franchiseId) {
      console.log(`⚠️  Neither admin has a franchise ID.`);
      console.log(`\nThese are independent cart admins.`);
      console.log(`Add-ons are scoped per cart admin, not shared.`);
    } else {
      console.log(`❌ DIFFERENT FRANCHISES (or one has no franchise).`);
      console.log(`\nCurrent Admin Franchise: ${currentAdmin.franchiseId || 'None'}`);
      console.log(`Add-on Owner Franchise: ${addonOwner.franchiseId || 'None'}`);
      console.log(`\nAdd-ons are scoped per cart admin, not shared across different franchises.`);
    }
    
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`🎯 RECOMMENDATION`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    
    console.log(`Option 1: Create add-ons for "${currentAdmin.name}" cart`);
    console.log(`  - Log in as: ${currentAdmin.email}`);
    console.log(`  - Go to Global Add-ons page`);
    console.log(`  - Create add-ons\n`);
    
    console.log(`Option 2: Modify system to share add-ons at franchise level`);
    console.log(`  - Requires code changes to addonController.js`);
    console.log(`  - Add-ons would be shared among all carts in same franchise\n`);

  } catch (err) {
    console.error("Error:", err);
  } finally {
    await mongoose.disconnect();
  }
}

checkFranchiseRelationship();
