const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");

let modelsLoaded = false;

function loadAllModelsOnce() {
  if (modelsLoaded) return;
  const modelsRoot = path.join(__dirname, "..", "..", "models");
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && /\.js$/i.test(entry.name)) {
        require(fullPath);
      }
    }
  };
  walk(modelsRoot);
  modelsLoaded = true;
}

function toObjectId(value) {
  if (!value) return null;
  if (value instanceof mongoose.Types.ObjectId) return value;
  if (!mongoose.Types.ObjectId.isValid(String(value))) return null;
  return new mongoose.Types.ObjectId(String(value));
}

function withCartLegacyOr(cartId) {
  const objectId = toObjectId(cartId);
  if (!objectId) return {};
  // Legacy cafeId fallback is required because parts of TerraCart still query with cafeId.
  return {
    $or: [{ cartId: objectId }, { cafeId: objectId }],
  };
}

function withFranchiseOr(franchiseId) {
  const objectId = toObjectId(franchiseId);
  if (!objectId) return {};
  return { franchiseId: objectId };
}

function getAllOperationalModelNames() {
  loadAllModelsOnce();
  return Object.keys(mongoose.models).filter(
    (name) =>
      ![
        "BackupJob",
        "BackupRecord",
        "RestoreRecord",
        "BackupRestoreAuditLog",
        "BackupRestoreLock",
      ].includes(name)
  );
}

function buildSystemCollectionMap() {
  const map = new Map();
  getAllOperationalModelNames().forEach((name) => map.set(name, {}));
  return map;
}

async function buildFranchiseCollectionMap(franchiseId) {
  const franchiseObjectId = toObjectId(franchiseId);
  const map = new Map();
  const all = getAllOperationalModelNames();

  all.forEach((name) => {
    map.set(name, withFranchiseOr(franchiseObjectId));
  });

  map.set("User", { $or: [{ _id: franchiseObjectId }, withFranchiseOr(franchiseObjectId)] });
  map.set("Cart", withFranchiseOr(franchiseObjectId));
  map.set("Franchise", {
    $or: [{ _id: franchiseObjectId }, { franchiseAdminId: franchiseObjectId }],
  });

  return map;
}

async function buildCartCollectionMap(cartId) {
  const cartObjectId = toObjectId(cartId);
  const map = new Map();
  const all = getAllOperationalModelNames();

  all.forEach((name) => {
    map.set(name, withCartLegacyOr(cartObjectId));
  });

  map.set("User", {
    $or: [{ _id: cartObjectId }, { cartId: cartObjectId }, { cafeId: cartObjectId }],
  });
  map.set("Cart", { $or: [{ _id: cartObjectId }, { cartAdminId: cartObjectId }] });
  return map;
}

async function resolveScope({ scopeType, scopeId = null }) {
  if (scopeType === "system") {
    return { scopeType, scopeId: null, collectionQueryMap: buildSystemCollectionMap() };
  }
  if (scopeType === "franchise") {
    if (!scopeId) throw new Error("scopeId is required for franchise scope");
    return {
      scopeType,
      scopeId: toObjectId(scopeId),
      collectionQueryMap: await buildFranchiseCollectionMap(scopeId),
    };
  }
  if (scopeType === "cart") {
    if (!scopeId) throw new Error("scopeId is required for cart scope");
    return {
      scopeType,
      scopeId: toObjectId(scopeId),
      collectionQueryMap: await buildCartCollectionMap(scopeId),
    };
  }
  throw new Error("Invalid scopeType");
}

module.exports = {
  resolveScope,
  getAllOperationalModelNames,
};
