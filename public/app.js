// armazenamento (Firebase: Auth com Google + Firestore por usuário)

import {
  loginWithGoogle,
  loginWithIdentifier,
  registerWithEmail,
  resetPassword,
  getEmailForUsername,
  logout,
  watchAuthState,
  saveWishlist,
  watchWishlist,
} from './firebase.js';

let currentUid = null;
let unsubscribeWishlist = null;
let dataReady = false;

// utilidades gerais

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
const escapeAttr = escapeHtml;

function normalizeText(s) {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

// Só deixa passar http/https pra evitar XSS via "javascript:" (ou outro
// esquema perigoso) num link/imagem vindo de um item importado ou colado
// manualmente. Sempre retorna null se não for seguro pra usar como href/src.
function safeHttpUrl(raw) {
  if (!raw) return null;
  try {
    const u = new URL(String(raw), window.location.href);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function safeImageSrc(raw) {
  const httpUrl = safeHttpUrl(raw);
  if (httpUrl) return httpUrl;
  return typeof raw === 'string' && /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(raw) ? raw : null;
}

// Converte texto de preço em número, aceitando tanto "1.234,56" (BR)
// quanto "1234.56" ou "1,234.56" (formatos que vêm de metatags internacionais).
function parsePrice(raw) {
  if (raw == null) return NaN;
  let s = String(raw).trim();
  s = s.replace(/[^\d.,]/g, '');
  if (!s) return NaN;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    if (lastComma > lastDot) {
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      s = s.replace(/,/g, '');
    }
  } else if (lastComma > -1) {
    const parts = s.split(',');
    if (parts.length > 2) {
      const dec = parts.pop();
      s = parts.join('') + '.' + dec;
    } else {
      s = s.replace(',', '.');
    }
  } else if (lastDot > -1) {
    const parts = s.split('.');
    if (parts.length > 2) {
      const dec = parts.pop();
      s = parts.join('') + '.' + dec;
    }
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : NaN;
}

function formatBRL(n) {
  return 'R$ ' + n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function slugify(str) {
  return (
    String(str)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '') || 'categoria'
  );
}

// estado do app

const DEFAULT_CATEGORIES = [
  { id: 'mouses', label: 'Mouses' },
  { id: 'roupas', label: 'Roupas' },
  { id: 'decoracao', label: 'Decoração' },
  { id: 'outros', label: 'Outros' },
];

function migrateItems(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((it) => {
    let price = null;
    if (typeof it.price === 'number' && Number.isFinite(it.price)) {
      price = it.price;
    } else if (it.price != null && String(it.price).trim() !== '') {
      const parsed = parsePrice(it.price);
      price = Number.isFinite(parsed) ? parsed : null;
    }
    const qty = Number.isFinite(it.qty) && it.qty > 0 ? Math.round(it.qty) : 1;
    return {
      id: it.id || uid(),
      name: it.name || '',
      category: it.category || 'outros',
      price,
      qty,
      link: it.link || '',
      image: it.image || '',
      bought: !!it.bought,
      createdAt: it.createdAt || Date.now(),
    };
  });
}

let items = [];
let categories = DEFAULT_CATEGORIES;

let filter = 'todos';
let search = '';
let sortMode = 'recentes';
let editingCategories = false;
let addingCategory = false;
let newCategoryName = '';

let showForm = false;
let editingId = null;
let form = emptyForm();
let fetchStatus = '';
let fetchError = false;
let fetching = false;
let shouldFocusLink = false;

let toast = null;
let toastTimer = null;

function emptyForm(category) {
  return { name: '', category: category || categories[0]?.id || '', price: '', qty: '1', link: '', image: '' };
}

function persistToCloud() {
  if (!currentUid) return;
  saveWishlist(currentUid, { items, categories }).catch((err) => {
    console.error('Erro ao salvar no Firebase', err);
    showToast('Não consegui salvar. Verifique sua conexão.');
  });
}
function save() { persistToCloud(); }
function saveCategories() { persistToCloud(); }
function catLabel(id) { return (categories.find((c) => c.id === id) || {}).label || id; }

// ações (o que acontece quando o usuário mexe em algo)

function openNewForm() {
  editingId = null;
  form = emptyForm(filter !== 'todos' ? filter : undefined);
  fetchStatus = '';
  fetchError = false;
  showForm = true;
  shouldFocusLink = true;
  render();
}

function openEditForm(item) {
  editingId = item.id;
  form = {
    name: item.name,
    category: item.category,
    price: item.price != null ? String(item.price).replace('.', ',') : '',
    qty: String(item.qty || 1),
    link: item.link || '',
    image: item.image || '',
  };
  fetchStatus = '';
  fetchError = false;
  showForm = true;
  shouldFocusLink = false;
  render();
  document.getElementById('f-name')?.focus();
}

function closeForm() {
  showForm = false;
  editingId = null;
  fetchStatus = '';
  fetchError = false;
  render();
}

function submitForm() {
  const name = form.name.trim();
  if (!name) return;
  const priceParsed = form.price.trim() ? parsePrice(form.price) : NaN;
  const qtyParsed = parseInt(form.qty, 10);
  const qty = Number.isFinite(qtyParsed) && qtyParsed > 0 ? qtyParsed : 1;

  const data = {
    name,
    category: form.category,
    price: Number.isFinite(priceParsed) ? priceParsed : null,
    qty,
    link: form.link.trim(),
    image: form.image,
  };

  if (editingId) {
    const idx = items.findIndex((i) => i.id === editingId);
    if (idx !== -1) items[idx] = { ...items[idx], ...data };
  } else {
    items.push({ id: uid(), ...data, bought: false, createdAt: Date.now() });
  }
  save();
  closeForm();
}

function toggleBought(id) {
  const it = items.find((i) => i.id === id);
  if (!it) return;
  it.bought = !it.bought;
  save();
  render();
}

function removeItem(id) {
  const idx = items.findIndex((i) => i.id === id);
  if (idx === -1) return;
  const [removed] = items.splice(idx, 1);
  save();
  showToast(`"${removed.name}" removido.`, () => {
    items.splice(idx, 0, removed);
    save();
  });
}

function showToast(message, undoFn) {
  clearTimeout(toastTimer);
  toast = { message, undoFn };
  render();
  toastTimer = setTimeout(() => {
    toast = null;
    render();
  }, 6000);
}

function handleUndo() {
  if (toast?.undoFn) toast.undoFn();
  clearTimeout(toastTimer);
  toast = null;
  render();
}

function addCategory(label) {
  const trimmed = label.trim();
  if (!trimmed) return;
  const base = slugify(trimmed);
  let id = base;
  let n = 2;
  while (categories.some((c) => c.id === id)) id = `${base}-${n++}`;
  categories.push({ id, label: trimmed });
  saveCategories();
  addingCategory = false;
  newCategoryName = '';
  render();
}

function removeCategory(id) {
  if (categories.length <= 1) return;
  const inUse = items.some((i) => i.category === id);
  if (inUse) {
    const fallback = categories.find((c) => c.id !== id)?.id;
    items.forEach((i) => { if (i.category === id) i.category = fallback; });
    save();
  }
  categories = categories.filter((c) => c.id !== id);
  if (filter === id) filter = 'todos';
  saveCategories();
  render();
  if (inUse) showToast(`Itens movidos para "${catLabel(filter === 'todos' ? categories[0]?.id : filter)}".`);
}

async function fetchPreview() {
  if (!form.link.trim()) return;
  fetching = true;
  fetchStatus = 'Buscando dados...';
  fetchError = false;
  render();
  try {
    const res = await fetch('/api/preview?url=' + encodeURIComponent(form.link.trim()));
    const data = await res.json();
    if (!res.ok || data.error) {
      fetchError = true;
      fetchStatus = data.error || 'Não consegui buscar esse link.';
    } else {
      if (data.title && !form.name.trim()) form.name = data.title;
      if (data.price) form.price = data.price;
      if (data.image) form.image = data.image;
      fetchStatus = data.title ? 'Dados encontrados em ' + (data.siteName || '') : 'Encontrei algumas informações, confira antes de adicionar.';
    }
  } catch {
    fetchError = true;
    fetchStatus = 'Não consegui buscar esse link.';
  } finally {
    fetching = false;
    render();
  }
}

function exportData() {
  const payload = { exportedAt: new Date().toISOString(), items, categories };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `lista-compras-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data || !Array.isArray(data.items)) throw new Error('formato inválido');
      const ok = window.confirm('Isso vai substituir sua lista atual pelos dados do arquivo. Continuar?');
      if (!ok) return;
      items = migrateItems(data.items);
      if (Array.isArray(data.categories) && data.categories.length) categories = data.categories;
      save();
      saveCategories();
      filter = 'todos';
      render();
      showToast('Lista importada com sucesso.');
    } catch {
      window.alert('Não consegui ler esse arquivo. Verifique se é um backup exportado daqui.');
    }
  };
  reader.readAsText(file);
}

// listas/derivados usados na hora de renderizar

function sortItems(list) {
  const sorted = [...list];
  sorted.sort((a, b) => {
    if (a.bought !== b.bought) return a.bought ? 1 : -1;
    switch (sortMode) {
      case 'nome':
        return a.name.localeCompare(b.name, 'pt-BR');
      case 'preco-desc':
        return (b.price ?? -Infinity) - (a.price ?? -Infinity);
      case 'preco-asc':
        return (a.price ?? Infinity) - (b.price ?? Infinity);
      default:
        return b.createdAt - a.createdAt;
    }
  });
  return sorted;
}

function visibleItems() {
  let list = filter === 'todos' ? items : items.filter((i) => i.category === filter);
  if (search.trim()) {
    const q = normalizeText(search);
    list = list.filter((i) => normalizeText(i.name).includes(q));
  }
  return sortItems(list);
}

function computeTotals() {
  const pendingItems = items.filter((i) => !i.bought);
  const pendingTotal = pendingItems.reduce((s, i) => s + (i.price != null ? i.price * i.qty : 0), 0);
  return { pendingCount: pendingItems.length, pendingTotal, totalCount: items.length };
}

// renderização

function render() {
  renderHeaderAndSummary();
  renderToolbar();
  renderFilters();
  renderItems();
  renderForm();
  renderToast();
}

function renderHeaderAndSummary() {
  const { pendingCount, pendingTotal, totalCount } = computeTotals();
  document.getElementById('pendingCount').textContent = totalCount ? `${pendingCount} pendente${pendingCount !== 1 ? 's' : ''}` : '';
  document.getElementById('summary').innerHTML = totalCount
    ? `<span>${totalCount} item${totalCount !== 1 ? 's' : ''} no total</span>${pendingTotal > 0 ? `<span>Total pendente: <strong>${formatBRL(pendingTotal)}</strong></span>` : '<span></span>'}`
    : '';
}

function renderToolbar() {
  const toolbar = document.getElementById('toolbar');
  toolbar.innerHTML = `
    <input class="search-input" id="f-search" type="search" placeholder="Buscar por nome" value="${escapeAttr(search)}" aria-label="Buscar item por nome">
    <select class="sort-select" id="f-sort" aria-label="Ordenar itens">
      <option value="recentes" ${sortMode === 'recentes' ? 'selected' : ''}>Mais recentes</option>
      <option value="nome" ${sortMode === 'nome' ? 'selected' : ''}>Nome (A-Z)</option>
      <option value="preco-desc" ${sortMode === 'preco-desc' ? 'selected' : ''}>Preço (maior)</option>
      <option value="preco-asc" ${sortMode === 'preco-asc' ? 'selected' : ''}>Preço (menor)</option>
    </select>
  `;
  document.getElementById('f-search').oninput = (e) => { search = e.target.value; renderItems(); };
  document.getElementById('f-sort').onchange = (e) => { sortMode = e.target.value; renderItems(); };
}

function renderFilters() {
  const el = document.getElementById('filters');
  let html = `<button class="filter-btn ${filter === 'todos' ? 'active' : ''}" data-filter="todos">Todos (${items.length})</button>`;
  categories.forEach((c) => {
    const count = items.filter((i) => i.category === c.id).length;
    html += `<button class="filter-btn ${filter === c.id ? 'active' : ''}" data-filter="${c.id}">${escapeHtml(c.label)} (${count})${
      editingCategories && categories.length > 1
        ? `<span class="filter-remove" data-remove-cat="${c.id}" role="button" aria-label="Remover categoria ${escapeAttr(c.label)}" title="Remover categoria">✕</span>`
        : ''
    }</button>`;
  });
  if (editingCategories) {
    html += addingCategory
      ? ''
      : `<button class="filter-btn" id="showAddCat">+ Nova</button>`;
  }
  html += `<button class="filters-edit-toggle" id="toggleEditCat">${editingCategories ? 'Concluir' : 'Editar categorias'}</button>`;
  el.innerHTML = html;

  el.querySelectorAll('[data-filter]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      if (e.target.closest('[data-remove-cat]')) return;
      filter = btn.dataset.filter;
      render();
    });
  });
  el.querySelectorAll('[data-remove-cat]').forEach((btn) => {
    btn.onclick = (e) => { e.stopPropagation(); removeCategory(btn.dataset.removeCat); };
  });
  document.getElementById('toggleEditCat').onclick = () => {
    editingCategories = !editingCategories;
    addingCategory = false;
    render();
  };
  const showAddCat = document.getElementById('showAddCat');
  if (showAddCat) showAddCat.onclick = () => { addingCategory = true; render(); };

  let addRow = document.getElementById('newCatRow');
  if (editingCategories && addingCategory) {
    if (!addRow) {
      addRow = document.createElement('div');
      addRow.id = 'newCatRow';
      addRow.className = 'new-cat-row';
      el.insertAdjacentElement('afterend', addRow);
    }
    addRow.innerHTML = `
      <input id="newCatInput" placeholder="Nome da nova categoria" value="${escapeAttr(newCategoryName)}">
      <button class="btn-fetch" id="confirmAddCat">Adicionar</button>
    `;
    const input = document.getElementById('newCatInput');
    input.oninput = (e) => { newCategoryName = e.target.value; };
    input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); addCategory(newCategoryName); } };
    document.getElementById('confirmAddCat').onclick = () => addCategory(newCategoryName);
    input.focus();
  } else if (addRow) {
    addRow.remove();
  }
}

function renderItemMeta(item) {
  const parts = [];
  if (item.price != null) {
    parts.push(item.qty > 1 ? `${item.qty}× ${formatBRL(item.price)} = ${formatBRL(item.price * item.qty)}` : formatBRL(item.price));
  }
  const href = safeHttpUrl(item.link);
  if (href) parts.push(`<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">Ver item ↗</a>`);
  if (!parts.length) return '';
  return `<div class="meta">${parts.map((p) => `<span>${p}</span>`).join('')}</div>`;
}

function renderItems() {
  const itemsEl = document.getElementById('items');

  if (!dataReady) {
    itemsEl.innerHTML = `<div class="empty">Carregando sua lista...</div>`;
    return;
  }

  const sorted = visibleItems();

  if (sorted.length === 0) {
    let msg = 'Nenhum item ainda. Adicione o primeiro abaixo.';
    if (items.length > 0) msg = search.trim() ? 'Nada encontrado pra essa busca.' : 'Nada nessa categoria.';
    itemsEl.innerHTML = `<div class="empty">${escapeHtml(msg)}</div>`;
    return;
  }

  itemsEl.innerHTML = sorted.map((item) => `
    <div class="item ${item.bought ? 'bought' : ''}">
      <button class="check ${item.bought ? 'checked' : ''}" data-toggle="${item.id}" aria-label="${item.bought ? 'Desmarcar' : 'Marcar como comprado'}">${item.bought ? '✓' : ''}</button>
      ${item.image && safeImageSrc(item.image) ? `<img class="item-img" src="${escapeAttr(safeImageSrc(item.image))}" alt="">` : ''}
      <div class="item-body">
        <div class="item-name-row">
          <span class="item-name ${item.bought ? 'bought' : ''}">${escapeHtml(item.name)}</span>
          ${item.qty > 1 ? `<span class="item-qty">×${item.qty}</span>` : ''}
        </div>
        <div class="tags"><span class="tag tag-cat">${escapeHtml(catLabel(item.category))}</span></div>
        ${renderItemMeta(item)}
      </div>
      <div class="item-actions">
        <button class="icon-btn" data-edit="${item.id}" aria-label="Editar item" title="Editar">✎</button>
        <button class="icon-btn del" data-remove="${item.id}" aria-label="Remover item" title="Remover">✕</button>
      </div>
    </div>
  `).join('');

  itemsEl.querySelectorAll('[data-toggle]').forEach((btn) => { btn.onclick = () => toggleBought(btn.dataset.toggle); });
  itemsEl.querySelectorAll('[data-remove]').forEach((btn) => { btn.onclick = () => removeItem(btn.dataset.remove); });
  itemsEl.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.onclick = () => {
      const it = items.find((i) => i.id === btn.dataset.edit);
      if (it) openEditForm(it);
    };
  });
}

function renderForm() {
  const formArea = document.getElementById('formArea');
  if (!showForm) {
    formArea.innerHTML = `<button class="add-btn" id="openForm">+ Adicionar item</button>`;
    document.getElementById('openForm').onclick = openNewForm;
    return;
  }

  formArea.innerHTML = `
    <div class="form">
      <p class="form-title">${editingId ? 'Editar item' : 'Novo item'}</p>
      <div class="link-row">
        <input id="f-link" placeholder="Cole o link do produto" value="${escapeAttr(form.link)}">
        <button class="btn-fetch" id="f-fetch" ${fetching ? 'disabled' : ''}>${fetching ? 'Buscando...' : 'Buscar dados'}</button>
      </div>
      <div class="fetch-status ${fetchError ? 'error' : ''}">${escapeHtml(fetchStatus)}</div>
      ${form.image ? `<div class="preview"><img src="${escapeAttr(form.image)}" alt=""><span style="font-size:12px;color:var(--text-dim)">Imagem encontrada</span></div>` : ''}
      <input id="f-name" placeholder="Nome do item" value="${escapeAttr(form.name)}">
      <div class="row">
        <select id="f-cat">
          ${categories.map((c) => `<option value="${c.id}" ${form.category === c.id ? 'selected' : ''}>${escapeHtml(c.label)}</option>`).join('')}
        </select>
        <input class="qty-input" id="f-qty" type="number" min="1" step="1" placeholder="Qtd" value="${escapeAttr(form.qty)}" aria-label="Quantidade">
      </div>
      <input id="f-price" placeholder="Preço (opcional)" value="${escapeAttr(form.price)}">
      <div class="form-actions">
        <button class="btn-primary" id="f-add">${editingId ? 'Salvar alterações' : 'Adicionar'}</button>
        <button class="btn-cancel" id="f-cancel">Cancelar</button>
      </div>
    </div>
  `;

  document.getElementById('f-link').oninput = (e) => { form.link = e.target.value; };
  document.getElementById('f-link').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); fetchPreview(); } };
  document.getElementById('f-fetch').onclick = fetchPreview;
  document.getElementById('f-name').oninput = (e) => { form.name = e.target.value; };
  document.getElementById('f-cat').onchange = (e) => { form.category = e.target.value; };
  document.getElementById('f-qty').oninput = (e) => { form.qty = e.target.value; };
  document.getElementById('f-price').oninput = (e) => { form.price = e.target.value; };
  ['f-name', 'f-qty', 'f-price'].forEach((id) => {
    document.getElementById(id).onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); submitForm(); } };
  });
  document.getElementById('f-add').onclick = submitForm;
  document.getElementById('f-cancel').onclick = closeForm;

  if (shouldFocusLink) {
    document.getElementById('f-link').focus();
    shouldFocusLink = false;
  }
}

function renderToast() {
  const el = document.getElementById('toastArea');
  if (!toast) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <div class="toast">
      <span>${escapeHtml(toast.message)}</span>
      ${toast.undoFn ? `<button id="undoBtn">Desfazer</button>` : ''}
    </div>
  `;
  const undoBtn = document.getElementById('undoBtn');
  if (undoBtn) undoBtn.onclick = handleUndo;
}

// boot do app

function initDataActions() {
  document.getElementById('exportBtn').onclick = exportData;
  const fileInput = document.getElementById('importInput');
  document.getElementById('importBtn').onclick = () => fileInput.click();
  fileInput.onchange = () => {
    if (fileInput.files[0]) importData(fileInput.files[0]);
    fileInput.value = '';
  };
}

function translateAuthError(err, { genericCredentials = false } = {}) {
  // Em telas de login, não diferenciamos "não existe" de "senha errada":
  // isso evita que alguém descubra quais e-mails/usuários têm conta só
  // testando o formulário (enumeração de contas).
  if (genericCredentials) {
    const credentialCodes = ['auth/user-not-found', 'auth/wrong-password', 'auth/invalid-credential', 'auth/invalid-email'];
    if (credentialCodes.includes(err?.code)) return 'E-mail/usuário ou senha incorretos.';
  }
  const messages = {
    'auth/invalid-email': 'E-mail inválido.',
    'auth/user-not-found': 'Não encontrei conta com esse e-mail/usuário.',
    'auth/wrong-password': 'Senha incorreta.',
    'auth/invalid-credential': 'E-mail, usuário ou senha incorretos.',
    'auth/email-already-in-use': 'Já existe uma conta com esse e-mail.',
    'auth/weak-password': 'A senha precisa ter pelo menos 6 caracteres.',
    'auth/missing-password': 'Digite uma senha.',
    'auth/too-many-requests': 'Muitas tentativas. Tente novamente em alguns minutos.',
    'auth/popup-closed-by-user': 'Login cancelado.',
    'username-taken': 'Esse nome de usuário já está em uso, escolha outro.',
  };
  return messages[err?.code] || 'Não consegui entrar: ' + (err?.message || 'tente novamente.');
}

function initAuth() {
  let authMode = 'login';

  const usernameInput = document.getElementById('authUsername');
  const emailInput = document.getElementById('authEmail');
  const passwordInput = document.getElementById('authPassword');
  const authForm = document.getElementById('emailAuthForm');
  const authBtn = document.getElementById('emailAuthBtn');
  const modeToggle = document.getElementById('authModeToggle');
  const forgotBtn = document.getElementById('forgotPasswordBtn');
  const authError = document.getElementById('authError');

  function setAuthMode(mode) {
    authMode = mode;
    authBtn.textContent = mode === 'login' ? 'Entrar' : 'Criar conta';
    modeToggle.textContent = mode === 'login' ? 'Não tem conta? Criar conta' : 'Já tem conta? Entrar';
    usernameInput.hidden = mode !== 'register';
    passwordInput.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    if (mode === 'register') {
      emailInput.type = 'email';
      emailInput.placeholder = 'E-mail';
      emailInput.autocomplete = 'email';
    } else {
      emailInput.type = 'text';
      emailInput.placeholder = 'E-mail ou usuário';
      emailInput.autocomplete = 'username';
    }
    authError.textContent = '';
  }
  setAuthMode('login');

  modeToggle.onclick = () => setAuthMode(authMode === 'login' ? 'register' : 'login');

  authForm.onsubmit = (e) => {
    e.preventDefault();
    authError.textContent = '';
    const identifier = emailInput.value.trim();
    const password = passwordInput.value;
    if (!identifier || !password) return;

    if (authMode === 'register') {
      const username = usernameInput.value.trim();
      if (!username) {
        authError.textContent = 'Digite um nome de usuário.';
        return;
      }
      if (!/^[a-zA-Z0-9_.]{3,20}$/.test(username)) {
        authError.textContent = 'Usuário: 3 a 20 caracteres (letras, números, _ ou .).';
        return;
      }
      registerWithEmail(identifier, password, username)
        .then(() => {
          const label = document.getElementById('userLabel');
          if (label) label.textContent = username;
        })
        .catch((err) => {
          authError.textContent = translateAuthError(err);
        });
    } else {
      loginWithIdentifier(identifier, password).catch((err) => {
        authError.textContent = translateAuthError(err, { genericCredentials: true });
      });
    }
  };

  forgotBtn.onclick = () => {
    authError.textContent = '';
    const identifier = emailInput.value.trim();
    if (!identifier) {
      authError.textContent = 'Digite seu e-mail ou usuário acima primeiro pra receber o link de redefinição.';
      return;
    }
    // Sempre mostra a mesma mensagem no final, exista a conta ou não —
    // do contrário, esse formulário vira uma forma fácil de descobrir
    // quais e-mails/usuários têm conta no app (enumeração de contas).
    const emailLookup = identifier.includes('@')
      ? Promise.resolve(identifier)
      : getEmailForUsername(identifier);

    emailLookup
      .then((email) => (email ? resetPassword(email) : null))
      .catch(() => {})
      .finally(() => {
        showToast('Se existir uma conta com esse e-mail/usuário, enviamos um link de redefinição de senha.');
      });
  };

  document.getElementById('googleLoginBtn').onclick = () => {
    authError.textContent = '';
    loginWithGoogle().catch((err) => {
      authError.textContent = translateAuthError(err);
    });
  };
  document.getElementById('logoutBtn').onclick = () => logout();

  watchAuthState((user) => {
    if (unsubscribeWishlist) {
      unsubscribeWishlist();
      unsubscribeWishlist = null;
    }

    if (user) {
      currentUid = user.uid;
      dataReady = false;
      document.getElementById('authScreen').hidden = true;
      document.getElementById('appRoot').hidden = false;
      document.getElementById('userLabel').textContent = user.displayName || user.email || '';
      render();

      unsubscribeWishlist = watchWishlist(
        currentUid,
        (snap) => {
          const data = snap.exists() ? snap.data() : {};
          items = migrateItems(data.items || []);
          categories = Array.isArray(data.categories) && data.categories.length ? data.categories : DEFAULT_CATEGORIES;
          dataReady = true;
          render();
        },
        (err) => {
          console.error('Erro ao carregar dados do Firestore', err);
          showToast('Não consegui carregar sua lista da nuvem.');
        }
      );
    } else {
      currentUid = null;
      items = [];
      categories = DEFAULT_CATEGORIES;
      dataReady = false;
      document.getElementById('appRoot').hidden = true;
      document.getElementById('authScreen').hidden = false;
    }
  });
}

initDataActions();
initAuth();