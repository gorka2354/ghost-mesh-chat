// === Ghost Mesh Chat — crypto.js (E2E шифрование ECDH + AES-GCM) ===

let myKeyPair = null;       // { publicKey, privateKey }
let myPublicKeyJwk = null;  // экспортированный публичный ключ

// Генерация пары ключей ECDH
async function generateKeyPair() {
  myKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey']
  );
  myPublicKeyJwk = await crypto.subtle.exportKey('jwk', myKeyPair.publicKey);
}

// Загрузка ключей из профиля или генерация новых
async function loadOrCreateKeys() {
  const profile = await loadProfileFromDB();
  if (profile && profile.publicKey && profile.privateKey) {
    try {
      const pubKey = await crypto.subtle.importKey(
        'jwk', profile.publicKey,
        { name: 'ECDH', namedCurve: 'P-256' }, true, []
      );
      const privKey = await crypto.subtle.importKey(
        'jwk', profile.privateKey,
        { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']
      );
      myKeyPair = { publicKey: pubKey, privateKey: privKey };
      myPublicKeyJwk = profile.publicKey;
      dlog('keys loaded from profile', 'ok');
      return;
    } catch (e) {
      dlog('failed to load keys, regenerating: ' + e.message, 'warn');
    }
  }
  await generateKeyPair();
  const privJwk = await crypto.subtle.exportKey('jwk', myKeyPair.privateKey);
  saveProfile({ publicKey: myPublicKeyJwk, privateKey: privJwk });
  dlog('keys generated and saved', 'ok');
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
