const admin = require("firebase-admin");
const path = require("path");
const dotenv = require("dotenv");

const REQUIRED_FIREBASE_ENV_KEYS = [
  "FIREBASE_PROJECT_ID",
  "FIREBASE_PRIVATE_KEY",
  "FIREBASE_CLIENT_EMAIL",
];

const readEnvValue = (key) =>
  String(process.env[key] || "")
    .trim()
    .replace(/^['"]|['"]$/g, "");

const getServiceAccountFromEnv = () => {
  const projectId = readEnvValue("FIREBASE_PROJECT_ID");
  const privateKeyId = readEnvValue("FIREBASE_PRIVATE_KEY_ID");
  const clientEmail = readEnvValue("FIREBASE_CLIENT_EMAIL");
  const privateKeyRaw = String(process.env.FIREBASE_PRIVATE_KEY || "").trim();

  const missingKeys = REQUIRED_FIREBASE_ENV_KEYS.filter((key) => {
    const value =
      key === "FIREBASE_PRIVATE_KEY" ? privateKeyRaw : readEnvValue(key);
    return !value;
  });

  if (missingKeys.length > 0) {
    return {
      serviceAccount: null,
      error: `Missing Firebase env keys: ${missingKeys.join(", ")}`,
    };
  }

  const normalizedPrivateKey = privateKeyRaw
    .replace(/^['"]|['"]$/g, "")
    .replace(/\\n/g, "\n");

  const serviceAccount = {
    type: "service_account",
    projectId,
    privateKey: normalizedPrivateKey,
    clientEmail,
  };

  if (privateKeyId) {
    serviceAccount.privateKeyId = privateKeyId;
  }

  return {
    serviceAccount,
    error: null,
  };
};

let isFirebaseConfigured = false;
let firebaseInitError = null;

const loadEnvFallback = () => {
  // Allow self-healing when .env gets fixed without restarting process.
  dotenv.config({ path: path.join(__dirname, "..", ".env") });
};

const ensureFirebaseInitialized = () => {
  try {
    // Initialize once per process to avoid duplicate app errors.
    if (admin.apps.length > 0) {
      isFirebaseConfigured = true;
      firebaseInitError = null;
      return true;
    }

    loadEnvFallback();
    const { serviceAccount, error } = getServiceAccountFromEnv();
    if (error) {
      isFirebaseConfigured = false;
      firebaseInitError = error;
      console.error(`[FIREBASE] ${firebaseInitError}`);
      return false;
    }

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    isFirebaseConfigured = true;
    firebaseInitError = null;
    console.log(`[FIREBASE] Initialized for project ${serviceAccount.projectId}`);
    return true;
  } catch (error) {
    isFirebaseConfigured = false;
    firebaseInitError = error?.message || "Unknown Firebase initialization error";
    console.error(`[FIREBASE] Initialization failed: ${firebaseInitError}`);
    return false;
  }
};

const getFirebaseInitError = () => firebaseInitError;

ensureFirebaseInitialized();

module.exports = {
  admin,
  ensureFirebaseInitialized,
  getFirebaseInitError,
};
