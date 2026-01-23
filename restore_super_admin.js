const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
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
    // Check if exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
        console.log(`Super Admin with email ${email} already exists.`);
        
        // Optional: Reset password if it exists?
        // Let's just update it to be sure
        const salt = await bcrypt.genSalt(10);
        existingUser.password = await bcrypt.hash(password, salt);
        existingUser.role = "super_admin"; // Ensure role is super_admin
        existingUser.name = name;
        await existingUser.save();
        console.log("Updated existing user to Super Admin with default credentials.");
    } else {
        // Create new
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const newUser = await User.create({
            name,
            email,
            password: hashedPassword, // Store hashed password directly as we are bypassing pre-save hook effectively or just to be safe
            role: "super_admin"
        });
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
