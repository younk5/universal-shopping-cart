import * as cheerio from 'cheerio';
import dns from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 3 * 1024 * 1024; // um <head> não deveria nem chegar perto disso

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
  // primeiro "R$ 1.234,56" (ou "R$ 99,90") que aparecer no HTML
  const match = text.match(/R\$\s*([\d.]{1,10},\d{2})/);
  if (match) return match[1];
  const matchDollar = text.match(/\$\s*([\d,]{1,10}\.\d{2})/);
  if (matchDollar) return matchDollar[1];
  return null;
}

// --- Proteção contra SSRF -------------------------------------------------
//
// O servidor busca uma URL que o próprio usuário informa, então precisa
// impedir que isso vire um jeito de acessar rede interna, localhost ou
// metadata de nuvem (169.254.169.254 e afins).
//
// O jeito ingênuo de fazer isso é resolver o hostname, checar se o IP é
// privado, e se não for, deixar o fetch() seguir em frente normalmente.
// O problema é que o fetch() vai resolver o DNS de novo por conta própria
// — e nada garante que a segunda resolução devolve o mesmo IP da primeira.
// Um domínio malicioso com TTL baixo pode responder um IP público na hora
// da checagem e um IP interno (127.0.0.1, 10.x, etc.) alguns milissegundos
// depois, na hora da conexão de verdade. Isso é "DNS rebinding" e é o jeito
// clássico de furar esse tipo de validação.
//
// Pra fechar essa brecha, resolvemos o host UMA vez, validamos o(s) IP(s)
// retornado(s), e conectamos manualmente nesse IP específico (mandando o
// Host/SNI corretos pra continuar funcionando com vhosts e certificados
// válidos). Assim a validação e a conexão real usam sempre o mesmo
// endereço — não tem brecha de tempo entre checar e usar.

function isPrivateIPv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  if (p[0] === 0) return true;
  if (p[0] === 10) return true;
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT — usado como range de metadata em algumas nuvens (ex: Alibaba)
  if (p[0] === 127) return true;
  if (p[0] === 169 && p[1] === 254) return true; // link-local, inclui o metadata da AWS/GCP/Azure
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  if (p[0] === 198 && (p[1] === 18 || p[1] === 19)) return true; // reservado pra benchmark
  return false;
}

// Expande qualquer forma de endereço IPv6 (com "::", com IPv4 embutido no
// final, etc.) pra 8 grupos de 16 bits, pra dar pra comparar prefixo sem
// depender de o endereço vir "bonitinho" e comprimido.
function expandIPv6(ip) {
  const addr = ip.split('%')[0]; // remove zone index tipo "%eth0" se tiver

  function toGroups(part) {
    if (!part) return [];
    return part.split(':').flatMap((seg) => {
      if (seg.includes('.')) {
        const b = seg.split('.').map(Number);
        if (b.length !== 4 || b.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return [NaN];
        return [(b[0] << 8) | b[1], (b[2] << 8) | b[3]];
      }
      return [seg === '' ? NaN : parseInt(seg, 16)];
    });
  }

  if (addr.includes('::')) {
    const [head, tail] = addr.split('::');
    const headGroups = toGroups(head);
    const tailGroups = toGroups(tail);
    const filled = 8 - headGroups.length - tailGroups.length;
    if (filled < 0) return [NaN];
    return [...headGroups, ...Array(filled).fill(0), ...tailGroups];
  }
  return toGroups(addr);
}

function isPrivateIPv6(ip) {
  const g = expandIPv6(ip);
  if (g.length !== 8 || g.some((n) => Number.isNaN(n))) return true; // não deu pra entender -> bloqueia
  if (g.every((n) => n === 0)) return true; // ::
  if (g.slice(0, 7).every((n) => n === 0) && g[7] === 1) return true; // ::1
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10, link-local
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7, unique local
  // ::ffff:a.b.c.d -> IPv4 mapeado, valida a parte v4 escondida ali
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    const v4 = `${(g[6] >> 8) & 0xff}.${g[6] & 0xff}.${(g[7] >> 8) & 0xff}.${g[7] & 0xff}`;
    return isPrivateIPv4(v4);
  }
  return false;
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  if (net.isIPv6(ip)) return isPrivateIPv6(ip);
  return true; // formato que não reconhecemos -> bloqueia por segurança
}

// Resolve o hostname, garante que nenhum IP retornado é privado, e devolve
// um endereço público específico pra usar na conexão (ver nota acima sobre
// por que isso não pode ser "checa e depois deixa o fetch resolver de novo").
async function resolvePublicAddress(hostname) {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0') {
    throw new Error('host_bloqueado');
  }
  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error('host_nao_resolvido');
  }
  if (addresses.length === 0 || addresses.some((a) => isPrivateIp(a.address))) {
    throw new Error('host_bloqueado');
  }
  return (addresses.find((a) => a.family === 4) || addresses[0]).address;
}

// Faz uma requisição GET conectando direto no `address` validado, mas
// mandando Host/SNI do hostname original — assim vhost e certificado TLS
// continuam funcionando normalmente, só a resolução de DNS que a gente
// controla.
function requestPinned(target, address, signal) {
  const isHttps = target.protocol === 'https:';
  const client = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    const req = client.request(
      {
        hostname: address,
        servername: isHttps ? target.hostname : undefined, // SNI + validação do cert usam o hostname real
        port: target.port || (isHttps ? 443 : 80),
        path: target.pathname + target.search,
        method: 'GET',
        headers: {
          Host: target.host,
          'User-Agent': USER_AGENT,
          'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        },
        signal,
      },
      (res) => resolve(res)
    );
    req.on('error', reject);
    req.end();
  });
}

async function fetchWithProtection(startUrl) {
  let current = new URL(startUrl);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!['http:', 'https:'].includes(current.protocol)) {
      throw Object.assign(new Error('Use um link http ou https.'), { status: 400 });
    }

    let address;
    try {
      address = await resolvePublicAddress(current.hostname);
    } catch {
      throw Object.assign(new Error('Esse endereço não pode ser acessado.'), { status: 400 });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let response;
    try {
      response = await requestPinned(current, address, controller.signal);
    } catch {
      throw Object.assign(new Error('Não consegui acessar esse link.'), { status: 502 });
    } finally {
      clearTimeout(timer);
    }

    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      response.resume(); // descarta o corpo do redirect, não precisamos dele
      const location = response.headers.location;
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

function readLimited(response, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    response.on('data', (chunk) => {
      received += chunk.length;
      if (received > maxBytes) {
        response.destroy();
        return;
      }
      chunks.push(chunk);
    });
    response.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    response.on('error', reject);
    response.on('close', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
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

  if (response.statusCode < 200 || response.statusCode >= 400) {
    response.resume();
    throw Object.assign(new Error(`Site respondeu ${response.statusCode}`), { status: 502 });
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
