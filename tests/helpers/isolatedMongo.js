const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const TEST_DB = "terracart_inventory_isolation_test";

const assertIsolatedTestDatabase = (uri, dbName = TEST_DB) => {
  const parsed = new URL(uri);
  if (process.env.NODE_ENV !== "test" ||
      parsed.protocol !== "mongodb:" ||
      !["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname) ||
      dbName !== TEST_DB || parsed.pathname !== `/${TEST_DB}`) {
    throw new Error("ISOLATED_TEST_DATABASE_REQUIRED");
  }
};

const startIsolatedMongo = async () => {
  if (process.env.NODE_ENV !== "test") throw new Error("ISOLATED_TEST_DATABASE_REQUIRED");
  const server = await MongoMemoryReplSet.create({ replSet: { count: 1, dbName: TEST_DB } });
  const uri = server.getUri(TEST_DB);
  assertIsolatedTestDatabase(uri);
  process.env.MONGO_URI = uri;
  await mongoose.connect(uri, { dbName: TEST_DB });
  if (mongoose.connection.name !== TEST_DB) {
    await mongoose.disconnect();
    await server.stop();
    throw new Error("ISOLATED_TEST_DATABASE_REQUIRED");
  }
  return server;
};

module.exports = { TEST_DB, assertIsolatedTestDatabase, startIsolatedMongo };
