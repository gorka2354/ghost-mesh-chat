// === Ghost Mesh Chat — app.js ===

// --- Элементы DOM ---
const myIdEl = document.getElementById('my-id');
const myIdCopyEl = document.getElementById('my-id-copy');
const peerIdInput = document.getElementById('peer-id-input');
const connectBtn = document.getElementById('connect-btn');
const createRoomBtn = document.getElementById('create-room-btn');
const connectScreen = document.getElementById('connect-screen');
const roomScreen = document.getElementById('room-screen');
const inviteLinkEl = document.getElementById('invite-link');
const copyLinkBtn = document.getElementById('copy-link-btn');
const chatScreen = document.getElementById('chat-screen');
const roomIdDisplay = document.getElementById('room-id-display');
const onlineCountEl = document.getElementById('online-count');
const messagesEl = document.getElementById('messages');
const msgInput = document.getElementById('msg-input');
const sendBtn = document.getElementById('send-btn');
const statusEl = document.getElementById('status');
const typingIndicator = document.getElementById('typing-indicator');
const typingNick = document.getElementById('typing-nick');
const typewriterToggle = document.getElementById('typewriter-toggle');
const lockIcon = document.getElementById('lock-icon');
const debugToggle = document.getElementById('debug-toggle');
const debugPanel = document.getElementById('debug-panel');
const debugLog = document.getElementById('debug-log');
const signalStatusEl = document.getElementById('signal-status');

// --- Debug-логирование ---
function dlog(msg, level = 'info') {
  // В консоль всегда
  console.log('[ghost-mesh]', msg);

  if (!debugLog) return;
  const line = document.createElement('div');
  line.className = 'debug-line' + (level === 'error' ? ' debug-error' : level === 'warn' ? ' debug-warn' : level === 'ok' ? ' debug-ok' : '');
  const time = new Date().toTimeString().substring(0, 8);
  line.innerHTML = '<span class="debug-time">' + time + '</span>' + escapeHtmlSimple(msg);
  debugLog.appendChild(line);
  debugPanel.scrollTop = debugPanel.scrollHeight;
}

// Простой escapeHtml без зависимости от DOM (для раннего вызова)
function escapeHtmlSimple(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Перехватываем глобальные ошибки
window.addEventListener('error', (e) => {
  dlog('JS ERROR: ' + e.message + ' @ ' + e.filename + ':' + e.lineno, 'error');
});

window.addEventListener('unhandledrejection', (e) => {
  dlog('PROMISE ERROR: ' + e.reason, 'error');
});

// --- Генерация ID ---
function generateId() {
  const hex = Math.random().toString(16).substring(2, 6);
  return 'ghost-' + hex;
}

function generateRoomId() {
  const hex = Math.random().toString(16).substring(2, 8);
  return 'room-' + hex;
}

// Загружаем никнейм из localStorage или генерируем новый
function loadOrCreateNickname() {
  try {
    const saved = localStorage.getItem('ghost-nickname');
    if (saved) return saved;
  } catch (e) {}
  const nick = generateId();
  try { localStorage.setItem('ghost-nickname', nick); } catch (e) {}
  return nick;
}

function resetNickname() {
  const nick = generateId();
  try { localStorage.setItem('ghost-nickname', nick); } catch (e) {}
  return nick;
}

// --- Состояние ---
let peer = null;
let isHost = false;
let roomId = null;
let myNickname = loadOrCreateNickname();
// peerId -> { conn, nickname, sharedKey (CryptoKey), publicKeyRaw }
const connections = new Map();

// Настройки
let typewriterEnabled = true;
const FILE_MAX_SIZE = 50 * 1024 * 1024;
const CHUNK_SIZE = 16000;

// --- IndexedDB — локальное хранилище сообщений ---
const DB_NAME = 'ghost-mesh-db';
const DB_VERSION = 2;
let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const database = e.target.result;
      // v1: messages
      if (!database.objectStoreNames.contains('messages')) {
        const store = database.createObjectStore('messages', { keyPath: 'msgId' });
        store.createIndex('chatId', 'chatId', { unique: false });
        store.createIndex('timestamp', 'timestamp', { unique: false });
      }
      // v2: rooms (список чатов)
      if (!database.objectStoreNames.contains('rooms')) {
        database.createObjectStore('rooms', { keyPath: 'chatId' });
      }
    };
    req.onsuccess = (e) => {
      db = e.target.result;
      dlog('IndexedDB opened (v' + DB_VERSION + ')', 'ok');
      resolve(db);
    };
    req.onerror = (e) => {
      dlog('IndexedDB error: ' + e.target.error, 'error');
      reject(e.target.error);
    };
  });
}

// --- Rooms store: список чатов ---

function saveRoom(chatId, data) {
  if (!db || !chatId) return;
  try {
    const tx = db.transaction('rooms', 'readwrite');
    const store = tx.objectStore('rooms');
    const getReq = store.get(chatId);
    getReq.onsuccess = () => {
      const existing = getReq.result || {};
      store.put(Object.assign(existing, data, { chatId: chatId }));
    };
  } catch (e) {
    dlog('saveRoom error: ' + e.message, 'error');
  }
}

function updateRoomLastMessage(chatId, text, author) {
  if (!db || !chatId) return;
  try {
    const tx = db.transaction('rooms', 'readwrite');
    const store = tx.objectStore('rooms');
    const getReq = store.get(chatId);
    getReq.onsuccess = () => {
      const room = getReq.result;
      if (room) {
        room.lastMsg = (author ? author + ': ' : '') + (text || '').substring(0, 80);
        room.lastTs = Date.now();
        store.put(room);
      }
    };
  } catch (e) {}
}

function loadAllRooms() {
  if (!db) return Promise.resolve([]);
  return new Promise((resolve) => {
    try {
      const tx = db.transaction('rooms', 'readonly');
      const req = tx.objectStore('rooms').getAll();
      req.onsuccess = () => {
        const rooms = req.result || [];
        rooms.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
        resolve(rooms);
      };
      req.onerror = () => resolve([]);
    } catch (e) { resolve([]); }
  });
}

function deleteRoom(chatId) {
  if (!db || !chatId) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(['rooms', 'messages'], 'readwrite');
      tx.objectStore('rooms').delete(chatId);
      // Удаляем сообщения этой комнаты
      const index = tx.objectStore('messages').index('chatId');
      const cur = index.openCursor(IDBKeyRange.only(chatId));
      cur.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) { cursor.delete(); cursor.continue(); }
      };
      tx.oncomplete = () => { dlog('deleted room: ' + chatId, 'ok'); resolve(); };
      tx.onerror = () => resolve();
    } catch (e) { resolve(); }
  });
}

// Генерация уникального ID сообщения
function generateMsgId() {
  return Date.now() + '-' + Math.random().toString(36).substring(2, 8);
}

// Получить chatId — стабильный ключ для группировки сообщений
// Используем currentChatId если уже определён, иначе вычисляем
let currentChatId = null;

function getChatId() {
  if (currentChatId) return currentChatId;
  if (roomId) return roomId;
  return null;
}

// Установить chatId при получении hello (когда известен никнейм собеседника)
function updateChatId() {
  if (roomId) {
    currentChatId = roomId;
  } else {
    // Для прямого чата — сортированные никнеймы
    const nicks = [myNickname];
    for (const [, entry] of connections) {
      if (entry.nickname) nicks.push(entry.nickname);
    }
    nicks.sort();
    currentChatId = 'dm:' + nicks.join(',');
  }
  dlog('chatId: ' + currentChatId);
}

// Сохранить сообщение в IndexedDB
function saveMessageToDB(msg) {
  if (!db || !msg.chatId) return;
  try {
    const tx = db.transaction('messages', 'readwrite');
    tx.objectStore('messages').put(msg);
  } catch (e) {
    dlog('DB save error: ' + e.message, 'error');
  }
}

// Загрузить историю чата из IndexedDB
function loadHistory(chatId) {
  if (!db) return Promise.resolve([]);
  return new Promise((resolve) => {
    try {
      const tx = db.transaction('messages', 'readonly');
      const store = tx.objectStore('messages');
      const index = store.index('chatId');
      const req = index.getAll(chatId);
      req.onsuccess = () => {
        const msgs = req.result || [];
        // Сортируем по timestamp
        msgs.sort((a, b) => a.timestamp - b.timestamp);
        resolve(msgs);
      };
      req.onerror = () => resolve([]);
    } catch (e) {
      resolve([]);
    }
  });
}

// Отрисовка истории из IndexedDB (без typewriter, без звука)
function renderHistory(messages) {
  for (const msg of messages) {
    if (msg.type === 'system') {
      const div = document.createElement('div');
      div.className = 'msg-system';
      div.textContent = '> ' + msg.text + ' [' + msg.timeStr + ']';
      messagesEl.appendChild(div);
    } else if (msg.type === 'msg') {
      const isMe = msg.author === myNickname;
      const div = document.createElement('div');
      div.className = 'msg';
      const avatar = document.createElement('img');
      avatar.className = 'msg-avatar';
      avatar.src = generateAvatar(msg.author);
      avatar.alt = msg.author;
      const body = document.createElement('div');
      body.className = 'msg-body';
      const header = document.createElement('div');
      header.className = 'msg-header';
      header.innerHTML =
        '<span class="author ' + (isMe ? 'me' : '') + '">' + escapeHtml(msg.author) + '</span>' +
        '<span class="time">' + msg.timeStr + '</span>';
      const textEl = document.createElement('span');
      textEl.className = 'text';
      textEl.textContent = msg.text;
      body.appendChild(header);
      body.appendChild(textEl);
      div.appendChild(avatar);
      div.appendChild(body);
      messagesEl.appendChild(div);
    }
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// --- Ping/pong и peer reconnect ---
const PING_INTERVAL = 15000;  // пинг каждые 15 сек
const PONG_TIMEOUT = 5000;    // ждём pong 5 сек
const PEER_GRACE_PERIOD = 30000; // 30 сек грейс перед "отключился"
const MAX_PEER_RECONNECT = 3;   // макс попыток реконнекта к пиру
let pingIntervalId = null;
const peerPongTimers = new Map();    // peerId → timeout (ожидание pong)
const peerGraceTimers = new Map();   // peerId → { timer, reconnectCount, nickname, publicKeyRaw }

// Таймеры "печатает"
const typingTimers = new Map();

// Буферы входящих файлов
const incomingFiles = new Map();

// --- E2E шифрование (ECDH + AES-GCM) ---
let myKeyPair = null;   // { publicKey, privateKey }
let myPublicKeyJwk = null; // экспортированный публичный ключ

// Генерация пары ключей ECDH
async function generateKeyPair() {
  myKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveKey']
  );
  myPublicKeyJwk = await crypto.subtle.exportKey('jwk', myKeyPair.publicKey);
}

// Получение shared AES-GCM ключа из публичного ключа пира
async function deriveSharedKey(peerPublicKeyJwk) {
  const peerPublicKey = await crypto.subtle.importKey(
    'jwk',
    peerPublicKeyJwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
  return await crypto.subtle.deriveKey(
    { name: 'ECDH', public: peerPublicKey },
    myKeyPair.privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// Шифрование строки
async function encryptData(sharedKey, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv },
    sharedKey,
    encoded
  );
  return {
    iv: Array.from(iv),
    data: Array.from(new Uint8Array(ciphertext))
  };
}

// Расшифровка
async function decryptData(sharedKey, iv, data) {
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(iv) },
    sharedKey,
    new Uint8Array(data)
  );
  return new TextDecoder().decode(decrypted);
}

// Fingerprint из публичного ключа (для верификации)
function getFingerprint(jwk) {
  const str = jwk.x + jwk.y;
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(16).toUpperCase().padStart(8, '0');
}

// --- Пиксельная аватарка 4x4 из хэша никнейма ---
function generateAvatar(nickname) {
  let hash = 0;
  for (let i = 0; i < nickname.length; i++) {
    hash = ((hash << 5) - hash + nickname.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash % 360);
  const color = 'hsl(' + hue + ', 55%, 55%)';
  const bgColor = 'hsl(' + hue + ', 30%, 25%)';
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 4;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, 4, 4);
  ctx.fillStyle = color;
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 2; x++) {
      const bit = (Math.abs(hash >> (y * 2 + x)) & 1);
      if (bit) {
        ctx.fillRect(x, y, 1, 1);
        ctx.fillRect(3 - x, y, 1, 1);
      }
    }
    hash = ((hash << 3) ^ (hash >> 2)) | 0;
  }
  return canvas.toDataURL();
}

// --- 8-битный звук уведомления ---
let audioCtx = null;

function playNotificationSound() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  const now = audioCtx.currentTime;
  [440, 587].forEach((freq, i) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(freq, now + i * 0.1);
    gain.gain.setValueAtTime(0.08, now + i * 0.1);
    gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.1 + 0.15);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(now + i * 0.1);
    osc.stop(now + i * 0.1 + 0.15);
  });
}

// --- Время HH:MM:SS ---
function getTimeString() {
  return new Date().toTimeString().substring(0, 8);
}

// --- Эффект посимвольной печати ---
function typewriterEffect(element, text, callback) {
  if (!typewriterEnabled) {
    element.textContent = text;
    if (callback) callback();
    return;
  }
  let i = 0;
  const speed = Math.max(10, Math.min(30, 600 / text.length));
  function type() {
    if (i < text.length) {
      element.textContent = text.substring(0, i + 1);
      i++;
      setTimeout(type, speed);
    } else {
      if (callback) callback();
    }
  }
  type();
}

// --- Проверяем hash в URL ---
function checkInviteLink() {
  const hash = window.location.hash.substring(1);
  if (hash && hash.startsWith('room-')) return hash;
  return null;
}

// --- Переключение на экран чата ---
let historyLoaded = false;

function showChat() {
  connectScreen.classList.add('hidden');
  roomScreen.classList.add('hidden');
  chatScreen.classList.remove('hidden');
  if (roomId) {
    roomIdDisplay.textContent = '# ' + roomId;
  } else {
    roomIdDisplay.textContent = '# direct';
  }
  // URL остаётся чистым — хеш только в invite-ссылке
}

// Выход из чата на главный экран (соединения остаются живыми)
// Пиры, от которых мы сознательно отключились (блокируем реконнект)
const disconnectedPeers = new Set();
let disconnectedClearTimer = null;

// Полная очистка текущей сессии чата
function teardownChatSession() {
  // Очищаем старый список и собираем текущих пиров
  disconnectedPeers.clear();
  if (disconnectedClearTimer) { clearTimeout(disconnectedClearTimer); disconnectedClearTimer = null; }

  const conns = [];
  for (const [peerId, entry] of connections) {
    disconnectedPeers.add(peerId);
    conns.push(entry);
  }

  // Очищаем Map и таймеры ДО закрытия соединений
  // (close-обработчики PeerJS могут быть синхронными)
  connections.clear();
  stopPingLoop();

  for (const [, info] of peerGraceTimers) {
    if (info.timer) clearTimeout(info.timer);
  }
  peerGraceTimers.clear();

  for (const [, timer] of typingTimers) {
    clearTimeout(timer);
  }
  typingTimers.clear();
  typingIndicator.classList.add('hidden');

  // Теперь закрываем соединения (close-обработчики увидят пустой Map)
  for (const entry of conns) {
    try { entry.conn.close(); } catch (e) {}
  }

  // Сбрасываем состояние
  roomId = null;
  isHost = false;
  currentChatId = null;
  historyLoaded = false;

  // Очищаем UI сообщений
  messagesEl.innerHTML = '';
  updateOnlineCount();
  updateLockIcon();

  // Автоочистка disconnectedPeers через 60 сек (дольше PEER_GRACE_PERIOD)
  disconnectedClearTimer = setTimeout(() => {
    disconnectedPeers.clear();
    disconnectedClearTimer = null;
  }, 60000);

  dlog('teardownChatSession: сессия очищена, blocked peers: ' + [...disconnectedPeers].join(', '));
}

function leaveChat() {
  teardownChatSession();
  // Уничтожаем peer и переинициализируем с никнеймом
  // (чтобы peer ID не остался roomId хоста)
  if (peer && !peer.destroyed) peer.destroy();
  initPeer(myNickname);

  chatScreen.classList.add('hidden');
  roomScreen.classList.add('hidden');
  connectScreen.classList.remove('hidden');
  window.history.replaceState(null, '', window.location.pathname);
  setStatus('online — главный экран');
  dlog('leaveChat: вернулись на главный экран');
  renderRoomsList();
}

// --- Список чатов (мои чаты) ---
async function renderRoomsList() {
  const section = document.getElementById('rooms-section');
  const list = document.getElementById('rooms-list');
  if (!section || !list) return;

  const rooms = await loadAllRooms();
  if (rooms.length === 0) {
    section.classList.add('hidden');
    return;
  }

  list.innerHTML = '';
  section.classList.remove('hidden');

  for (const room of rooms) {
    const card = document.createElement('div');
    card.className = 'room-card';

    const info = document.createElement('div');
    info.className = 'room-card-info';

    const name = document.createElement('div');
    name.className = 'room-card-name';
    name.textContent = room.name || room.chatId;

    const last = document.createElement('div');
    last.className = 'room-card-last';
    last.textContent = room.lastMsg || 'нет сообщений';

    info.appendChild(name);
    info.appendChild(last);

    const time = document.createElement('div');
    time.className = 'room-card-time';
    time.textContent = room.lastTs ? formatRoomTime(room.lastTs) : '';

    const del = document.createElement('button');
    del.className = 'room-card-delete';
    del.textContent = '×';
    del.title = 'удалить чат';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      await deleteRoom(room.chatId);
      renderRoomsList();
    });

    card.appendChild(info);
    card.appendChild(time);
    card.appendChild(del);

    card.addEventListener('click', () => rejoinFromRoomCard(room));
    list.appendChild(card);
  }
}

function formatRoomTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (now - d < 86400000 && d.getDate() === now.getDate()) {
    return d.toTimeString().substring(0, 5);
  }
  if (now - d < 172800000) return 'вчера';
  return d.getDate() + '.' + (d.getMonth() + 1).toString().padStart(2, '0');
}

function rejoinFromRoomCard(room) {
  teardownChatSession();

  if (room.mode === 'room' && room.isHost) {
    // Хост — перерегистрируемся с тем же room ID
    roomId = room.roomId || room.chatId;
    isHost = true;
    dlog('rooms: rejoin как хост ' + roomId);
    if (peer && !peer.destroyed) peer.destroy();
    initPeer(roomId, () => { onOpenAsHost(); });
  } else if (room.mode === 'room') {
    // Гость — подключаемся к комнате
    roomId = room.roomId || room.chatId;
    dlog('rooms: rejoin как гость ' + roomId);
    connectToRoom(roomId);
  } else if (room.mode === 'direct' && room.peers && room.peers.length > 0) {
    // Прямой чат
    dlog('rooms: rejoin direct → ' + room.peers.join(', '));
    for (const peerId of room.peers) {
      connectToPeer(peerId);
    }
  }
}

// Загрузка истории — вызывается после hello, когда chatId стабилен
function loadChatHistory() {
  if (historyLoaded) return;
  const chatId = getChatId();
  if (!chatId) return;
  historyLoaded = true;

  loadHistory(chatId).then(msgs => {
    if (msgs.length > 0) {
      dlog('history: loaded ' + msgs.length + ' messages for ' + chatId, 'ok');
      // Вставляем историю ПЕРЕД текущими сообщениями
      const existing = messagesEl.innerHTML;
      messagesEl.innerHTML = '';
      renderHistory(msgs);
      messagesEl.insertAdjacentHTML('beforeend', existing);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  });
  msgInput.focus();
}

// --- Инициализация PeerJS ---
let peerRetries = 0;
const MAX_PEER_RETRIES = 3;

// --- Статус signaling-сервера ---
let signalingState = 'offline'; // online | reconnecting | offline
let reconnectAttempts = 0;
let reconnectTimer = null;

function setSignalingStatus(state) {
  signalingState = state;
  signalStatusEl.className = 'signal-dot ' + state;
  const titles = { online: 'signaling: online', reconnecting: 'signaling: переподключение...', offline: 'signaling: offline' };
  signalStatusEl.title = titles[state] || state;
  dlog('signaling status: ' + state, state === 'online' ? 'ok' : state === 'offline' ? 'error' : 'warn');
}

// Exponential backoff: 2с, 4с, 8с, 16с, 30с макс
function getReconnectDelay() {
  const delay = Math.min(2000 * Math.pow(2, reconnectAttempts), 30000);
  return delay;
}

// Макс попыток peer.reconnect() перед полной переинициализацией
const MAX_RECONNECT_BEFORE_REINIT = 3;

function scheduleSignalingReconnect() {
  if (peer.destroyed) return;
  if (reconnectTimer) clearTimeout(reconnectTimer);

  reconnectAttempts++;

  // После 3 неудачных reconnect — полная переинициализация
  if (reconnectAttempts > MAX_RECONNECT_BEFORE_REINIT) {
    dlog('reconnect не помог (' + MAX_RECONNECT_BEFORE_REINIT + ' попыток), полная переинициализация', 'warn');
    reinitPeer();
    return;
  }

  const delay = getReconnectDelay();
  dlog('signaling reconnect in ' + (delay / 1000) + 's (attempt ' + reconnectAttempts + '/' + MAX_RECONNECT_BEFORE_REINIT + ')', 'warn');
  setStatus('signaling переподключение... (' + reconnectAttempts + '/' + MAX_RECONNECT_BEFORE_REINIT + ')');

  reconnectTimer = setTimeout(() => {
    if (!peer.destroyed && !peer.open) {
      dlog('attempting signaling reconnect...');
      peer.reconnect();
    }
  }, delay);
}

// Полная переинициализация peer (при смене сети и т.д.)
function reinitPeer() {
  resetReconnectState();
  peerRetries = 0;

  // Сохраняем список пиров для переподключения после reinit
  const savedPeers = [];
  for (const [peerId, entry] of connections) {
    savedPeers.push(peerId);
  }
  // Также сохраняем пиров из грейса
  for (const [peerId] of peerGraceTimers) {
    if (!savedPeers.includes(peerId)) savedPeers.push(peerId);
  }
  dlog('reinit: сохранены пиры для реконнекта: ' + (savedPeers.length > 0 ? savedPeers.join(', ') : 'нет'));

  // Очищаем грейсы — будем переподключаться заново
  for (const [peerId] of peerGraceTimers) cancelPeerGrace(peerId);
  connections.clear();
  stopPingLoop();

  // Уничтожаем старый peer
  if (peer && !peer.destroyed) {
    try { peer.destroy(); } catch (e) {}
  }

  // Callback после успешного подключения к signaling — переподключаемся к пирам
  const onReconnected = () => {
    if (savedPeers.length > 0) {
      dlog('reinit: переподключаюсь к ' + savedPeers.length + ' пир(ам)', 'ok');
      for (const peerId of savedPeers) {
        connectToPeer(peerId);
      }
    }
    // Если есть roomId и мы гость — подключаемся к комнате тоже
    if (roomId && !isHost && !savedPeers.includes(roomId)) {
      connectToRoom(roomId);
    }
  };

  // Определяем с каким ID переподключаться
  if (isHost && roomId) {
    dlog('reinit: переинициализация как хост ' + roomId, 'warn');
    setSignalingStatus('reconnecting');
    initPeer(roomId, () => { onOpenAsHost(); onReconnected(); });
  } else {
    dlog('reinit: переинициализация как ' + myNickname, 'warn');
    setSignalingStatus('reconnecting');
    initPeer(myNickname, onReconnected);
  }
}

function resetReconnectState() {
  reconnectAttempts = 0;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

// Конфигурация PeerJS — свой signaling-сервер
const SIGNAL_HOST = 'ghost-mesh-signal.onrender.com';
const SIGNAL_URL = 'https://' + SIGNAL_HOST;

const PEER_CONFIG = {
  host: SIGNAL_HOST,
  port: 443,
  path: '/peerjs',
  secure: true,
  debug: 0,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  }
};

// --- Keep-alive для signaling-сервера (не даём Render уснуть) ---
const KEEP_ALIVE_INTERVAL = 10 * 60 * 1000; // 10 минут
let keepAliveTimer = null;

function startKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    fetch(SIGNAL_URL + '/health')
      .then(r => r.json())
      .then(data => dlog('keep-alive: server uptime ' + Math.round(data.uptime) + 's', 'ok'))
      .catch(() => dlog('keep-alive: signaling не отвечает', 'warn'));
  }, KEEP_ALIVE_INTERVAL);
  dlog('keep-alive started (every 10 min)');
}

function stopKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

function initPeer(peerId, onOpen) {
  dlog('initPeer: id=' + peerId + ', retry=' + peerRetries);
  resetReconnectState();
  const thisPeer = new Peer(peerId, PEER_CONFIG);
  peer = thisPeer;

  // Таймаут подключения к signaling-серверу (10 сек)
  const connectTimeout = setTimeout(() => {
    if (peer !== thisPeer) return; // устаревший таймер
    if (!thisPeer.open && !thisPeer.destroyed) {
      if (peerRetries < MAX_PEER_RETRIES) {
        peerRetries++;
        dlog('signaling timeout, retry ' + peerRetries, 'warn');
        setStatus('signaling не отвечает, повтор ' + peerRetries + '/' + MAX_PEER_RETRIES);
        thisPeer.destroy();
        initPeer(peerId, onOpen);
      } else {
        dlog('signaling failed after ' + MAX_PEER_RETRIES + ' retries', 'error');
        setStatus('signaling недоступен');
      }
    }
  }, 10000);

  thisPeer.on('open', (id) => {
    if (peer !== thisPeer) return;
    clearTimeout(connectTimeout);
    peerRetries = 0;
    resetReconnectState();
    setSignalingStatus('online');
    startKeepAlive();
    dlog('peer.open: id=' + id, 'ok');
    myIdEl.textContent = myNickname;
    myIdCopyEl.textContent = myNickname;
    setStatus('online — ожидание');
    if (onOpen) onOpen(id);
  });

  thisPeer.on('connection', (incoming) => {
    if (peer !== thisPeer) return;
    dlog('incoming connection from ' + incoming.peer);
    handleConnection(incoming);
  });

  thisPeer.on('error', (err) => {
    if (peer !== thisPeer) return;
    clearTimeout(connectTimeout);
    dlog('peer.error: type=' + err.type + ' msg=' + err.message, 'error');
    if (err.type === 'unavailable-id') {
      thisPeer.destroy();
      if (isHost) {
        roomId = generateRoomId();
        initPeer(roomId, onOpenAsHost);
      } else {
        initPeer(myNickname + '-' + Math.random().toString(16).substring(2, 4));
      }
      return;
    }
    if (err.type === 'peer-unavailable') {
      setStatus('пир не найден');
      return;
    }
    setStatus('ошибка: ' + err.type);
  });

  thisPeer.on('disconnected', () => {
    if (peer !== thisPeer) return; // событие от старого peer — игнорируем
    dlog('peer.disconnected (destroyed=' + thisPeer.destroyed + ')', 'warn');
    if (thisPeer.destroyed) return;
    setSignalingStatus('reconnecting');
    scheduleSignalingReconnect();
  });

  thisPeer.on('close', () => {
    if (peer !== thisPeer) return; // событие от старого peer — игнорируем
    dlog('peer.close — полное отключение', 'error');
    setSignalingStatus('offline');
  });
}

function onOpenAsHost() {
  const link = window.location.origin + window.location.pathname + '#' + roomId;
  inviteLinkEl.textContent = link;
  connectScreen.classList.add('hidden');
  roomScreen.classList.remove('hidden');
  setStatus('комната ' + roomId + ' — ожидание');
  window.history.replaceState(null, '', '#' + roomId);
}

function createRoom() {
  teardownChatSession();
  roomId = generateRoomId();
  isHost = true;
  if (peer && !peer.destroyed) peer.destroy();
  initPeer(roomId, () => {
    onOpenAsHost();
    updateChatId();
    saveRoom(roomId, { name: '# ' + roomId, mode: 'room', isHost: true, roomId: roomId, lastTs: Date.now(), peers: [] });
  });
}

function connectToPeer(remotePeerId) {
  const id = remotePeerId.trim();
  if (!id) { dlog('connectToPeer: пустой ID', 'warn'); return; }
  if (connections.has(id)) { dlog('connectToPeer: уже подключён к ' + id, 'warn'); return; }
  if (!peer || !peer.open) {
    dlog('connectToPeer: signaling не подключён, невозможно соединиться', 'error');
    setStatus('signaling не подключён');
    return;
  }
  dlog('connectToPeer: подключаюсь к ' + id);
  setStatus('подключение к ' + id + '...');
  const conn = peer.connect(id, { reliable: true });
  handleConnection(conn);
}

// --- Отправка (нешифрованная, для hello/peers) ---
function sendToRaw(conn, obj) {
  conn.send(JSON.stringify(obj));
}

// --- Отправка с шифрованием конкретному пиру ---
async function sendToEncrypted(conn, peerId, obj) {
  const entry = connections.get(peerId);
  if (!entry || !entry.sharedKey) {
    // Ключ ещё не согласован — отправляем как есть
    sendToRaw(conn, obj);
    return;
  }
  const plaintext = JSON.stringify(obj);
  const encrypted = await encryptData(entry.sharedKey, plaintext);
  sendToRaw(conn, { type: 'encrypted', iv: encrypted.iv, data: encrypted.data });
}

// --- Broadcast с шифрованием (для каждого пира свой шифр) ---
async function broadcastEncrypted(obj) {
  for (const [peerId, entry] of connections) {
    if (entry.conn.open) {
      await sendToEncrypted(entry.conn, peerId, obj);
    }
  }
}

// --- Ping/pong система для детекции обрывов ---
function startPingLoop() {
  if (pingIntervalId) return;
  pingIntervalId = setInterval(() => {
    for (const [peerId, entry] of connections) {
      if (entry.conn.open) {
        try {
          sendToRaw(entry.conn, { type: 'ping', ts: Date.now() });
        } catch (e) {}
        // Ставим таймер ожидания pong
        if (!peerPongTimers.has(peerId)) {
          peerPongTimers.set(peerId, setTimeout(() => {
            peerPongTimers.delete(peerId);
            dlog('ping timeout: ' + (entry.nickname || peerId) + ' не ответил', 'warn');
            // DataChannel возможно мёртв — закрываем, сработает reconnect через грейс
            if (entry.conn.open) {
              try { entry.conn.close(); } catch (e) {}
            }
          }, PONG_TIMEOUT));
        }
      }
    }
  }, PING_INTERVAL);
}

function stopPingLoop() {
  if (pingIntervalId) {
    clearInterval(pingIntervalId);
    pingIntervalId = null;
  }
  for (const [, timer] of peerPongTimers) clearTimeout(timer);
  peerPongTimers.clear();
}

// Обработка pong — пир жив
function handlePong(peerId) {
  const timer = peerPongTimers.get(peerId);
  if (timer) {
    clearTimeout(timer);
    peerPongTimers.delete(peerId);
  }
}

// --- Грейс-период и reconnect к пиру ---
// Грейс привязан к НИКНЕЙМУ, а не peer ID — при rejoin peer ID может измениться
function startPeerGrace(peerId, nickname, publicKeyRaw) {
  const graceKey = nickname || peerId;
  // Уже в грейсе — не дублируем
  if (peerGraceTimers.has(graceKey)) return;

  const graceInfo = { reconnectCount: 0, nickname: nickname, peerId: peerId, publicKeyRaw: publicKeyRaw, timer: null };
  peerGraceTimers.set(graceKey, graceInfo);

  dlog('grace: ' + graceKey + ' — ждём реконнект (' + (PEER_GRACE_PERIOD / 1000) + 's)', 'warn');
  updateOnlineCount();

  // Пробуем переподключиться к последнему известному peer ID
  attemptPeerReconnect(graceKey, graceInfo);

  // Таймер грейс-периода
  graceInfo.timer = setTimeout(() => {
    if (peerGraceTimers.has(graceKey)) {
      peerGraceTimers.delete(graceKey);
      dlog('grace: ' + graceKey + ' — грейс истёк, отключён', 'error');
      addSystemMessage(graceKey + ' отключился');
      updateOnlineCount();
      updateLockIcon();
    }
  }, PEER_GRACE_PERIOD);
}

function attemptPeerReconnect(graceKey, graceInfo) {
  if (!peerGraceTimers.has(graceKey)) return;
  if (!peer || !peer.open) return;
  if (graceInfo.reconnectCount >= MAX_PEER_RECONNECT) return;

  graceInfo.reconnectCount++;
  dlog('peer reconnect: ' + graceKey + ' попытка ' + graceInfo.reconnectCount + '/' + MAX_PEER_RECONNECT);

  const conn = peer.connect(graceInfo.peerId, { reliable: true });
  handleConnection(conn, graceInfo);
}

// Отмена грейса по никнейму
function cancelGraceByNickname(nickname) {
  if (!nickname) return;
  const grace = peerGraceTimers.get(nickname);
  if (grace) {
    if (grace.timer) clearTimeout(grace.timer);
    peerGraceTimers.delete(nickname);
    dlog('grace cancelled for ' + nickname, 'ok');
  }
}

function cancelPeerGrace(peerId) {
  // Пробуем отменить и по peerId, и ищем по никнейму
  const grace = peerGraceTimers.get(peerId);
  if (grace) {
    if (grace.timer) clearTimeout(grace.timer);
    peerGraceTimers.delete(peerId);
    return;
  }
  // Поиск по peerId внутри graceInfo
  for (const [key, info] of peerGraceTimers) {
    if (info.peerId === peerId) {
      if (info.timer) clearTimeout(info.timer);
      peerGraceTimers.delete(key);
      return;
    }
  }
}

// Проверка всех DataChannel (вызывается при visibilitychange)
function checkAllConnections() {
  for (const [peerId, entry] of connections) {
    if (!entry.conn.open) {
      const nickname = entry.nickname;
      const graceKey = nickname || peerId;
      dlog('check: DataChannel с ' + graceKey + ' мёртв', 'warn');
      const pubKey = entry.publicKeyRaw;
      connections.delete(peerId);
      if (!peerGraceTimers.has(graceKey)) {
        startPeerGrace(peerId, nickname, pubKey);
      }
    }
  }
}

// --- Обработка соединения ---
function handleConnection(conn, graceInfo) {
  const ownerPeer = peer; // Запоминаем текущий экземпляр peer

  conn.on('open', () => {
    // Игнорируем events от старого уничтоженного peer
    if (peer !== ownerPeer) {
      dlog('stale conn.open from old peer, ignoring');
      try { conn.close(); } catch (e) {}
      return;
    }

    // Отклоняем реконнект от пиров, которых мы сознательно отключили
    if (disconnectedPeers.has(conn.peer)) {
      dlog('rejecting reconnect from disconnected peer: ' + conn.peer);
      try { conn.close(); } catch (e) {}
      return;
    }

    // Проверяем — это реконнект после грейса?
    const wasInGrace = peerGraceTimers.has(conn.peer);
    if (wasInGrace) {
      cancelPeerGrace(conn.peer);
      dlog('peer reconnected: ' + conn.peer + ' (из грейса)', 'ok');
    }

    // Если уже есть соединения в direct-чате и это новый пир — переключаемся
    if (!wasInGrace && connections.size > 0 && !(isHost && roomId)) {
      dlog('new peer in direct chat: teardown old session, switching');
      teardownChatSession();
    }

    connections.set(conn.peer, { conn: conn, nickname: (graceInfo && graceInfo.nickname) || null, sharedKey: null, publicKeyRaw: (graceInfo && graceInfo.publicKeyRaw) || null });

    // Отправляем hello с публичным ключом
    sendToRaw(conn, { type: 'hello', nickname: myNickname, publicKey: myPublicKeyJwk });

    // Хост отправляет список пиров
    if (isHost) {
      const peerList = [];
      for (const [peerId] of connections) {
        if (peerId !== conn.peer) peerList.push(peerId);
      }
      if (peerList.length > 0) {
        sendToRaw(conn, { type: 'peers', list: peerList });
      }
    }

    showChat();
    startPingLoop();
    updateOnlineCount();
    setStatus('подключён — ' + connections.size + ' пир(ов)');
  });

  conn.on('data', async (raw) => {
    // Игнорируем данные от соединений, не принадлежащих текущей сессии
    if (!connections.has(conn.peer)) return;
    let parsed = null;
    if (typeof raw === 'string') {
      try { parsed = JSON.parse(raw); } catch (e) { /* обычный текст */ }
    }

    if (!parsed) {
      // Обычный текст (не JSON)
      const entry = connections.get(conn.peer);
      const author = (entry && entry.nickname) || conn.peer;
      addMessage(author, raw);
      playNotificationSound();
      return;
    }

    // Зашифрованное сообщение — расшифровываем и обрабатываем рекурсивно
    if (parsed.type === 'encrypted') {
      const entry = connections.get(conn.peer);
      if (!entry || !entry.sharedKey) return;
      try {
        const decrypted = await decryptData(entry.sharedKey, parsed.iv, parsed.data);
        const inner = JSON.parse(decrypted);
        await handleDecryptedMessage(conn, inner);
      } catch (e) {
        addSystemMessage('ошибка расшифровки от ' + conn.peer);
      }
      return;
    }

    // Нешифрованные служебные сообщения (hello, peers)
    if (parsed.type === 'hello') {
      const entry = connections.get(conn.peer);
      if (entry) {
        entry.nickname = parsed.nickname;
        entry.publicKeyRaw = parsed.publicKey;

        // Проверяем — этот никнейм был в грейсе? (реконнект с новым peer ID)
        const wasInGrace = peerGraceTimers.has(parsed.nickname);
        if (wasInGrace) {
          cancelGraceByNickname(parsed.nickname);
        }

        // Удаляем старое соединение с тем же никнеймом (другой peer ID)
        for (const [oldPeerId, oldEntry] of connections) {
          if (oldPeerId !== conn.peer && oldEntry.nickname === parsed.nickname) {
            dlog('removing stale connection: ' + oldPeerId + ' (replaced by ' + conn.peer + ')');
            try { oldEntry.conn.close(); } catch (e) {}
            connections.delete(oldPeerId);
          }
        }

        // Вычисляем shared key
        if (parsed.publicKey) {
          try {
            entry.sharedKey = await deriveSharedKey(parsed.publicKey);
            const fp = getFingerprint(parsed.publicKey);
            if (wasInGrace) {
              addSystemMessage(parsed.nickname + ' переподключился 🔒 [' + fp + ']');
            } else {
              addSystemMessage(parsed.nickname + ' подключился 🔒 [' + fp + ']');
            }
            updateLockIcon();
          } catch (e) {
            addSystemMessage(parsed.nickname + (wasInGrace ? ' переподключился' : ' подключился') + ' (без шифрования)');
          }
        } else {
          addSystemMessage(parsed.nickname + (wasInGrace ? ' переподключился' : ' подключился') + ' (без шифрования)');
        }
      }
      updateChatId();
      loadChatHistory();
      updateOnlineCount();

      // Сохраняем чат в список
      const cid = getChatId();
      if (cid) {
        const peersList = [];
        for (const [pid] of connections) peersList.push(pid);
        saveRoom(cid, {
          name: roomId ? '# ' + roomId : '@ ' + parsed.nickname,
          mode: roomId ? 'room' : 'direct',
          isHost: isHost,
          roomId: roomId || null,
          peers: peersList,
          lastTs: Date.now()
        });
      }
      return;
    }

    if (parsed.type === 'peers') {
      for (const peerId of parsed.list) {
        if (!connections.has(peerId) && peerId !== peer.id) {
          connectToPeer(peerId);
        }
      }
      return;
    }

    // Ping/pong — heartbeat между пирами
    if (parsed.type === 'ping') {
      try { sendToRaw(conn, { type: 'pong', ts: parsed.ts }); } catch (e) {}
      return;
    }
    if (parsed.type === 'pong') {
      handlePong(conn.peer);
      return;
    }

    // Всё остальное — обрабатываем как нешифрованное (fallback)
    await handleDecryptedMessage(conn, parsed);
  });

  conn.on('close', () => {
    const entry = connections.get(conn.peer);
    // Если соединения нет в Map — закрыто через teardownChatSession, игнорируем
    if (!entry) return;
    const name = entry.nickname || conn.peer;
    const pubKey = entry.publicKeyRaw;
    connections.delete(conn.peer);
    clearTypingTimer(conn.peer);

    // Грейс-ключ — по никнейму (если известен), иначе по peer ID
    const graceKey = (entry && entry.nickname) || conn.peer;

    // Если этот никнейм уже подключён через другой peer ID — не нужен грейс
    let stillConnected = false;
    if (entry && entry.nickname) {
      for (const [, e] of connections) {
        if (e.nickname === entry.nickname) { stillConnected = true; break; }
      }
    }

    if (stillConnected) {
      // Тот же никнейм подключён через другой peer ID — молча убираем старое
      dlog('stale conn closed: ' + conn.peer + ' (nickname ' + name + ' still connected)', 'info');
    } else if (peer && peer.open && !peerGraceTimers.has(graceKey)) {
      // Грейс-период — пробуем реконнект
      startPeerGrace(conn.peer, name, pubKey);
    } else if (!peerGraceTimers.has(graceKey)) {
      // Signaling тоже мёртв — сразу отключаем
      addSystemMessage(name + ' отключился');
      updateOnlineCount();
      updateLockIcon();
    }

    setStatus(connections.size > 0
      ? 'подключён — ' + connections.size + ' пир(ов)'
      : (peerGraceTimers.size > 0 ? 'переподключение...' : 'все отключились'));

    if (connections.size === 0 && peerGraceTimers.size === 0) stopPingLoop();
  });

  conn.on('error', (err) => {
    addSystemMessage('ошибка соединения с ' + conn.peer + ': ' + err);
  });
}

// --- Обработка расшифрованного (или нешифрованного) сообщения ---
async function handleDecryptedMessage(conn, parsed) {
  if (parsed.type === 'msg') {
    addMessage(parsed.nickname, parsed.text);
    playNotificationSound();
    return;
  }

  if (parsed.type === 'typing') {
    showTypingIndicator(parsed.nickname, conn.peer);
    return;
  }

  if (parsed.type === 'voice') {
    addVoiceMessage(parsed.nickname, parsed.audio, parsed.duration, false, parsed.mimeType);
    playNotificationSound();
    return;
  }

  if (parsed.type === 'file-meta') {
    incomingFiles.set(parsed.transferId, {
      meta: parsed, chunks: [], received: 0, progressEl: null
    });
    const entry = connections.get(conn.peer);
    const nick = (entry && entry.nickname) || parsed.nickname;
    addFileMessage(nick, parsed, false);
    return;
  }

  if (parsed.type === 'file-chunk') {
    const transfer = incomingFiles.get(parsed.transferId);
    if (!transfer) return;
    transfer.chunks.push(parsed.data);
    transfer.received++;
    const pct = Math.round((transfer.received / transfer.meta.totalChunks) * 100);
    if (transfer.progressEl) transfer.progressEl.style.width = pct + '%';
    return;
  }

  if (parsed.type === 'file-done') {
    const transfer = incomingFiles.get(parsed.transferId);
    if (!transfer) return;
    finalizeFileReceive(transfer);
    incomingFiles.delete(parsed.transferId);
    playNotificationSound();
    return;
  }
}

// --- Иконка замка ---
function updateLockIcon() {
  if (!lockIcon) return;
  let allEncrypted = connections.size > 0;
  for (const [, entry] of connections) {
    if (!entry.sharedKey) {
      allEncrypted = false;
      break;
    }
  }
  if (allEncrypted) {
    lockIcon.textContent = '🔒';
    lockIcon.title = 'E2E зашифровано (AES-256-GCM)';
    lockIcon.className = 'lock-on';
  } else if (connections.size > 0) {
    lockIcon.textContent = '🔓';
    lockIcon.title = 'Частично зашифровано';
    lockIcon.className = 'lock-partial';
  } else {
    lockIcon.textContent = '';
    lockIcon.className = '';
  }
}

// --- Индикатор "печатает" ---
function showTypingIndicator(nickname, peerId) {
  typingNick.textContent = nickname + ' печатает';
  typingIndicator.classList.remove('hidden');
  clearTypingTimer(peerId);
  const timerId = setTimeout(() => {
    typingIndicator.classList.add('hidden');
    typingTimers.delete(peerId);
  }, 2000);
  typingTimers.set(peerId, timerId);
}

function clearTypingTimer(peerId) {
  if (typingTimers.has(peerId)) {
    clearTimeout(typingTimers.get(peerId));
    typingTimers.delete(peerId);
  }
  if (typingTimers.size === 0) {
    typingIndicator.classList.add('hidden');
  }
}

let typingTimeout = null;
function onTyping() {
  if (connections.size === 0) return;
  if (typingTimeout) return;
  broadcastEncrypted({ type: 'typing', nickname: myNickname });
  typingTimeout = setTimeout(() => { typingTimeout = null; }, 1000);
}

// --- Голосовые сообщения ---
let mediaRecorder = null;
let audioChunks = [];
let recordingStartTime = 0;
const voiceBtn = document.getElementById('voice-btn');

// Начать/остановить запись
voiceBtn.addEventListener('click', async () => {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    // Остановить запись
    mediaRecorder.stop();
    voiceBtn.classList.remove('recording');
    return;
  }

  // Начать запись
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Выбираем формат: webm для Chrome/Firefox, mp4 для Safari
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/mp4';
    mediaRecorder = new MediaRecorder(stream, { mimeType: mimeType });
    audioChunks = [];
    recordingStartTime = Date.now();

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
      const duration = Math.round((Date.now() - recordingStartTime) / 1000);
      const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType });
      // Останавливаем доступ к микрофону
      stream.getTracks().forEach(t => t.stop());

      // Конвертируем в base64 и отправляем
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = reader.result.split(',')[1];
        broadcastEncrypted({
          type: 'voice',
          nickname: myNickname,
          audio: base64,
          duration: duration,
          mimeType: mediaRecorder.mimeType
        });
        addVoiceMessage(myNickname, base64, duration, true, mediaRecorder.mimeType);
      };
      reader.readAsDataURL(blob);
    };

    mediaRecorder.start();
    voiceBtn.classList.add('recording');
    dlog('recording started, mime=' + mimeType, 'ok');
  } catch (e) {
    dlog('mic error: ' + e.message, 'error');
    addSystemMessage('нет доступа к микрофону');
  }
});

// Отображение голосового сообщения
function addVoiceMessage(author, base64Audio, duration, isMe, mimeType) {
  const div = document.createElement('div');
  div.className = 'msg';

  const avatar = document.createElement('img');
  avatar.className = 'msg-avatar';
  avatar.src = generateAvatar(author);
  avatar.alt = author;

  const body = document.createElement('div');
  body.className = 'msg-body';

  const header = document.createElement('div');
  header.className = 'msg-header';
  header.innerHTML =
    '<span class="author ' + (isMe ? 'me' : '') + '">' + escapeHtml(author) + '</span>' +
    '<span class="time">' + getTimeString() + '</span>';

  // Карточка голосового
  const voiceCard = document.createElement('div');
  voiceCard.className = 'voice-card';

  // Кнопка play/pause
  const playBtn = document.createElement('button');
  playBtn.className = 'voice-play-btn';
  playBtn.textContent = '▶';

  // Визуальная волна (генерируем из длительности)
  const waveform = document.createElement('div');
  waveform.className = 'voice-waveform';
  const barCount = Math.min(Math.max(8, duration * 4), 32);
  const bars = [];
  for (let i = 0; i < barCount; i++) {
    const bar = document.createElement('div');
    bar.className = 'voice-bar';
    // Псевдослучайная высота из хэша
    const h = 6 + Math.abs(Math.sin(i * 1.7 + duration) * 18);
    bar.style.height = h + 'px';
    waveform.appendChild(bar);
    bars.push(bar);
  }

  // Длительность
  const durEl = document.createElement('span');
  durEl.className = 'voice-duration';
  durEl.textContent = formatDuration(duration);

  voiceCard.appendChild(playBtn);
  voiceCard.appendChild(waveform);
  voiceCard.appendChild(durEl);

  // Воспроизведение
  let audio = null;
  let isPlaying = false;

  playBtn.addEventListener('click', () => {
    if (isPlaying && audio) {
      audio.pause();
      audio.currentTime = 0;
      playBtn.textContent = '▶';
      isPlaying = false;
      bars.forEach(b => b.classList.remove('active'));
      return;
    }

    // Определяем mimeType
    const type = mimeType || 'audio/webm;codecs=opus';
    const byteChars = atob(base64Audio);
    const byteArray = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) {
      byteArray[i] = byteChars.charCodeAt(i);
    }
    const blob = new Blob([byteArray], { type: type });
    const url = URL.createObjectURL(blob);

    audio = new Audio(url);
    audio.play();
    isPlaying = true;
    playBtn.textContent = '⏸';

    // Анимация волны при воспроизведении
    const animInterval = setInterval(() => {
      if (!isPlaying) { clearInterval(animInterval); return; }
      const progress = audio.currentTime / audio.duration;
      const activeIdx = Math.floor(progress * bars.length);
      bars.forEach((b, i) => {
        b.classList.toggle('active', i <= activeIdx);
      });
    }, 100);

    audio.onended = () => {
      playBtn.textContent = '▶';
      isPlaying = false;
      bars.forEach(b => b.classList.remove('active'));
      clearInterval(animInterval);
    };
  });

  body.appendChild(header);
  body.appendChild(voiceCard);
  div.appendChild(avatar);
  div.appendChild(body);
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m + ':' + (s < 10 ? '0' : '') + s;
}

// --- Счётчик онлайн ---
function updateOnlineCount() {
  const connected = connections.size;
  const inGrace = peerGraceTimers.size;
  const total = connected + 1;
  if (inGrace > 0) {
    onlineCountEl.textContent = total + ' online (+' + inGrace + ' reconnecting)';
  } else {
    onlineCountEl.textContent = total + ' online';
  }
}

// --- Отправка сообщения ---
function sendMessage() {
  const text = msgInput.value.trim();
  if (!text || connections.size === 0) return;
  broadcastEncrypted({ type: 'msg', nickname: myNickname, text: text });
  addMessage(myNickname, text, true);
  msgInput.value = '';
}

// --- Отображение сообщений ---
function addMessage(author, text, isMe = false) {
  const timeStr = getTimeString();
  const div = document.createElement('div');
  div.className = 'msg';

  const avatar = document.createElement('img');
  avatar.className = 'msg-avatar';
  avatar.src = generateAvatar(author);
  avatar.alt = author;

  const body = document.createElement('div');
  body.className = 'msg-body';

  const header = document.createElement('div');
  header.className = 'msg-header';
  header.innerHTML =
    '<span class="author ' + (isMe ? 'me' : '') + '">' + escapeHtml(author) + '</span>' +
    '<span class="time">' + timeStr + '</span>';

  const textEl = document.createElement('span');
  textEl.className = 'text';

  body.appendChild(header);
  body.appendChild(textEl);
  div.appendChild(avatar);
  div.appendChild(body);
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  if (!isMe) {
    typewriterEffect(textEl, text, () => {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  } else {
    textEl.textContent = text;
  }

  // Сохраняем в IndexedDB
  const chatId = getChatId();
  saveMessageToDB({
    msgId: generateMsgId(),
    chatId: chatId,
    type: 'msg',
    author: author,
    text: text,
    timeStr: timeStr,
    timestamp: Date.now()
  });
  updateRoomLastMessage(chatId, text, author);
}

function addSystemMessage(text, saveToDB = true) {
  const timeStr = getTimeString();
  const div = document.createElement('div');
  div.className = 'msg-system';
  div.textContent = '> ' + text + ' [' + timeStr + ']';
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  if (saveToDB) {
    saveMessageToDB({
      msgId: generateMsgId(),
      chatId: getChatId(),
      type: 'system',
      text: text,
      timeStr: timeStr,
      timestamp: Date.now()
    });
  }
}

// --- Передача файлов ---
function sendFile(file) {
  if (!file || connections.size === 0) return;

  if (file.size > FILE_MAX_SIZE) {
    addSystemMessage('файл слишком большой (макс. 50 МБ)');
    return;
  }

  const transferId = myNickname + '-' + Date.now();
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

  const meta = {
    type: 'file-meta',
    transferId: transferId,
    nickname: myNickname,
    fileName: file.name,
    fileSize: file.size,
    fileType: file.type,
    totalChunks: totalChunks
  };
  broadcastEncrypted(meta);
  addFileMessage(myNickname, Object.assign({}, meta, { localFile: file }), true);

  const reader = new FileReader();
  reader.onload = () => {
    const uint8 = new Uint8Array(reader.result);
    let chunkIndex = 0;

    async function sendNextChunk() {
      if (chunkIndex >= totalChunks) {
        await broadcastEncrypted({ type: 'file-done', transferId: transferId });
        return;
      }

      const start = chunkIndex * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, uint8.length);
      const chunk = Array.from(uint8.slice(start, end));

      await broadcastEncrypted({
        type: 'file-chunk',
        transferId: transferId,
        index: chunkIndex,
        data: chunk
      });

      chunkIndex++;
      const pct = Math.round((chunkIndex / totalChunks) * 100);
      const myProgress = document.getElementById('progress-' + transferId);
      if (myProgress) myProgress.style.width = pct + '%';

      setTimeout(sendNextChunk, 5);
    }

    sendNextChunk();
  };
  reader.readAsArrayBuffer(file);
}

function finalizeFileReceive(transfer) {
  const allBytes = [];
  for (const chunk of transfer.chunks) {
    for (const byte of chunk) allBytes.push(byte);
  }
  const uint8 = new Uint8Array(allBytes);
  const blob = new Blob([uint8], { type: transfer.meta.fileType });
  const url = URL.createObjectURL(blob);

  const card = document.getElementById('card-' + transfer.meta.transferId);
  if (!card) return;

  const progressDiv = card.querySelector('.file-progress');
  if (progressDiv) progressDiv.remove();

  const downloadLink = document.createElement('a');
  downloadLink.href = url;
  downloadLink.download = transfer.meta.fileName;
  downloadLink.textContent = 'save';
  card.appendChild(downloadLink);

  if (transfer.meta.fileType && transfer.meta.fileType.startsWith('image/')) {
    const preview = document.createElement('img');
    preview.className = 'file-preview';
    preview.src = url;
    card.parentElement.appendChild(preview);
  }
}

function addFileMessage(author, meta, isMe) {
  const div = document.createElement('div');
  div.className = 'msg';

  const avatar = document.createElement('img');
  avatar.className = 'msg-avatar';
  avatar.src = generateAvatar(author);
  avatar.alt = author;

  const body = document.createElement('div');
  body.className = 'msg-body';

  const header = document.createElement('div');
  header.className = 'msg-header';
  header.innerHTML =
    '<span class="author ' + (isMe ? 'me' : '') + '">' + escapeHtml(author) + '</span>' +
    '<span class="time">' + getTimeString() + '</span>';

  const fileDiv = document.createElement('div');
  fileDiv.className = 'msg-file';

  const card = document.createElement('div');
  card.className = 'file-card';
  card.id = 'card-' + meta.transferId;

  const icon = document.createElement('span');
  icon.className = 'file-icon';
  icon.textContent = getFileIcon(meta.fileType);

  const info = document.createElement('div');
  info.className = 'file-info';
  info.innerHTML =
    '<div class="file-name">' + escapeHtml(meta.fileName) + '</div>' +
    '<div class="file-size">' + formatFileSize(meta.fileSize) + '</div>';

  card.appendChild(icon);
  card.appendChild(info);

  const progressWrap = document.createElement('div');
  progressWrap.className = 'file-progress';
  const progressBar = document.createElement('div');
  progressBar.className = 'file-progress-bar';
  progressBar.id = 'progress-' + meta.transferId;
  progressWrap.appendChild(progressBar);
  card.appendChild(progressWrap);

  if (!isMe) {
    const transfer = incomingFiles.get(meta.transferId);
    if (transfer) transfer.progressEl = progressBar;
  }

  fileDiv.appendChild(card);
  body.appendChild(header);
  body.appendChild(fileDiv);
  div.appendChild(avatar);
  div.appendChild(body);
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  if (isMe && meta.localFile && meta.fileType && meta.fileType.startsWith('image/')) {
    const url = URL.createObjectURL(meta.localFile);
    const preview = document.createElement('img');
    preview.className = 'file-preview';
    preview.src = url;
    fileDiv.appendChild(preview);
  }
}

function getFileIcon(fileType) {
  if (!fileType) return '📄';
  if (fileType.startsWith('image/')) return '🖼';
  if (fileType.startsWith('video/')) return '🎬';
  if (fileType.startsWith('audio/')) return '🎵';
  if (fileType.includes('pdf')) return '📕';
  if (fileType.includes('zip') || fileType.includes('rar') || fileType.includes('7z')) return '📦';
  return '📄';
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// --- Статус ---
function setStatus(text) {
  statusEl.textContent = '[ ' + text + ' ]';
}

// --- Утилиты ---
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function copyToClipboard(text, feedbackEl) {
  navigator.clipboard.writeText(text).then(() => {
    const original = feedbackEl.textContent;
    feedbackEl.textContent = 'скопировано!';
    setTimeout(() => { feedbackEl.textContent = original; }, 1000);
  });
}

// --- Обработчики событий ---

document.getElementById('back-btn').addEventListener('click', leaveChat);

createRoomBtn.addEventListener('click', createRoom);

connectBtn.addEventListener('click', () => {
  if (connections.size > 0) teardownChatSession();
  connectToPeer(peerIdInput.value);
});

peerIdInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    if (connections.size > 0) teardownChatSession();
    connectToPeer(peerIdInput.value);
  }
});

sendBtn.addEventListener('click', sendMessage);

msgInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendMessage();
});

msgInput.addEventListener('input', onTyping);

myIdCopyEl.addEventListener('click', () => {
  copyToClipboard(myIdCopyEl.textContent, myIdCopyEl);
});

copyLinkBtn.addEventListener('click', () => {
  copyToClipboard(inviteLinkEl.textContent, inviteLinkEl);
});

inviteLinkEl.addEventListener('click', () => {
  copyToClipboard(inviteLinkEl.textContent, inviteLinkEl);
});

// Смена ID
document.getElementById('new-id-btn').addEventListener('click', () => {
  myNickname = resetNickname();
  myIdEl.textContent = myNickname;
  myIdCopyEl.textContent = myNickname;
  dlog('new identity: ' + myNickname, 'ok');
  // Переинициализируем peer с новым ID
  if (peer && !peer.destroyed) peer.destroy();
  initPeer(myNickname);
});

// Отправка файлов
const fileInput = document.getElementById('file-input');
const fileBtn = document.getElementById('file-btn');

fileBtn.addEventListener('click', () => { fileInput.click(); });

fileInput.addEventListener('change', () => {
  if (fileInput.files.length > 0) {
    sendFile(fileInput.files[0]);
    fileInput.value = '';
  }
});

// Drag & drop
let dragCounter = 0;

messagesEl.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragCounter++;
  if (dragCounter === 1) showDragOverlay();
});

messagesEl.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragCounter--;
  if (dragCounter === 0) hideDragOverlay();
});

messagesEl.addEventListener('dragover', (e) => { e.preventDefault(); });

messagesEl.addEventListener('drop', (e) => {
  e.preventDefault();
  dragCounter = 0;
  hideDragOverlay();
  if (e.dataTransfer.files.length > 0) sendFile(e.dataTransfer.files[0]);
});

function showDragOverlay() {
  if (document.getElementById('drag-overlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'drag-overlay';
  overlay.className = 'drag-overlay';
  overlay.innerHTML = '<span>> перетащи файл сюда</span>';
  messagesEl.style.position = 'relative';
  messagesEl.appendChild(overlay);
}

function hideDragOverlay() {
  const overlay = document.getElementById('drag-overlay');
  if (overlay) overlay.remove();
}

// Переключение анимации
typewriterToggle.addEventListener('click', () => {
  typewriterEnabled = !typewriterEnabled;
  typewriterToggle.classList.toggle('active', typewriterEnabled);
  typewriterToggle.textContent = typewriterEnabled ? '▸ anim' : '▹ anim';
});
typewriterToggle.classList.toggle('active', typewriterEnabled);

// Показ fingerprint по клику на замок
if (lockIcon) {
  lockIcon.addEventListener('click', () => {
    let info = 'Мой fingerprint: ' + getFingerprint(myPublicKeyJwk) + '\n';
    for (const [, entry] of connections) {
      if (entry.nickname && entry.publicKeyRaw) {
        info += entry.nickname + ': ' + getFingerprint(entry.publicKeyRaw);
      }
    }
    addSystemMessage(info);
  });
}

// Отключение при закрытии
window.addEventListener('beforeunload', () => {
  stopKeepAlive();
  for (const [, entry] of connections) entry.conn.close();
  if (peer) peer.destroy();
});

// --- Обработка смены сети (mobile → WiFi, WiFi → mobile) ---
window.addEventListener('online', () => {
  dlog('network: online event — сеть вернулась', 'ok');
  if (peer && !peer.open && !peer.destroyed) {
    dlog('network: peer не подключён, переинициализация...', 'warn');
    reinitPeer();
  }
});

window.addEventListener('offline', () => {
  dlog('network: offline event — сеть потеряна', 'error');
  setSignalingStatus('offline');
  setStatus('нет сети');
});

// --- Возврат на вкладку (сворачивание телефона) ---
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    dlog('visibility: вкладка активна', 'info');
    // Проверяем состояние signaling
    if (peer && !peer.destroyed && !peer.open) {
      dlog('visibility: signaling отвалился, переинициализация', 'warn');
      reinitPeer();
    } else if (peer && peer.open) {
      setSignalingStatus('online');
      // Проверяем все DataChannel
      checkAllConnections();
    }
  }
});

// --- Старт (async для генерации ключей) ---
// Кнопки debug-панели
document.getElementById('debug-copy').addEventListener('click', () => {
  const lines = debugLog.querySelectorAll('.debug-line');
  const text = Array.from(lines).map(l => l.textContent).join('\n');
  navigator.clipboard.writeText(text).then(() => {
    setStatus('лог скопирован');
  });
});

document.getElementById('debug-clear').addEventListener('click', () => {
  debugLog.innerHTML = '';
});

debugToggle.addEventListener('click', () => {
  debugPanel.classList.toggle('hidden');
  debugToggle.classList.toggle('active', !debugPanel.classList.contains('hidden'));
  debugToggle.textContent = debugPanel.classList.contains('hidden') ? '▸ log' : '▾ log';
});

(async function start() {
  dlog('start: userAgent=' + navigator.userAgent);
  dlog('start: url=' + location.href);

  // Открываем IndexedDB
  try {
    await openDB();
  } catch (e) {
    dlog('IndexedDB unavailable, history disabled', 'warn');
  }

  try {
    setStatus('генерация ключей...');
    dlog('generating ECDH keys...');
    await generateKeyPair();
    dlog('keys generated OK', 'ok');
    setStatus('ключи готовы, подключение...');
  } catch (e) {
    dlog('crypto error: ' + e.message, 'error');
    setStatus('crypto недоступен, без шифрования');
    myPublicKeyJwk = null;
  }

  // Показываем список сохранённых чатов
  await renderRoomsList();

  const inviteHash = checkInviteLink();

  // Два сценария:
  // 1) Invite-ссылка #room-XXXX → подключаемся к комнате
  // 2) Нет → главный экран + список чатов
  if (inviteHash) {
    roomId = inviteHash;
    dlog('invite link: ' + inviteHash);
    initPeer(myNickname, () => {
      connectToRoom(inviteHash);
      // Очищаем хеш — ссылка одноразовая
      window.history.replaceState(null, '', window.location.pathname);
    });
  } else {
    initPeer(myNickname);
  }
})();

// --- Подключение к комнате с retry (использует handleConnection) ---
let roomRetries = 0;
const MAX_ROOM_RETRIES = 5;

function connectToRoom(roomPeerId) {
  dlog('connectToRoom: attempt ' + (roomRetries + 1) + ', target=' + roomPeerId);
  setStatus('подключение к комнате...');

  const conn = peer.connect(roomPeerId, { reliable: true });

  // Таймаут на случай если соединение зависнет
  const timeout = setTimeout(() => {
    dlog('room connect timeout', 'warn');
    try { conn.close(); } catch (e) {}
    retryRoomConnect(roomPeerId);
  }, 8000);

  // При успешном открытии — сбрасываем retry и передаём в handleConnection
  conn.on('open', () => {
    clearTimeout(timeout);
    roomRetries = 0;
    dlog('room connected!', 'ok');
  });

  conn.on('error', (err) => {
    clearTimeout(timeout);
    dlog('room conn error: ' + err, 'error');
    retryRoomConnect(roomPeerId);
  });

  // Вся логика обработки (hello, data, close) — через handleConnection
  handleConnection(conn);
}

function retryRoomConnect(roomPeerId) {
  roomRetries++;
  if (roomRetries <= MAX_ROOM_RETRIES) {
    const delay = roomRetries * 2000;
    dlog('retry room in ' + delay + 'ms (' + roomRetries + '/' + MAX_ROOM_RETRIES + ')', 'warn');
    setStatus('комната не найдена, повтор ' + roomRetries + '/' + MAX_ROOM_RETRIES);
    setTimeout(() => connectToRoom(roomPeerId), delay);
  } else {
    dlog('room connect failed after ' + MAX_ROOM_RETRIES + ' attempts', 'error');
    setStatus('комната не найдена');
    // Возвращаем на главный экран
    chatScreen.classList.add('hidden');
    roomScreen.classList.add('hidden');
    connectScreen.classList.remove('hidden');
    window.history.replaceState(null, '', window.location.pathname);
  }
}
