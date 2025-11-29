/**
 * Migration Script: Assign Codes to Existing Franchises and Carts
 * 
 * This script assigns franchise codes and cart codes to existing records
 * that don't have them yet.
 * 
 * Run: node scripts/migrate-codes.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/userModel');
const { generateFranchiseCode, generateCartCode } = require('../utils/codeGenerator');

const connectDB = async () => {
  try {
    const mongoUri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/terra-cart";
    await mongoose.connect(mongoUri);
    console.log('✅ MongoDB Connected');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error.message);
    process.exit(1);
  }
};

const migrateCodes = async () => {
  try {
    await connectDB();
    
    console.log('\n🔄 Starting code migration...\n');
    
    // Step 1: Generate codes for all franchises without codes
    const franchisesWithoutCodes = await User.find({ 
      role: 'franchise_admin',
      $or: [
        { franchiseCode: { $exists: false } },
        { franchiseCode: null },
        { franchiseCode: '' }
      ]
    }).sort({ createdAt: 1 });
    
    console.log(`📊 Found ${franchisesWithoutCodes.length} franchises without codes\n`);
    
    let franchiseCount = 0;
    for (const franchise of franchisesWithoutCodes) {
      try {
        const { franchiseShortcut, franchiseSequence, franchiseCode } = await generateFranchiseCode(franchise.name);
        
        await User.findByIdAndUpdate(franchise._id, {
          franchiseShortcut,
          franchiseSequence,
          franchiseCode
        });
        
        console.log(`  ✅ Franchise "${franchise.name}" → ${franchiseCode}`);
        franchiseCount++;
      } catch (error) {
        console.error(`  ❌ Error processing franchise "${franchise.name}": ${error.message}`);
      }
    }
    
    console.log(`\n✅ Processed ${franchiseCount} franchises\n`);
    
    // Step 2: Generate codes for all carts without codes
    const cartsWithoutCodes = await User.find({
      role: 'admin',
      franchiseId: { $exists: true, $ne: null },
      $or: [
        { cartCode: { $exists: false } },
        { cartCode: null },
        { cartCode: '' }
      ]
    }).sort({ createdAt: 1 });
    
    console.log(`📊 Found ${cartsWithoutCodes.length} carts without codes\n`);
    
    let cartCount = 0;
    for (const cart of cartsWithoutCodes) {
      try {
        // Ensure franchise has a code first
        const franchise = await User.findById(cart.franchiseId).select('franchiseCode franchiseShortcut name');
        if (!franchise) {
          console.error(`  ❌ Cart "${cart.cartName || cart.name}" has invalid franchiseId: ${cart.franchiseId}`);
          continue;
        }
        
        // If franchise doesn't have a code, generate one
        if (!franchise.franchiseCode) {
          const { franchiseShortcut, franchiseSequence, franchiseCode } = await generateFranchiseCode(franchise.name);
          await User.findByIdAndUpdate(franchise._id, {
            franchiseShortcut,
            franchiseSequence,
            franchiseCode
          });
          console.log(`  ⚠️  Generated missing franchise code for "${franchise.name}": ${franchiseCode}`);
        }
        
        const { cartSequence, cartCode } = await generateCartCode(cart.franchiseId);
        
        await User.findByIdAndUpdate(cart._id, {
          cartSequence,
          cartCode
        });
        
        console.log(`  ✅ Cart "${cart.cartName || cart.name}" → ${cartCode}`);
        cartCount++;
      } catch (error) {
        console.error(`  ❌ Error processing cart "${cart.cartName || cart.name}": ${error.message}`);
      }
    }
    
    console.log(`\n✅ Processed ${cartCount} carts\n`);
    
    // Step 3: Verify all records have codes
    console.log('🔍 Verifying all records have codes...\n');
    
    const franchisesStillMissing = await User.countDocuments({
      role: 'franchise_admin',
      $or: [
        { franchiseCode: { $exists: false } },
        { franchiseCode: null },
        { franchiseCode: '' }
      ]
    });
    
    const cartsStillMissing = await User.countDocuments({
      role: 'admin',
      franchiseId: { $exists: true, $ne: null },
      $or: [
        { cartCode: { $exists: false } },
        { cartCode: null },
        { cartCode: '' }
      ]
    });
    
    if (franchisesStillMissing > 0) {
      console.log(`  ⚠️  ${franchisesStillMissing} franchises still missing codes`);
    } else {
      console.log(`  ✅ All franchises have codes`);
    }
    
    if (cartsStillMissing > 0) {
      console.log(`  ⚠️  ${cartsStillMissing} carts still missing codes`);
    } else {
      console.log(`  ✅ All carts have codes`);
    }
    
    // Step 4: Check for duplicate codes
    console.log('\n🔍 Checking for duplicate codes...\n');
    
    const franchiseCodes = await User.find({ 
      role: 'franchise_admin',
      franchiseCode: { $exists: true, $ne: null, $ne: '' }
    }).select('franchiseCode name').lean();
    
    const cartCodes = await User.find({ 
      role: 'admin',
      cartCode: { $exists: true, $ne: null, $ne: '' }
    }).select('cartCode cartName name').lean();
    
    const allCodes = {};
    let duplicates = [];
    
    franchiseCodes.forEach(f => {
      if (allCodes[f.franchiseCode]) {
        duplicates.push({ type: 'franchise', code: f.franchiseCode, name: f.name });
      } else {
        allCodes[f.franchiseCode] = { type: 'franchise', name: f.name };
      }
    });
    
    cartCodes.forEach(c => {
      if (allCodes[c.cartCode]) {
        duplicates.push({ type: 'cart', code: c.cartCode, name: c.cartName || c.name });
      } else {
        allCodes[c.cartCode] = { type: 'cart', name: c.cartName || c.name };
      }
    });
    
    // Check for conflicts between franchise and cart codes
    franchiseCodes.forEach(f => {
      if (allCodes[f.franchiseCode] && allCodes[f.franchiseCode].type === 'cart') {
        duplicates.push({ type: 'conflict', code: f.franchiseCode, franchise: f.name, cart: allCodes[f.franchiseCode].name });
      }
    });
    
    if (duplicates.length > 0) {
      console.log(`  ⚠️  Found ${duplicates.length} duplicate/conflicting codes:\n`);
      duplicates.forEach(d => {
        if (d.type === 'conflict') {
          console.log(`    ❌ CONFLICT: Code "${d.code}" used by both franchise "${d.franchise}" and cart "${d.cart}"`);
        } else {
          console.log(`    ❌ DUPLICATE: Code "${d.code}" used by multiple ${d.type}s`);
        }
      });
    } else {
      console.log(`  ✅ No duplicate codes found`);
    }
    
    console.log('\n✅ Migration complete!\n');
    
  } catch (error) {
    console.error('❌ Migration error:', error);
  } finally {
    await mongoose.connection.close();
    console.log('🔌 MongoDB disconnected');
    process.exit(0);
  }
};

// Run migration
migrateCodes();
