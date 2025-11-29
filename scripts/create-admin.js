const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const path = require('path');
const User = require(path.join(__dirname, '../models/userModel'));

async function createAdminUsers() {
  try {
    await mongoose.connect('mongodb://127.0.0.1:27017/terra-cart');
    
    console.log('Connected to MongoDB');
    
    // Create password hash
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash('Admin@123', salt);
    
    // Create Super Admin user
    const superAdmin = await User.findOneAndUpdate(
      { email: 'superadmin@terra.cart' },
      {
        name: 'Super Admin',
        email: 'superadmin@terra.cart',
        password: passwordHash,
        role: 'super_admin'
      },
      { upsert: true, new: true }
    );
    
    console.log('\n✅ Super Admin user created/updated:');
    console.log('Email:', superAdmin.email);
    console.log('Password: Admin@123');
    console.log('Role:', superAdmin.role);
    
    // Create Franchise Admin user
    const franchiseAdmin = await User.findOneAndUpdate(
      { email: 'franchise@terra.cart' },
      {
        name: 'Franchise Admin',
        email: 'franchise@terra.cart',
        password: passwordHash,
        role: 'franchise_admin'
      },
      { upsert: true, new: true }
    );
    
    console.log('\n✅ Franchise Admin user created/updated:');
    console.log('Email:', franchiseAdmin.email);
    console.log('Password: Admin@123');
    console.log('Role:', franchiseAdmin.role);
    
    console.log('\n✨ Both admin users are ready!');
    console.log('\nSuper Admin Login:');
    console.log('  URL: http://localhost:5173 (super-admin)');
    console.log('  Email: superadmin@terra.cart');
    console.log('  Password: Admin@123');
    console.log('\nFranchise Admin Login:');
    console.log('  URL: http://localhost:5174 (franchise-admin)');
    console.log('  Email: franchise@terra.cart');
    console.log('  Password: Admin@123');
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    mongoose.connection.close();
  }
}

createAdminUsers();