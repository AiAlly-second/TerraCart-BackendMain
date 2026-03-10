/**
 * Terra Cart Backend Server
 * Production-ready with security enhancements
 */

const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const mongoose = require("mongoose");
const path = require("path");
const cors = require("cors");
const compression = require("compression");
const dotenv = require("dotenv");
const { createClient } = require("redis");
const { createAdapter } = require("@socket.io/redis-adapter");
const jwt = require("jsonwebtoken");
const User = require("./models/userModel");
const Employee = require("./models/employeeModel");
const connectDB = require("./config/db");
const { scheduleOrderAutoRelease } = require("./services/orderAutoRelease");
const {
  scheduleDailyRevenue,
  scheduleMonthlyRevenue,
} = require("./services/revenueScheduler");
const {
  startAttendanceTaskSchedulers,
} = require("./services/attendanceTaskSchedulerService");

// Security middleware
const {
  rateLimiters,
  securityHeaders,
  sanitizeInput,
  errorHandler,
  getCorsConfig,
} = require("./middleware/securityMiddleware");

// Always load backend/.env (do not use .env.production)
dotenv.config({ path: path.join(__dirname, ".env") });

// Silence backend runtime console output by default.
// Set BACKEND_ENABLE_CONSOLE_LOGS=true to re-enable logs when needed.
const muteRuntimeConsole =
  String(process.env.BACKEND_ENABLE_CONSOLE_LOGS || "").toLowerCase() !==
  "true";
if (muteRuntimeConsole) {
  const noop = () => {};
  console.log = noop;
  console.info = noop;
  console.warn = noop;
  console.error = noop;
  console.debug = noop;
  console.trace = noop;
}

// Validate critical environment variables
const validateEnv = () => {
  const warnings = [];

  if (
    !process.env.JWT_SECRET ||
    process.env.JWT_SECRET === "sarva-cafe-secret-key-2025"
  ) {
    warnings.push(
      "⚠️  JWT_SECRET is using default value. Set a strong secret in production!"
    );
  }

  if (!process.env.MONGO_URI) {
    warnings.push("⚠️  MONGO_URI not set. Using local MongoDB.");
  }

  if (process.env.NODE_ENV === "production") {
    if (!process.env.ALLOWED_ORIGINS) {
      warnings.push("⚠️  ALLOWED_ORIGINS not set. CORS may be too permissive.");
    }
    if (!process.env.SIGNED_URL_SECRET) {
      warnings.push(
        "⚠️  SIGNED_URL_SECRET not set. Using JWT_SECRET as fallback."
      );
    }
  }

  // Security warnings removed for cleaner console output
};

validateEnv();

// Global error handlers to prevent silent crashes
process.on("uncaughtException", (err) => {
  console.error("❌ UNCAUGHT EXCEPTION:", err.message);
  console.error(err.stack);
  // Give time for logs to flush before exiting
  setTimeout(() => process.exit(1), 1000);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ UNHANDLED REJECTION:", reason);
  // Note: We don't necessarily want to exit on rejection, but we should log it
});

// Initialize Express app
const app = express();
const server = http.createServer(app);
let redisPubClient;
let redisSubClient;

// Respect client IP/HTTPS headers when running behind ALB / reverse proxy
const trustProxyHops = Number.parseInt(process.env.TRUST_PROXY_HOPS || "1", 10);
app.set("trust proxy", Number.isNaN(trustProxyHops) ? 1 : trustProxyHops);

// Socket.IO setup
const io = socketIo(server, {
  cors: getCorsConfig(),
  pingTimeout: 60000,
  pingInterval: 25000,
});

const SOCKET_ROLE_ALLOWLIST = new Set([
  "super_admin",
  "franchise_admin",
  "admin",
  "waiter",
  "cook",
  "captain",
  "manager",
  "employee",
]);

const SOCKET_TRACE_ENABLED =
  String(
    process.env.BACKEND_ENABLE_SOCKET_TRACE ||
      process.env.BACKEND_ENABLE_SOCKET_DEBUG ||
      ""
  ).toLowerCase() === "true";

const writeSocketTraceLog = (message, metadata = null) => {
  if (!SOCKET_TRACE_ENABLED) return;
  let suffix = "";
  if (metadata && typeof metadata === "object") {
    try {
      suffix = ` ${JSON.stringify(metadata)}`;
    } catch (_error) {
      suffix = " [metadata_unserializable]";
    }
  }
  try {
    process.stdout.write(`[SOCKET_TRACE] ${message}${suffix}\n`);
  } catch (_error) {
    // Ignore trace write errors.
  }
};

const normalizeSocketRoomValue = (value) => {
  const normalized = String(value || "").trim();
  if (!normalized) return null;
  if (normalized.length > 64) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(normalized)) return null;
  return normalized;
};

const normalizeSocketRole = (role) => String(role || "").trim().toLowerCase();

const toSocketUserRoom = (userId) => {
  const normalized = normalizeSocketRoomValue(userId);
  return normalized ? `user_${normalized}` : null;
};

const extractSocketBearerToken = (socket) => {
  const authToken = socket?.handshake?.auth?.token;
  const headerToken = socket?.handshake?.headers?.authorization;
  const queryToken = socket?.handshake?.query?.token;
  const raw =
    (typeof authToken === "string" && authToken) ||
    (typeof headerToken === "string" && headerToken) ||
    (typeof queryToken === "string" && queryToken) ||
    "";
  if (!raw) return "";
  return raw.startsWith("Bearer ") ? raw.slice(7).trim() : raw.trim();
};

const extractSocketAnonymousSessionId = (socket) => {
  const authSessionId = socket?.handshake?.auth?.anonymousSessionId;
  const querySessionId = socket?.handshake?.query?.anonymousSessionId;
  const headerSessionId = socket?.handshake?.headers?.["x-anonymous-session-id"];
  const raw =
    (typeof authSessionId === "string" && authSessionId) ||
    (typeof querySessionId === "string" && querySessionId) ||
    (typeof headerSessionId === "string" && headerSessionId) ||
    "";
  return normalizeSocketRoomValue(raw);
};

const resolveSocketCartIds = async (user) => {
  const cartIds = new Set();
  if (!user) return cartIds;

  if (user._id) cartIds.add(String(user._id));
  if (user.cartId) cartIds.add(String(user.cartId));
  if (user.cafeId) cartIds.add(String(user.cafeId));

  if ((user.employeeId || user._id || user.email) && !user.cartId && !user.cafeId) {
    try {
      let employee = null;

      // Preferred lookup when JWT includes linked employeeId.
      if (user.employeeId) {
        employee = await Employee.findById(user.employeeId)
          .select("cartId cafeId")
          .lean();
      }

      // Backward compatibility: many staff records are linked by userId only.
      if (!employee && user._id) {
        employee = await Employee.findOne({ userId: user._id })
          .select("cartId cafeId")
          .lean();
      }

      // Safety fallback: legacy records where userId link is missing but email matches.
      if (!employee && user.email) {
        employee = await Employee.findOne({
          email: String(user.email).toLowerCase(),
        })
          .select("cartId cafeId")
          .lean();
      }

      if (employee?.cartId) cartIds.add(String(employee.cartId));
      if (employee?.cafeId) cartIds.add(String(employee.cafeId));
    } catch (_error) {
      // Ignore lookup errors; caller will enforce currently available IDs.
    }
  }

  return cartIds;
};

io.use(async (socket, next) => {
  try {
    socket.data.user = null;
    const token = extractSocketBearerToken(socket);
    if (!token) return next();

    const secret = String(process.env.JWT_SECRET || "").trim();
    if (!secret) return next();

    const decoded = jwt.verify(token, secret);
    if (!decoded?.id) return next();

    const user = await User.findById(decoded.id)
      .select("_id role email cartId cafeId franchiseId employeeId tokenVersion")
      .lean();
    if (!user) return next();

    const tokenVersion =
      decoded.tokenVersion !== undefined ? Number(decoded.tokenVersion) : 0;
    const userTokenVersion =
      user.tokenVersion !== undefined ? Number(user.tokenVersion) : 0;
    if (tokenVersion !== userTokenVersion) return next();

    socket.data.user = user;
    return next();
  } catch (_error) {
    socket.data.user = null;
    return next();
  }
});

const setupSocketRedisAdapter = async () => {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return;

  const pubClient = createClient({ url: redisUrl });
  const subClient = pubClient.duplicate();

  pubClient.on("error", (err) => {
    console.error("[REDIS] Socket pub client error:", err.message);
  });
  subClient.on("error", (err) => {
    console.error("[REDIS] Socket sub client error:", err.message);
  });

  await Promise.all([pubClient.connect(), subClient.connect()]);
  io.adapter(createAdapter(pubClient, subClient));

  redisPubClient = pubClient;
  redisSubClient = subClient;
};

// Middleware
app.use(
  compression({
    threshold: Number.parseInt(
      process.env.COMPRESSION_THRESHOLD_BYTES || "1024",
      10
    ),
  })
);
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(cors(getCorsConfig()));
app.use(securityHeaders);
app.use(sanitizeInput);

// Apply rate limiting to all routes
app.use(rateLimiters.api);

// Routes
app.use("/api/users", require("./routes/userRoutes"));
app.use("/api/menu", require("./routes/menuRoutes"));
app.use("/api/voice-order", require("./routes/voiceOrderRoutes"));
app.use("/api/voice-inventory", require("./routes/voiceInventoryRoutes"));
app.use("/api/voice-command", require("./routes/voiceCommandRoutes"));
app.use("/api/translations", require("./routes/translationRoutes"));
app.use("/api/addons", require("./routes/addonRoutes"));
app.use("/api/default-menu", require("./routes/defaultMenuRoutes"));
app.use("/api/orders", require("./routes/orderRoutes"));
app.use("/api/tables", require("./routes/tableRoutes"));
app.use("/api/payments", require("./routes/paymentRoutes"));
app.use("/api/payment-qr", require("./routes/paymentQrRoutes"));
app.use("/api/customers", require("./routes/customerRoutes"));
app.use("/api/waitlist", require("./routes/waitlistRoutes"));
app.use("/api/feedback", require("./routes/feedbackRoutes"));
app.use("/api/revenue", require("./routes/revenueRoutes"));
app.use("/api/admin", require("./routes/adminRoutes"));
app.use("/api/files", require("./routes/fileRoutes"));
app.use("/api/inventory", require("./routes/inventoryRoutes"));
app.use("/api/kiosk", require("./routes/kioskRoutes"));
app.use("/api/kiosk-owner", require("./routes/kioskOwnerRoutes"));
app.use("/api/carts", require("./routes/cartRoutes"));
app.use("/api/employees", require("./routes/employeeRoutes"));
app.use("/api/attendance", require("./routes/attendanceRoutes"));
app.use("/api/printer-config", require("./routes/printerConfigRoutes"));
app.use("/api/employee-schedule", require("./routes/employeeScheduleRoutes"));
app.use("/api/employee-schedules", require("./routes/employeeScheduleRoutes"));
app.use("/api/employee-skills", require("./routes/employeeSkillsRoutes"));
app.use("/api/admin/costing", require("./routes/costingRoutes"));
app.use("/api/costing-v2", require("./routes/costing-v2Routes"));
app.use("/api/dashboard", require("./routes/dashboardRoutes"));
app.use("/api/tasks", require("./routes/taskRoutes"));
app.use("/api/daily-tasks", require("./routes/dailyTaskRoutes"));
app.use("/api/customer-requests", require("./routes/customerRequestRoutes"));
app.use("/api/leave-requests", require("./routes/leaveRequestRoutes"));
app.use("/api/compliance", require("./routes/complianceRoutes"));
app.use("/api/kot", require("./routes/kotRoutes"));
app.use("/api/analytics", require("./routes/analyticsRoutes"));
app.use("/api/print", require("./routes/printRoutes")); // Network printer routes
app.use("/api/print-queue", require("./routes/printQueueRoutes")); // Print queue for mobile agent
app.use("/api/geocode", require("./routes/geocodeRoutes"));
app.use("/api/app", require("./routes/appUpdateRoutes"));
app.use("/api", require("./routes/notificationRoutes"));


// Health check endpoints (both /health and /api/health for compatibility)
const healthRoutes = require("./routes/healthRoutes");
app.use("/api", healthRoutes);
app.get("/health", (req, res) => {
  const dbReady = mongoose.connection.readyState === 1;
  const status = dbReady ? "healthy" : "degraded";
  res.status(dbReady ? 200 : 503).json({
    status,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || "development",
    dbState: mongoose.connection.readyState,
  });
});

// Static file serving for uploads
app.use(
  "/uploads/menu",
  express.static(path.join(__dirname, "uploads/menu"), {
    maxAge: "1d",
    etag: true,
    lastModified: true,
  })
);

if (
  process.env.NODE_ENV !== "production" ||
  process.env.ALLOW_PUBLIC_UPLOADS === "true"
) {
  app.use(
    "/uploads",
    express.static(path.join(__dirname, "uploads"), {
      maxAge: "1h",
      etag: true,
    })
  );
} else {
  app.use(
    "/uploads/payment-qr",
    express.static(path.join(__dirname, "uploads/payment-qr"), {
      maxAge: "1d",
      etag: true,
    })
  );
}

// Socket.IO connection handling with room support
io.on("connection", (socket) => {
  writeSocketTraceLog("client connected", {
    socketId: socket.id,
    hasUser: !!socket.data?.user,
  });
  // Client connected - removed verbose logging
  // Auto-join authenticated staff to their cart/cafe rooms so realtime
  // order/KOT updates work even if explicit join events are delayed or missing.
  (async () => {
    try {
      const user = socket.data?.user || null;
      if (!user) return;

      const role = normalizeSocketRole(user.role);
      if (role && SOCKET_ROLE_ALLOWLIST.has(role)) {
        socket.join(`role:${role}`);
        writeSocketTraceLog("joined role room", {
          socketId: socket.id,
          room: `role:${role}`,
        });
      }

      const userRoom = toSocketUserRoom(user?._id);
      if (userRoom) {
        socket.join(userRoom);
        writeSocketTraceLog("joined user room", {
          socketId: socket.id,
          room: userRoom,
        });
      }

      // Keep super_admin explicit-join only to avoid joining many rooms.
      if (role === "super_admin") return;

      const allowedCartIds = await resolveSocketCartIds(user);
      for (const cartId of allowedCartIds) {
        const normalizedCartId = normalizeSocketRoomValue(cartId);
        if (!normalizedCartId) continue;
        socket.join(`cart:${normalizedCartId}`);
        socket.join(`cafe:${normalizedCartId}`);
        writeSocketTraceLog("joined cart/cafe rooms", {
          socketId: socket.id,
          cartId: normalizedCartId,
        });
      }
    } catch (_error) {
      // Best-effort auto-join; explicit join events still work as fallback.
    }
  })();

  const initialAnonymousSessionId = extractSocketAnonymousSessionId(socket);
  if (initialAnonymousSessionId) {
    socket.join(`anon_${initialAnonymousSessionId}`);
    writeSocketTraceLog("joined anon room on connect", {
      socketId: socket.id,
      room: `anon_${initialAnonymousSessionId}`,
    });
  }

  // Join cafe room
  socket.on("join:cafe", async (cafeId) => {
    const normalizedCafeId = normalizeSocketRoomValue(cafeId);
    if (!normalizedCafeId) {
      writeSocketTraceLog("join:cafe rejected invalid room", {
        socketId: socket.id,
        cafeId,
      });
      return;
    }

    const user = socket.data?.user || null;
    if (user && normalizeSocketRole(user.role) !== "super_admin") {
      const allowedCartIds = await resolveSocketCartIds(user);
      if (!allowedCartIds.has(normalizedCafeId)) {
        writeSocketTraceLog("join:cafe rejected unauthorized room", {
          socketId: socket.id,
          cafeId: normalizedCafeId,
          userId: user._id ? String(user._id) : null,
        });
        return;
      }
    }

    const room = `cafe:${normalizedCafeId}`;
    socket.join(room);
    writeSocketTraceLog("join:cafe", {
      socketId: socket.id,
      room,
    });
  });

  // Join franchise room
  socket.on("join:franchise", (franchiseId) => {
    const normalizedFranchiseId = normalizeSocketRoomValue(franchiseId);
    if (!normalizedFranchiseId) {
      writeSocketTraceLog("join:franchise rejected invalid room", {
        socketId: socket.id,
        franchiseId,
      });
      return;
    }

    const user = socket.data?.user || null;
    if (!user) {
      writeSocketTraceLog("join:franchise rejected anonymous", {
        socketId: socket.id,
        franchiseId: normalizedFranchiseId,
      });
      return;
    }

    const role = normalizeSocketRole(user.role);
    if (role === "super_admin") {
      socket.join(`franchise:${normalizedFranchiseId}`);
      return;
    }

    const sameFranchiseId =
      user._id && String(user._id) === normalizedFranchiseId;
    const adminFranchiseId =
      user.franchiseId && String(user.franchiseId) === normalizedFranchiseId;

    if ((role === "franchise_admin" && sameFranchiseId) || (role === "admin" && adminFranchiseId)) {
      socket.join(`franchise:${normalizedFranchiseId}`);
      writeSocketTraceLog("join:franchise", {
        socketId: socket.id,
        room: `franchise:${normalizedFranchiseId}`,
      });
      return;
    }

    writeSocketTraceLog("join:franchise rejected unauthorized room", {
      socketId: socket.id,
      franchiseId: normalizedFranchiseId,
      userId: user._id ? String(user._id) : null,
      role,
    });
  });

  // Join role-based room
  socket.on("join:role", (role) => {
    const normalizedRequestedRole = normalizeSocketRole(role);
    if (!normalizedRequestedRole || !SOCKET_ROLE_ALLOWLIST.has(normalizedRequestedRole)) {
      writeSocketTraceLog("join:role rejected invalid role", {
        socketId: socket.id,
        role,
      });
      return;
    }

    const user = socket.data?.user || null;
    if (!user) {
      writeSocketTraceLog("join:role rejected anonymous", {
        socketId: socket.id,
        role: normalizedRequestedRole,
      });
      return;
    }

    const normalizedUserRole = normalizeSocketRole(user.role);
    if (
      normalizedUserRole === "super_admin" ||
      normalizedUserRole === normalizedRequestedRole
    ) {
      socket.join(`role:${normalizedRequestedRole}`);
      writeSocketTraceLog("join:role", {
        socketId: socket.id,
        room: `role:${normalizedRequestedRole}`,
      });
      return;
    }

    writeSocketTraceLog("join:role rejected unauthorized role", {
      socketId: socket.id,
      role: normalizedRequestedRole,
      userRole: normalizedUserRole,
    });
  });

  // Join cart room (for mobile app users)
  socket.on("join:cart", async (cartId) => {
    const normalizedCartId = normalizeSocketRoomValue(cartId);
    if (!normalizedCartId) {
      writeSocketTraceLog("join:cart rejected invalid room", {
        socketId: socket.id,
        cartId,
      });
      return;
    }

    const user = socket.data?.user || null;
    if (user && normalizeSocketRole(user.role) !== "super_admin") {
      const allowedCartIds = await resolveSocketCartIds(user);
      if (!allowedCartIds.has(normalizedCartId)) {
        writeSocketTraceLog("join:cart rejected unauthorized room", {
          socketId: socket.id,
          cartId: normalizedCartId,
          userId: user._id ? String(user._id) : null,
        });
        return;
      }
    }

    const cartRoom = `cart:${normalizedCartId}`;
    const cafeRoom = `cafe:${normalizedCartId}`;
    socket.join(cartRoom);
    socket.join(cafeRoom);
    writeSocketTraceLog("join:cart", {
      socketId: socket.id,
      cartRoom,
      cafeRoom,
    });
  });

  socket.on("join_room", (payload) => {
    const normalizedPayload =
      payload && typeof payload === "object"
        ? payload
        : { anonymousSessionId: payload };

    const requestedUserId = normalizeSocketRoomValue(normalizedPayload?.userId);
    const requestedAnonymousSessionId = normalizeSocketRoomValue(
      normalizedPayload?.anonymousSessionId
    );

    if (requestedUserId) {
      const socketUser = socket.data?.user || null;
      const socketUserId = normalizeSocketRoomValue(socketUser?._id);
      const socketUserRole = normalizeSocketRole(socketUser?.role);
      const canJoinUserRoom =
        socketUserId &&
        (socketUserId === requestedUserId || socketUserRole === "super_admin");
      if (canJoinUserRoom) {
        socket.join(`user_${requestedUserId}`);
        writeSocketTraceLog("join_room user", {
          socketId: socket.id,
          room: `user_${requestedUserId}`,
        });
      } else {
        writeSocketTraceLog("join_room user rejected", {
          socketId: socket.id,
          requestedUserId,
          socketUserId: socketUserId || null,
          socketUserRole: socketUserRole || null,
        });
      }
    }

    if (requestedAnonymousSessionId) {
      socket.join(`anon_${requestedAnonymousSessionId}`);
      writeSocketTraceLog("join_room anon", {
        socketId: socket.id,
        room: `anon_${requestedAnonymousSessionId}`,
      });
    }
  });

  // Join kiosk room (for mobile app users)
  socket.on("join:kiosk", (kioskId) => {
    const normalizedKioskId = normalizeSocketRoomValue(kioskId);
    if (!normalizedKioskId) {
      writeSocketTraceLog("join:kiosk rejected invalid room", {
        socketId: socket.id,
        kioskId,
      });
      return;
    }

    const user = socket.data?.user || null;
    if (!user) {
      writeSocketTraceLog("join:kiosk rejected anonymous", {
        socketId: socket.id,
        kioskId: normalizedKioskId,
      });
      return;
    }

    socket.join(`kiosk:${normalizedKioskId}`);
    writeSocketTraceLog("join:kiosk", {
      socketId: socket.id,
      room: `kiosk:${normalizedKioskId}`,
    });
  });

  socket.on("disconnect", (reason) => {
    writeSocketTraceLog("client disconnected", {
      socketId: socket.id,
      reason,
    });
    // Client disconnected - removed verbose logging
  });

  // Handle socket errors
  socket.on("error", (error) => {
    // Only log actual errors, not normal disconnections
    if (error.message && !error.message.includes("transport close")) {
      console.error(`[SOCKET] Error:`, error.message);
    }
  });
});

// Helper function to emit to cafe room
const emitToCafe = (io, cafeId, event, data) => {
  if (cafeId) {
    const cafeRoom = `cafe:${cafeId}`;
    const cartRoom = `cart:${cafeId}`;
    io.to(cafeRoom).emit(event, data);
    io.to(cartRoom).emit(event, data); // Also emit to cart room
    writeSocketTraceLog("emitToCafe", {
      event,
      cafeRoom,
      cartRoom,
      orderId: data?._id || data?.orderId || null,
      status: data?.status || null,
      lifecycleStatus: data?.lifecycleStatus || null,
    });
    // Emitted to cafe and cart rooms
  }
};

// Helper function to emit to franchise room
const emitToFranchise = (io, franchiseId, event, data) => {
  if (franchiseId) {
    io.to(`franchise:${franchiseId}`).emit(event, data);
    console.log(`[SOCKET] Emitted ${event} to franchise:${franchiseId}`);
  }
};

// Helper function to emit to cart room
const emitToCart = (io, cartId, event, data) => {
  if (cartId) {
    const cartRoom = `cart:${cartId}`;
    const cafeRoom = `cafe:${cartId}`;
    io.to(cartRoom).emit(event, data);
    io.to(cafeRoom).emit(event, data); // Also emit to cafe room for backward compatibility
    writeSocketTraceLog("emitToCart", {
      event,
      cartRoom,
      cafeRoom,
      orderId: data?._id || data?.orderId || null,
      status: data?.status || null,
      lifecycleStatus: data?.lifecycleStatus || null,
    });
    // Emitted to cart room
  }
};
// Helper function to emit to kiosk room
const emitToKiosk = (io, kioskId, event, data) => {
  if (kioskId) {
    io.to(`kiosk:${kioskId}`).emit(event, data);
    // Emitted to kiosk room
  }
};

// Make helpers available to routes
app.set("emitToCafe", emitToCafe);
app.set("emitToFranchise", emitToFranchise);
app.set("emitToCart", emitToCart);
app.set("emitToKiosk", emitToKiosk);

// Make io available to routes
app.set("io", io);

// Schedule background jobs
// scheduleOrderAutoRelease(io); // DISABLED: Orders should only be cancelled by customer or admin, not automatically
scheduleDailyRevenue();
scheduleMonthlyRevenue();

// Error handling middleware (must be last)
app.use(errorHandler);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ message: "Route not found" });
});

// Connect to database and start server
const startServer = async () => {
  try {
    await connectDB();
    await setupSocketRedisAdapter();
    startAttendanceTaskSchedulers({ io, emitToCafe });

    const PORT = process.env.PORT || 5001;
    const keepAliveTimeoutMs = Number.parseInt(
      process.env.HTTP_KEEP_ALIVE_TIMEOUT_MS || "65000",
      10
    );
    const requestTimeoutMs = Number.parseInt(
      process.env.HTTP_REQUEST_TIMEOUT_MS || "120000",
      10
    );

    if (!Number.isNaN(keepAliveTimeoutMs) && keepAliveTimeoutMs > 0) {
      server.keepAliveTimeout = keepAliveTimeoutMs;
      server.headersTimeout = keepAliveTimeoutMs + 5000;
    }
    if (!Number.isNaN(requestTimeoutMs) && requestTimeoutMs > 0) {
      server.requestTimeout = requestTimeoutMs;
    }

    // CRITICAL: Omit host to listen on all interfaces (IPv4 and IPv6)
    // This resolves 'localhost' resolution issues in some environments
    server.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`📡 Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`🌐 Server accessible locally at: http://localhost:${PORT}`);
    });
  } catch (error) {
    process.exit(1);
  }
};

startServer();

const closeRedisClients = async () => {
  await new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
  });
  await Promise.allSettled([
    redisPubClient?.quit?.(),
    redisSubClient?.quit?.(),
  ]);
  await Promise.allSettled([mongoose.connection.close()]);
};

process.on("SIGTERM", async () => {
  await closeRedisClients();
  process.exit(0);
});

process.on("SIGINT", async () => {
  await closeRedisClients();
});

module.exports = { app, server, io };
