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

// --- Состояние ---
let peer = null;
let isHost = false;
let roomId = null;
const myNickname = generateId();
// peerId -> { conn, nickname, sharedKey (CryptoKey), publicKeyRaw }
const connections = new Map();

// Настройки
let typewriterEnabled = true;
const FILE_MAX_SIZE = 50 * 1024 * 1024;
const CHUNK_SIZE = 16000;

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
function showChat() {
  connectScreen.classList.add('hidden');
  roomScreen.classList.add('hidden');
  chatScreen.classList.remove('hidden');
  if (roomId) {
    roomIdDisplay.textContent = '# ' + roomId;
  } else {
    roomIdDisplay.textContent = '# direct';
  }
  msgInput.focus();
}

// --- Инициализация PeerJS ---
let peerRetries = 0;
const MAX_PEER_RETRIES = 3;

// Конфигурация PeerJS с явными параметрами
const PEER_CONFIG = {
  secure: true,
  debug: 0,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  }
};

function initPeer(peerId, onOpen) {
  dlog('initPeer: id=' + peerId + ', retry=' + peerRetries);
  peer = new Peer(peerId, PEER_CONFIG);

  // Таймаут подключения к signaling-серверу (10 сек)
  const connectTimeout = setTimeout(() => {
    if (!peer.open && !peer.destroyed) {
      if (peerRetries < MAX_PEER_RETRIES) {
        peerRetries++;
        dlog('signaling timeout, retry ' + peerRetries, 'warn');
        setStatus('signaling не отвечает, повтор ' + peerRetries + '/' + MAX_PEER_RETRIES);
        peer.destroy();
        initPeer(peerId, onOpen);
      } else {
        dlog('signaling failed after ' + MAX_PEER_RETRIES + ' retries', 'error');
        setStatus('signaling недоступен');
      }
    }
  }, 10000);

  peer.on('open', (id) => {
    clearTimeout(connectTimeout);
    peerRetries = 0;
    dlog('peer.open: id=' + id, 'ok');
    myIdEl.textContent = myNickname;
    myIdCopyEl.textContent = myNickname;
    setStatus('online — ожидание');
    if (onOpen) onOpen(id);
  });

  peer.on('connection', (incoming) => {
    dlog('incoming connection from ' + incoming.peer);
    handleConnection(incoming);
  });

  peer.on('error', (err) => {
    clearTimeout(connectTimeout);
    dlog('peer.error: type=' + err.type + ' msg=' + err.message, 'error');
    if (err.type === 'unavailable-id') {
      peer.destroy();
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

  peer.on('disconnected', () => {
    dlog('peer.disconnected (destroyed=' + peer.destroyed + ')', 'warn');
    if (peer.destroyed) return;
    setStatus('отключён, переподключение...');
    setTimeout(() => {
      if (!peer.destroyed && !peer.open) {
        dlog('attempting reconnect...');
        peer.reconnect();
      }
    }, 2000);
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
  roomId = generateRoomId();
  isHost = true;
  peer.destroy();
  initPeer(roomId, onOpenAsHost);
}

function connectToPeer(remotePeerId) {
  const id = remotePeerId.trim();
  if (!id || connections.has(id)) return;
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

// --- Обработка соединения ---
function handleConnection(conn) {
  conn.on('open', () => {
    connections.set(conn.peer, { conn: conn, nickname: null, sharedKey: null, publicKeyRaw: null });

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
    updateOnlineCount();
    setStatus('подключён — ' + connections.size + ' пир(ов)');
  });

  conn.on('data', async (raw) => {
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
        // Вычисляем shared key
        if (parsed.publicKey) {
          try {
            entry.sharedKey = await deriveSharedKey(parsed.publicKey);
            const fp = getFingerprint(parsed.publicKey);
            addSystemMessage(parsed.nickname + ' подключился 🔒 [' + fp + ']');
            updateLockIcon();
          } catch (e) {
            addSystemMessage(parsed.nickname + ' подключился (без шифрования)');
          }
        } else {
          addSystemMessage(parsed.nickname + ' подключился (без шифрования)');
        }
      }
      updateOnlineCount();
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

    // Всё остальное — обрабатываем как нешифрованное (fallback)
    await handleDecryptedMessage(conn, parsed);
  });

  conn.on('close', () => {
    const entry = connections.get(conn.peer);
    const name = (entry && entry.nickname) || conn.peer;
    connections.delete(conn.peer);
    clearTypingTimer(conn.peer);
    addSystemMessage(name + ' отключился');
    updateOnlineCount();
    updateLockIcon();
    setStatus(connections.size > 0
      ? 'подключён — ' + connections.size + ' пир(ов)'
      : 'все отключились');
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

// --- Счётчик онлайн ---
function updateOnlineCount() {
  const total = connections.size + 1;
  onlineCountEl.textContent = total + ' online';
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
}

function addSystemMessage(text) {
  const div = document.createElement('div');
  div.className = 'msg-system';
  div.textContent = '> ' + text + ' [' + getTimeString() + ']';
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
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

createRoomBtn.addEventListener('click', createRoom);

connectBtn.addEventListener('click', () => {
  connectToPeer(peerIdInput.value);
});

peerIdInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') connectToPeer(peerIdInput.value);
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
  for (const [, entry] of connections) entry.conn.close();
  if (peer) peer.destroy();
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

  const inviteOnStart = checkInviteLink();
  if (inviteOnStart) {
    roomId = inviteOnStart;
    initPeer(myNickname + '-' + Math.random().toString(16).substring(2, 4), () => {
      connectToPeer(inviteOnStart);
    });
  } else {
    initPeer(myNickname);
  }
})();
