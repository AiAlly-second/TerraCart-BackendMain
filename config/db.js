const mongoose = require("mongoose");

const LOCAL_MONGO_URI = "mongodb://127.0.0.1:27017/terra-cart";

const connectWithUri = async (mongoUri) => {
  // A t3.small does not need a 100-connection default pool. Deployments can
  // override these values, while this default preserves host memory.
  const maxPoolSize = Number.parseInt(process.env.MONGO_MAX_POOL_SIZE || "20", 10);
  const minPoolSize = Number.parseInt(process.env.MONGO_MIN_POOL_SIZE || "0", 10);
  const maxIdleTimeMS = Number.parseInt(process.env.MONGO_MAX_IDLE_TIME_MS || "30000", 10);
  const connectTimeoutMS = Number.parseInt(process.env.MONGO_CONNECT_TIMEOUT_MS || "10000", 10);
  const isAtlas = mongoUri.includes("mongodb+srv://");
  const boundedMaxPool = Number.isFinite(maxPoolSize) && maxPoolSize > 0 ? Math.min(maxPoolSize, 50) : 20;

  if (isAtlas) {
    console.log("[DB] Connecting to MongoDB Atlas...");
  } else {
    console.log("[DB] Connecting to local MongoDB...");
  }

  const conn = await mongoose.connect(mongoUri, {
    // Options for better connection handling
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 15000,
    maxPoolSize: boundedMaxPool,
    minPoolSize: Number.isFinite(minPoolSize) && minPoolSize >= 0 ? Math.min(minPoolSize, boundedMaxPool) : 0,
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

module.exports = connectDB;
