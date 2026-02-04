// DIAGNOSTIC SCRIPT - Run this in Node.js REPL to check ingredients
// Usage: node diagnostics_ingredients.js

const mongoose = require('mongoose');
require('dotenv').config();

async function diagnoseIngredients() {
  try {
    console.log('Connecting to MongoDB...');
    // Try both common environment variable names
    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!mongoUri) {
      console.error('❌ MongoDB URI not found in environment variables!');
      console.error('   Check your .env file for MONGO_URI or MONGODB_URI');
      process.exit(1);
    }
    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB\n');

    const Ingredient = require('./models/costing-v2/ingredientModel');
    
    // Total count
    const total = await Ingredient.countDocuments({});
    console.log(`📊 TOTAL INGREDIENTS IN DATABASE: ${total}\n`);
    
    if (total === 0) {
      console.log('❌ NO INGREDIENTS FOUND IN DATABASE!');
      console.log('   → Super Admin needs to create ingredients first');
      console.log('   → Go to Finances → Ingredients → Add Ingredient\n');
      process.exit(0);
    }
    
    // Breakdown by cartId
    console.log('📋 BREAKDOWN BY CART/KIOSK:');
    const sharedCount = await Ingredient.countDocuments({ cartId: null });
    const withCartId = await Ingredient.countDocuments({ cartId: { $ne: null } });
    const noCartIdField = await Ingredient.countDocuments({ cartId: { $exists: false } });
    
    console.log(`   - Shared (cartId: null): ${sharedCount}`);
    console.log(`   - Cart-specific (has cartId): ${withCartId}`);
    console.log(`   - Legacy (no cartId field): ${noCartIdField}\n`);
    
    // Breakdown by isActive
    console.log('🔘 BREAKDOWN BY ACTIVE STATUS:');
    const active = await Ingredient.countDocuments({ isActive: true });
    const inactive = await Ingredient.countDocuments({ isActive: false });
    console.log(`   - Active: ${active}`);
    console.log(`   - Inactive: ${inactive}\n`);
    
    // Shared ingredients breakdown
    if (sharedCount > 0) {
      console.log('🌍 SHARED INGREDIENTS DETAILS:');
      const sharedActive = await Ingredient.countDocuments({ cartId: null, isActive: true });
      const sharedInactive = await Ingredient.countDocuments({ cartId: null, isActive: false });
      console.log(`   - Shared + Active: ${sharedActive}`);
      console.log(`   - Shared + Inactive: ${sharedInactive}\n`);
      
      // Sample shared ingredients
      const sampleShared = await Ingredient.find({ cartId: null })
        .select('name category isActive franchiseId')
        .limit(10)
        .lean();
      
      console.log('📝 SAMPLE SHARED INGREDIENTS:');
      sampleShared.forEach((ing, idx) => {
        console.log(`   ${idx + 1}. ${ing.name} (${ing.category}) - ${ing.isActive ? '✅ Active' : '❌ Inactive'} - franchiseId: ${ing.franchiseId || 'null'}`);
      });
      console.log('');
    }
    
    // Cart-specific breakdown
    if (withCartId > 0) {
      const cartIds = await Ingredient.distinct('cartId', { cartId: { $ne: null } });
      console.log(`🏪 CART-SPECIFIC INGREDIENTS:`);
      console.log(`   - Number of carts with ingredients: ${cartIds.length}\n`);
      
      for (const cartId of cartIds.slice(0, 5)) {
        const count = await Ingredient.countDocuments({ cartId: cartId });
        const User = require('./models/userModel');
        const cart = await User.findById(cartId).select('cafeName name email').lean();
        console.log(`   - ${cart?.cafeName || cart?.name || 'Unknown'} (${cartId}): ${count} ingredients`);
      }
      console.log('');
    }
    
    // Test query for cart admin
    console.log('🧪 TEST QUERY FOR CART ADMIN:');
    console.log('   Enter a cart admin user ID to test: (press Ctrl+C tocancel)');
    
    // For now, just test with the first cart admin we find
    const User = require('./models/userModel');
    const cartAdmin = await User.findOne({ role: 'admin' }).select('_id cafeName name email').lean();
    
    if (cartAdmin) {
      console.log(`   Testing with: ${cartAdmin.cafeName || cartAdmin.name} (${cartAdmin._id})\n`);
      
      const testCartId = new mongoose.Types.ObjectId(cartAdmin._id);
      
      // Test the query cart admin would use
      const testQuery = {
        $or: [
          { cartId: null },
          { cartId: testCartId },
          { cartId: { $exists: false } }
        ]
      };
      
      const testResults = await Ingredient.countDocuments(testQuery);
      console.log(`   ✅ Query result: ${testResults} ingredients`);
      
      if (testResults === 0) {
        console.log(`   ❌ PROBLEM: Cart admin would see 0 ingredients!`);
        console.log(`   ℹ️  This cart has:`);
        console.log(`      - Own ingredients: ${await Ingredient.countDocuments({ cartId: testCartId })}`);
        console.log(`      - Available shared: ${sharedCount}`);
        console.log(`   🔧 FIX: Super admin should push ingredients to this cart\n`);
      } else {
        console.log(`   ✅ GOOD: Cart admin would see ${testResults} ingredients`);
        
        const breakdown = {
          shared: await Ingredient.countDocuments({ cartId: null }),
          own: await Ingredient.countDocuments({ cartId: testCartId }),
          legacy: await Ingredient.countDocuments({ cartId: { $exists: false } })
        };
        console.log(`      - Shared: ${breakdown.shared}`);
        console.log(`      - Own: ${breakdown.own}`);
        console.log(`      - Legacy: ${breakdown.legacy}\n`);
      }
    } else {
      console.log('   ⚠️  No cart admin found in database\n');
    }
    
    console.log('✅ Diagnosis complete!');
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Error during diagnosis:', error.message);
    console.error(error);
    process.exit(1);
  }
}

diagnoseIngredients();
