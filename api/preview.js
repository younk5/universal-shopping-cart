import { getPreviewData } from '../lib/preview.js';
import { isRateLimited } from '../lib/rateLimit.js';

export default async function handler(req, res) {
  const url = req.query.url;

  if (!url || typeof url !== 'string') {
    res.status(400).json({ error: 'url é obrigatória' });
    return;
  }

  // limitado por instância (ver comentário em lib/rateLimit.js) — não é
  // uma defesa forte na Vercel, mas não custa ter.
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  if (isRateLimited(ip)) {
    res.status(429).json({ error: 'Muitas buscas em pouco tempo. Espere um pouco e tente de novo.' });
    return;
  }

  try {
    const data = await getPreviewData(url);
    res.status(200).json(data);
  } catch (err) {
    res
      .status(err.status || 500)
      .json({ error: err.message || 'Não consegui acessar esse link. Copie os dados manualmente.' });
  }
}
