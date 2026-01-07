
const mongoose = require('mongoose');
const Ingredient = require('./models/costing-v2/ingredientModel');
const User = require('./models/userModel');
require('dotenv').config({ path: './.env' });

async function checkIngredients() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to MongoDB');

    const total = await Ingredient.countDocuments();
    console.log(`Total Ingredients: ${total}`);

    const shared = await Ingredient.find({ cartId: null });
    console.log(`Shared Ingredients (cartId: null): ${shared.length}`);
    if (shared.length > 0) {
      console.log('Sample Shared:', shared[0]);
    }

    const missingCartId = await Ingredient.find({ cartId: { $exists: false } });
    console.log(`Missing cartId field: ${missingCartId.length}`);

    // Check for "null" string
    // const stringNull = await Ingredient.find({ cartId: "null" }); // This might fail if schema is strict ObjectId
    // console.log(`String "null" cartId: ${stringNull.length}`);

    // Group by cartId
    const aggregation = await Ingredient.aggregate([
      {
        $group: {
          _id: "$cartId",
          count: { $sum: 1 },
          isActiveTrue: { $sum: { $cond: [{ $eq: ["$isActive", true] }, 1, 0] } },
          isActiveFalse: { $sum: { $cond: [{ $eq: ["$isActive", false] }, 1, 0] } }
        }
      }
    ]);
    
    console.log('Ingredients grouped by cartId:');
    console.log(JSON.stringify(aggregation, null, 2));

    // Get details of the cartIds found
    const cartIds = aggregation.map(g => g._id).filter(id => id);
    const users = await User.find({ _id: { $in: cartIds } });
    console.log('Ingredient Owners:', users.map(u => ({ 
      _id: u._id, 
      name: u.name, 
      role: u.role, 
      email: u.email 
    })));

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await mongoose.connection.close();
  }
}

checkIngredients();
