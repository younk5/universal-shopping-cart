# Lista de Compras — wishlist com busca automática de produto

Você cola o link do produto e a lista preenche sozinha nome, imagem e preço.
Organize por categorias, marque o que já comprou e exporte um backup.

`JavaScript` · `Node.js` · `Firebase` · `Cheerio` · `Vercel`

> O deploy antigo saiu do ar. O projeto roda localmente com os comandos abaixo.

---

## O problema

Lista de compras em papel ou no bloco de notas perde justamente a informação que
importa: qual era o modelo exato, quanto custava e de onde veio o link. Na hora
de decidir a compra, sobra a dúvida.

## O que ele faz

- **Busca automática**: cola o link do produto e o servidor extrai nome, imagem
  e preço direto da página.
- **Categorias personalizáveis**: agrupe por loja, tipo de produto ou o critério
  que fizer sentido para você.
- **Edição completa**: corrija qualquer campo, reordene e marque o item como já
  comprado.
- **Backup local**: exporte a lista em arquivo para não depender só da nuvem.
- **Sincronização**: os dados ficam no Firebase, disponíveis em qualquer
  aparelho.

## Por que a busca roda no servidor

A extração dos dados é feita com **Cheerio**, no servidor, e não no navegador.
Duas razões:

1. A maioria das lojas não permite requisição direta de outro domínio (CORS),
   então a leitura precisa sair do servidor.
2. A lógica de interpretação do HTML fica fora do cliente — quando uma loja muda
   o layout, ajusta-se um arquivo no servidor, sem quebrar a versão do usuário.

## Como rodar

```bash
npm install
npm start
```

Abre em `http://localhost:3000`.

Antes de usar a busca automática, preencha as credenciais do Firebase em
`public/firebase-config.js`.

## Estrutura

```
api/preview.js        endpoint que busca e interpreta a página do produto
lib/preview.js        extração de nome, imagem e preço (Cheerio)
public/index.html     interface
public/app.js         estado da lista, filtros, categorias e backup
public/firebase.js    inicialização do Firebase
public/style.css      estilos
server.js             servidor local
```

## Stack

| Camada | Tecnologia |
|---|---|
| Front-end | HTML, CSS, JavaScript puro |
| Servidor | Node.js |
| Extração | Cheerio |
| Dados | Firebase |
| Deploy | Vercel |
