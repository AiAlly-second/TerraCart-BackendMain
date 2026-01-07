
const mongoose = require('mongoose');
const Ingredient = require('./models/costing-v2/ingredientModel');
require('dotenv').config({ path: './.env' });

async function checkBesan() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to MongoDB');

    const besan = await Ingredient.find({ name: { $regex: 'besan', $options: 'i' } });
    console.log('Besan Ingredients found:');
    besan.forEach(Ing => {
        console.log({
            id: Ing._id,
            name: Ing.name,
            cartId: Ing.cartId,
            qtyOnHand: Ing.qtyOnHand,
            baseUnit: Ing.baseUnit
        });
    });

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await mongoose.connection.close();
  }
}

checkBesan();
