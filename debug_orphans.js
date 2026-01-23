const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const User = require("./models/userModel");
const Employee = require("./models/employeeModel");

const connectDB = async () => {
  try {
    if (!process.env.MONGO_URI) {
        console.error("MONGO_URI is missing in .env");
        process.exit(1);
    }
    const conn = await mongoose.connect(process.env.MONGO_URI);
    console.log(`MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
};

const checkOrphans = async () => {
  await connectDB();

  console.log("\n--- Checking for Orphaned Users ---");
  
  // Get all users
  const users = await User.find({ role: { $nin: ['super_admin', 'customer'] } }).lean();
  console.log(`Found ${users.length} administrative/employee users.`);

  // Get all active Franchise Admins and Cart Admins
  const franchiseAdmins = await User.find({ role: 'franchise_admin' }).select('_id name').lean();
  const franchiseIds = franchiseAdmins.map(f => f._id.toString());
  
  const cartAdmins = await User.find({ role: 'admin' }).select('_id name franchiseId').lean();
  const cartIds = cartAdmins.map(c => c._id.toString());

  console.log(`Active Franchises: ${franchiseIds.length}`);
  console.log(`Active Carts: ${cartIds.length}`);

  let orphanedUsers = [];

  for (const user of users) {
    const userId = user._id.toString();
    const role = user.role;
    
    // Check Franchise Admin Logic
    if (role === 'franchise_admin') {
        // Franchise admins are usually top-level (unless deleted manually and stuck)
        continue; 
    }

    // Check Cart Admin Logic
    if (role === 'admin') {
      if (user.franchiseId) {
        const fid = user.franchiseId.toString();
        if (!franchiseIds.includes(fid)) {
           console.log(`[ORPHAN] Cart Admin "${user.name}" (${user.email}) has missing Franchise ID: ${fid}`);
           orphanedUsers.push(userId);
        }
      } else {
        console.log(`[WARNING] Cart Admin "${user.name}" (${user.email}) has NO Franchise ID`);
      }
      continue;
    }

    // Check Employee/Mobile Roles
    if (['waiter', 'cook', 'captain', 'manager', 'employee'].includes(role)) {
       let isOrphan = false;
       let reason = "";

       // Check cafeId (link to Cart Admin)
       if (user.cafeId) {
          const cid = user.cafeId.toString();
          if (!cartIds.includes(cid)) {
             isOrphan = true;
             reason = `Linked Cart (cafeId: ${cid}) does not exist.`;
          }
       } else {
          // If no cafeId, check franchiseId (link to Franchise)
          if (user.franchiseId) {
             const fid = user.franchiseId.toString();
             if (!franchiseIds.includes(fid)) {
                isOrphan = true;
                reason = `Linked Franchise (franchiseId: ${fid}) does not exist.`;
             }
          } else {
             // If neither, it's likely an orphan or legacy data
             isOrphan = true;
             reason = "No cafeId or franchiseId found.";
          }
       }

       if (isOrphan) {
          console.log(`[ORPHAN] User "${user.name}" (${user.email}) Role: ${role}. Reason: ${reason}`);
          orphanedUsers.push(userId);
       }
    }
  }

  console.log(`\nFound ${orphanedUsers.length} orphaned users.`);
  
  if (orphanedUsers.length > 0) {
      console.log("Cleaning up orphaned users...");
      const result = await User.deleteMany({ _id: { $in: orphanedUsers } });
      console.log(`Deleted ${result.deletedCount} orphaned users.`);
  } else {
      console.log("No orphaned users to clean up.");
  }

  process.exit();
};

checkOrphans();
