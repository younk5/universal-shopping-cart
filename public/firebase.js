// inicialização do Firebase (Auth com Google + Firestore)

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  updateProfile,
  deleteUser,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js";
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  runTransaction,
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

// Guarda um mapa "nome de usuário -> e-mail" pra permitir login por usuário,
// já que o Firebase Auth só reconhece e-mail nativamente.
// Caminho: usernames/{username em minúsculas} = { uid, email }
function usernameDocRef(username) {
  return doc(db, 'usernames', username.trim().toLowerCase());
}

export async function getEmailForUsername(username) {
  const snap = await getDoc(usernameDocRef(username));
  return snap.exists() ? snap.data().email : null;
}

export async function registerWithEmail(email, password, username) {
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  try {
    await updateProfile(cred.user, { displayName: username });
    await runTransaction(db, async (tx) => {
      const ref = usernameDocRef(username);
      const snap = await tx.get(ref);
      if (snap.exists()) {
        const err = new Error('username-taken');
        err.code = 'username-taken';
        throw err;
      }
      tx.set(ref, { uid: cred.user.uid, email });
    });
    return cred;
  } catch (err) {
    // Se não conseguiu reservar o nome de usuário, desfaz a criação da conta.
    await deleteUser(cred.user).catch(() => {});
    throw err;
  }
}

// Aceita e-mail OU nome de usuário: se não parecer um e-mail, resolve
// primeiro pra descobrir o e-mail correspondente antes de tentar o login.
export async function loginWithIdentifier(identifier, password) {
  let email = identifier.trim();
  if (!email.includes('@')) {
    const found = await getEmailForUsername(email);
    if (!found) {
      const err = new Error('Não encontrei conta com esse usuário.');
      err.code = 'auth/user-not-found';
      throw err;
    }
    email = found;
  }
  return signInWithEmailAndPassword(auth, email, password);
}

export function loginWithEmail(email, password) {
  return signInWithEmailAndPassword(auth, email, password);
}

export function resetPassword(email) {
  return sendPasswordResetEmail(auth, email);
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