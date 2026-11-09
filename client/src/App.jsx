
import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import "./App.css";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://192.168.0.101:3001";

function App() {
  const [modal, setModal] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [userName, setUserName] = useState(() => localStorage.getItem("ourCinemaName") || "");
  const [roomUsers, setRoomUsers] = useState([]);
  const [activeRoomCode, setActiveRoomCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [connected, setConnected] = useState(false);
  const [messages, setMessages] = useState([]);
  const [message, setMessage] = useState("");
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [episode, setEpisode] = useState("1");
  const [videoUrl, setVideoUrl] = useState("");
  const [videoName, setVideoName] = useState("");
  const [videoError, setVideoError] = useState("");
  const [libraryVideos, setLibraryVideos] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [libraryError, setLibraryError] = useState("");

  const socketRef = useRef(null);
  const chatEndRef = useRef(null);
  const videoRef = useRef(null);
  const fileInputRef = useRef(null);
  const pendingPlaybackRef = useRef(null);

  useEffect(() => {
    const socket = io(SERVER_URL);
    socketRef.current = socket;

    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));

    socket.on("connect_error", () => {
      setConnected(false);
      setError("Не удалось подключиться к серверу.");
    });

    socket.on("room-users-updated", (users) => {
      setRoomUsers(Array.isArray(users) ? users : []);
    });

    socket.on("library-updated", () => {
      loadLibrary();
    });

    socket.on("video-selected", (video) => {
      setVideoUrl(video ? `${SERVER_URL}${video.url}` : "");
      setVideoName(video?.name || "");
      setVideoError("");
      setCurrentTime(0);
      setDuration(0);
      setIsPlaying(false);
      pendingPlaybackRef.current = {
        isPlaying: false,
        currentTime: 0,
        episode
      };

      if (videoRef.current) {
        videoRef.current.pause();
      }
    });

    socket.on("chat-message", (data) => {
      setMessages((old) => [...old, data]);
    });

    socket.on("playback-update", (data) => {
      if (typeof data.isPlaying === "boolean") {
        setIsPlaying(data.isPlaying);
      }

      if (typeof data.currentTime === "number") {
        setCurrentTime(data.currentTime);
      }

      if (data.episode !== undefined) {
        setEpisode(String(data.episode));
      }

      pendingPlaybackRef.current = data;
      applyRemotePlayback(data);
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    loadLibrary();
  }, []);

  async function loadLibrary() {
    try {
      const response = await fetch(`${SERVER_URL}/api/videos`);
      const data = await response.json();

      if (response.ok) {
        setLibraryVideos(Array.isArray(data.videos) ? data.videos : []);
      }
    } catch {
      setLibraryError("Не удалось загрузить видеотеку. Проверь подключение к серверу.");
    }
  }

  function applyRemotePlayback(data) {
    const video = videoRef.current;

    if (!video || video.readyState < 1) return;

    if (typeof data.currentTime === "number") {
      if (Math.abs(video.currentTime - data.currentTime) > 1.2) {
        video.currentTime = data.currentTime;
      }
    }

    if (data.isPlaying) {
      video.play().catch(() => {
        setVideoError("Нажми кнопку воспроизведения, чтобы запустить видео.");
      });
    } else {
      video.pause();
    }
  }

  function createRoom() {
    const socket = socketRef.current;
    const cleanName = userName.trim().replace(/\s+/g, " ").slice(0, 24);

    if (!cleanName) {
      setError("Введи свой никнейм.");
      return;
    }

    localStorage.setItem("ourCinemaName", cleanName);
    setUserName(cleanName);

    if (!socket?.connected) {
      setError("Сервер недоступен. Проверь, запущен ли он.");
      setModal("error");
      return;
    }

    setLoading(true);

    socket.emit("create-room", { name: cleanName }, (response) => {
      setLoading(false);

      if (!response?.success) {
        setError("Не удалось создать комнату.");
        setModal("error");
        return;
      }

      openRoom(response.roomCode, null, response.users, response.currentVideo);
      setModal("");
    });
  }

  function joinRoom() {
    const socket = socketRef.current;
    const code = roomCode.trim().toUpperCase();
    const cleanName = userName.trim().replace(/\s+/g, " ").slice(0, 24);

    if (!cleanName) {
      setError("Введи свой никнейм.");
      return;
    }

    localStorage.setItem("ourCinemaName", cleanName);
    setUserName(cleanName);

    if (!code) {
      setError("Введи код комнаты.");
      return;
    }

    if (!socket?.connected) {
      setError("Сервер недоступен. Проверь подключение.");
      return;
    }

    setLoading(true);

    socket.emit("join-room", code, { name: cleanName }, (response) => {
      setLoading(false);

      if (!response?.success) {
        setError(response?.message || "Комната не найдена.");
        return;
      }

      openRoom(response.roomCode, response.playback, response.users, response.currentVideo);
      setRoomCode("");
      setModal("");
    });
  }

  function openRoom(code, playback, users = [], currentVideo = null) {
    setActiveRoomCode(code);
    setMessages([]);
    setRoomUsers(Array.isArray(users) ? users : []);
    setVideoUrl(currentVideo ? `${SERVER_URL}${currentVideo.url}` : "");
    setVideoName(currentVideo?.name || "");
    setVideoError("");

    const initialPlayback = playback || {
      isPlaying: false,
      currentTime: 0,
      episode: 1
    };

    setIsPlaying(initialPlayback.isPlaying || false);
    setCurrentTime(initialPlayback.currentTime || 0);
    setEpisode(String(initialPlayback.episode || 1));

    pendingPlaybackRef.current = initialPlayback;
  }

  async function uploadVideo(event) {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) return;

    if (!file.type.startsWith("video/")) {
      setLibraryError("Выбери видеофайл.");
      setVideoError("Выбери видеофайл.");
      return;
    }

    const formData = new FormData();
    formData.append("video", file);

    setUploading(true);
    setLibraryError("");
    setVideoError("");

    try {
      const response = await fetch(`${SERVER_URL}/api/videos`, {
        method: "POST",
        body: formData
      });

      const data = await response.json();

      if (!response.ok || !data.video) {
        throw new Error(data.message || "Не удалось загрузить видео.");
      }

      setLibraryVideos((old) => [
        data.video,
        ...old.filter((item) => item.id !== data.video.id)
      ]);

      if (activeRoomCode) {
        selectLibraryVideo(data.video);
      }
    } catch (uploadError) {
      const message = uploadError.message || "Ошибка загрузки видео.";
      setLibraryError(message);
      setVideoError(message);
    } finally {
      setUploading(false);
    }
  }

  async function deleteVideo(video) {
    const confirmed = window.confirm(
      `Удалить видео "${video.name}"?\n\nФайл будет полностью удалён с сервера.`
    );

    if (!confirmed) return;

    setLibraryError("");

    try {
      const response = await fetch(
        `${SERVER_URL}/api/videos/${encodeURIComponent(video.id)}`,
        { method: "DELETE" }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || "Не удалось удалить видео.");
      }

      setLibraryVideos((old) =>
        old.filter((item) => item.id !== video.id)
      );
    } catch (deleteError) {
      setLibraryError(deleteError.message || "Ошибка удаления видео.");
    }
  }

  function selectLibraryVideo(video) {
    if (!video || !socketRef.current?.connected) {
      setVideoError("Нет соединения с сервером.");
      return;
    }

    socketRef.current.emit("select-video", video.id, (response) => {
      if (!response?.success) {
        setVideoError(response?.message || "Не удалось выбрать видео.");
      }
    });
  }

  function handleVideoLoaded() {
    const video = videoRef.current;

    if (!video) return;

    setDuration(Number.isFinite(video.duration) ? video.duration : 0);

    const pending = pendingPlaybackRef.current;

    if (pending) {
      applyRemotePlayback(pending);
    }
  }

  async function togglePlayback() {
    const video = videoRef.current;

    if (!videoUrl || !video) {
      setVideoError("Сначала выбери видеофайл.");
      return;
    }

    setVideoError("");

    if (video.paused) {
      try {
        await video.play();

        setIsPlaying(true);

        updatePlayback({
          isPlaying: true,
          currentTime: video.currentTime,
          episode
        });
      } catch {
        setVideoError("Не удалось запустить видео.");
      }
    } else {
      video.pause();

      setIsPlaying(false);

      updatePlayback({
        isPlaying: false,
        currentTime: video.currentTime,
        episode
      });
    }
  }

  function seekVideo(value) {
    const time = Number(value);
    const video = videoRef.current;

    if (!video || !videoUrl) return;

    video.currentTime = time;
    setCurrentTime(time);

    updatePlayback({
      currentTime: time,
      isPlaying: !video.paused,
      episode
    });
  }

  function handleTimeUpdate() {
    const video = videoRef.current;

    if (video) {
      setCurrentTime(video.currentTime);
    }
  }

  function changeEpisode(value) {
    setEpisode(value);
    setCurrentTime(0);
    setIsPlaying(false);

    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.currentTime = 0;
    }

    updatePlayback({
      episode: value,
      currentTime: 0,
      isPlaying: false
    });
  }

  function updatePlayback(data) {
    socketRef.current?.emit("playback-update", data);
  }

  function sendMessage(event) {
    event.preventDefault();

    const cleanMessage = message.trim();

    if (!cleanMessage || !socketRef.current?.connected) return;

    socketRef.current.emit("chat-message", cleanMessage);
    setMessage("");
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds)) return "00:00";

    const minutes = Math.floor(seconds / 60);
    const remaining = Math.floor(seconds % 60);

    return `${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
  }

  function copyCode() {
    navigator.clipboard.writeText(activeRoomCode).catch(() => {
      setError("Не удалось скопировать код.");
    });
  }

  function closeModal() {
    setModal("");
    setError("");
  }

  if (activeRoomCode) {
    return (
      <div className="app room-page">
        <header className="header room-header">
          <a className="logo" href="#" onClick={(event) => event.preventDefault()}>
            OUR<span> CINEMA</span>
            <div className="logo-dot"></div>
          </a>

          <div className="room-header-info">
            <span className="connection-dot"></span>
            {connected ? "Сервер подключён" : "Нет соединения"}
          </div>

          <button className="header-button" onClick={copyCode}>
            Код: {activeRoomCode}
          </button>
        </header>

        <main className="room-layout">
          <section className="room-main">
            <div className="room-title">
              <div>
                <span className="section-label">YOUR PRIVATE ROOM</span>
                <h1>Совместный просмотр</h1>
              </div>

              <div className="room-users">
                <div className="room-user-avatars">
                  {roomUsers.slice(0, 4).map((user) => (
                    <span className="user-avatar" key={user.id} title={user.name}>
                      {(user.name || "Г").charAt(0).toUpperCase()}
                    </span>
                  ))}
                </div>

                <div className="room-users-info">
                  <strong>{roomUsers.length} участника</strong>
                  <span className="room-user-names">
                    {roomUsers.map((user) => user.name).join(" · ")}
                  </span>
                </div>
              </div>
            </div>

            <div className="video-player">
              {videoUrl ? (
                <video
                  ref={videoRef}
                  src={videoUrl}
                  onLoadedMetadata={handleVideoLoaded}
                  onTimeUpdate={handleTimeUpdate}
                  onEnded={() => {
                    setIsPlaying(false);
                    updatePlayback({
                      isPlaying: false,
                      currentTime: duration,
                      episode
                    });
                  }}
                  style={{
                    width: "100%",
                    aspectRatio: "16 / 9",
                    display: "block",
                    background: "#000",
                    objectFit: "contain"
                  }}
                />
              ) : (
                <div className="video-placeholder">
                  <div className="play-symbol">▶</div>
                  <h2>OUR CINEMA</h2>
                  <p>Выбери видеофайл для просмотра</p>
                  <span>Поддерживаются видеофайлы с твоего компьютера</span>
                </div>
              )}

              <div
                style={{
                  padding: "12px 16px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "12px",
                  flexWrap: "wrap"
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: "13px", color: "#aaa" }}>
                    Текущий видеофайл
                  </div>

                  <div
                    style={{
                      fontSize: "14px",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap"
                    }}
                  >
                    {videoName || "Файл не выбран"}
                  </div>
                </div>

                <button
                  className="secondary-button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                >
                  {uploading ? "Загрузка..." : "Загрузить видео"}
                </button>
              </div>

              {videoError && (
                <p style={{ color: "#ff7777", padding: "0 16px 10px" }}>
                  {videoError}
                </p>
              )}

              <div className="player-controls">
                <button className="play-button" onClick={togglePlayback}>
                  {isPlaying ? "Ⅱ" : "▶"}
                </button>

                <span className="player-time">
                  {formatTime(currentTime)}
                </span>

                <input
                  className="timeline"
                  type="range"
                  min="0"
                  max={duration || 1}
                  step="0.1"
                  value={Math.min(currentTime, duration || 1)}
                  onChange={(event) => seekVideo(event.target.value)}
                  disabled={!videoUrl}
                />

                <span className="player-time">
                  {formatTime(duration)}
                </span>
              </div>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept="video/mp4,video/webm,video/quicktime,video/x-matroska,video/*"
              onChange={uploadVideo}
              style={{ display: "none" }}
            />

            <div className="room-library-panel">
              <div className="room-library-heading">
                <div>
                  <span className="section-label">YOUR VIDEO COLLECTION</span>
                  <h2>Моя видеотека</h2>
                </div>

                <span>{libraryVideos.length} файлов</span>
              </div>

              {libraryVideos.length > 0 ? (
                <div className="room-library-list">
                  {libraryVideos.map((video) => (
                    <div className="library-video-item" key={video.id}>
                      <span className="library-video-icon">▶</span>

                      <span className="library-video-name">
                        {video.name}
                      </span>

                      <button
                        className="library-video-action"
                        onClick={() => selectLibraryVideo(video)}
                      >
                        Выбрать
                      </button>

                      <button
                        onClick={() => deleteVideo(video)}
                        style={{
                          background: "transparent",
                          border: "1px solid #713b3b",
                          color: "#ff7777",
                          padding: "7px 10px",
                          borderRadius: "6px",
                          cursor: "pointer"
                        }}
                      >
                        Удалить
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="library-empty">
                  Пока нет видео. Загрузи первый файл.
                </p>
              )}

              {libraryError && (
                <p className="library-error">{libraryError}</p>
              )}
            </div>

            <div className="episode-panel">
              <div>
                <span className="section-label">NOW WATCHING</span>
                <h2>Бесстыжие</h2>
                <p>Выберите эпизод для совместного просмотра</p>
              </div>

              <div className="episode-select">
                <label htmlFor="episode">Серия</label>

                <select
                  id="episode"
                  value={episode}
                  onChange={(event) => changeEpisode(event.target.value)}
                >
                  {Array.from({ length: 12 }, (_, index) => (
                    <option key={index + 1} value={String(index + 1)}>
                      Серия {index + 1}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="room-note">
              <span>ⓘ</span>
              Видео загружается один раз в общую библиотеку сервера. После выбора оно автоматически появляется у всех участников.
            </div>
          </section>

          <aside className="chat-panel">
            <div className="chat-heading">
              <div>
                <span className="section-label">YOUR SPACE</span>
                <h2>Общий чат</h2>
              </div>

              <span className="chat-status">● В сети</span>
            </div>

            <div className="chat-messages">
              {messages.length === 0 && (
                <div className="chat-empty">
                  <span>✉</span>
                  <p>Пока сообщений нет</p>
                  <small>Начните общение прямо сейчас</small>
                </div>
              )}

              {messages.map((item, index) => (
                <div className="chat-message" key={`${item.time}-${index}`}>
                  <div className="message-avatar">
                    {(item.name || "Г").charAt(0).toUpperCase()}
                  </div>

                  <div className="message-content">
                    <div className="message-meta">
                      <strong>{item.name || "Гость"}</strong>

                      <span>
                        {item.time
                          ? new Date(item.time).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit"
                            })
                          : ""}
                      </span>
                    </div>

                    <p>{item.message}</p>
                  </div>
                </div>
              ))}

              <div ref={chatEndRef}></div>
            </div>

            <form className="chat-form" onSubmit={sendMessage}>
              <input
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder="Написать сообщение..."
                maxLength={500}
              />

              <button type="submit" disabled={!message.trim()}>
                ➤
              </button>
            </form>

            <div className="chat-footer">
              Сообщения видны участникам этой комнаты
            </div>
          </aside>
        </main>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="header">
        <a className="logo" href="#">
          OUR<span> CINEMA</span>
          <div className="logo-dot"></div>
        </a>

        <nav>
          <a href="#home">Главная</a>
          <a href="#library">Библиотека</a>
          <a href="#about">О проекте</a>
        </nav>

        <button
          className="header-button"
          onClick={() => {
            setError("");
            setModal("join");
          }}
        >
          Войти в комнату
        </button>
      </header>

      <main>
        <section className="hero" id="home">
          <div className="hero-content">
            <div className="eyebrow">
              <span></span> YOUR PRIVATE CINEMA
            </div>

            <h1>
              Кино лучше,<br />
              когда <span>вместе.</span>
            </h1>

            <p>
              Создайте свою комнату, пригласите близкого человека
              и смотрите любимые сериалы одновременно.
            </p>

            <div className="hero-buttons">
              <button
                className="primary-button"
                onClick={() => {
                  setError("");
                  setModal("create");
                }}
                disabled={loading}
              >
                <span>▶</span>
                {loading ? "Создание..." : "Создать комнату"}
              </button>

              <button
                className="secondary-button"
                onClick={() => {
                  setError("");
                  setModal("join");
                }}
              >
                Присоединиться
              </button>
            </div>

            <div className="hero-info">
              <div className="avatars">
                <span>U</span>
                <span>♥</span>
              </div>

              <div>
                <strong>Только вы вдвоём</strong>
                <small>Ваше личное пространство</small>
              </div>
            </div>
          </div>

          <div className="hero-art">
            <div className="poster">
              <div className="poster-top">OUR CINEMA ORIGINAL</div>

              <div className="poster-main">
                <span>SHAME</span>
                <span>LESS</span>
              </div>

              <div className="poster-bottom">
                <span>СЕРИАЛ В НАШЕЙ БИБЛИОТЕКЕ</span>
                <strong>БЕСТЫЖИЕ</strong>
              </div>

              <div className="poster-number">01</div>
            </div>

            <div className="art-glow"></div>
          </div>
        </section>

        <section className="library" id="library">
          <div className="section-heading">
            <div>
              <span className="section-label">YOUR COLLECTION</span>
              <h2>Ваша библиотека</h2>
              <p>Фильмы и сериалы, которые можно смотреть вместе.</p>
            </div>

            <div className="library-actions">
              <span className="library-count">
                {libraryVideos.length} ВИДЕО
              </span>

              <button
                className="secondary-button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
              >
                {uploading ? "Загрузка..." : "+ Добавить видео"}
              </button>
            </div>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept="video/mp4,video/webm,video/quicktime,video/x-matroska,video/*"
            onChange={uploadVideo}
            style={{ display: "none" }}
          />

          {libraryError && (
            <p className="library-error">{libraryError}</p>
          )}

          {libraryVideos.length > 0 && (
            <div className="home-video-library">
              {libraryVideos.map((video) => (
                <div className="home-video-item" key={video.id}>
                  <span className="home-video-icon">▶</span>

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <strong>{video.name}</strong>
                    <small>{video.sizeLabel}</small>
                  </div>

                  <button
                    onClick={() => deleteVideo(video)}
                    style={{
                      background: "transparent",
                      border: "1px solid #713b3b",
                      color: "#ff7777",
                      padding: "7px 10px",
                      borderRadius: "6px",
                      cursor: "pointer",
                      flexShrink: 0
                    }}
                  >
                    Удалить
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="series-card">
            <div className="series-cover">
              <div className="cover-decoration">S</div>
              <div className="cover-title">SHAMELESS</div>
              <div className="cover-subtitle">БЕСТЫЖИЕ</div>
            </div>

            <div className="series-details">
              <span className="series-tag">НАША КОЛЛЕКЦИЯ</span>
              <h3>Бесстыжие</h3>

              <div className="series-meta">
                <span>2011–2021</span>
                <span>•</span>
                <span>Комедия / Драма</span>
              </div>

              <p>
                История большой семьи Галлагеров,
                их жизни, приключений и непростых отношений.
              </p>

              <button
                className="watch-button"
                onClick={() => setModal("series")}
              >
                Смотреть сериал <span>→</span>
              </button>
            </div>
          </div>
        </section>

        <section className="bottom-section" id="about">
          <div>
            <span className="section-label">MADE FOR TWO</span>
            <h2>Ваш вечер. Ваше кино.</h2>
          </div>

          <p>
            Смотрите вместе, общайтесь в чате и наслаждайтесь
            каждым моментом независимо от расстояния.
          </p>
        </section>
      </main>

      <footer>
        <div className="logo">OUR<span> CINEMA</span></div>
        <span>MADE FOR TWO ♥</span>
        <span>© 2026 OUR CINEMA</span>
      </footer>

      {modal && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <button className="close-modal" onClick={closeModal}>
              ×
            </button>

            {modal === "create" && (
              <>
                <div className="modal-icon">▶</div>
                <h2>Создать комнату</h2>
                <p>Придумай никнейм, который увидят остальные участники.</p>

                <input
                  className="name-input"
                  value={userName}
                  onChange={(event) => setUserName(event.target.value)}
                  placeholder="Твой никнейм"
                  maxLength={24}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") createRoom();
                  }}
                />

                {error && <small className="form-error">{error}</small>}

                <button
                  className="primary-button modal-button"
                  onClick={createRoom}
                  disabled={loading}
                >
                  {loading ? "Создание..." : "Создать комнату"}
                </button>
              </>
            )}

            {modal === "join" && (
              <>
                <div className="modal-icon">↗</div>
                <h2>Присоединиться</h2>
                <p>Введи никнейм и код комнаты, который тебе отправили.</p>

                <input
                  className="name-input"
                  value={userName}
                  onChange={(event) => setUserName(event.target.value)}
                  placeholder="Твой никнейм"
                  maxLength={24}
                />

                <input
                  value={roomCode}
                  onChange={(event) =>
                    setRoomCode(event.target.value.toUpperCase())
                  }
                  placeholder="Например, A7K92B"
                  maxLength={6}
                />

                {error && <small className="form-error">{error}</small>}

                <button
                  className="primary-button modal-button"
                  onClick={joinRoom}
                  disabled={loading}
                >
                  {loading ? "Подключение..." : "Подключиться"}
                </button>
              </>
            )}

            {modal === "error" && (
              <>
                <div className="modal-icon">!</div>
                <h2>Ошибка подключения</h2>
                <p>{error}</p>

                <button
                  className="primary-button modal-button"
                  onClick={closeModal}
                >
                  Понятно
                </button>
              </>
            )}

            {modal === "series" && (
              <>
                <div className="modal-icon">▶</div>
                <h2>Бесстыжие</h2>
                <p>
                  Добавь видеофайл, на который у тебя есть права,
                  в раздел «Моя видеотека». Для сериалов можно
                  подключать только легальные источники воспроизведения.
                </p>

                <button
                  className="primary-button modal-button"
                  onClick={closeModal}
                >
                  Понятно
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
