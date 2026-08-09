# Lista de compras

## Como rodar

1. Extraia a pasta e abra um terminal dentro dela.
2. Instale as dependências:
   ```
   npm install
   ```
3. Inicie o servidor:
   ```
   npm start
   ```
4. Abra http://localhost:3000 no navegador.

## Como usar o "Buscar dados"

Ao adicionar um item, cole o link do produto e clique em "Buscar dados"
(ou aperte Enter no campo do link).
O servidor acessa a página e tenta extrair nome, preço e imagem
automaticamente (via meta tags Open Graph, que a maioria das lojas usa).

Nem todo site expõe essas informações do mesmo jeito, então às vezes
só parte dos campos vem preenchida — é só completar manualmente o que
faltar antes de adicionar.

## Funcionalidades

- **Editar item**: clique no ícone de lápis num item pra alterar nome,
  categoria, quantidade, preço ou link.
- **Quantidade**: cada item pode ter uma quantidade; o total pendente
  considera preço × quantidade.
- **Busca e ordenação**: filtre por nome e ordene por mais recentes,
  nome ou preço.
- **Categorias**: clique em "Editar categorias" (na barra de filtros) pra
  criar novas categorias ou remover as que não usa. Itens de uma categoria
  removida são movidos automaticamente para outra.
- **Desfazer exclusão**: ao remover um item aparece um aviso com a opção
  "Desfazer" por alguns segundos.
- **Backup**: os botões "Exportar backup" / "Importar backup" no rodapé
  salvam ou restauram sua lista como um arquivo `.json`. Útil pra migrar
  de navegador, já que os dados só ficam salvos localmente (veja abaixo).

## Onde os dados ficam salvos

Os itens e categorias ficam salvos no Firestore (banco de dados do
Firebase), associados à sua conta Google. Você precisa entrar com Google
pra ver e editar sua lista, e ela fica sincronizada automaticamente entre
todos os dispositivos onde você fizer login com a mesma conta. Cada
pessoa só enxerga a própria lista — os dados de contas diferentes não se
misturam.

Os botões "Exportar backup" / "Importar backup" continuam disponíveis
pra tirar um snapshot `.json` da lista quando quiser.

## Configurar o Firebase

O app precisa de um projeto Firebase próprio pra funcionar. Passos:

1. Acesse [console.firebase.google.com](https://console.firebase.google.com)
   e crie um projeto nesse (ou use um já existente).
2. **Ative o login com Google**: no menu lateral, vá em
   *Build → Authentication → Get started*, aba "Sign-in method", ative o
   provedor **Google**.
3. **Crie o Firestore**: menu lateral *Build → Firestore Database →
   Create database*. Pode deixar no modo de produção (as regras de
   segurança do projeto já cuidam do acesso).
4. **Aplique as regras de segurança**: na aba "Regras" do Firestore,
   cole o conteúdo do arquivo `firestore.rules` (na raiz deste projeto)
   e publique. Isso garante que cada pessoa só acessa a própria lista.
5. **Pegue a configuração do app Web**: em
   *⚙️ Configurações do projeto → Geral → Seus apps*, clique no ícone
   `</>` pra registrar um app Web (se ainda não tiver um) e copie o
   objeto `firebaseConfig`.
6. Cole esses valores em `public/firebase-config.js`, substituindo os
   placeholders.
7. **Domínios autorizados**: em *Authentication → Settings → Authorized
   domains*, `localhost` já vem liberado por padrão. Depois do deploy,
   adicione o domínio da Vercel (ex: `seu-projeto.vercel.app`) — sem
   isso, o login com Google falha em produção.

## Sobre o servidor

O endpoint `/api/preview` busca a URL que você cola no formulário para
extrair as informações do produto. Como o servidor acessa um endereço
informado pelo usuário, ele:

- só aceita links `http`/`https`;
- bloqueia endereços internos/privados (localhost, redes `10.x`,
  `192.168.x`, `169.254.x`/metadata de nuvem, IPv6 equivalentes, etc.),
  inclusive em redirecionamentos;
- resolve o DNS uma única vez e conecta direto no IP validado (em vez de
  deixar a biblioteca de HTTP resolver de novo por conta própria) — isso
  fecha uma brecha clássica de "DNS rebinding", onde o mesmo hostname
  responde um IP diferente entre a checagem e a conexão real;
- aplica um tempo limite de 8s e um limite de tamanho de resposta (3MB)
  pra evitar que um link mal-intencionado ou muito lento trave o servidor;
- tem um rate limit simples por IP pra não virar um proxy livre pra
  bater em qualquer URL (ver `lib/rateLimit.js` — vale lembrar que na
  Vercel isso é por instância da function, não é uma defesa forte de
  verdade, só reduz abuso casual).

Se um link for bloqueado ou não puder ser acessado, é só preencher os
dados manualmente.

Essa lógica de busca fica em `lib/preview.js`, usada tanto pelo
`server.js` (rodando local) quanto por `api/preview.js` (rodando como
Vercel Function em produção) — assim as duas versões nunca ficam
dessincronizadas.

## Limitação conhecida: login por usuário e e-mail

Pra permitir login com "nome de usuário" (além de e-mail), o app mantém
uma coleção pública `usernames/{username}` no Firestore que guarda
`{ uid, email }`, com leitura (`get`, não `list`) liberada pra qualquer
um — inclusive sem estar logado. Isso é necessário porque o Firebase
Auth só reconhece e-mail nativamente, e a resolução usuário → e-mail
precisa acontecer antes do login, direto do navegador.

Isso significa que, embora a interface nunca revele se um e-mail/usuário
tem conta ou não (mensagens de erro genéricas, tanto no login quanto no
"esqueci minha senha"), alguém que já saiba ou consiga adivinhar um nome
de usuário pode consultar o Firestore diretamente (com o SDK do
Firebase, sem passar pelo app) e descobrir o e-mail associado. Ou seja,
a proteção contra enumeração de contas existe na UI, mas não no dado em
si — quem for direto na API do Firestore não passa por ela.

Pra um app pessoal/uso pequeno isso costuma ser um risco aceitável, mas
vale saber que existe. Se um dia isso importar mais, a forma correta de
fechar de vez seria mover essa resolução usuário → e-mail pra trás de
uma Cloud Function (que não devolve o e-mail cru pro cliente), com
Firebase App Check e algum rate limit de verdade — isso é uma mudança
de arquitetura maior (exige plano Blaze), então não foi feito aqui.

## Deploy na Vercel

O projeto já está pronto para deploy sem configuração extra:

- `public/` contém os arquivos estáticos (HTML/CSS/JS), servidos
  diretamente pela CDN da Vercel.
- `api/preview.js` vira automaticamente uma Vercel Function que
  responde em `/api/preview`.
- `server.js` (com Express) só é usado para rodar localmente com
  `npm run dev` — não é necessário nem usado em produção na Vercel.

Passos:

1. Suba o projeto para um repositório no GitHub (ou GitLab/Bitbucket).
2. Em [vercel.com](https://vercel.com), clique em "Add New… → Project"
   e importe o repositório.
3. Deixe o Framework Preset como "Other" — a Vercel detecta a pasta
   `public/` e a pasta `api/` automaticamente, sem precisar de build
   command nem de configurações adicionais.
4. Clique em "Deploy".

Ou, via CLI, dentro da pasta do projeto:

```
npm i -g vercel
vercel
```

**Atenção sobre o Firebase:** não esqueça do passo 7 da seção acima
(adicionar o domínio da Vercel nos "Authorized domains" do
Authentication) — sem isso, o botão "Entrar com Google" não funciona no
site publicado, só localmente.
