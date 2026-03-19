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
let conn = null;
let isHost = false;
let roomId = null;
const myNickname = generateId(); // никнейм — всегда ghost-XXXX
let peerNickname = null;         // никнейм собеседника

// --- Проверяем hash в URL (приглашение) ---
function checkInviteLink() {
  const hash = window.location.hash.substring(1);
  if (hash && hash.startsWith('room-')) {
    return hash;
  }
  return null;
}

// --- Инициализация PeerJS ---
function initPeer(peerId, onOpen) {
  peer = new Peer(peerId);

  peer.on('open', (id) => {
    myIdEl.textContent = myNickname;
    myIdCopyEl.textContent = myNickname;
    setStatus('online — ожидание');

    if (onOpen) onOpen(id);
  });

  // Входящее соединение
  peer.on('connection', (incoming) => {
    conn = incoming;
    setupConnection();
  });

  peer.on('error', (err) => {
    if (err.type === 'unavailable-id') {
      peer.destroy();
      // Если хост — пробуем другой room ID
      if (isHost) {
        roomId = generateRoomId();
        initPeer(roomId, onOpenAsHost);
      } else {
        initPeer(generateId() + '-' + Math.random().toString(16).substring(2, 4));
      }
      return;
    }
    if (err.type === 'peer-unavailable') {
      setStatus('собеседник не найден');
      addSystemMessage('не удалось подключиться — ID не найден');
      return;
    }
    setStatus('ошибка: ' + err.type);
  });

  peer.on('disconnected', () => {
    setStatus('отключён от signaling');
  });
}

// --- Колбэк при открытии как хост ---
function onOpenAsHost() {
  const link = window.location.origin + window.location.pathname + '#' + roomId;
  inviteLinkEl.textContent = link;

  connectScreen.classList.add('hidden');
  roomScreen.classList.remove('hidden');
  setStatus('комната ' + roomId + ' — ожидание гостей');

  window.history.replaceState(null, '', '#' + roomId);
}

// --- Создание комнаты ---
function createRoom() {
  roomId = generateRoomId();
  isHost = true;

  // Пересоздаём peer с room ID — чтобы гости подключались по нему
  peer.destroy();
  initPeer(roomId, onOpenAsHost);
}

// --- Подключение к собеседнику ---
function connectToPeer(remotePeerId) {
  const id = remotePeerId.trim();
  if (!id) return;

  conn = peer.connect(id, { reliable: true });
  setupConnection();
}

// --- Настройка соединения ---
function setupConnection() {
  conn.on('open', () => {
    // Отправляем свой никнейм как первое служебное сообщение
    conn.send(JSON.stringify({ type: 'hello', nickname: myNickname }));

    // Переключаемся на экран чата
    connectScreen.classList.add('hidden');
    roomScreen.classList.add('hidden');
    chatScreen.classList.remove('hidden');

    // Показываем ID комнаты в заголовке
    if (roomId) {
      roomIdDisplay.textContent = '# ' + roomId;
    } else {
      roomIdDisplay.textContent = '# direct';
    }
    updateOnlineCount(1);

    setStatus('подключён');
    msgInput.focus();
  });

  conn.on('data', (raw) => {
    // Пробуем распарсить как служебное сообщение
    let parsed = null;
    if (typeof raw === 'string') {
      try { parsed = JSON.parse(raw); } catch (e) { /* обычный текст */ }
    }

    if (parsed && parsed.type === 'hello') {
      // Получили никнейм собеседника
      peerNickname = parsed.nickname;
      addSystemMessage('подключился ' + peerNickname);
      setStatus('подключён к ' + peerNickname);
      return;
    }

    // Обычное сообщение
    const author = peerNickname || conn.peer;
    addMessage(author, raw);
  });

  conn.on('close', () => {
    const name = peerNickname || conn.peer;
    addSystemMessage(name + ' отключился');
    setStatus('отключён');
    updateOnlineCount(0);
    peerNickname = null;
  });

  conn.on('error', (err) => {
    addSystemMessage('ошибка соединения: ' + err);
  });
}

// --- Счётчик онлайн ---
function updateOnlineCount(peers) {
  const total = peers + 1;
  onlineCountEl.textContent = total + ' online';
}

// --- Отправка сообщения ---
function sendMessage() {
  const text = msgInput.value.trim();
  if (!text || !conn || !conn.open) return;

  conn.send(text);
  addMessage(myNickname, text, true);
  msgInput.value = '';
}

// --- Отображение сообщений ---
function addMessage(author, text, isMe = false) {
  const div = document.createElement('div');
  div.className = 'msg';
  div.innerHTML =
    '<span class="author ' + (isMe ? 'me' : '') + '">' + escapeHtml(author) + '</span> ' +
    '<span class="text">' + escapeHtml(text) + '</span>';
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addSystemMessage(text) {
  const div = document.createElement('div');
  div.className = 'msg-system';
  div.textContent = '> ' + text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
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

myIdCopyEl.addEventListener('click', () => {
  copyToClipboard(myIdCopyEl.textContent, myIdCopyEl);
});

copyLinkBtn.addEventListener('click', () => {
  copyToClipboard(inviteLinkEl.textContent, inviteLinkEl);
});

inviteLinkEl.addEventListener('click', () => {
  copyToClipboard(inviteLinkEl.textContent, inviteLinkEl);
});

// --- Старт ---
const inviteOnStart = checkInviteLink();
if (inviteOnStart) {
  roomId = inviteOnStart;
  // Инициализируемся со своим случайным ID, потом подключаемся к комнате
  initPeer(myNickname + '-' + Math.random().toString(16).substring(2, 4), () => {
    connectToPeer(inviteOnStart);
  });
} else {
  initPeer(myNickname);
}
