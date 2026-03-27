// === Ghost Mesh Chat — ui.js (UI-рендеринг и взаимодействие) ===

// --- Пиксельная аватарка ---
function generateAvatar(nickname, avatarData) {
  const data = avatarData || (nickname === myNickname ? myAvatarData : null) || peerAvatars.get(nickname);
  if (data && data.length === 64) {
    const canvas = document.createElement('canvas');
    canvas.width = 8;
    canvas.height = 8;
    const ctx = canvas.getContext('2d');
    for (let i = 0; i < 64; i++) {
      ctx.fillStyle = data[i];
      ctx.fillRect(i % 8, Math.floor(i / 8), 1, 1);
    }
    return canvas.toDataURL();
  }
  // Фоллбэк: генерация из хэша ника (4x4 зеркальный)
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

// --- Browser Notifications ---
function showBrowserNotification(author, text) {
  if (!document.hidden) return; // вкладка активна — не нужно
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const n = new Notification(author, {
    body: text,
    icon: './icon.svg',
    tag: 'ghost-mesh-msg' // заменяет предыдущее уведомление, не спамит
  });
  n.onclick = () => {
    window.focus();
    n.close();
  };
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
  chatScreen.classList.remove('hidden');
  if (!(isHost && roomId)) hideInviteBar();
  if (roomId) {
    roomIdDisplay.textContent = '# ' + roomId;
  } else if (currentChatId && currentChatId.startsWith('dm:')) {
    const nicks = currentChatId.replace('dm:', '').split(',');
    const other = nicks.find(n => n !== myNickname) || 'direct';
    roomIdDisplay.textContent = '@ ' + other;
  } else {
    roomIdDisplay.textContent = '# direct';
  }
}

function setChatInputEnabled(enabled) {
  msgInput.disabled = !enabled;
  sendBtn.disabled = !enabled;
  voiceBtn.disabled = !enabled;
  document.getElementById('file-btn').classList.toggle('disabled', !enabled);
}

// --- Invite-bar ---
function showInviteBar() {
  const link = window.location.origin + window.location.pathname + '#' + roomId;
  inviteLinkEl.textContent = link;
  inviteBar.classList.remove('hidden');
}

function hideInviteBar() {
  inviteBar.classList.add('hidden');
}

function onOpenAsHost() {
  showInviteBar();
  showChat();
  setChatInputEnabled(false);
  setStatus('комната ' + roomId + ' — ожидание');
  window.history.replaceState(null, '', '#' + roomId);
}

function createRoom() {
  teardownChatSession();
  roomId = generateRoomId();
  isHost = true;
  currentChatId = roomId;
  if (peer && !peer.destroyed) peer.destroy();
  initPeer(roomId, () => {
    onOpenAsHost();
    saveRoom(roomId, { name: '# ' + roomId, mode: 'room', isHost: true, roomId: roomId, lastTs: Date.now(), peers: [] });
  });
}

// --- Отрисовка истории из IndexedDB ---
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

// Загрузка истории — вызывается после hello, когда chatId стабилен
function loadChatHistory() {
  if (historyLoaded) return;
  const chatId = getChatId();
  if (!chatId) return;
  historyLoaded = true;

  loadHistory(chatId).then(msgs => {
    if (msgs.length > 0) {
      dlog('history: loaded ' + msgs.length + ' messages for ' + chatId, 'ok');
      const existing = messagesEl.innerHTML;
      messagesEl.innerHTML = '';
      renderHistory(msgs);
      messagesEl.insertAdjacentHTML('beforeend', existing);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  });
  msgInput.focus();
}

// --- Отправка и отображение сообщений ---
function sendMessage() {
  const text = msgInput.value.trim();
  if (!text || chatConnectionsCount() === 0) return;
  broadcastEncrypted({ type: 'msg', nickname: myNickname, text: text });
  addMessage(myNickname, text, true);
  msgInput.value = '';
}

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

// --- Иконка замка ---
function updateLockIcon() {
  if (!lockIcon) return;
  const cc = chatConnections();
  let allEncrypted = cc.length > 0;
  for (const [, entry] of cc) {
    if (!entry.sharedKey) {
      allEncrypted = false;
      break;
    }
  }
  if (allEncrypted) {
    lockIcon.textContent = '🔒';
    lockIcon.title = 'E2E зашифровано (AES-256-GCM)';
    lockIcon.className = 'lock-on';
  } else if (cc.length > 0) {
    lockIcon.textContent = '🔓';
    lockIcon.title = 'Частично зашифровано';
    lockIcon.className = 'lock-partial';
  } else {
    lockIcon.textContent = '';
    lockIcon.className = '';
  }
}

// --- Счётчик онлайн ---
function updateOnlineCount() {
  const connected = chatConnectionsCount();
  const inGrace = peerGraceTimers.size;
  const total = connected + 1;
  if (connected === 0 && inGrace === 0) {
    onlineCountEl.textContent = 'оффлайн';
  } else if (inGrace > 0) {
    onlineCountEl.textContent = total + ' online (+' + inGrace + ' reconnecting)';
  } else {
    onlineCountEl.textContent = total + ' online';
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
  if (chatConnectionsCount() === 0) return;
  if (typingTimeout) return;
  broadcastEncrypted({ type: 'typing', nickname: myNickname });
  typingTimeout = setTimeout(() => { typingTimeout = null; }, 1000);
}

// --- Голосовые сообщения ---
let mediaRecorder = null;
let audioChunks = [];
let recordingStartTime = 0;

// Начать/остановить запись
voiceBtn.addEventListener('click', async () => {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    voiceBtn.classList.remove('recording');
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
      stream.getTracks().forEach(t => t.stop());

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

  const voiceCard = document.createElement('div');
  voiceCard.className = 'voice-card';

  const playBtn = document.createElement('button');
  playBtn.className = 'voice-play-btn';
  playBtn.textContent = '▶';

  const waveform = document.createElement('div');
  waveform.className = 'voice-waveform';
  const barCount = Math.min(Math.max(8, duration * 4), 32);
  const bars = [];
  for (let i = 0; i < barCount; i++) {
    const bar = document.createElement('div');
    bar.className = 'voice-bar';
    const h = 6 + Math.abs(Math.sin(i * 1.7 + duration) * 18);
    bar.style.height = h + 'px';
    waveform.appendChild(bar);
    bars.push(bar);
  }

  const durEl = document.createElement('span');
  durEl.className = 'voice-duration';
  durEl.textContent = formatDuration(duration);

  voiceCard.appendChild(playBtn);
  voiceCard.appendChild(waveform);
  voiceCard.appendChild(durEl);

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

// --- Передача файлов ---
function sendFile(file) {
  if (!file || chatConnectionsCount() === 0) return;

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

// --- Список чатов ---
function formatRoomTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (now - d < 86400000 && d.getDate() === now.getDate()) {
    return d.toTimeString().substring(0, 5);
  }
  if (now - d < 172800000) return 'вчера';
  return d.getDate() + '.' + (d.getMonth() + 1).toString().padStart(2, '0');
}

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

// --- Drag & drop ---
let dragCounter = 0;

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
