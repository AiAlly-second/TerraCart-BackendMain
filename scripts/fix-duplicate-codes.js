/**
 * Fix Duplicate Codes Script
 * 
 * This script finds and fixes duplicate franchise codes and cart codes,
 * and ensures no conflicts between franchise codes and cart codes.
 * 
 * Run: node scripts/fix-duplicate-codes.js
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

const fixDuplicates = async () => {
  try {
    await connectDB();
    
    console.log('\n🔍 Finding duplicate codes...\n');
    
    // Find all franchise codes
    const franchises = await User.find({ 
      role: 'franchise_admin',
      franchiseCode: { $exists: true, $ne: null, $ne: '' }
    }).select('_id name franchiseCode franchiseShortcut franchiseSequence').lean();
    
    // Find all cart codes
    const carts = await User.find({ 
      role: 'admin',
      cartCode: { $exists: true, $ne: null, $ne: '' }
    }).select('_id cartName name cartCode cartSequence franchiseId').lean();
    
    // Build code maps
    const franchiseCodeMap = {};
    const cartCodeMap = {};
    const allCodesMap = {};
    
    franchises.forEach(f => {
      if (!franchiseCodeMap[f.franchiseCode]) {
        franchiseCodeMap[f.franchiseCode] = [];
      }
      franchiseCodeMap[f.franchiseCode].push(f);
      allCodesMap[f.franchiseCode] = { type: 'franchise', items: franchiseCodeMap[f.franchiseCode] };
    });
    
    carts.forEach(c => {
      if (!cartCodeMap[c.cartCode]) {
        cartCodeMap[c.cartCode] = [];
      }
      cartCodeMap[c.cartCode].push(c);
      if (allCodesMap[c.cartCode]) {
        allCodesMap[c.cartCode].conflict = true;
        allCodesMap[c.cartCode].cartItems = cartCodeMap[c.cartCode];
      } else {
        allCodesMap[c.cartCode] = { type: 'cart', items: cartCodeMap[c.cartCode] };
      }
    });
    
    // Find duplicates
    const duplicates = [];
    const conflicts = [];
    
    Object.keys(franchiseCodeMap).forEach(code => {
      if (franchiseCodeMap[code].length > 1) {
        duplicates.push({ code, type: 'franchise', items: franchiseCodeMap[code] });
      }
      if (cartCodeMap[code]) {
        conflicts.push({ code, franchise: franchiseCodeMap[code], carts: cartCodeMap[code] });
      }
    });
    
    Object.keys(cartCodeMap).forEach(code => {
      if (cartCodeMap[code].length > 1) {
        duplicates.push({ code, type: 'cart', items: cartCodeMap[code] });
      }
    });
    
    if (duplicates.length === 0 && conflicts.length === 0) {
      console.log('✅ No duplicates or conflicts found!\n');
      await mongoose.connection.close();
      process.exit(0);
    }
    
    console.log(`Found ${duplicates.length} duplicate codes and ${conflicts.length} conflicts\n`);
    
    // Fix duplicate franchises (keep first, regenerate others)
    for (const dup of duplicates.filter(d => d.type === 'franchise')) {
      console.log(`\n🔧 Fixing duplicate franchise code: ${dup.code}`);
      const items = dup.items.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
      const keep = items[0];
      const fix = items.slice(1);
      
      console.log(`  ✅ Keeping: "${keep.name}" (${keep._id})`);
      
      for (const item of fix) {
        try {
          // Generate new code
          const newCode = await generateFranchiseCode(item.name);
          await User.findByIdAndUpdate(item._id, {
            franchiseShortcut: newCode.franchiseShortcut,
            franchiseSequence: newCode.franchiseSequence,
            franchiseCode: newCode.franchiseCode
          });
          console.log(`  ✅ Fixed: "${item.name}" → ${newCode.franchiseCode}`);
        } catch (error) {
          console.error(`  ❌ Error fixing "${item.name}": ${error.message}`);
        }
      }
    }
    
    // Fix duplicate carts (keep first, regenerate others)
    for (const dup of duplicates.filter(d => d.type === 'cart')) {
      console.log(`\n🔧 Fixing duplicate cart code: ${dup.code}`);
      const items = dup.items.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
      const keep = items[0];
      const fix = items.slice(1);
      
      console.log(`  ✅ Keeping: "${keep.cartName || keep.name}" (${keep._id})`);
      
      for (const item of fix) {
        try {
          if (!item.franchiseId) {
            console.error(`  ❌ Cart "${item.cartName || item.name}" has no franchiseId, skipping`);
            continue;
          }
          
          // Generate new code
          const newCode = await generateCartCode(item.franchiseId);
          await User.findByIdAndUpdate(item._id, {
            cartSequence: newCode.cartSequence,
            cartCode: newCode.cartCode
          });
          console.log(`  ✅ Fixed: "${item.cartName || item.name}" → ${newCode.cartCode}`);
        } catch (error) {
          console.error(`  ❌ Error fixing "${item.cartName || item.name}": ${error.message}`);
        }
      }
    }
    
    // Fix conflicts (regenerate cart codes)
    for (const conflict of conflicts) {
      console.log(`\n🔧 Fixing conflict: Code "${conflict.code}" used by both franchise and cart(s)`);
      console.log(`  Franchise: "${conflict.franchise[0].name}"`);
      
      for (const cart of conflict.carts) {
        try {
          if (!cart.franchiseId) {
            console.error(`  ❌ Cart "${cart.cartName || cart.name}" has no franchiseId, skipping`);
            continue;
          }
          
          // Generate new code
          const newCode = await generateCartCode(cart.franchiseId);
          await User.findByIdAndUpdate(cart._id, {
            cartSequence: newCode.cartSequence,
            cartCode: newCode.cartCode
          });
          console.log(`  ✅ Fixed cart: "${cart.cartName || cart.name}" → ${newCode.cartCode}`);
        } catch (error) {
          console.error(`  ❌ Error fixing cart "${cart.cartName || cart.name}": ${error.message}`);
        }
      }
    }
    
    console.log('\n✅ All duplicates and conflicts fixed!\n');
    
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await mongoose.connection.close();
    console.log('🔌 MongoDB disconnected');
    process.exit(0);
  }
};

// Run fix
fixDuplicates();

