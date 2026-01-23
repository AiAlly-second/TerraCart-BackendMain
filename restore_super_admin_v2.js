const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const User = require("./models/userModel");

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

const createSuperAdmin = async () => {
  await connectDB();

  const email = "superadmin@terra.cart";
  const password = "password123";
  const name = "Restored Super Admin";

  try {
    const existingUser = await User.findOne({ email });
    if (existingUser) {
        console.log(`User found. Updating to plain text '${password}' (will be hashed by model)...`);
        
        existingUser.password = password; // Set plain text
        existingUser.role = "super_admin";
        existingUser.name = name;
        
        await existingUser.save(); // Model middleware will hash it
        console.log("Updated existing user credentials.");
    } else {
        console.log(`Creating new user with plain text '${password}' (will be hashed by model)...`);
        
        // Pass plain text password to create
        await User.create({
            name,
            email,
            password: password, 
            role: "super_admin"
        }); // Model middleware will hash it
        console.log("Created new Super Admin user.");
    }

    console.log("\n-------------------------------------------");
    console.log("Super Admin Ready");
    console.log(`Email: ${email}`);
    console.log(`Password: ${password}`);
    console.log("-------------------------------------------\n");

  } catch (error) {
    console.error(`Error: ${error.message}`);
  }

  process.exit();
};

createSuperAdmin();
