const mongoose = require('mongoose');
require('dotenv').config();

const Ingredient = require('./models/costing-v2/ingredientModel');

async function makeIngredientsShared() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB\n');

    // Count ingredients before update
    const totalBefore = await Ingredient.countDocuments({});
    const withCartIdBefore = await Ingredient.countDocuments({ 
      cartId: { $ne: null, $exists: true } 
    });
    
    console.log(`📊 Before Update:`);
    console.log(`   Total ingredients: ${totalBefore}`);
    console.log(`   With cartId (cart-specific): ${withCartIdBefore}`);
    console.log(`   Shared (cartId=null): ${totalBefore - withCartIdBefore}\n`);

    // Ask for confirmation
    console.log(`⚠️  This will set cartId = null for ALL ${withCartIdBefore} ingredients`);
    console.log(`   Making them visible to ALL cart admins as shared/global ingredients.\n`);
    
    // Update all ingredients to have cartId = null (make them shared)
    const result = await Ingredient.updateMany(
      { cartId: { $ne: null } }, // Find all ingredients with a cartId
      { $set: { cartId: null } } // Set cartId to null
    );

    console.log(`✅ Update complete!`);
    console.log(`   Modified ${result.modifiedCount} ingredients\n`);

    // Count after update
    const totalAfter = await Ingredient.countDocuments({});
    const withCartIdAfter = await Ingredient.countDocuments({ 
      cartId: { $ne: null, $exists: true } 
    });
    const sharedAfter = await Ingredient.countDocuments({ 
      $or: [{ cartId: null }, { cartId: { $exists: false } }] 
    });
    
    console.log(`📊 After Update:`);
    console.log(`   Total ingredients: ${totalAfter}`);
    console.log(`   With cartId (cart-specific): ${withCartIdAfter}`);
    console.log(`   Shared (cartId=null): ${sharedAfter}\n`);

    console.log(`💡 All ingredients are now shared! Cart admins should see them.`);

    await mongoose.connection.close();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

makeIngredientsShared();
