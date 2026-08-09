// ---------------------------------------------------------------------------
// Configuração do Firebase
// ---------------------------------------------------------------------------
// Substitua os valores abaixo pelos do SEU projeto Firebase.
// Onde encontrar: console.firebase.google.com > (seu projeto) >
// ⚙️ Configurações do projeto > aba "Geral" > seção "Seus apps" >
// clique no app da Web (ou crie um com o ícone </>) > "Config do SDK".
//
// Esses valores NÃO são segredos (são públicos por design no Firebase Web) -
// a segurança de verdade fica nas regras do Firestore (veja firestore.rules),
// que garantem que cada pessoa só acessa os próprios dados.

export const firebaseConfig = {
  apiKey: "COLOQUE_SUA_API_KEY_AQUI",
  authDomain: "SEU_PROJETO.firebaseapp.com",
  projectId: "SEU_PROJETO",
  storageBucket: "SEU_PROJETO.firebasestorage.app",
  messagingSenderId: "COLOQUE_AQUI",
  appId: "COLOQUE_AQUI",
};
