import * as cheerio from 'cheerio';
import dns from 'node:dns/promises';
import net from 'node:net';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 3 * 1024 * 1024; // 3MB é mais que suficiente pro <head> de qualquer site

const META_SELECTORS = {
  title: ['meta[property="og:title"]', 'meta[name="twitter:title"]'],
  image: ['meta[property="og:image"]', 'meta[name="twitter:image"]'],
  price: [
    'meta[property="product:price:amount"]',
    'meta[property="og:price:amount"]',
    'meta[itemprop="price"]',
    'meta[name="twitter:data1"]',
  ],
  siteName: ['meta[property="og:site_name"]'],
};

function firstMeta($, selectors) {
  for (const sel of selectors) {
    const val = $(sel).attr('content');
    if (val && val.trim()) return val.trim();
  }
  return null;
}

function guessPriceFromText(text) {
  // pega o primeiro padrão tipo R$ 1.234,56 ou R$ 99,90 no HTML
  const match = text.match(/R\$\s*([\d.]{1,10},\d{2})/);
  if (match) return match[1];
  const matchDollar = text.match(/\$\s*([\d,]{1,10}\.\d{2})/);
  if (matchDollar) return matchDollar[1];
  return null;
}

// --- Proteção contra SSRF -------------------------------------------------
// Como o servidor busca uma URL que o usuário informa, é preciso garantir
// que ele não seja usado pra acessar endereços internos (localhost, rede
// privada, metadata de cloud etc). Verificamos o host inicial e também
// cada salto de redirecionamento, já que seguimos redirects manualmente.

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    if (p[0] === 10) return true;
    if (p[0] === 127) return true;
    if (p[0] === 0) return true;
    if (p[0] === 169 && p[1] === 254) return true; // link-local / cloud metadata
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe80')) return true; // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local
    if (lower.startsWith('::ffff:')) return isPrivateIp(lower.slice(7)); // IPv4-mapped
    return false;
  }
  return true; // não reconhecido -> bloqueia por segurança
}

async function assertPublicHost(hostname) {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0') {
    throw new Error('host_bloqueado');
  }
  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch {
    throw new Error('host_nao_resolvido');
  }
  if (addresses.length === 0 || addresses.some((a) => isPrivateIp(a.address))) {
    throw new Error('host_bloqueado');
  }
}

async function fetchWithProtection(startUrl) {
  let current = new URL(startUrl);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!['http:', 'https:'].includes(current.protocol)) {
      throw Object.assign(new Error('Use um link http ou https.'), { status: 400 });
    }

    try {
      await assertPublicHost(current.hostname);
    } catch {
      throw Object.assign(new Error('Esse endereço não pode ser acessado.'), { status: 400 });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(current.toString(), {
        headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' },
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch {
      throw Object.assign(new Error('Não consegui acessar esse link.'), { status: 502 });
    } finally {
      clearTimeout(timer);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) {
        throw Object.assign(new Error('Redirecionamento inválido.'), { status: 502 });
      }
      current = new URL(location, current);
      continue;
    }

    return { response, finalUrl: current };
  }

  throw Object.assign(new Error('Link com redirecionamentos demais.'), { status: 502 });
}

async function readLimited(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

// ---------------------------------------------------------------------------

/**
 * Busca e extrai título, imagem, preço e nome do site a partir de uma URL
 * informada pelo usuário, com proteção contra SSRF.
 * Lança um Error com `.status` (400/502/etc) em caso de falha esperada.
 */
export async function getPreviewData(urlStr) {
  let target;
  try {
    target = new URL(urlStr);
  } catch {
    throw Object.assign(new Error('Esse link não parece válido.'), { status: 400 });
  }

  const { response, finalUrl } = await fetchWithProtection(target.toString());

  if (!response.ok) {
    throw Object.assign(new Error(`Site respondeu ${response.status}`), { status: 502 });
  }

  const html = await readLimited(response, MAX_RESPONSE_BYTES);
  const $ = cheerio.load(html);

  let title = firstMeta($, META_SELECTORS.title) || $('title').first().text().trim() || null;
  let image = firstMeta($, META_SELECTORS.image) || null;
  let price = firstMeta($, META_SELECTORS.price) || guessPriceFromText(html);
  const siteName = firstMeta($, META_SELECTORS.siteName) || finalUrl.hostname.replace('www.', '');

  if (price) {
    price = price.replace(/[^\d.,]/g, '');
  }

  // imagem relativa -> absoluta
  if (image && !image.startsWith('http')) {
    image = new URL(image, finalUrl.origin).toString();
  }

  return { title, image, price, siteName, url: finalUrl.toString() };
}
