// === Ghost Mesh Chat — app.js (обработчики событий и запуск) ===

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
    for (const [, entry] of chatConnections()) {
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

// --- Обработка смены сети ---
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

// --- Возврат на вкладку ---
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    dlog('visibility: вкладка активна', 'info');
    if (peer && !peer.destroyed && !peer.open) {
      dlog('visibility: signaling отвалился, переинициализация', 'warn');
      reinitPeer();
    } else if (peer && peer.open) {
      setSignalingStatus('online');
      checkAllConnections();
    }
  }
});

// --- Debug-панель ---
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

// --- Старт ---
(async function start() {
  dlog('start: userAgent=' + navigator.userAgent);
  dlog('start: url=' + location.href);

  try {
    await openDB();
  } catch (e) {
    dlog('IndexedDB unavailable, history disabled', 'warn');
  }

  // Запрашиваем разрешение на уведомления (ненавязчиво, только если ещё не решено)
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().then(p => {
      dlog('notifications: ' + p, p === 'granted' ? 'ok' : 'warn');
    });
  }

  const savedProfile = await loadProfileFromDB();
  if (savedProfile) {
    if (savedProfile.nickname) {
      myNickname = savedProfile.nickname;
      try { localStorage.setItem('ghost-nickname', myNickname); } catch (e) {}
    }
    if (savedProfile.avatarData) {
      myAvatarData = savedProfile.avatarData;
    }
    dlog('profile loaded: ' + myNickname, 'ok');
  }

  try {
    setStatus('загрузка ключей...');
    dlog('loading/generating ECDH keys...');
    await loadOrCreateKeys();
    setStatus('ключи готовы, подключение...');
  } catch (e) {
    dlog('crypto error: ' + e.message, 'error');
    setStatus('crypto недоступен, без шифрования');
    myPublicKeyJwk = null;
  }

  await renderRoomsList();

  const inviteHash = checkInviteLink();

  if (inviteHash) {
    roomId = inviteHash;
    dlog('invite link: ' + inviteHash);
    initPeer(myNickname, () => {
      connectToRoom(inviteHash);
      window.history.replaceState(null, '', window.location.pathname);
    });
  } else {
    initPeer(myNickname);
  }
})();
