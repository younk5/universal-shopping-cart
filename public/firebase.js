// ---------------------------------------------------------------------------
// Inicialização do Firebase (Auth com Google + Firestore)
// ---------------------------------------------------------------------------

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js";
import {
  getFirestore,
  doc,
  setDoc,
  onSnapshot,
  enableIndexedDbPersistence,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";
import { firebaseConfig } from './firebase-config.js';

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);

const googleProvider = new GoogleAuthProvider();

// Permite abrir o app offline e sincronizar quando a conexão voltar.
// Se falhar (ex: mais de uma aba aberta), o app continua funcionando
// normalmente, só sem cache offline.
enableIndexedDbPersistence(db).catch(() => {});

export function loginWithGoogle() {
  return signInWithPopup(auth, googleProvider);
}

export function logout() {
  return signOut(auth);
}

export function watchAuthState(callback) {
  return onAuthStateChanged(auth, callback);
}

// Cada usuário tem um único documento com toda a lista dele.
// Caminho: users/{uid}/data/wishlist
function wishlistDocRef(uid) {
  return doc(db, 'users', uid, 'data', 'wishlist');
}

export function saveWishlist(uid, data) {
  return setDoc(wishlistDocRef(uid), data);
}

export function watchWishlist(uid, onData, onError) {
  return onSnapshot(wishlistDocRef(uid), onData, onError);
}
