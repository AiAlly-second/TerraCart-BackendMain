const mongoose = require("mongoose");

const LOCAL_MONGO_URI = "mongodb://127.0.0.1:27017/terra-cart";

const connectWithUri = async (mongoUri) => {
  const maxPoolSize = Number.parseInt(process.env.MONGO_MAX_POOL_SIZE || "100", 10);
  const minPoolSize = Number.parseInt(process.env.MONGO_MIN_POOL_SIZE || "5", 10);
  const maxIdleTimeMS = Number.parseInt(process.env.MONGO_MAX_IDLE_TIME_MS || "30000", 10);
  const connectTimeoutMS = Number.parseInt(process.env.MONGO_CONNECT_TIMEOUT_MS || "10000", 10);
  const isAtlas = mongoUri.includes("mongodb+srv://");

  if (isAtlas) {
    console.log("[DB] Connecting to MongoDB Atlas...");
  } else {
    console.log("[DB] Connecting to local MongoDB...");
  }

  const conn = await mongoose.connect(mongoUri, {
    // Options for better connection handling
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
    maxPoolSize: Number.isNaN(maxPoolSize) ? 100 : maxPoolSize,
    minPoolSize: Number.isNaN(minPoolSize) ? 5 : minPoolSize,
    maxIdleTimeMS: Number.isNaN(maxIdleTimeMS) ? 30000 : maxIdleTimeMS,
    connectTimeoutMS: Number.isNaN(connectTimeoutMS) ? 10000 : connectTimeoutMS,
  });

  const connectionInfo = isAtlas
    ? `Atlas Cluster: ${conn.connection.host}`
    : `Local: ${conn.connection.host}`;
  console.log(`[DB] Connected: ${connectionInfo}`);
  console.log(`[DB] Database: ${conn.connection.name}`);
  return conn;
};

const connectDB = async () => {
  const mongoUri = process.env.MONGO_URI || LOCAL_MONGO_URI;

  try {
    await connectWithUri(mongoUri);
    return;
  } catch (error) {
    const message = error?.message || String(error);
    console.error("[DB] Connection error:", message);

    if (message.includes("authentication failed")) {
      console.error("[DB] Tip: Check username and password in MONGO_URI");
    } else if (message.includes("ENOTFOUND") || message.includes("getaddrinfo")) {
      console.error("[DB] Tip: Check network and cluster URL");
    } else if (message.includes("IP")) {
      console.error("[DB] Tip: Add your IP address to MongoDB Atlas network access list");
    } else if (message.includes("timeout")) {
      console.error("[DB] Tip: Check network/firewall settings");
    }

    const canFallbackToLocal =
      process.env.NODE_ENV !== "production" &&
      mongoUri !== LOCAL_MONGO_URI &&
      String(process.env.MONGO_LOCAL_FALLBACK_ENABLED || "true").toLowerCase() !== "false";

    if (canFallbackToLocal) {
      console.warn(
        "[DB] Primary MongoDB failed. Falling back to local MongoDB at 127.0.0.1:27017."
      );
      await connectWithUri(LOCAL_MONGO_URI);
      return;
    }

    console.error("[DB] Atlas setup guide: MONGODB_ATLAS_SETUP.md");
    throw error;
  }
};

// Graceful shutdown
process.on("SIGINT", async () => {
  await mongoose.connection.close();
  console.log("[DB] MongoDB disconnected on app termination");
  process.exit(0);
});

module.exports = connectDB;
