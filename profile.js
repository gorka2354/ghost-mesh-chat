// === Ghost Mesh Chat — profile.js (профиль и аватар) ===

const AVATAR_SIZE = 8;
const AVATAR_PALETTE = [
  '#1a1b26', '#3b4261', '#565f89', '#787c99',
  '#9ece6a', '#7aa2f7', '#bb9af7', '#f7768e',
  '#ff9e64', '#e0af68', '#d4a574', '#e8d4b8',
  '#2ac3de', '#73daca', '#ffffff'
];

const profileModal = document.getElementById('profile-modal');
const profileBtn = document.getElementById('profile-btn');
const profileClose = document.getElementById('profile-close');
const profileSave = document.getElementById('profile-save');
const profileNickname = document.getElementById('profile-nickname');
const profileFingerprint = document.getElementById('profile-fingerprint');
const avatarPreview = document.getElementById('avatar-preview');
const avatarCanvas = document.getElementById('avatar-canvas');
const avatarPalette = document.getElementById('avatar-palette');
const avatarMirror = document.getElementById('avatar-mirror');
const avatarRandomize = document.getElementById('avatar-randomize');
const avatarClear = document.getElementById('avatar-clear');

let editorPixels = new Array(AVATAR_SIZE * AVATAR_SIZE).fill(AVATAR_PALETTE[0]);
let selectedColor = AVATAR_PALETTE[7];
let isDrawing = false;

// Инициализация палитры
AVATAR_PALETTE.forEach(color => {
  const el = document.createElement('div');
  el.className = 'palette-color' + (color === selectedColor ? ' active' : '');
  el.style.background = color;
  el.addEventListener('click', () => {
    avatarPalette.querySelector('.active')?.classList.remove('active');
    el.classList.add('active');
    selectedColor = color;
  });
  avatarPalette.appendChild(el);
});

// Рендер пикселей на canvas
function renderEditor() {
  const ctx = avatarCanvas.getContext('2d');
  for (let i = 0; i < editorPixels.length; i++) {
    const x = i % AVATAR_SIZE;
    const y = Math.floor(i / AVATAR_SIZE);
    ctx.fillStyle = editorPixels[i];
    ctx.fillRect(x, y, 1, 1);
  }
  const pCtx = avatarPreview.getContext('2d');
  pCtx.drawImage(avatarCanvas, 0, 0);
}

// Рисование на canvas
function paintPixel(e) {
  const rect = avatarCanvas.getBoundingClientRect();
  const scaleX = AVATAR_SIZE / rect.width;
  const scaleY = AVATAR_SIZE / rect.height;
  const x = Math.floor((e.clientX - rect.left) * scaleX);
  const y = Math.floor((e.clientY - rect.top) * scaleY);
  if (x < 0 || x >= AVATAR_SIZE || y < 0 || y >= AVATAR_SIZE) return;
  editorPixels[y * AVATAR_SIZE + x] = selectedColor;
  if (avatarMirror.checked) {
    const mx = AVATAR_SIZE - 1 - x;
    editorPixels[y * AVATAR_SIZE + mx] = selectedColor;
  }
  renderEditor();
}

avatarCanvas.addEventListener('mousedown', (e) => { isDrawing = true; paintPixel(e); });
avatarCanvas.addEventListener('mousemove', (e) => { if (isDrawing) paintPixel(e); });
window.addEventListener('mouseup', () => { isDrawing = false; });

// Touch support
avatarCanvas.addEventListener('touchstart', (e) => {
  e.preventDefault(); isDrawing = true;
  paintPixel(e.touches[0]);
});
avatarCanvas.addEventListener('touchmove', (e) => {
  e.preventDefault();
  if (isDrawing) paintPixel(e.touches[0]);
});
avatarCanvas.addEventListener('touchend', () => { isDrawing = false; });

// Рандомизация аватара
function randomizeAvatar() {
  const bg = AVATAR_PALETTE[Math.floor(Math.random() * 4)];
  const fg = AVATAR_PALETTE[4 + Math.floor(Math.random() * (AVATAR_PALETTE.length - 4))];
  editorPixels.fill(bg);
  for (let y = 0; y < AVATAR_SIZE; y++) {
    for (let x = 0; x < Math.ceil(AVATAR_SIZE / 2); x++) {
      if (Math.random() > 0.5) {
        editorPixels[y * AVATAR_SIZE + x] = fg;
        editorPixels[y * AVATAR_SIZE + (AVATAR_SIZE - 1 - x)] = fg;
      }
    }
  }
  renderEditor();
}

avatarRandomize.addEventListener('click', randomizeAvatar);
avatarClear.addEventListener('click', () => {
  editorPixels.fill(AVATAR_PALETTE[0]);
  renderEditor();
});

// Открытие/закрытие модалки
function openProfileModal() {
  profileNickname.value = myNickname;
  if (myPublicKeyJwk) {
    profileFingerprint.textContent = getFingerprint(myPublicKeyJwk);
  }
  if (myAvatarData) {
    editorPixels = [...myAvatarData];
  } else {
    randomizeAvatar();
  }
  renderEditor();
  profileModal.classList.remove('hidden');
}

function closeProfileModal() {
  profileModal.classList.add('hidden');
}

profileBtn.addEventListener('click', openProfileModal);
profileClose.addEventListener('click', closeProfileModal);
profileModal.querySelector('.modal-backdrop').addEventListener('click', closeProfileModal);

profileFingerprint.addEventListener('click', () => {
  copyToClipboard(profileFingerprint.textContent, profileFingerprint);
});

// Сохранение профиля
profileSave.addEventListener('click', async () => {
  const newNick = profileNickname.value.trim();
  if (!newNick) return;

  const nickChanged = newNick !== myNickname;
  myNickname = newNick;
  myAvatarData = [...editorPixels];
  try { localStorage.setItem('ghost-nickname', myNickname); } catch (e) {}

  const profileData = { nickname: myNickname, avatarData: myAvatarData };
  if (myKeyPair) {
    profileData.publicKey = myPublicKeyJwk;
    profileData.privateKey = await crypto.subtle.exportKey('jwk', myKeyPair.privateKey);
  }
  saveProfile(profileData);

  myIdEl.textContent = myNickname;
  myIdCopyEl.textContent = myNickname;

  if (nickChanged) {
    if (peer && !peer.destroyed) peer.destroy();
    initPeer(myNickname);
    dlog('peer reinit with new nickname: ' + myNickname, 'ok');
  }

  closeProfileModal();
  dlog('profile saved: ' + myNickname, 'ok');
});
