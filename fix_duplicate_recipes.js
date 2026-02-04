// FIX SCRIPT - Remove duplicate BOMs/Recipes
// Keeps the oldest shared version of each recipe, removes all other duplicates
// Run with: node fix_duplicate_recipes.js

const mongoose = require('mongoose');
require('dotenv').config();

async function fixDuplicateRecipes() {
  try {
    console.log('🔧 FIXING DUPLICATE RECIPES\n');
    console.log('Connecting to MongoDB...');
    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB\n');

    const Recipe = require('./models/costing-v2/recipeModel');
    
    // Find all duplicates
    const duplicates = await Recipe.aggregate([
      {
        $group: {
          _id: "$name",
          count: { $sum: 1 },
          recipes: { 
            $push: { 
              id: "$_id", 
              cartId: "$cartId",
              createdAt: "$createdAt"
            } 
          }
        }
      },
      {
        $match: {
          count: { $gt: 1 }
        }
      }
    ]);
    
    if (duplicates.length === 0) {
      console.log('✅ No duplicates found!');
      process.exit(0);
    }
    
    console.log(`⚠️  Found ${duplicates.length} recipe names with duplicates:\n`);
    
    let totalToDelete = 0;
    const idsToDelete = [];
    
    for (const dup of duplicates) {
      console.log(`📋 Recipe: "${dup._id}" (${dup.count} copies)`);
      
      // Sort recipes: Shared (cartId: null) first, then by creation date (oldest first)
      const sorted = dup.recipes.sort((a, b) => {
        // Prioritize shared recipes (cartId: null)
        if (a.cartId === null && b.cartId !== null) return -1;
        if (a.cartId !== null && b.cartId === null) return 1;
        // If both shared or both cart-specific, sort by date (oldest first)
        return new Date(a.createdAt) - new Date(b.createdAt);
      });
      
      // Keep the first one (oldest shared if available, or oldest overall)
      const toKeep = sorted[0];
      const toDelete = sorted.slice(1);
      
      const keepType = toKeep.cartId ? `Cart-specific (${toKeep.cartId})` : 'Shared (cartId: null)';
      console.log(`   ✅ KEEPING: ${toKeep.id} (${keepType}) - Created: ${toKeep.createdAt}`);
      
      toDelete.forEach(recipe => {
        const deleteType = recipe.cartId ? `Cart-specific (${recipe.cartId})` : 'Shared';
        console.log(`   ❌ DELETING: ${recipe.id} (${deleteType}) - Created: ${recipe.createdAt}`);
        idsToDelete.push(recipe.id);
        totalToDelete++;
      });
      
      console.log('');
    }
    
    console.log(`\n📊 SUMMARY:`);
    console.log(`   - Duplicate recipe names found: ${duplicates.length}`);
    console.log(`   - Total recipes to delete: ${totalToDelete}`);
    console.log(`   - Recipes to keep: ${duplicates.length}\n`);
    
    if (totalToDelete === 0) {
      console.log('✅ Nothing to delete!');
      process.exit(0);
    }
    
    console.log('⚠️  WARNING: This will permanently delete duplicate recipes!');
    console.log('⚠️  Only the oldest shared version of each recipe will be kept.\n');
    console.log('✅ Proceeding with deletion...\n');
    
    // Delete duplicates
    const deleteResult = await Recipe.deleteMany({
      _id: { $in: idsToDelete }
    });
    
    console.log(`✅ DELETION COMPLETE!`);
    console.log(`   Deleted ${deleteResult.deletedCount} duplicate recipes\n`);
    
    // Verify
    const remaining = await Recipe.countDocuments({});
    const remainingByName = await Recipe.aggregate([
      { $group: { _id: "$name", count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } }
    ]);
    
    console.log('📊 FINAL STATE:');
    console.log(`   - Total recipes remaining: ${remaining}`);
    console.log(`   - Duplicate names remaining: ${remainingByName.length}\n`);
    
    if (remainingByName.length === 0) {
      console.log('✅ All duplicates removed! Each recipe name is now unique.');
    } else {
      console.log('⚠️  Some duplicates still remain (may be cart-specific variations)');
    }
    
    // Show what's left
    console.log('\n📝 REMAINING RECIPES:');
    const allRecipes = await Recipe.find({})
      .select('name cartId isActive')
      .populate('cartId', 'cafeName name')
      .sort({ name: 1 })
      .lean();
    
    allRecipes.forEach((recipe, idx) => {
      const type = recipe.cartId ? 
        `Cart: ${recipe.cartId.cafeName || recipe.cartId.name}` : 
        'Shared';
      console.log(`   ${idx + 1}. ${recipe.name} (${type})`);
    });
    
    console.log('\n✅ Fix complete!');
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Error during fix:', error.message);
    console.error(error);
    process.exit(1);
  }
}

fixDuplicateRecipes();
