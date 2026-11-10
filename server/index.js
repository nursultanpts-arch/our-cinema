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
const ROOM_RECONNECT_GRACE_MS = 2 * 60 * 1000;

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
const emptyRoomTimeouts = new Map();

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function cleanName(value) {
  if (typeof value !== "string") return "Гость";
  const name = value.trim().replace(/\s+/g, " ").slice(0, 24);
  return name || "Гость";
}

function cleanOwnerToken(value) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, 128);
}

function getSocketRoom(socket) {
  return [...socket.rooms].find((room) => room !== socket.id);
}

function sendRoomUsers(roomCode) {
  const room = rooms.get(roomCode);
  if (room) io.to(roomCode).emit("room-users-updated", room.users);
}

function cancelRoomDeletion(roomCode) {
  const timeout = emptyRoomTimeouts.get(roomCode);
  if (timeout) clearTimeout(timeout);
  emptyRoomTimeouts.delete(roomCode);
}

function isRoomOwner(socket, room) {
  return Boolean(room && room.ownerId === socket.id);
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

app.delete("/api/videos/:id", (req, res) => {
  const videoId = req.params.id;
  const videos = readLibrary();
  const video = videos.find((item) => item.id === videoId);

  if (!video) {
    return res.status(404).json({ message: "Видео не найдено." });
  }

  const filePath = path.join(UPLOAD_DIR, path.basename(video.filename));

  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    const updatedVideos = videos.filter((item) => item.id !== videoId);
    saveLibrary(updatedVideos);

    for (const [roomCode, room] of rooms.entries()) {
      if (room.currentVideo?.id === videoId) {
        room.currentVideo = null;
        room.playback = { isPlaying: false, currentTime: 0 };
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
    const ownerToken = cleanOwnerToken(data?.ownerToken);

    if (!ownerToken) {
      if (typeof callback === "function") {
        callback({ success: false, message: "Не удалось подтвердить создателя комнаты." });
      }
      return;
    }

    let roomCode;
    do roomCode = generateRoomCode();
    while (rooms.has(roomCode));

    const room = {
      ownerId: socket.id,
      ownerToken,
      users: [{ id: socket.id, name }],
      playback: { isPlaying: false, currentTime: 0 },
      currentVideo: null,
      messages: []
    };

    rooms.set(roomCode, room);
    socket.join(roomCode);

    if (typeof callback === "function") {
      callback({
        success: true,
        roomCode,
        users: room.users,
        currentVideo: room.currentVideo,
        playback: room.playback,
        messages: room.messages,
        isOwner: true
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

    cancelRoomDeletion(code);

    const name = cleanName(data?.name);
    const suppliedOwnerToken = cleanOwnerToken(data?.ownerToken);

    if (suppliedOwnerToken && suppliedOwnerToken === room.ownerToken) {
      room.ownerId = socket.id;
    }

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
        currentVideo: room.currentVideo,
        messages: room.messages || [],
        isOwner: isRoomOwner(socket, room)
      });
    }

    sendRoomUsers(code);
    console.log(`Пользователь ${name} вошёл в комнату: ${code}`);
  });

  socket.on("select-video", (videoId, callback) => {
    const roomCode = getSocketRoom(socket);
    const room = roomCode ? rooms.get(roomCode) : null;

    if (!room) {
      if (typeof callback === "function") {
        callback({ success: false, message: "Сначала войди в комнату." });
      }
      return;
    }

    if (!isRoomOwner(socket, room)) {
      if (typeof callback === "function") {
        callback({ success: false, message: "Выбирать видео может только создатель комнаты." });
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

    room.currentVideo = publicVideo(video);
    room.playback = { isPlaying: false, currentTime: 0 };

    io.to(roomCode).emit("video-selected", room.currentVideo);
    io.to(roomCode).emit("playback-update", room.playback);

    if (typeof callback === "function") {
      callback({ success: true, video: room.currentVideo });
    }
  });

  socket.on("playback-update", (data) => {
    const roomCode = getSocketRoom(socket);
    const room = roomCode ? rooms.get(roomCode) : null;

    if (!room || !isRoomOwner(socket, room) || !data || typeof data !== "object") {
      return;
    }

    const nextPlayback = { ...room.playback };

    if (typeof data.isPlaying === "boolean") {
      nextPlayback.isPlaying = data.isPlaying;
    }

    if (typeof data.currentTime === "number" && Number.isFinite(data.currentTime)) {
      nextPlayback.currentTime = Math.max(0, data.currentTime);
    }

    room.playback = nextPlayback;
    socket.to(roomCode).emit("playback-update", room.playback);
  });

  socket.on("chat-message", (message) => {
    const roomCode = getSocketRoom(socket);
    if (!roomCode || !rooms.has(roomCode) || typeof message !== "string") return;

    const cleanMessage = message.trim().slice(0, 500);
    if (!cleanMessage) return;

    const room = rooms.get(roomCode);
    const user = room.users.find((item) => item.id === socket.id);

    const chatMessage = {
      userId: socket.id,
      name: user?.name || "Гость",
      message: cleanMessage,
      time: new Date().toISOString()
    };

    room.messages = room.messages || [];
    room.messages.push(chatMessage);

    if (room.messages.length > 100) {
      room.messages = room.messages.slice(-100);
    }

    io.to(roomCode).emit("chat-message", chatMessage);
  });

  socket.on("disconnect", () => {
    for (const [roomCode, room] of rooms.entries()) {
      const previousLength = room.users.length;
      room.users = room.users.filter((user) => user.id !== socket.id);

      if (room.users.length !== previousLength) {
        if (room.users.length === 0) {
          cancelRoomDeletion(roomCode);

          const timeout = setTimeout(() => {
            const currentRoom = rooms.get(roomCode);

            if (currentRoom && currentRoom.users.length === 0) {
              rooms.delete(roomCode);
              console.log(`Комната ${roomCode} удалена после ожидания повторного входа.`);
            }

            emptyRoomTimeouts.delete(roomCode);
          }, ROOM_RECONNECT_GRACE_MS);

          emptyRoomTimeouts.set(roomCode, timeout);
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