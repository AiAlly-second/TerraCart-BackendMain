const mongoose = require('mongoose');
const path = require('path');
const User = require(path.join(__dirname, '../models/userModel'));
const Employee = require(path.join(__dirname, '../models/employeeModel'));
require('dotenv').config();

async function createWaiterUser() {
  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/terra-cart';
    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB');

    const email = 'waiter@aially.com';
    const password = '111111';
    const name = 'Waiter User';

    // Check if user already exists
    const existingUser = await User.findOne({ email: email.toLowerCase().trim() });
    if (existingUser) {
      console.log('⚠️  User already exists with email:', email);
      console.log('   User ID:', existingUser._id);
      console.log('   Role:', existingUser.role);
      console.log('   Name:', existingUser.name);
      
      // Update password if needed
      existingUser.password = password; // Will be hashed by pre-save hook
      await existingUser.save();
      console.log('✅ Password updated for existing user');
      
      await mongoose.connection.close();
      return;
    }

    // Find a cart admin to link the waiter to (optional - can be set later)
    const cartAdmin = await User.findOne({ role: 'admin' }).select('_id franchiseId');
    let cafeId = null;
    let franchiseId = null;

    if (cartAdmin) {
      cafeId = cartAdmin._id;
      franchiseId = cartAdmin.franchiseId;
      console.log('📌 Linking waiter to cart:', cartAdmin._id);
      if (franchiseId) {
        console.log('📌 Linking waiter to franchise:', franchiseId);
      }
    } else {
      console.log('⚠️  No cart admin found. Creating waiter without cart/franchise link.');
      console.log('   You can link this waiter to a cart later via admin panel.');
    }

    // Create waiter user
    const waiterUser = await User.create({
      name: name,
      email: email.toLowerCase().trim(),
      password: password, // Will be hashed by pre-save hook
      role: 'waiter',
      cafeId: cafeId,
      franchiseId: franchiseId,
      isActive: true,
    });

    console.log('\n✅ Waiter user created successfully!');
    console.log('   User ID:', waiterUser._id);
    console.log('   Name:', waiterUser.name);
    console.log('   Email:', waiterUser.email);
    console.log('   Password: 111111');
    console.log('   Role:', waiterUser.role);
    if (cafeId) {
      console.log('   Linked to Cart:', cafeId);
    }
    if (franchiseId) {
      console.log('   Linked to Franchise:', franchiseId);
    }

    // Create Employee document for the waiter
    try {
      const employee = await Employee.create({
        name: name,
        dateOfBirth: new Date('1990-01-01'), // Default DOB
        mobile: '9999999999', // Default mobile
        employeeRole: 'waiter',
        cafeId: cafeId,
        franchiseId: franchiseId,
        isActive: true,
      });

      console.log('\n✅ Employee document created successfully!');
      console.log('   Employee ID:', employee._id);
      console.log('   Employee Role:', employee.employeeRole);
    } catch (empError) {
      console.log('\n⚠️  Employee document creation failed (non-critical):', empError.message);
      console.log('   User can still login. Employee can be created later via admin panel.');
    }

    console.log('\n🎉 Waiter user setup complete!');
    console.log('\n📱 Mobile App Login Credentials:');
    console.log('   Email:', email);
    console.log('   Password:', password);
    console.log('   Role: waiter (mobile login enabled)');

  } catch (error) {
    console.error('❌ Error creating waiter user:', error.message);
    if (error.code === 11000) {
      console.error('   Email already exists in database');
    }
  } finally {
    await mongoose.connection.close();
    console.log('\n🔌 Database connection closed');
  }
}

// Run the script
createWaiterUser();

