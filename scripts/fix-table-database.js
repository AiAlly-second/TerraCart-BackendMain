/**
 * Comprehensive script to diagnose and fix table management database issues
 * This script will:
 * 1. Check for old cafeId references and migrate to cartId
 * 2. Fix missing cartId/franchiseId relationships
 * 3. Fix duplicate indexes and unique constraint violations
 * 4. Clean up orphaned tables
 * 5. Ensure all required fields are present
 */

const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const Table = require("../models/tableModel").Table;
const User = require("../models/userModel");

const mongoUri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/terra-cart";

async function connectDB() {
  try {
    await mongoose.connect(mongoUri);
    console.log("✅ Connected to MongoDB");
  } catch (err) {
    console.error("❌ MongoDB connection error:", err.message);
    process.exit(1);
  }
}

async function fixTableDatabase() {
  try {
    await connectDB();
    console.log("\n🔍 Starting table database diagnostics and fixes...\n");

    // Step 1: Check for old cafeId field in database (using direct collection access)
    console.log("📋 Step 1: Checking for old cafeId references...");
    const TableCollection = mongoose.connection.collection("tables");
    const tablesWithCafeId = await TableCollection.find({ cafeId: { $exists: true } }).toArray();
    
    if (tablesWithCafeId.length > 0) {
      console.log(`   ⚠️  Found ${tablesWithCafeId.length} tables with old 'cafeId' field. Migrating to 'cartId'...`);
      for (const table of tablesWithCafeId) {
        await TableCollection.updateOne(
          { _id: table._id },
          { 
            $set: { cartId: table.cafeId },
            $unset: { cafeId: "" }
          }
        );
        console.log(`   ✅ Migrated table ${table._id} (cafeId -> cartId)`);
      }
    } else {
      console.log("   ✅ No old cafeId references found");
    }

    // Step 2: Check for tables with missing cartId or franchiseId
    console.log("\n📋 Step 2: Checking for missing cartId/franchiseId relationships...");
    const allTables = await Table.find({}).lean();
    let fixedRelationships = 0;
    
    for (const table of allTables) {
      let needsUpdate = false;
      const updateData = {};
      
      // If table has cartId but no franchiseId, try to get franchiseId from cart admin
      if (table.cartId && !table.franchiseId) {
        try {
          const cartAdmin = await User.findById(table.cartId).select("franchiseId");
          if (cartAdmin && cartAdmin.franchiseId) {
            updateData.franchiseId = cartAdmin.franchiseId;
            needsUpdate = true;
            console.log(`   🔧 Table ${table.number} (${table._id}): Adding franchiseId ${cartAdmin.franchiseId}`);
          }
        } catch (err) {
          console.error(`   ⚠️  Error finding franchise for table ${table._id}:`, err.message);
        }
      }
      
      // If table has invalid cartId reference, try to find valid cart admin
      if (table.cartId) {
        try {
          const cartAdmin = await User.findById(table.cartId);
          if (!cartAdmin || cartAdmin.role !== "admin") {
            console.log(`   ⚠️  Table ${table.number} (${table._id}) has invalid cartId. Setting to null.`);
            updateData.cartId = null;
            needsUpdate = true;
          }
        } catch (err) {
          console.error(`   ⚠️  Error validating cartId for table ${table._id}:`, err.message);
        }
      }
      
      if (needsUpdate) {
        await Table.updateOne({ _id: table._id }, { $set: updateData });
        fixedRelationships++;
      }
    }
    
    if (fixedRelationships > 0) {
      console.log(`   ✅ Fixed ${fixedRelationships} table relationships`);
    } else {
      console.log("   ✅ All table relationships are valid");
    }

    // Step 3: Fix missing required fields
    console.log("\n📋 Step 3: Checking for missing required fields...");
    const tablesMissingFields = await Table.find({
      $or: [
        { number: { $exists: false } },
        { qrSlug: { $exists: false } },
        { qrSlug: null },
        { qrSlug: "" }
      ]
    }).lean();
    
    if (tablesMissingFields.length > 0) {
      console.log(`   ⚠️  Found ${tablesMissingFields.length} tables with missing required fields. Fixing...`);
      for (const table of tablesMissingFields) {
        const updateData = {};
        
        // Generate number from tableNumber if missing
        if (!table.number && table.tableNumber) {
          const num = parseInt(table.tableNumber);
          if (!isNaN(num) && num > 0) {
            updateData.number = num;
          }
        }
        
        // Generate qrSlug if missing
        if (!table.qrSlug || table.qrSlug === "") {
          const crypto = require("crypto");
          let newSlug = crypto.randomBytes(8).toString("hex");
          // Ensure uniqueness
          let attempts = 0;
          while (attempts < 10) {
            const existing = await Table.findOne({ qrSlug: newSlug });
            if (!existing) break;
            newSlug = crypto.randomBytes(8).toString("hex");
            attempts++;
          }
          updateData.qrSlug = newSlug;
          updateData.qrToken = newSlug;
          console.log(`   🔧 Generated qrSlug for table ${table._id || table.tableNumber}: ${newSlug}`);
        }
        
        if (Object.keys(updateData).length > 0) {
          await Table.updateOne({ _id: table._id }, { $set: updateData });
          console.log(`   ✅ Fixed table ${table._id || table.tableNumber}`);
        }
      }
    } else {
      console.log("   ✅ All tables have required fields");
    }

    // Step 4: Fix duplicate table numbers within same cart
    console.log("\n📋 Step 4: Checking for duplicate table numbers...");
    const tablesByCart = {};
    const duplicateNumbers = [];
    
    for (const table of allTables) {
      const key = `${table.cartId || 'global'}_${table.number}`;
      if (!tablesByCart[key]) {
        tablesByCart[key] = [];
      }
      tablesByCart[key].push(table);
    }
    
    for (const [key, tables] of Object.entries(tablesByCart)) {
      if (tables.length > 1) {
        console.log(`   ⚠️  Found ${tables.length} duplicate tables with number ${tables[0].number} in cart ${key}`);
        duplicateNumbers.push(...tables.slice(1)); // Keep first, mark others as duplicates
      }
    }
    
    if (duplicateNumbers.length > 0) {
      console.log(`   🔧 Found ${duplicateNumbers.length} duplicate tables. Consider manual cleanup.`);
      console.log("   Duplicate table IDs:", duplicateNumbers.map(t => t._id).join(", "));
    } else {
      console.log("   ✅ No duplicate table numbers found");
    }

    // Step 5: Clean up orphaned tables (tables with invalid references)
    console.log("\n📋 Step 5: Checking for orphaned tables...");
    let orphanedCount = 0;
    
    for (const table of allTables) {
      if (table.cartId) {
        const cartAdmin = await User.findById(table.cartId);
        if (!cartAdmin) {
          console.log(`   ⚠️  Table ${table.number} (${table._id}) has invalid cartId ${table.cartId}`);
          orphanedCount++;
        }
      }
      
      if (table.franchiseId) {
        const franchise = await User.findById(table.franchiseId);
        if (!franchise) {
          console.log(`   ⚠️  Table ${table.number} (${table._id}) has invalid franchiseId ${table.franchiseId}`);
          orphanedCount++;
        }
      }
    }
    
    if (orphanedCount > 0) {
      console.log(`   ⚠️  Found ${orphanedCount} tables with invalid references. Consider manual cleanup.`);
    } else {
      console.log("   ✅ No orphaned tables found");
    }

    // Step 6: Rebuild indexes
    console.log("\n📋 Step 6: Rebuilding table indexes...");
    try {
      await TableCollection.dropIndexes();
      console.log("   ✅ Dropped existing indexes");
    } catch (err) {
      if (err.code === 27 || err.codeName === 'IndexNotFound') {
        console.log("   ℹ️  No indexes to drop");
      } else {
        console.log(`   ⚠️  Error dropping indexes: ${err.message}`);
      }
    }
    
    // Recreate indexes through model
    await Table.syncIndexes();
    console.log("   ✅ Recreated indexes");

    // Step 7: Summary
    console.log("\n📊 Summary:");
    const totalTables = await Table.countDocuments({});
    const tablesWithCartId = await Table.countDocuments({ cartId: { $exists: true, $ne: null } });
    const tablesWithFranchiseId = await Table.countDocuments({ franchiseId: { $exists: true, $ne: null } });
    
    console.log(`   Total tables: ${totalTables}`);
    console.log(`   Tables with cartId: ${tablesWithCartId}`);
    console.log(`   Tables with franchiseId: ${tablesWithFranchiseId}`);
    
    console.log("\n✅ Table database check and fix completed!\n");

  } catch (err) {
    console.error("\n❌ Error:", err);
    console.error(err.stack);
  } finally {
    await mongoose.connection.close();
    console.log("📴 Database connection closed");
    process.exit(0);
  }
}

// Run the script
fixTableDatabase();












