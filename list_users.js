// LIST USERS - Show all cart admins in the system
// Usage: node list_users.js

const mongoose = require('mongoose');
require('dotenv').config();

async function listUsers() {
  try {
    console.log('Connecting to MongoDB...');
    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB\n');

    const User = require('./models/userModel');
    
    // Get all users
    const allUsers = await User.find({}).select('_id role name cafeName email franchiseId createdAt').lean();
    
    console.log(`📋 TOTAL USERS: ${allUsers.length}\n`);
    
    // Group by role
    const superAdmins = allUsers.filter(u => u.role === 'super_admin');
    const franchiseAdmins = allUsers.filter(u => u.role === 'franchise_admin');
    const cartAdmins = allUsers.filter(u => u.role === 'admin');
    
    console.log(`👑 SUPER ADMINS (${superAdmins.length}):`);
    superAdmins.forEach((user, idx) => {
      console.log(`   ${idx + 1}. ${user.name || user.email}`);
      console.log(`      ID: ${user._id}`);
      console.log(`      Email: ${user.email}\n`);
    });
    
    console.log(`🏢 FRANCHISE ADMINS (${franchiseAdmins.length}):`);
    franchiseAdmins.forEach((user, idx) => {
      console.log(`   ${idx + 1}. ${user.name || user.email}`);
      console.log(`      ID: ${user._id}`);
      console.log(`      Email: ${user.email}\n`);
    });
    
    console.log(`🏪 CART ADMINS (${cartAdmins.length}):`);
    cartAdmins.forEach((user, idx) => {
      const franchiseInfo = user.franchiseId ? `Franchise: ${user.franchiseId}` : 'No franchise';
      console.log(`   ${idx + 1}. ${user.cafeName || user.name || user.email}`);
      console.log(`      ID: ${user._id}`);
      console.log(`      Email: ${user.email}`);
      console.log(`      ${franchiseInfo}`);
      console.log(`      Created: ${user.createdAt || 'Unknown'}\n`);
    });
    
    console.log('\n💡 To test a cart admin, run:');
    console.log('   node test_new_cart_ingredients.js <CART_ADMIN_ID>\n');
    
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error);
    process.exit(1);
  }
}

listUsers();
