import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { getPreviewData } from './lib/preview.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/preview', async (req, res) => {
  const url = req.query.url;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'url é obrigatória' });
  }

  try {
    const data = await getPreviewData(url);
    res.json(data);
  } catch (err) {
    res
      .status(err.status || 500)
      .json({ error: err.message || 'Não consegui acessar esse link. Copie os dados manualmente.' });
  }
});

app.listen(PORT, () => {
  console.log(`Lista de compras rodando em http://localhost:${PORT}`);
});
