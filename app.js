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
const connections = new Map(); // peerId -> { conn, nickname }

// Настройки
let typewriterEnabled = true; // анимация посимвольного ввода

// Таймеры "печатает"
const typingTimers = new Map(); // peerId -> timeoutId

// --- Пиксельная аватарка 4x4 из хэша никнейма ---
function generateAvatar(nickname) {
  // Простой хэш из строки
  let hash = 0;
  for (let i = 0; i < nickname.length; i++) {
    hash = ((hash << 5) - hash + nickname.charCodeAt(i)) | 0;
  }

  // Цвет из хэша (тёплая палитра)
  const hue = Math.abs(hash % 360);
  const color = 'hsl(' + hue + ', 55%, 55%)';
  const bgColor = 'hsl(' + hue + ', 30%, 25%)';

  // Генерируем симметричный паттерн 4x4 (зеркалим по горизонтали)
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 4;
  const ctx = canvas.getContext('2d');

  // Заливка фона
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, 4, 4);

  // Рисуем пиксели (левая половина + зеркало)
  ctx.fillStyle = color;
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 2; x++) {
      // Используем биты хэша для определения пикселя
      const bit = (Math.abs(hash >> (y * 2 + x)) & 1);
      if (bit) {
        ctx.fillRect(x, y, 1, 1);
        ctx.fillRect(3 - x, y, 1, 1); // зеркало
      }
    }
    hash = ((hash << 3) ^ (hash >> 2)) | 0; // перемешиваем биты
  }

  return canvas.toDataURL();
}

// --- 8-битный звук уведомления (Web Audio API) ---
let audioCtx = null;

function playNotificationSound() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }

  const now = audioCtx.currentTime;

  // Мягкий 8-битный "блинк" — две ноты
  [440, 587].forEach((freq, i) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = 'square'; // 8-битный звук
    osc.frequency.setValueAtTime(freq, now + i * 0.1);

    gain.gain.setValueAtTime(0.08, now + i * 0.1);
    gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.1 + 0.15);

    osc.connect(gain);
    gain.connect(audioCtx.destination);

    osc.start(now + i * 0.1);
    osc.stop(now + i * 0.1 + 0.15);
  });
}

// --- Время в формате HH:MM:SS ---
function getTimeString() {
  const now = new Date();
  return now.toTimeString().substring(0, 8);
}

// --- Эффект посимвольной печати ---
function typewriterEffect(element, text, callback) {
  if (!typewriterEnabled) {
    element.textContent = text;
    if (callback) callback();
    return;
  }

  let i = 0;
  const speed = Math.max(10, Math.min(30, 600 / text.length)); // адаптивная скорость

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
  setStatus('комната ' + roomId + ' — ожидание');

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

// --- Обработка соединения ---
function handleConnection(conn) {
  conn.on('open', () => {
    connections.set(conn.peer, { conn: conn, nickname: null });

    sendTo(conn, { type: 'hello', nickname: myNickname });

    // Хост отправляет список пиров новичку
    if (isHost) {
      const peerList = [];
      for (const [peerId] of connections) {
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
    let parsed = null;
    if (typeof raw === 'string') {
      try { parsed = JSON.parse(raw); } catch (e) { /* обычный текст */ }
    }

    if (parsed && parsed.type === 'hello') {
      const entry = connections.get(conn.peer);
      if (entry) entry.nickname = parsed.nickname;
      addSystemMessage(parsed.nickname + ' подключился');
      updateOnlineCount();
      return;
    }

    if (parsed && parsed.type === 'peers') {
      for (const peerId of parsed.list) {
        if (!connections.has(peerId) && peerId !== peer.id) {
          connectToPeer(peerId);
        }
      }
      return;
    }

    if (parsed && parsed.type === 'msg') {
      addMessage(parsed.nickname, parsed.text);
      playNotificationSound();
      return;
    }

    if (parsed && parsed.type === 'typing') {
      showTypingIndicator(parsed.nickname, conn.peer);
      return;
    }

    // Обычный текст
    const entry = connections.get(conn.peer);
    const author = (entry && entry.nickname) || conn.peer;
    addMessage(author, raw);
    playNotificationSound();
  });

  conn.on('close', () => {
    const entry = connections.get(conn.peer);
    const name = (entry && entry.nickname) || conn.peer;
    connections.delete(conn.peer);
    clearTypingTimer(conn.peer);
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

// --- Индикатор "печатает" ---
function showTypingIndicator(nickname, peerId) {
  typingNick.textContent = nickname + ' печатает';
  typingIndicator.classList.remove('hidden');

  // Сбрасываем предыдущий таймер
  clearTypingTimer(peerId);

  // Скрываем через 2 секунды без активности
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
  // Если больше никто не печатает — скрываем
  if (typingTimers.size === 0) {
    typingIndicator.classList.add('hidden');
  }
}

// --- Отправка "печатает" при наборе ---
let typingTimeout = null;

function onTyping() {
  if (connections.size === 0) return;

  // Не спамим — отправляем не чаще раза в секунду
  if (typingTimeout) return;

  broadcast({ type: 'typing', nickname: myNickname });

  typingTimeout = setTimeout(() => {
    typingTimeout = null;
  }, 1000);
}

// --- Служебная отправка ---
function sendTo(conn, obj) {
  conn.send(JSON.stringify(obj));
}

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
  const total = connections.size + 1;
  onlineCountEl.textContent = total + ' online';
}

// --- Отправка сообщения ---
function sendMessage() {
  const text = msgInput.value.trim();
  if (!text || connections.size === 0) return;

  broadcast({ type: 'msg', nickname: myNickname, text: text });
  addMessage(myNickname, text, true);
  msgInput.value = '';
}

// --- Отображение сообщений ---
function addMessage(author, text, isMe = false) {
  const div = document.createElement('div');
  div.className = 'msg';

  // Аватарка
  const avatar = document.createElement('img');
  avatar.className = 'msg-avatar';
  avatar.src = generateAvatar(author);
  avatar.alt = author;

  // Тело сообщения
  const body = document.createElement('div');
  body.className = 'msg-body';

  // Заголовок: автор + время
  const header = document.createElement('div');
  header.className = 'msg-header';
  header.innerHTML =
    '<span class="author ' + (isMe ? 'me' : '') + '">' + escapeHtml(author) + '</span>' +
    '<span class="time">' + getTimeString() + '</span>';

  // Текст сообщения
  const textEl = document.createElement('span');
  textEl.className = 'text';

  body.appendChild(header);
  body.appendChild(textEl);
  div.appendChild(avatar);
  div.appendChild(body);
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  // Печатаем с эффектом или без
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

// Отслеживаем набор текста для индикатора
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

// Переключение анимации печати
typewriterToggle.addEventListener('click', () => {
  typewriterEnabled = !typewriterEnabled;
  typewriterToggle.classList.toggle('active', typewriterEnabled);
  typewriterToggle.textContent = typewriterEnabled ? '▸ anim' : '▹ anim';
});

// Начальное состояние кнопки
typewriterToggle.classList.toggle('active', typewriterEnabled);

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
