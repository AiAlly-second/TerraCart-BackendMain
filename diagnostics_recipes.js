// DIAGNOSTIC SCRIPT - Check for duplicate BOMs/Recipes
// Usage: node diagnostics_recipes.js

const mongoose = require('mongoose');
require('dotenv').config();

async function diagnoseRecipes() {
  try {
    console.log('Connecting to MongoDB...');
    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!mongoUri) {
      console.error('❌ MongoDB URI not found in environment variables!');
      process.exit(1);
    }
    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB\n');

    const Recipe = require('./models/costing-v2/recipeModel');
    const User = require('./models/userModel');
    
    // Total count
    const total = await Recipe.countDocuments({});
    console.log(`📊 TOTAL RECIPES IN DATABASE: ${total}\n`);
    
    if (total === 0) {
      console.log('❌ NO RECIPES FOUND IN DATABASE!');
      process.exit(0);
    }
    
    // Breakdown by cartId
    console.log('📋 BREAKDOWN BY CART/KIOSK:');
    const sharedCount = await Recipe.countDocuments({ cartId: null });
    const withCartId = await Recipe.countDocuments({ cartId: { $ne: null } });
    const noCartIdField = await Recipe.countDocuments({ cartId: { $exists: false } });
    
    console.log(`   - Shared (cartId: null): ${sharedCount}`);
    console.log(`   - Cart-specific (has cartId): ${withCartId}`);
    console.log(`   - Legacy (no cartId field): ${noCartIdField}\n`);
    
    // Find duplicates by name
    console.log('🔍 CHECKING FOR DUPLICATES (by name):');
    const duplicates = await Recipe.aggregate([
      {
        $group: {
          _id: "$name",
          count: { $sum: 1 },
          ids: { $push: "$_id" },
          cartIds: { $push: "$cartId" }
        }
      },
      {
        $match: {
          count: { $gt: 1 }
        }
      },
      {
        $sort: { count: -1 }
      }
    ]);
    
    if (duplicates.length === 0) {
      console.log('   ✅ No duplicates found (all recipe names are unique)\n');
    } else {
      console.log(`   ⚠️  Found ${duplicates.length} duplicate recipe names:\n`);
      for (const dup of duplicates) {
        console.log(`   - "${dup._id}": ${dup.count} copies`);
        console.log(`     IDs: ${dup.ids.join(', ')}`);
        console.log(`     CartIDs: ${dup.cartIds.map(c => c || 'null').join(', ')}\n`);
      }
    }
    
    // Get sample recipes
    console.log('📝 ALL RECIPES IN DATABASE:');
    const allRecipes = await Recipe.find({})
      .select('name cartId isActive createdBy createdAt')
      .populate('cartId', 'cafeName name')
      .lean();
    
    allRecipes.forEach((recipe, idx) => {
      const cartInfo = recipe.cartId 
        ? `Cart: ${recipe.cartId.cafeName || recipe.cartId.name || recipe.cartId._id}` 
        : 'Shared (cartId: null)';
      const status = recipe.isActive ? '✅ Active' : '❌ Inactive';
      console.log(`   ${idx + 1}. ${recipe.name}`);
      console.log(`      - ${cartInfo}`);
      console.log(`      - ${status}`);
      console.log(`      - ID: ${recipe._id}`);
      console.log(`      - Created: ${recipe.createdAt || 'Unknown'}\n`);
    });
    
    // Test query for cart admin
    console.log('🧪 TEST QUERY FOR CART ADMIN:');
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
      
      const testResults = await Recipe.find(testQuery).select('name cartId').lean();
      console.log(`   ✅ Query result: ${testResults.length} recipes`);
      
      if (testResults.length > 0) {
        console.log(`\n   📋 RECIPES CART ADMIN WOULD SEE:`);
        testResults.forEach((rec, idx) => {
          const type = rec.cartId ? 
            (rec.cartId.toString() === testCartId.toString() ? 'Own' : 'Other Cart') : 
            'Shared';
          console.log(`      ${idx + 1}. ${rec.name} (${type})`);
        });
        
        // Check for duplicates in results
        const names = testResults.map(r => r.name);
        const duplicateNames = names.filter((name, index) => names.indexOf(name) !== index);
        const uniqueDuplicates = [...new Set(duplicateNames)];
        
        if (uniqueDuplicates.length > 0) {
          console.log(`\n   ⚠️⚠️⚠️ DUPLICATES FOUND IN CART ADMIN VIEW:`);
          uniqueDuplicates.forEach(name => {
            const count = names.filter(n => n === name).length;
            console.log(`      - "${name}": appears ${count} times`);
          });
        } else {
          console.log(`\n   ✅ No duplicates in cart admin view`);
        }
      }
    } else {
      console.log('   ⚠️  No cart admin found in database\n');
    }
    
    console.log('\n✅ Diagnosis complete!');
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Error during diagnosis:', error.message);
    console.error(error);
    process.exit(1);
  }
}

diagnoseRecipes();
