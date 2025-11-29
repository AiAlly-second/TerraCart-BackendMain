const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const path = require('path');
const User = require(path.join(__dirname, '../models/userModel'));

async function verifyAndCreateAdmins() {
  try {
    // Load .env file if it exists
    require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
    
    // Connect to the same database as the server
    const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/terra-cart';
    
    console.log('🔌 Connecting to MongoDB...');
    console.log('📍 URI:', mongoUri.replace(/\/\/[^:]+:[^@]+@/, '//***:***@')); // Hide password
    
    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
    });
    
    console.log('✅ Connected to MongoDB:', mongoUri);
    
    // Check existing users
    const existingUsers = await User.find({ role: { $in: ['super_admin', 'franchise_admin', 'admin'] } });
    console.log('\n📋 Existing admin users:');
    if (existingUsers.length === 0) {
      console.log('  No admin users found');
    } else {
      existingUsers.forEach(u => {
        console.log(`  - ${u.email} (${u.role})`);
      });
    }
    
    // Create password hash
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash('Admin@123', salt);
    
    // Create or update Super Admin user
    let superAdmin = await User.findOne({ email: 'superadmin@terra.cart' });
    if (superAdmin) {
      // Use findOneAndUpdate to bypass pre-save hook and set password directly
      superAdmin = await User.findOneAndUpdate(
        { email: 'superadmin@terra.cart' },
        {
          name: 'Super Admin',
          password: passwordHash,
          role: 'super_admin'
        },
        { new: true }
      );
      console.log('\n✅ Super Admin user updated');
    } else {
      superAdmin = await User.create({
        name: 'Super Admin',
        email: 'superadmin@terra.cart',
        password: 'Admin@123', // Let the pre-save hook hash it
        role: 'super_admin'
      });
      console.log('\n✅ Super Admin user created');
    }
    console.log('   Email:', superAdmin.email);
    console.log('   Password: Admin@123');
    console.log('   Role:', superAdmin.role);
    console.log('   ID:', superAdmin._id);
    
    // Create or update Franchise Admin user
    let franchiseAdmin = await User.findOne({ email: 'franchise@terra.cart' });
    if (franchiseAdmin) {
      // Use findOneAndUpdate to bypass pre-save hook and set password directly
      franchiseAdmin = await User.findOneAndUpdate(
        { email: 'franchise@terra.cart' },
        {
          name: 'Franchise Admin',
          password: passwordHash,
          role: 'franchise_admin'
        },
        { new: true }
      );
      console.log('\n✅ Franchise Admin user updated');
    } else {
      franchiseAdmin = await User.create({
        name: 'Franchise Admin',
        email: 'franchise@terra.cart',
        password: 'Admin@123', // Let the pre-save hook hash it
        role: 'franchise_admin'
      });
      console.log('\n✅ Franchise Admin user created');
    }
    console.log('   Email:', franchiseAdmin.email);
    console.log('   Password: Admin@123');
    console.log('   Role:', franchiseAdmin.role);
    console.log('   ID:', franchiseAdmin._id);
    
    // Verify users can be found
    console.log('\n🔍 Verifying users can be found...');
    const testSuper = await User.findOne({ email: 'superadmin@terra.cart' });
    const testFranchise = await User.findOne({ email: 'franchise@terra.cart' });
    
    if (testSuper) {
      console.log('✅ Super Admin found:', testSuper.email, testSuper.role);
    } else {
      console.log('❌ Super Admin NOT found!');
    }
    
    if (testFranchise) {
      console.log('✅ Franchise Admin found:', testFranchise.email, testFranchise.role);
    } else {
      console.log('❌ Franchise Admin NOT found!');
    }
    
    // Test password
    console.log('\n🔐 Testing password...');
    const passwordTest = await testSuper.matchPassword('Admin@123');
    console.log('Password match test:', passwordTest ? '✅ PASS' : '❌ FAIL');
    
    console.log('\n✨ Setup complete!');
    console.log('\n📝 Login Credentials:');
    console.log('\nSuper Admin:');
    console.log('  Email: superadmin@terra.cart');
    console.log('  Password: Admin@123');
    console.log('\nFranchise Admin:');
    console.log('  Email: franchise@terra.cart');
    console.log('  Password: Admin@123');
    
  } catch (error) {
    console.error('❌ Error:', error);
    if (error.message) {
      console.error('   Message:', error.message);
    }
  } finally {
    await mongoose.connection.close();
    console.log('\n🔌 Database connection closed');
  }
}

verifyAndCreateAdmins();

