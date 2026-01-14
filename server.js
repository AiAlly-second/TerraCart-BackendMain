/**
 * Terra Cart Backend Server
 * Production-ready with security enhancements
 */

const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const path = require("path");
const cors = require("cors");
const dotenv = require("dotenv");
const connectDB = require("./config/db");
const { scheduleOrderAutoRelease } = require("./services/orderAutoRelease");
const {
  scheduleDailyRevenue,
  scheduleMonthlyRevenue,
} = require("./services/revenueScheduler");

// Security middleware
const {
  rateLimiters,
  securityHeaders,
  sanitizeInput,
  errorHandler,
  getCorsConfig,
} = require("./middleware/securityMiddleware");

// Load env vars
dotenv.config();

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

// Initialize Express app
const app = express();
const server = http.createServer(app);

// Socket.IO setup
const io = socketIo(server, {
  cors: getCorsConfig(),
  pingTimeout: 60000,
  pingInterval: 25000,
});

// Middleware
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
app.use("/api/employee-schedule", require("./routes/employeeScheduleRoutes"));
app.use("/api/employee-skills", require("./routes/employeeSkillsRoutes"));
app.use("/api/admin/costing", require("./routes/costingRoutes"));
app.use("/api/costing-v2", require("./routes/costing-v2Routes"));
app.use("/api/dashboard", require("./routes/dashboardRoutes"));
app.use("/api/tasks", require("./routes/taskRoutes"));
app.use("/api/customer-requests", require("./routes/customerRequestRoutes"));
app.use("/api/compliance", require("./routes/complianceRoutes"));
app.use("/api/kot", require("./routes/kotRoutes"));
app.use("/api/analytics", require("./routes/analyticsRoutes"));


// Health check endpoints (both /health and /api/health for compatibility)
const healthRoutes = require("./routes/healthRoutes");
app.use("/api", healthRoutes);
app.get("/health", (req, res) => {
  res.json({ 
    status: "healthy", 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development'
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
  // Client connected - removed verbose logging

  // Join cafe room
  socket.on("join:cafe", (cafeId) => {
    if (cafeId) {
      const room = `cafe:${cafeId}`;
      socket.join(room);
    }
  });

  // Join franchise room
  socket.on("join:franchise", (franchiseId) => {
    if (franchiseId) {
      const room = `franchise:${franchiseId}`;
      socket.join(room);
    }
  });

  // Join role-based room
  socket.on("join:role", (role) => {
    if (role) {
      const room = `role:${role}`;
      socket.join(room);
    }
  });

  // Join cart room (for mobile app users)
  socket.on("join:cart", (cartId) => {
    if (cartId) {
      const room = `cart:${cartId}`;
      socket.join(room);
      // Also join cafe room for backward compatibility
      socket.emit("join:cafe", cartId);
    }
  });

  // Join kiosk room (for mobile app users)
  socket.on("join:kiosk", (kioskId) => {
    if (kioskId) {
      const room = `kiosk:${kioskId}`;
      socket.join(room);
    }
  });

  socket.on("disconnect", (reason) => {
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

    const PORT = process.env.PORT || 5001;
    // CRITICAL: Bind to 0.0.0.0 for EC2 compatibility (allows external connections)
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`📡 Environment: ${process.env.NODE_ENV || 'development'}`);
      if (process.env.NODE_ENV === 'production') {
        console.log(`🌐 Server accessible at: http://0.0.0.0:${PORT}`);
      }
    });
  } catch (error) {
    process.exit(1);
  }
};

startServer();

module.exports = { app, server, io };
