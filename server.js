// server.js
import 'dotenv/config';
import express from 'express';
import path from 'path';
import multer from 'multer';
import { fileURLToPath } from 'url';

// Routers existentes (déjalos como ya los tienes)
import waRouter from './wa.js';
import messengerRouter from './index.js';
import pricesRouter from './prices.js';

// ========= Sheets (SIN carpeta /src) =========
import {
  summariesLastNDays,
  historyForIdLastNDays,
  appendMessage,
  // (si tus routers los usan, estos también existen)
  readPrices, writePrices, readRate, writeRate,
} from './sheets.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ========= Estáticos =========
app.use('/image', express.static(path.join(__dirname, 'image')));
app.use(express.static(path.join(__dirname, 'public')));

// UI del inbox
app.get('/inbox', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'agent.html'));
});

// Básicos
app.get('/', (_req, res) => res.send('OK'));
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get('/privacidad', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacidad.html'));
});

// Routers existentes
app.use(messengerRouter);
app.use(waRouter);
app.use(pricesRouter);

/* =============================
   NUEVO: /api/catalog
   Fuente: Hoja PRECIOS (readPrices)
   - Agrupa por "producto" (del sku "Producto-Presentación")
   - Junta todas las presentaciones de cada producto
   - Devuelve campos mínimos para el front del carrito
   ============================= */
app.get('/api/catalog', async (_req, res) => {
  try {
    const { prices = [] } = await readPrices(); // ya funciona en tu app
    // Agrupar
    const byProduct = new Map();
    for (const p of prices) {
      const sku = String(p.sku || '');
      // sku esperado: "Producto-Presentación" (de tu prices.js/html)
      let producto = sku;
      let presentacion = '';
      if (sku.includes('-')) {
        const parts = sku.split('-');
        producto = parts.shift() || '';
        presentacion = parts.join('-') || '';
      }

      const key = producto.trim();
      if (!key) continue;

      const cur = byProduct.get(key) || {
        skuBase: key,
        nombre: key,
        categoria: String(p.categoria || '').trim() || 'Herbicida',
        presentaciones: new Set(),
      };
      if (presentacion) cur.presentaciones.add(presentacion.trim());
      byProduct.set(key, cur);
    }

    const items = [...byProduct.values()].map(x => ({
      sku: x.skuBase, // base
      nombre: x.nombre,
      categoria: x.categoria,
      presentaciones: [...x.presentaciones],
      // campos opcionales para compatibilidad
      ingrediente_activo: '',
      formulacion: '',
      dosis: '',
      plaga: [],
      imagen: ''
    }));

    // Orden alfabético por defecto
    items.sort((a,b) => a.nombre.localeCompare(b.nombre, 'es'));

    res.json({ ok:true, items, count: items.length, source: 'prices' });
  } catch (e) {
    console.error('[catalog] from prices error:', e);
    res.status(500).json({ ok:false, error: 'catalog_unavailable' });
  }
});

// ========= AUTH simple para Inbox =========
const AGENT_TOKEN = process.env.AGENT_TOKEN || '';
function validateToken(token) {
  if (!AGENT_TOKEN) return true;       // si no configuras token, acepta cualquiera
  return token && token === AGENT_TOKEN;
}
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return res.sendStatus(401);
  if (!validateToken(h.slice(7).trim())) return res.sendStatus(401);
  next();
}

// ========= SSE (EventSource) =========
const sseClients = new Set();
function sseBroadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) { try { res.write(payload); } catch {} }
}
app.get('/wa/agent/stream', (req, res) => {
  const token = String(req.query.token || '');
  if (!validateToken(token)) return res.sendStatus(401);

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.write(': hi\n\n');

  const ping = setInterval(() => {
    try { res.write('event: ping\ndata: "💓"\n\n'); } catch {}
  }, 25000);

  sseClients.add(res);
  req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
});

// ========= Estado efímero para UI =========
const STATE = new Map(); // id -> { human:boolean, unread:number, last?:string, name?:string }

// ========= API del Inbox (Sheets Hoja 4) =========
app.post('/wa/agent/import-whatsapp', auth, async (req, res) => {
  try {
    const days = Number(req.body?.days || 3650);
    const items = await summariesLastNDays(days);
    for (const it of items) {
      const st = STATE.get(it.id) || { human:false, unread:0 };
      STATE.set(it.id, { ...st, name: it.name || it.id, last: it.last || '' });
    }
    res.json({ ok: true, imported: items.length });
  } catch (e) {
    console.error('[import-whatsapp]', e);
    res.status(500).json({ error: 'no se pudo importar desde Sheets' });
  }
});

app.get('/wa/agent/convos', auth, async (_req, res) => {
  try {
    const items = await summariesLastNDays(3650);
    const byId = new Map();
    for (const it of items) {
      byId.set(it.id, {
        id: it.id,
        name: it.name || it.id,
        last: it.last || '',
        lastTs: it.lastTs || 0,
        human: false,
        unread: 0,
      });
    }
    for (const [id, st] of STATE.entries()) {
      const cur = byId.get(id) || { id, name: id, last: '', lastTs: 0, human: false, unread: 0 };
      byId.set(id, {
        ...cur,
        name: st.name || cur.name || id,
        last: st.last || cur.last || '',
        human: !!st.human,
        unread: st.unread || 0,
      });
    }
    const convos = [...byId.values()]
      .sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0))
      .map(({ lastTs, ...rest }) => rest);
    res.json({ convos });
  } catch (e) {
    console.error('[convos]', e);
    res.status(500).json({ error: 'no se pudo leer Hoja 4' });
  }
});

app.get('/wa/agent/history/:id', auth, async (req, res) => {
  const id = String(req.params.id || '');
  try {
    const rows = await historyForIdLastNDays(id, 3650);
    const memory = rows.map(r => ({ role:r.role, content:r.content, ts:r.ts }));
    const name = STATE.get(id)?.name || rows[rows.length-1]?.name || id;
    const last = memory[memory.length-1]?.content || '';
    const st = STATE.get(id) || { human:false, unread:0 };
    STATE.set(id, { ...st, last, name, unread:0 });
    res.json({ id, name, human: !!st.human, memory });
  } catch (e) {
    console.error('[history]', e);
    res.status(500).json({ error: 'no se pudo leer historial' });
  }
});

app.post('/wa/agent/send', auth, async (req, res) => {
  const { to, text } = req.body || {};
  if (!to || !text) return res.status(400).json({ error: 'to y text requeridos' });
  const id = String(to);
  const ts = Date.now();
  const name = STATE.get(id)?.name || id;

  try {
    await appendMessage({ waId:id, name, ts, role:'agent', content:String(text) });
    const st = STATE.get(id) || { human:false, unread:0 };
    STATE.set(id, { ...st, last:String(text), unread:0 });
    sseBroadcast('msg', { id, role:'agent', content:String(text), ts });
    res.json({ ok:true });
  } catch (e) {
    console.error('[send]', e);
    res.status(500).json({ error: 'no se pudo guardar en Hoja 4' });
  }
});

app.post('/wa/agent/read', auth, (req, res) => {
  const id = String(req.body?.to || '');
  if (!id) return res.status(400).json({ error:'to requerido' });
  const st = STATE.get(id) || { human:false, unread:0 };
  STATE.set(id, { ...st, unread:0 });
  res.json({ ok:true });
});

app.post('/wa/agent/handoff', auth, (req, res) => {
  const id = String(req.body?.to || '');
  const mode = String(req.body?.mode || '');
  if (!id) return res.status(400).json({ error:'to requerido' });
  const st = STATE.get(id) || { human:false, unread:0 };
  STATE.set(id, { ...st, human: mode === 'human' });
  res.json({ ok:true });
});

const upload = multer({ storage: multer.memoryStorage() });
app.post('/wa/agent/send-media', auth, upload.array('files'), async (req, res) => {
  const { to, caption = '' } = req.body || {};
  if (!to) return res.status(400).json({ error: 'to requerido' });

  const id = String(to);
  const baseTs = Date.now();
  const files = Array.isArray(req.files) ? req.files : [];
  if (!files.length) return res.status(400).json({ error: 'files vacío' });

  try {
    let idx = 0;
    for (const f of files) {
      const sizeKB = Math.round((Number(f.size || 0) / 1024) * 10) / 10;
      const line = `📎 Archivo: ${f.originalname} (${sizeKB} KB)`;
      const ts = baseTs + (idx++);
      await appendMessage({ waId:id, name:STATE.get(id)?.name || id, ts, role:'agent', content:line });
      sseBroadcast('msg', { id, role:'agent', content:line, ts });
    }
    if (caption && caption.trim()) {
      const ts = baseTs + files.length;
      await appendMessage({ waId:id, name:STATE.get(id)?.name || id, ts, role:'agent', content:String(caption) });
      sseBroadcast('msg', { id, role:'agent', content:String(caption), ts });
      const st = STATE.get(id) || { human:false, unread:0 };
      STATE.set(id, { ...st, last:String(caption), unread:0 });
    }
    res.json({ ok:true, sent: files.length });
  } catch (e) {
    console.error('[send-media]', e);
    res.status(500).json({ error: 'no se pudo guardar en Hoja 4' });
  }
});

// ========= Arranque =========
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server escuchando en :${PORT}`);
  console.log('   • Messenger:        GET/POST /webhook');
  console.log('   • WhatsApp:         GET/POST /wa/webhook');
  console.log('   • Inbox UI:         GET       /inbox');
  console.log('   • Inbox API:        /wa/agent/* (convos, history, send, read, handoff, send-media, import-whatsapp, stream)');
  console.log('   • Prices JSON:      GET       /api/prices');
  console.log('   • Catalog JSON:     GET       /api/catalog   (desde Hoja PRECIOS)');
  console.log('   • Health:           GET       /healthz');
});
