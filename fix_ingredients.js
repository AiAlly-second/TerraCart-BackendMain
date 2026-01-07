
const mongoose = require('mongoose');
const Ingredient = require('./models/costing-v2/ingredientModel');
require('dotenv').config({ path: './.env' });

async function fixIngredients() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to MongoDB');

    // Find all ingredients that have a cartId (are not shared)
    const ingredients = await Ingredient.find({ cartId: { $ne: null } });
    console.log(`Found ${ingredients.length} ingredients to convert to Shared (Global).`);

    for (const ing of ingredients) {
      console.log(`Converting "${ing.name}" (Cart: ${ing.cartId}) to Shared...`);
      
      // Check if a shared ingredient with this name already exists
      const existingShared = await Ingredient.findOne({ 
        name: ing.name, 
        cartId: null 
      });

      if (existingShared) {
        console.warn(`  ⚠️ SKIPPING: Shared ingredient "${ing.name}" already exists.`);
      } else {
        ing.cartId = null;
        await ing.save();
        console.log(`  ✅ Converted "${ing.name}" to Shared.`);
      }
    }
    
    console.log('Done!');

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await mongoose.connection.close();
  }
}

fixIngredients();
