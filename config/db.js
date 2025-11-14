const mongoose = require("mongoose");

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI || "mongodb://127.0.0.1:27017/sarva-cafe");
    console.log(`✅ MongoDB Connected: ${conn.connection.host}/${conn.connection.name}`);
  } catch (error) {
    console.error("❌ MongoDB connection error:", error.message);
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
