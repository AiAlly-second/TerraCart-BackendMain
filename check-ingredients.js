const mongoose = require('mongoose');
require('dotenv').config();

const Ingredient = require('./models/costing-v2/ingredientModel');
const User = require('./models/userModel');

async function checkIngredients() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB\n');

    // 1. Check total ingredients
    const totalIngredients = await Ingredient.countDocuments({});
    console.log(`📦 Total Ingredients in Database: ${totalIngredients}\n`);

    if (totalIngredients === 0) {
      console.log('❌ No ingredients found in database!');
      console.log('   You need to create ingredients first.\n');
      process.exit(0);
    }

    // 2. Check ingredients by cartId
    const ingredientsWithCartId = await Ingredient.countDocuments({ 
      cartId: { $ne: null, $exists: true } 
    });
    const ingredientsWithoutCartId = await Ingredient.countDocuments({ 
      $or: [{ cartId: null }, { cartId: { $exists: false } }] 
    });
    
    console.log(`📊 Ingredient Distribution:`);
    console.log(`   - With cartId (cart-specific): ${ingredientsWithCartId}`);
    console.log(`   - Without cartId (shared/global): ${ingredientsWithoutCartId}\n`);

    // 3. Show sample ingredients
    const sampleIngredients = await Ingredient.find({})
      .limit(10)
      .select('name cartId franchiseId isActive category')
      .populate('cartId', 'name email cafeName')
      .lean();

    console.log(`📝 Sample Ingredients (first 10):`);
    for (const ing of sampleIngredients) {
      const cartInfo = ing.cartId 
        ? `Cart: ${ing.cartId.cafeName || ing.cartId.name || ing.cartId.email || ing.cartId._id}`
        : 'Shared/Global (no cartId)';
      const status = ing.isActive ? '✅ Active' : '❌ Inactive';
      console.log(`   ${status} ${ing.name} (${ing.category || 'No category'}) - ${cartInfo}`);
    }
    console.log('');

    // 4. Check all cart admins
    const cartAdmins = await User.find({ role: 'admin', isActive: true })
      .select('_id name email cafeName')
      .lean();

    console.log(`👥 Active Cart Admins (${cartAdmins.length}):`);
    for (const admin of cartAdmins) {
      const adminId = admin._id.toString();
      const cartSpecificCount = await Ingredient.countDocuments({ cartId: admin._id });
      const sharedCount = await Ingredient.countDocuments({ 
        $or: [{ cartId: null }, { cartId: { $exists: false } }]
      });
      
      console.log(`   - ${admin.cafeName || admin.name || admin.email}:`);
      console.log(`     ID: ${adminId}`);
      console.log(`     Cart-specific ingredients: ${cartSpecificCount}`);
      console.log(`     Shared ingredients available: ${sharedCount}`);
      console.log(`     Total visible: ${cartSpecificCount + sharedCount}\n`);
    }

    // 5. Check active vs inactive
    const activeCount = await Ingredient.countDocuments({ isActive: true });
    const inactiveCount = await Ingredient.countDocuments({ isActive: false });
    
    console.log(`🔍 Active Status:`);
    console.log(`   - Active (isActive: true): ${activeCount}`);
    console.log(`   - Inactive (isActive: false): ${inactiveCount}\n`);

    // 6. Recommendations
    console.log(`💡 Recommendations:`);
    if (ingredientsWithoutCartId > 0 && cartAdmins.length > 0) {
      console.log(`   ✅ You have ${ingredientsWithoutCartId} shared/global ingredients`);
      console.log(`   ✅ These should be visible to all ${cartAdmins.length} cart admins`);
    }
    
    if (ingredientsWithCartId === 0 && cartAdmins.length > 0) {
      console.log(`   ⚠️  No cart-specific ingredients - only global ones exist`);
      console.log(`   💡 This is normal if you manage ingredients centrally`);
    }

    if (inactiveCount > 0) {
      console.log(`   ⚠️  ${inactiveCount} ingredients are inactive and won't show by default`);
      console.log(`   💡 Set isActive: true to make them visible`);
    }

    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

checkIngredients();
