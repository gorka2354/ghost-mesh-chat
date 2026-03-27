// === Ghost Mesh Chat — state.js (глобальные переменные и утилиты) ===

// --- Элементы DOM ---
const myIdEl = document.getElementById('my-id');
const myIdCopyEl = document.getElementById('my-id-copy');
const peerIdInput = document.getElementById('peer-id-input');
const connectBtn = document.getElementById('connect-btn');
const createRoomBtn = document.getElementById('create-room-btn');
const connectScreen = document.getElementById('connect-screen');
const inviteLinkEl = document.getElementById('invite-link');
const inviteBar = document.getElementById('invite-bar');
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
const voiceBtn = document.getElementById('voice-btn');

// --- Debug-логирование ---
function dlog(msg, level = 'info') {
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
let myAvatarData = null;
// peerId -> { conn, nickname, sharedKey (CryptoKey), publicKeyRaw, chatId, silent, fromGrace }
const connections = new Map();

// Возвращает только соединения текущего чата (по chatId)
function chatConnections() {
  const cid = getChatId();
  if (!cid) return [];
  const result = [];
  for (const [peerId, entry] of connections) {
    if (entry.chatId === cid) result.push([peerId, entry]);
  }
  return result;
}

function chatConnectionsCount() {
  return chatConnections().length;
}

// Настройки
let typewriterEnabled = true;
const FILE_MAX_SIZE = 50 * 1024 * 1024;
const CHUNK_SIZE = 16000;

// ChatId — стабильный ключ для группировки сообщений
let currentChatId = null;

function getChatId() {
  if (currentChatId) return currentChatId;
  if (roomId) return roomId;
  return null;
}

function updateChatId(connEntry) {
  if (roomId) {
    currentChatId = roomId;
  } else if (connEntry && connEntry.nickname) {
    const nicks = [myNickname, connEntry.nickname].sort();
    currentChatId = 'dm:' + nicks.join(',');
  }
  dlog('chatId: ' + currentChatId);
}

// Генерация уникального ID сообщения
function generateMsgId() {
  return Date.now() + '-' + Math.random().toString(36).substring(2, 8);
}

// Флаг загруженности истории
let historyLoaded = false;

// Общие Map-ы (используются в нескольких модулях)
const peerGraceTimers = new Map();   // graceKey → { timer, reconnectCount, nickname, peerId, publicKeyRaw }
const typingTimers = new Map();      // peerId → timeoutId
const incomingFiles = new Map();     // transferId → { meta, chunks, received, progressEl }
const peerAvatars = new Map();       // nickname → avatarData

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

function setStatus(text) {
  statusEl.textContent = '[ ' + text + ' ]';
}

function getTimeString() {
  return new Date().toTimeString().substring(0, 8);
}
