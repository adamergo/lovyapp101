const path = require("path");
const http = require("http");
const express = require("express");
const cookieParser = require("cookie-parser");
const cookie = require("cookie");
const { Server } = require("socket.io");

const { verifySocketToken } = require("./middleware/auth");
const { setIo } = require("./realtime");

const authRoutes = require("./routes/auth");
const uploadRoutes = require("./routes/upload");
const postRoutes = require("./routes/posts");
const storyRoutes = require("./routes/stories");
const snapRoutes = require("./routes/snaps");
const musicRoutes = require("./routes/music");
const messageRoutes = require("./routes/messages");
const notificationRoutes = require("./routes/notifications");
const userRoutes = require("./routes/users");
const settingsRoutes = require("./routes/settings");

const PROJECT_ROOT = path.join(__dirname, "..");
const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server);
setIo(io);

app.use(express.json());
app.use(cookieParser());

app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use("/media", express.static(PROJECT_ROOT));

app.use("/api/auth", authRoutes);
app.use("/api/upload", uploadRoutes);
app.use("/api/posts", postRoutes);
app.use("/api/stories", storyRoutes);
app.use("/api/snaps", snapRoutes);
app.use("/api/music", musicRoutes);
app.use("/api/messages", messageRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/users", userRoutes);
app.use("/api/settings", settingsRoutes);

app.use(express.static(PROJECT_ROOT));

app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found" });
  next();
});

io.use((socket, next) => {
  const rawCookie = socket.handshake.headers.cookie || "";
  const parsed = cookie.parse(rawCookie);
  const userId = verifySocketToken(parsed.token);
  if (!userId) return next(new Error("unauthorized"));
  socket.userId = userId;
  next();
});

io.on("connection", (socket) => {
  socket.join(`user:${socket.userId}`);
});

server.listen(PORT, () => {
  console.log(`LovyApp server running at http://localhost:${PORT}`);
});
