
const mongoose = require('mongoose');
const Ingredient = require('./models/costing-v2/ingredientModel');
require('dotenv').config({ path: './.env' });

async function resetAndFixBesan() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to MongoDB');

    // Find Besan
    const besan = await Ingredient.findOne({ name: { $regex: 'besan', $options: 'i' } });
    
    if (!besan) {
      console.log('Besan not found!');
      return;
    }

    console.log(`Checking Besan: ${besan.name}`);
    console.log(`Current Stock: ${besan.qtyOnHand} ${besan.baseUnit}`);
    console.log(`Cost: ${besan.currentCostPerBaseUnit}`);

    // Fix negative stock
    if (besan.qtyOnHand < 0) {
      console.log('Resetting negative stock to 5000g (5kg)...');
      besan.qtyOnHand = 5000;
      
      // Ensure cost is set reasonably (e.g. 0.05 per gram = 50 per kg)
      if (besan.currentCostPerBaseUnit <= 0) {
          besan.currentCostPerBaseUnit = 0.1; // Dummy cost
      }
      
      await besan.save();
      console.log('Besan stock reset to 5000g.');
    } else {
        console.log('Stock is positive, no action taken.');
    }

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await mongoose.connection.close();
  }
}

resetAndFixBesan();
