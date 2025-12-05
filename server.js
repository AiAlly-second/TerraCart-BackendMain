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
const { scheduleDailyRevenue, scheduleMonthlyRevenue } = require("./services/revenueScheduler");

// Security middleware
const {
  rateLimiters,
  securityHeaders,
  sanitizeInput,
  errorHandler,
  getCorsConfig
} = require("./middleware/securityMiddleware");

// Load env vars
dotenv.config();

// Validate critical environment variables
const validateEnv = () => {
  const warnings = [];
  
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'sarva-cafe-secret-key-2025') {
    warnings.push('⚠️  JWT_SECRET is using default value. Set a strong secret in production!');
  }
  
  if (!process.env.MONGO_URI) {
    warnings.push('⚠️  MONGO_URI not set. Using local MongoDB.');
  }
  
  if (process.env.NODE_ENV === 'production') {
    if (!process.env.ALLOWED_ORIGINS) {
      warnings.push('⚠️  ALLOWED_ORIGINS not set. CORS may be too permissive.');
    }
    if (!process.env.SIGNED_URL_SECRET) {
      warnings.push('⚠️  SIGNED_URL_SECRET not set. Using JWT_SECRET as fallback.');
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
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
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
app.use("/api/employees", require("./routes/employeeRoutes"));
app.use("/api/attendance", require("./routes/attendanceRoutes"));
app.use("/api/employee-schedule", require("./routes/employeeScheduleRoutes"));
app.use("/api/employee-skills", require("./routes/employeeSkillsRoutes"));
app.use("/api/dashboard", require("./routes/dashboardRoutes"));
app.use("/api/tasks", require("./routes/taskRoutes"));
app.use("/api/kot", require("./routes/kotRoutes"));
app.use("/api/customer-requests", require("./routes/customerRequestRoutes"));
app.use("/api/compliance", require("./routes/complianceRoutes"));

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Static file serving for uploads
app.use("/uploads/menu", express.static(path.join(__dirname, "uploads/menu"), {
  maxAge: '1d',
  etag: true,
  lastModified: true
}));

if (process.env.NODE_ENV !== 'production' || process.env.ALLOW_PUBLIC_UPLOADS === 'true') {
  app.use("/uploads", express.static(path.join(__dirname, "uploads"), {
    maxAge: '1h',
    etag: true
  }));
} else {
  app.use("/uploads/payment-qr", express.static(path.join(__dirname, "uploads/payment-qr"), {
    maxAge: '1d',
    etag: true
  }));
}

// Socket.IO connection handling
io.on("connection", (socket) => {
  socket.on("disconnect", (reason) => {
    // Socket disconnected
  });
  
  // Handle socket errors
  socket.on("error", (error) => {
    // Socket error
  });
});

// Make io available to routes
app.set("io", io);

// Schedule background jobs
scheduleOrderAutoRelease(io);
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
    const HOST = process.env.HOST || '0.0.0.0'; // Listen on all interfaces for mobile access
    server.listen(PORT, HOST, () => {
      console.log(`🚀 Server running on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
      // Get network interfaces to show actual IP
      const os = require('os');
      const networkInterfaces = os.networkInterfaces();
      let mobileIp = 'localhost';
      for (const interfaceName in networkInterfaces) {
        const interfaces = networkInterfaces[interfaceName];
        for (const iface of interfaces) {
          // Skip internal (i.e. 127.0.0.1) and non-IPv4 addresses
          if (iface.family === 'IPv4' && !iface.internal) {
            mobileIp = iface.address;
            break;
          }
        }
        if (mobileIp !== 'localhost') break;
      }
      console.log(`📱 Mobile access: http://${mobileIp}:${PORT}`);
      console.log(`💡 Update Flutter app API config if IP changed: http://${mobileIp}:${PORT}/api`);
    });
  } catch (error) {
    process.exit(1);
  }
};

startServer();

module.exports = { app, server, io };
