// Limite bem simples por IP: no máximo `max` requisições a cada `windowMs`.
// Serve pra evitar que alguém abuse do /api/preview como proxy pra bater em
// um monte de URL alheia usando o nosso servidor.
//
// É em memória, então tem uma limitação real: na Vercel cada instância da
// function tem sua própria memória (e pode reiniciar do zero a qualquer
// momento), então isso não segura um ataque mais sério em produção — pra
// isso valeria a pena um rate limit de verdade (ex: Upstash/Redis). Aqui já
// ajuda a barrar abuso casual e engana bot simples, mas não é a defesa
// final.

const hits = new Map(); // ip -> [timestamps]

export function isRateLimited(ip, { windowMs = 60_000, max = 20 } = {}) {
  const now = Date.now();
  const timestamps = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  timestamps.push(now);
  hits.set(ip, timestamps);

  // limpa entradas velhas de vez em quando pra não vazar memória
  if (hits.size > 5000) {
    for (const [key, list] of hits) {
      if (list.every((t) => now - t >= windowMs)) hits.delete(key);
    }
  }

  return timestamps.length > max;
}
