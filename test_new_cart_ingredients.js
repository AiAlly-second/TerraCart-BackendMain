// TEST SCRIPT - Check what a new cart admin would see for ingredients
// Usage: node test_new_cart_ingredients.js <CART_ADMIN_ID>

const mongoose = require('mongoose');
require('dotenv').config();

async function testNewCartIngredients() {
  try {
    const cartAdminId = process.argv[2];
    
    if (!cartAdminId) {
      console.log('Usage: node test_new_cart_ingredients.js <CART_ADMIN_ID>');
      console.log('\nTo find cart admin IDs, run: node list_users.js');
      process.exit(1);
    }
    
    console.log('Connecting to MongoDB...');
    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB\n');

    const Ingredient = require('./models/costing-v2/ingredientModel');
    const User = require('./models/userModel');
    
    // Verify cart admin exists
    const cartAdmin = await User.findById(cartAdminId).lean();
    if (!cartAdmin) {
      console.error(`❌ Cart admin with ID ${cartAdminId} not found!`);
      process.exit(1);
    }
    
    console.log(`📋 Testing for Cart Admin: ${cartAdmin.cafeName || cartAdmin.name || cartAdmin.email}`);
    console.log(`   - ID: ${cartAdminId}`);
    console.log(`   - Role: ${cartAdmin.role}`);
    console.log(`   - Franchise ID: ${cartAdmin.franchiseId || 'null'}\n`);
    
    // Check total ingredients in database
    const totalIngredients = await Ingredient.countDocuments({});
    const sharedIngredients = await Ingredient.countDocuments({ cartId: null });
    const cartSpecificIngredients = await Ingredient.countDocuments({ cartId: new mongoose.Types.ObjectId(cartAdminId) });
    
    console.log('📊 DATABASE STATE:');
    console.log(`   - Total ingredients: ${totalIngredients}`);
    console.log(`   - Shared (cartId: null): ${sharedIngredients}`);
    console.log(`   - Cart-specific for this cart: ${cartSpecificIngredients}\n`);
    
   // Test the EXACT query that getIngredients uses
    console.log('🧪 TESTING QUERY (as used in getIngredients for cart admin):');
    
    const userCartIdObj = new mongoose.Types.ObjectId(cartAdminId);
    
    const baseQuery = {
      $or: [
        { cartId: null },                    // Shared ingredients
        { cartId: userCartIdObj },           // Cart-specific ingredients  
        { cartId: { $exists: false } }       // Legacy ingredients
      ]
    };
    
    console.log('   Query:', JSON.stringify(baseQuery, null, 2));
    
    const results = await Ingredient.find(baseQuery)
      .select('name category cartId')
      .lean();
    
    console.log(`   ✅ Query returned: ${results.length} ingredients\n`);
    
    if (results.length === 0) {
      console.error('❌ PROBLEM: Cart admin would see 0 ingredients!');
      console.error('\n🔍 DEBUGGING:');
      
      // Try each condition separately
      const test1 = await Ingredient.countDocuments({ cartId: null });
      const test2 = await Ingredient.countDocuments({ cartId: userCartIdObj });
      const test3 = await Ingredient.countDocuments({ cartId: { $exists: false } });
      
      console.log(`   - Ingredients with cartId=null: ${test1}`);
      console.log(`   - Ingredients with cartId=${userCartIdObj}: ${test2}`);
      console.log(`   - Ingredients without cartId field: ${test3}`);
      console.log(`   - Total that should match: ${test1 + test2 + test3}\n`);
      
      // Check if there's a franchiseId issue
      if (cartAdmin.franchiseId) {
        const sharedWithFranchise = await Ingredient.countDocuments({ 
          cartId: null,
          franchiseId: cartAdmin.franchiseId
        });
        const sharedWithoutFranchise = await Ingredient.countDocuments({ 
          cartId: null,
          franchiseId: { $exists: false }
        });
        const sharedWithNullFranchise = await Ingredient.countDocuments({ 
          cartId: null,
          franchiseId: null
        });
        
        console.log('   🔍 FranchiseID breakdown for shared ingredients:');
        console.log(`      - Shared with franchiseId=${cartAdmin.franchiseId}: ${sharedWithFranchise}`);
        console.log(`      - Shared with franchiseId=null: ${sharedWithNullFranchise}`);
        console.log(`      - Shared without franchiseId field: ${sharedWithoutFranchise}\n`);
      }
      
      // Sample some shared ingredients to see their structure
      const sampleShared = await Ingredient.find({ cartId: null }).limit(3).lean();
      console.log('   📝 Sample shared ingredients:');
      sampleShared.forEach(ing => {
        console.log(`      - ${ing.name}: cartId=${ing.cartId}, franchiseId=${ing.franchiseId || 'undefined'}`);
      });
      
    } else {
      console.log('✅ Cart admin WILL see ingredients!\n');
      
      console.log('📝 INGREDIENTS CART ADMIN WOULD SEE:');
      results.forEach((ing, idx) => {
        const type = ing.cartId ? 'Cart-specific' : 'Shared';
        console.log(`   ${idx + 1}. ${ing.name} (${ing.category}) - ${type}`);
      });
      
      const sharedCount = results.filter(r => !r.cartId).length;
      const cartCount = results.filter(r => r.cartId).length;
      console.log(`\n   Summary: ${sharedCount} shared + ${cartCount} cart-specific = ${results.length} total`);
    }
    
    console.log('\n✅ Test complete!');
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error);
    process.exit(1);
  }
}

testNewCartIngredients();
