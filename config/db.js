const mongoose = require("mongoose");

const connectDB = async () => {
  try {
    const mongoUri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/terra-cart";
    
    // Check if using MongoDB Atlas (mongodb+srv://)
    const isAtlas = mongoUri.includes("mongodb+srv://");
    
    if (isAtlas) {
      console.log("🌐 Connecting to MongoDB Atlas (Cloud)...");
    } else {
      console.log("💻 Connecting to Local MongoDB...");
    }
    
    const conn = await mongoose.connect(mongoUri, {
      // Options for better connection handling
      serverSelectionTimeoutMS: 5000, // Timeout after 5s instead of 30s
      socketTimeoutMS: 45000, // Close sockets after 45s of inactivity
    });
    
    const connectionInfo = isAtlas 
      ? `Atlas Cluster: ${conn.connection.host}`
      : `Local: ${conn.connection.host}`;
    
    console.log(`✅ MongoDB Connected: ${connectionInfo}`);
    console.log(`📊 Database: ${conn.connection.name}`);
  } catch (error) {
    console.error("❌ MongoDB connection error:", error.message);
    
    // Provide helpful error messages
    if (error.message.includes("authentication failed")) {
      console.error("💡 Tip: Check your username and password in MONGO_URI");
    } else if (error.message.includes("ENOTFOUND") || error.message.includes("getaddrinfo")) {
      console.error("💡 Tip: Check your internet connection and cluster URL");
    } else if (error.message.includes("IP")) {
      console.error("💡 Tip: Add your IP address to MongoDB Atlas Network Access whitelist");
    } else if (error.message.includes("timeout")) {
      console.error("💡 Tip: Check your network connection and firewall settings");
    }
    
    console.error("\n📖 For MongoDB Atlas setup, see: MONGODB_ATLAS_SETUP.md");
    process.exit(1);
  }
};

// Graceful shutdown
process.on("SIGINT", async () => {
  await mongoose.connection.close();
  console.log("🔌 MongoDB disconnected on app termination");
  process.exit(0);
});

module.exports = connectDB;
