// server.js (ESM) — FIX: no usar `req` fuera de su handler
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { readPrices } from './sheets.js';

const app = express();
app.use(express.json());
app.use(cors());

// util de paths para servir /inbox (si corresponde)
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ---- helpers ----
function toCatalog(prices = []) {
  // Agrupa por producto y junta presentaciones
  const map = new Map();
  for (const p of prices) {
    const key = (p.nombre || '').trim();
    if (!key) continue;
    if (!map.has(key)) {
      map.set(key, {
        nombre: key,
        categoria: p.categoria || '',
        presentaciones: []
      });
    }
    map.get(key).presentaciones.push({
      presentacion: p.presentacion || '',
      unidad: p.unidad || '',
      sku: p.sku || '',
      precio_usd: Number(p.precio_usd || 0),
      precio_bs: Number(p.precio_bs || 0)
    });
  }
  // orden opcional
  return [...map.values()].sort((a, b) => a.nombre.localeCompare(b.nombre));
}

// ---- health ----
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// ---- precios crudos ----
app.get('/api/prices', async (req, res) => {
  try {
    const tier = String(req.query?.tier || 'public');
    const { prices, rate, version } = await readPrices(tier);
    res.json({ ok: true, tier, rate, version, prices });
  } catch (e) {
    console.error('[prices] error:', e?.message || e);
    res.status(500).json({ ok: false, error: 'PRICES_ERROR' });
  }
});

// ---- catálogo (a partir de precios) ----
app.get('/api/catalog', async (req, res) => {
  try {
    const tier = String(req.query?.tier || 'public');
    const { prices, rate, version } = await readPrices(tier);
    const items = toCatalog(prices);
    res.json({ ok: true, tier, rate, version, items });
  } catch (e) {
    console.error('[catalog] from prices error:', e?.message || e);
    res.status(500).json({ ok: false, error: 'CATALOG_ERROR' });
  }
});

// ---- UI opcional de inbox estática (si la tienes build-eada) ----
app.use('/inbox', express.static(path.join(__dirname, 'public')));

// ---- webhooks (placeholders si ya los tienes en otro archivo) ----
app.get('/webhook', (req, res) => res.send(req.query['hub.challenge'] || 'OK'));
app.post('/webhook', (_req, res) => res.sendStatus(200));
app.get('/wa/webhook', (req, res) => res.send(req.query['hub.challenge'] || 'OK'));
app.post('/wa/webhook', (_req, res) => res.sendStatus(200));

// ---- arranque ----
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`🚀 Server escuchando en :${PORT}`);
  console.log('   • Messenger:        GET/POST /webhook');
  console.log('   • WhatsApp:         GET/POST /wa/webhook');
  console.log('   • Inbox UI:         GET       /inbox');
  console.log('   • Inbox API:        /wa/agent/*');
  console.log('   • Prices JSON:      GET       /api/prices');
  console.log('   • Catalog JSON:     GET       /api/catalog   (desde Hoja PRECIOS)');
  console.log('   • Health:           GET       /healthz');
});
