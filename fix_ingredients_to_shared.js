// FIX SCRIPT - Convert cart-specific ingredients to shared
// This will make all ingredients visible to all cart admins
// Run with: node fix_ingredients_to_shared.js

const mongoose = require('mongoose');
require('dotenv').config();

async function fixIngredientsToShared() {
  try {
    console.log('🔧 FIXING INGREDIENTS - Converting to Shared\n');
    console.log('Connecting to MongoDB...');
    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB\n');

    const Ingredient = require('./models/costing-v2/ingredientModel');
    
    // Check current state
    const total = await Ingredient.countDocuments({});
    const shared = await Ingredient.countDocuments({ cartId: null });
    const cartSpecific = await Ingredient.countDocuments({ cartId: { $ne: null } });
    
    console.log('📊 CURRENT STATE:');
    console.log(`   - Total ingredients: ${total}`);
    console.log(`   - Shared (cartId: null): ${shared}`);
    console.log(`   - Cart-specific: ${cartSpecific}\n`);
    
    if (cartSpecific === 0) {
      console.log('✅ All ingredients are already shared!');
      console.log('   No fixes needed.\n');
      process.exit(0);
    }
    
    // Get all cart-specific ingredients
    const ingredientsToFix = await Ingredient.find({ cartId: { $ne: null } })
      .select('name category cartId')
      .lean();
    
    console.log('🔄 CONVERTING TO SHARED:');
    console.log(`   Found ${ingredientsToFix.length} cart-specific ingredients to convert\n`);
    
    // Show sample
    console.log('📝 SAMPLE INGREDIENTS TO CONVERT:');
    ingredientsToFix.slice(0, 10).forEach((ing, idx) => {
      console.log(`   ${idx + 1}. ${ing.name} (${ing.category}) - currently owned by cart: ${ing.cartId}`);
    });
    if (ingredientsToFix.length > 10) {
      console.log(`   ... and ${ingredientsToFix.length - 10} more\n`);
    } else {
      console.log('');
    }
    
    // Confirm before proceeding
    console.log('⚠️  WARNING: This will make these ingredients SHARED (visible to all carts)');
    console.log('⚠️  Cart-specific inventory quantities will be preserved per cart\n');
    console.log('✅ Proceeding with conversion...\n');
    
    // Update all cart-specific ingredients to shared (cartId: null)
    const updateResult = await Ingredient.updateMany(
      { cartId: { $ne: null } },
      { $set: { cartId: null } }
    );
    
    console.log(`✅ CONVERSION COMPLETE!`);
    console.log(`   Modified ${updateResult.modifiedCount} ingredients\n`);
    
    // Verify
    const newShared = await Ingredient.countDocuments({ cartId: null });
    const newCartSpecific = await Ingredient.countDocuments({ cartId: { $ne: null } });
    
    console.log('📊 NEW STATE:');
    console.log(`   - Total ingredients: ${total}`);
    console.log(`   - Shared (cartId: null): ${newShared}`);
    console.log(`   - Cart-specific: ${newCartSpecific}\n`);
    
    console.log('✅ All cart admins can now see these ingredients!');
    console.log('ℹ️  Note: Each cart still maintains separate inventory quantities\n');
    
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Error during fix:', error.message);
    console.error(error);
    process.exit(1);
  }
}

fixIngredientsToShared();
