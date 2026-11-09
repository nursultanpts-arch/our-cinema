
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3001;
const UPLOAD_DIR = path.join(__dirname, "uploads");
const DATA_DIR = path.join(__dirname, "data");
const LIBRARY_FILE = path.join(DATA_DIR, "library.json");
const MAX_VIDEO_SIZE = 2 * 1024 * 1024 * 1024;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

function readLibrary() {
  try {
    if (!fs.existsSync(LIBRARY_FILE)) return [];
    const data = JSON.parse(fs.readFileSync(LIBRARY_FILE, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveLibrary(videos) {
  fs.writeFileSync(LIBRARY_FILE, JSON.stringify(videos, null, 2), "utf8");
}

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} ГБ`;
}

function publicVideo(video) {
  return {
    id: video.id,
    name: video.name,
    url: `/uploads/${encodeURIComponent(video.filename)}`,
    size: video.size,
    sizeLabel: formatSize(video.size),
    uploadedAt: video.uploadedAt
  };
}

const storage = multer.diskStorage({
  destination: (req, file, callback) => callback(null, UPLOAD_DIR),
  filename: (req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase().slice(0, 12) || ".mp4";
    callback(null, `${crypto.randomUUID()}${extension}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_VIDEO_SIZE },
  fileFilter: (req, file, callback) => {
    if (!file.mimetype || !file.mimetype.startsWith("video/")) {
      return callback(new Error("Можно загружать только видеофайлы."));
    }
    callback(null, true);
  }
});

app.use(cors({ origin: true }));
app.use(express.json());
app.use("/uploads", express.static(UPLOAD_DIR, { acceptRanges: true, maxAge: "1h" }));

const io = new Server(server, {
  cors: {
    origin: true,
    methods: ["GET", "POST", "DELETE"]
  }
});

const rooms = new Map();

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function cleanName(value) {
  if (typeof value !== "string") return "Гость";
  const name = value.trim().replace(/\s+/g, " ").slice(0, 24);
  return name || "Гость";
}

function getSocketRoom(socket) {
  return [...socket.rooms].find((room) => room !== socket.id);
}

function sendRoomUsers(roomCode) {
  const room = rooms.get(roomCode);
  if (room) io.to(roomCode).emit("room-users-updated", room.users);
}

app.get("/", (req, res) => {
  res.json({ status: "OUR CINEMA server is running" });
});

app.get("/api/videos", (req, res) => {
  const videos = readLibrary()
    .filter((video) => fs.existsSync(path.join(UPLOAD_DIR, video.filename)))
    .map(publicVideo)
    .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));

  res.json({ videos });
});

app.post("/api/videos", (req, res) => {
  upload.single("video")(req, res, (error) => {
    if (error) {
      const message = error.code === "LIMIT_FILE_SIZE"
        ? "Файл слишком большой. Максимальный размер — 2 ГБ."
        : error.message || "Не удалось загрузить файл.";

      return res.status(400).json({ message });
    }

    if (!req.file) {
      return res.status(400).json({ message: "Файл не получен." });
    }

    const videos = readLibrary();

    const video = {
      id: crypto.randomUUID(),
      name: path.basename(req.file.originalname).slice(0, 180),
      filename: req.file.filename,
      size: req.file.size,
      uploadedAt: new Date().toISOString()
    };

    videos.push(video);
    saveLibrary(videos);

    io.emit("library-updated");

    res.status(201).json({ video: publicVideo(video) });
  });
});

// Удаление видео из библиотеки и с диска сервера
app.delete("/api/videos/:id", (req, res) => {
  const videoId = req.params.id;
  const videos = readLibrary();
  const video = videos.find((item) => item.id === videoId);

  if (!video) {
    return res.status(404).json({ message: "Видео не найдено." });
  }

  const filePath = path.join(UPLOAD_DIR, path.basename(video.filename));

  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    const updatedVideos = videos.filter((item) => item.id !== videoId);
    saveLibrary(updatedVideos);

    // Если удалённое видео сейчас выбрано в комнате,
    // очищаем его у всех участников.
    for (const [roomCode, room] of rooms.entries()) {
      if (room.currentVideo?.id === videoId) {
        room.currentVideo = null;
        room.playback = {
          isPlaying: false,
          currentTime: 0,
          episode: 1
        };

        io.to(roomCode).emit("video-selected", null);
        io.to(roomCode).emit("playback-update", room.playback);
      }
    }

    io.emit("library-updated");

    res.json({ success: true, message: "Видео успешно удалено." });
  } catch (error) {
    console.error("Ошибка удаления видео:", error);
    res.status(500).json({ message: "Не удалось удалить видео с сервера." });
  }
});

io.on("connection", (socket) => {
  console.log("Пользователь подключился:", socket.id);

  socket.on("create-room", (data, callback) => {
    const name = cleanName(data?.name);
    let roomCode;

    do roomCode = generateRoomCode();
    while (rooms.has(roomCode));

    const room = {
      users: [{ id: socket.id, name }],
      playback: { isPlaying: false, currentTime: 0, episode: 1 },
      currentVideo: null
    };

    rooms.set(roomCode, room);
    socket.join(roomCode);

    if (typeof callback === "function") {
      callback({
        success: true,
        roomCode,
        users: room.users,
        currentVideo: room.currentVideo
      });
    }

    sendRoomUsers(roomCode);
    console.log(`Создана комната ${roomCode}. Владелец: ${name}`);
  });

  socket.on("join-room", (roomCode, data, callback) => {
    const code = String(roomCode || "").trim().toUpperCase();
    const room = rooms.get(code);

    if (!room) {
      if (typeof callback === "function") {
        callback({ success: false, message: "Комната не найдена" });
      }
      return;
    }

    const name = cleanName(data?.name);

    if (!room.users.some((user) => user.id === socket.id)) {
      room.users.push({ id: socket.id, name });
    }

    socket.join(code);

    if (typeof callback === "function") {
      callback({
        success: true,
        roomCode: code,
        playback: room.playback,
        users: room.users,
        currentVideo: room.currentVideo
      });
    }

    sendRoomUsers(code);
    console.log(`Пользователь ${name} вошёл в комнату: ${code}`);
  });

  socket.on("select-video", (videoId, callback) => {
    const roomCode = getSocketRoom(socket);

    if (!roomCode || !rooms.has(roomCode)) {
      if (typeof callback === "function") {
        callback({ success: false, message: "Сначала войди в комнату." });
      }
      return;
    }

    const video = readLibrary().find((item) => item.id === videoId);

    if (!video || !fs.existsSync(path.join(UPLOAD_DIR, video.filename))) {
      if (typeof callback === "function") {
        callback({ success: false, message: "Видео не найдено в библиотеке." });
      }
      return;
    }

    const room = rooms.get(roomCode);
    room.currentVideo = publicVideo(video);
    room.playback = { isPlaying: false, currentTime: 0, episode: 1 };

    io.to(roomCode).emit("video-selected", room.currentVideo);
    io.to(roomCode).emit("playback-update", room.playback);

    if (typeof callback === "function") {
      callback({ success: true, video: room.currentVideo });
    }
  });

  socket.on("playback-update", (data) => {
    const roomCode = getSocketRoom(socket);

    if (!roomCode || !rooms.has(roomCode) || !data || typeof data !== "object") {
      return;
    }

    const room = rooms.get(roomCode);
    room.playback = { ...room.playback, ...data };

    socket.to(roomCode).emit("playback-update", room.playback);
  });

  socket.on("chat-message", (message) => {
    const roomCode = getSocketRoom(socket);

    if (!roomCode || !rooms.has(roomCode) || typeof message !== "string") {
      return;
    }

    const cleanMessage = message.trim().slice(0, 500);

    if (!cleanMessage) return;

    const room = rooms.get(roomCode);
    const user = room.users.find((item) => item.id === socket.id);

    io.to(roomCode).emit("chat-message", {
      userId: socket.id,
      name: user?.name || "Гость",
      message: cleanMessage,
      time: new Date().toISOString()
    });
  });

  socket.on("disconnect", () => {
    for (const [roomCode, room] of rooms.entries()) {
      const previousLength = room.users.length;

      room.users = room.users.filter((user) => user.id !== socket.id);

      if (room.users.length !== previousLength) {
        if (room.users.length === 0) {
          rooms.delete(roomCode);
        } else {
          sendRoomUsers(roomCode);
        }
      }
    }

    console.log("Пользователь отключился:", socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`OUR CINEMA server запущен: http://localhost:${PORT}`);
});
