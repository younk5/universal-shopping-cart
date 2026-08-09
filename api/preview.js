import { getPreviewData } from '../lib/preview.js';

export default async function handler(req, res) {
  const url = req.query.url;

  if (!url || typeof url !== 'string') {
    res.status(400).json({ error: 'url é obrigatória' });
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
