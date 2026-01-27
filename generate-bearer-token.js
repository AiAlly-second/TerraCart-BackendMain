const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const User = require("./models/userModel");
require("dotenv").config();

const generateBearerToken = async () => {
    try {
        const secret = process.env.JWT_SECRET;
        if (!secret) {
            console.error("JWT_SECRET is missing in .env");
            process.exit(1);
        }

        const uri = process.env.MONGO_URI;
        if (!uri) {
            console.error("MONGO_URI is missing in .env");
            process.exit(1);
        }

        await mongoose.connect(uri);

        // Find Super Admin
        const user = await User.findOne({ email: "superadmin@terra.cart" });

        if (!user) {
            console.error("Super Admin not found!");
            process.exit(1);
        }

        // Generate Token (Valid for 24 hours)
        const token = jwt.sign({ id: user._id }, secret, { expiresIn: "24h" });

        console.log("\n✅ Generated Bearer Token (Valid for 24 hours):");
        console.log(`Bearer ${token}`);
        
    } catch (err) {
        console.error(err);
    } finally {
        mongoose.disconnect();
    }
};

generateBearerToken();
