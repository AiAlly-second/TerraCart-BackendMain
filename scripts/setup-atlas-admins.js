/**
 * Setup Admin Users for MongoDB Atlas
 * 
 * This script creates/updates admin users in your MongoDB Atlas database.
 * It reads MONGO_URI from .env file or environment variables.
 * 
 * Usage:
 *   node backend/scripts/setup-atlas-admins.js
 * 
 * Or with custom MONGO_URI:
 *   MONGO_URI="your-connection-string" node backend/scripts/setup-atlas-admins.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const User = require('../models/userModel');

async function setupAtlasAdmins() {
  try {
    // Get MongoDB URI from environment or use default
    const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/terra-cart';
    
    console.log('🔌 Connecting to MongoDB...');
    console.log('📍 URI:', mongoUri.replace(/\/\/[^:]+:[^@]+@/, '//***:***@')); // Hide password
    
    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
    });
    
    console.log('✅ Connected to MongoDB successfully!\n');
    
    // Check existing admin users
    console.log('📋 Checking existing admin users...');
    const existingAdmins = await User.find({ 
      role: { $in: ['super_admin', 'franchise_admin', 'admin'] } 
    }).select('email role isActive isApproved');
    
    if (existingAdmins.length > 0) {
      console.log(`Found ${existingAdmins.length} existing admin user(s):`);
      existingAdmins.forEach(u => {
        console.log(`  - ${u.email} (${u.role}) - Active: ${u.isActive !== false}, Approved: ${u.isApproved !== false}`);
      });
    } else {
      console.log('  No admin users found. Creating new ones...\n');
    }
    
    // Default password for all admin users
    const defaultPassword = 'Admin@123';
    
    // Create/Update Super Admin
    console.log('\n👤 Setting up Super Admin...');
    let superAdmin = await User.findOne({ email: 'superadmin@terra.cart' });
    
    if (superAdmin) {
      // Update existing super admin
      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash(defaultPassword, salt);
      
      superAdmin = await User.findOneAndUpdate(
        { email: 'superadmin@terra.cart' },
        {
          name: 'Super Admin',
          password: passwordHash,
          role: 'super_admin',
          isActive: true,
        },
        { new: true }
      );
      console.log('  ✅ Super Admin updated');
    } else {
      // Create new super admin
      superAdmin = await User.create({
        name: 'Super Admin',
        email: 'superadmin@terra.cart',
        password: defaultPassword, // Will be hashed by pre-save hook
        role: 'super_admin',
        isActive: true,
      });
      console.log('  ✅ Super Admin created');
    }
    
    console.log(`  📧 Email: ${superAdmin.email}`);
    console.log(`  🔑 Password: ${defaultPassword}`);
    console.log(`  🆔 Role: ${superAdmin.role}`);
    console.log(`  🆔 ID: ${superAdmin._id}`);
    
    // Create/Update Franchise Admin
    console.log('\n👤 Setting up Franchise Admin...');
    let franchiseAdmin = await User.findOne({ email: 'franchise@terra.cart' });
    
    if (franchiseAdmin) {
      // Update existing franchise admin
      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash(defaultPassword, salt);
      
      franchiseAdmin = await User.findOneAndUpdate(
        { email: 'franchise@terra.cart' },
        {
          name: 'Franchise Admin',
          password: passwordHash,
          role: 'franchise_admin',
          isActive: true,
        },
        { new: true }
      );
      console.log('  ✅ Franchise Admin updated');
    } else {
      // Create new franchise admin
      franchiseAdmin = await User.create({
        name: 'Franchise Admin',
        email: 'franchise@terra.cart',
        password: defaultPassword, // Will be hashed by pre-save hook
        role: 'franchise_admin',
        isActive: true,
      });
      console.log('  ✅ Franchise Admin created');
    }
    
    console.log(`  📧 Email: ${franchiseAdmin.email}`);
    console.log(`  🔑 Password: ${defaultPassword}`);
    console.log(`  🆔 Role: ${franchiseAdmin.role}`);
    console.log(`  🆔 ID: ${franchiseAdmin._id}`);
    
    // Verify users can login
    console.log('\n🔐 Verifying password authentication...');
    const superPasswordTest = await superAdmin.matchPassword(defaultPassword);
    const franchisePasswordTest = await franchiseAdmin.matchPassword(defaultPassword);
    
    console.log(`  Super Admin password test: ${superPasswordTest ? '✅ PASS' : '❌ FAIL'}`);
    console.log(`  Franchise Admin password test: ${franchisePasswordTest ? '✅ PASS' : '❌ FAIL'}`);
    
    if (!superPasswordTest || !franchisePasswordTest) {
      console.error('\n❌ ERROR: Password verification failed!');
      console.error('   This might indicate a password hashing issue.');
      process.exit(1);
    }
    
    // Final verification - check users exist
    console.log('\n🔍 Final verification...');
    const verifySuper = await User.findOne({ email: 'superadmin@terra.cart' });
    const verifyFranchise = await User.findOne({ email: 'franchise@terra.cart' });
    
    if (!verifySuper || !verifyFranchise) {
      console.error('❌ ERROR: Users not found after creation!');
      process.exit(1);
    }
    
    console.log('✅ All admin users verified and ready!\n');
    
    // Display login information
    console.log('═══════════════════════════════════════════════════════════');
    console.log('📝 LOGIN CREDENTIALS');
    console.log('═══════════════════════════════════════════════════════════\n');
    
    console.log('🔴 Super Admin Login:');
    console.log('   Endpoint: POST /api/admin/login');
    console.log('   Email:    superadmin@terra.cart');
    console.log('   Password: Admin@123');
    console.log('   Frontend: http://localhost:5173 (super-admin app)\n');
    
    console.log('🟡 Franchise Admin Login:');
    console.log('   Endpoint: POST /api/admin/login');
    console.log('   Email:    franchise@terra.cart');
    console.log('   Password: Admin@123');
    console.log('   Frontend: http://localhost:5174 (franchise-admin app)\n');
    
    console.log('🟢 Cafe Admin Login:');
    console.log('   Endpoint: POST /api/users/login (for cafe admin role)');
    console.log('   Endpoint: POST /api/admin/login (also works)');
    console.log('   Note: Create cafe admin through franchise admin panel\n');
    
    console.log('═══════════════════════════════════════════════════════════');
    console.log('✨ Setup complete! You can now login with the credentials above.');
    console.log('═══════════════════════════════════════════════════════════\n');
    
  } catch (error) {
    console.error('\n❌ ERROR:', error.message);
    if (error.stack) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }
    
    // Provide helpful error messages
    if (error.message.includes('authentication failed')) {
      console.error('\n💡 Tip: Check your MongoDB Atlas username and password in MONGO_URI');
    } else if (error.message.includes('ENOTFOUND') || error.message.includes('getaddrinfo')) {
      console.error('\n💡 Tip: Check your internet connection and MongoDB Atlas cluster URL');
    } else if (error.message.includes('IP')) {
      console.error('\n💡 Tip: Add your IP address to MongoDB Atlas Network Access whitelist');
    } else if (error.message.includes('timeout')) {
      console.error('\n💡 Tip: Check your network connection and firewall settings');
    }
    
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('🔌 Database connection closed');
  }
}

// Run the script
setupAtlasAdmins();















