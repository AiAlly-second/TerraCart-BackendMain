const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const path = require("path");
const cors = require("cors");
const dotenv = require("dotenv");
const connectDB = require("./config/db");
const { scheduleOrderAutoRelease } = require("./services/orderAutoRelease");
const { scheduleDailyRevenue, scheduleMonthlyRevenue } = require("./services/revenueScheduler");

// Load env vars
dotenv.config();

// Connect to MongoDB
connectDB();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*", // Allow all origins or specify your frontend URL here
    methods: ["GET", "POST"]
  }
});

app.set("io", io);

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use("/api/users", require("./routes/userRoutes"));
app.use("/api/orders", require("./routes/orderRoutes")); // uses controller inside routes
app.use("/api/admin", require("./routes/adminRoutes")); // admin authentication routes
app.use("/api/tables", require("./routes/tableRoutes"));
app.use("/api/waitlist", require("./routes/waitlistRoutes"));
app.use("/api/menu", require("./routes/menuRoutes"));
app.use("/api/payments", require("./routes/paymentRoutes"));
app.use("/api/payment-qr", require("./routes/paymentQrRoutes"));
console.log("✅ Payment QR routes registered at /api/payment-qr");
app.use("/api/revenue", require("./routes/revenueRoutes"));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Background jobs
scheduleOrderAutoRelease(io);
scheduleDailyRevenue();
scheduleMonthlyRevenue();

// Health check route
app.get("/", (req, res) => {
  res.status(200).send("Sarva Cafe Node.js Backend is Live 🚀");
});

// Socket.IO connection handler (optional for logging)
io.on("connection", (socket) => {
  console.log("Admin panel connected via socket:", socket.id);
  socket.on("disconnect", () => {
    console.log("Socket disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 5001;
server.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
