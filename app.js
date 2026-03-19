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
let isHost = false;
let roomId = null;
const myNickname = generateId();

// Все активные соединения: peerId -> { conn, nickname }
const connections = new Map();

// --- Проверяем hash в URL (приглашение) ---
function checkInviteLink() {
  const hash = window.location.hash.substring(1);
  if (hash && hash.startsWith('room-')) {
    return hash;
  }
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
    handleConnection(incoming);
  });

  peer.on('error', (err) => {
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

  peer.destroy();
  initPeer(roomId, onOpenAsHost);
}

// --- Подключение к конкретному peer ID ---
function connectToPeer(remotePeerId) {
  const id = remotePeerId.trim();
  if (!id || connections.has(id)) return;

  const conn = peer.connect(id, { reliable: true });
  handleConnection(conn);
}

// --- Обработка соединения (входящего или исходящего) ---
function handleConnection(conn) {
  conn.on('open', () => {
    // Сохраняем соединение (никнейм придёт позже в hello)
    connections.set(conn.peer, { conn: conn, nickname: null });

    // Отправляем свой никнейм
    sendTo(conn, { type: 'hello', nickname: myNickname });

    // Если мы хост — отправляем новичку список всех пиров в комнате
    if (isHost) {
      const peerList = [];
      for (const [peerId, data] of connections) {
        // Не отправляем новичку его же ID
        if (peerId !== conn.peer) {
          peerList.push(peerId);
        }
      }
      if (peerList.length > 0) {
        sendTo(conn, { type: 'peers', list: peerList });
      }
    }

    showChat();
    updateOnlineCount();
    setStatus('подключён — ' + connections.size + ' пир(ов)');
  });

  conn.on('data', (raw) => {
    // Парсим служебные сообщения
    let parsed = null;
    if (typeof raw === 'string') {
      try { parsed = JSON.parse(raw); } catch (e) { /* обычный текст */ }
    }

    if (parsed && parsed.type === 'hello') {
      // Сохраняем никнейм пира
      const entry = connections.get(conn.peer);
      if (entry) entry.nickname = parsed.nickname;
      addSystemMessage(parsed.nickname + ' подключился');
      updateOnlineCount();
      return;
    }

    if (parsed && parsed.type === 'peers') {
      // Получили список пиров от хоста — подключаемся к каждому
      for (const peerId of parsed.list) {
        if (!connections.has(peerId) && peerId !== peer.id) {
          connectToPeer(peerId);
        }
      }
      return;
    }

    if (parsed && parsed.type === 'msg') {
      // Сообщение от пира
      addMessage(parsed.nickname, parsed.text);
      return;
    }

    // Обычный текст (обратная совместимость)
    const entry = connections.get(conn.peer);
    const author = (entry && entry.nickname) || conn.peer;
    addMessage(author, raw);
  });

  conn.on('close', () => {
    const entry = connections.get(conn.peer);
    const name = (entry && entry.nickname) || conn.peer;
    connections.delete(conn.peer);
    addSystemMessage(name + ' отключился');
    updateOnlineCount();
    setStatus(connections.size > 0
      ? 'подключён — ' + connections.size + ' пир(ов)'
      : 'все отключились');
  });

  conn.on('error', (err) => {
    addSystemMessage('ошибка соединения с ' + conn.peer + ': ' + err);
  });
}

// --- Отправка служебного сообщения конкретному пиру ---
function sendTo(conn, obj) {
  conn.send(JSON.stringify(obj));
}

// --- Broadcast — отправка всем подключённым пирам ---
function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const [peerId, entry] of connections) {
    if (entry.conn.open) {
      entry.conn.send(data);
    }
  }
}

// --- Счётчик онлайн ---
function updateOnlineCount() {
  const total = connections.size + 1; // +1 за себя
  onlineCountEl.textContent = total + ' online';
}

// --- Отправка сообщения ---
function sendMessage() {
  const text = msgInput.value.trim();
  if (!text || connections.size === 0) return;

  // Отправляем всем как структурированное сообщение
  broadcast({ type: 'msg', nickname: myNickname, text: text });
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

// --- Корректное отключение при закрытии вкладки ---
window.addEventListener('beforeunload', () => {
  for (const [peerId, entry] of connections) {
    entry.conn.close();
  }
  if (peer) peer.destroy();
});

// --- Старт ---
const inviteOnStart = checkInviteLink();
if (inviteOnStart) {
  roomId = inviteOnStart;
  initPeer(myNickname + '-' + Math.random().toString(16).substring(2, 4), () => {
    connectToPeer(inviteOnStart);
  });
} else {
  initPeer(myNickname);
}
