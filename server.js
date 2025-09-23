// server.js
import 'dotenv/config';
import express from 'express';
import path from 'path';
import multer from 'multer';
import fs from 'fs';
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

/* =======================================================================================
 *  API DE CATÁLOGO — lee Google Sheets (CSV) y devuelve JSON (para catalog.html/catalog.js)
 *  - Usa CATALOG_CSV_URL o (CATALOG_SHEET_ID + CATALOG_GID)
 *  - Permite override por query ?csv=
 *  - Tiene fallback opcional a ./knowledge/catalog.json si existe (para no caerse)
 * ======================================================================================= */

const CATALOG_CSV_URL = process.env.CATALOG_CSV_URL || '';
const CATALOG_SHEET_ID = process.env.CATALOG_SHEET_ID || '';
const CATALOG_GID = process.env.CATALOG_GID || '';

function csvSplit(line='') {
  const out=[]; let cur='', q=false;
  for (let i=0;i<line.length;i++){
    const ch=line[i];
    if (ch === '"'){
      if (q && line[i+1] === '"'){ cur+='"'; i++; }
      else q = !q;
    } else if (ch === ',' && !q){
      out.push(cur); cur='';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function parseCSV(text='') {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // BOM
  const lines = text.split(/\r?\n/).filter(l => l.trim().length);
  if (!lines.length) return { head:[], rows:[] };
  const head = csvSplit(lines.shift()).map(h => h.trim().toLowerCase());
  const rows = lines.map(l => {
    const c = csvSplit(l);
    const o = {};
    head.forEach((h,i)=> o[h] = (c[i] ?? '').trim());
    return o;
  });
  return { head, rows };
}

function presentList(x){
  return String(x || '')
    .split(/[,|]/)
    .map(s => s.trim())
    .filter(Boolean);
}

function normalizeRows(rows){
  return rows
    .map(r => ({
      sku: r.sku || r.SKU || '',
      nombre: r.nombre || r.Nombre || '',
      categoria: r.categoria || r.Categoria || '',
      ingrediente_activo: r.ingrediente_activo || r['ingrediente activo'] || r.ia || '',
      formulacion: r.formulacion || r.Formulacion || r['formulación'] || '',
      dosis: r.dosis || r.Dosis || '',
      plaga: r.plaga || r.Plaga || '',
      presentaciones: Array.isArray(r.presentaciones)
        ? r.presentaciones
        : presentList(r.presentaciones || r.Presentaciones || ''),
      imagen: r.imagen || r.Imagen || r.image || '',
    }))
    .filter(p => p.sku && p.nombre);
}

async function fetchCSV(url){
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) {
    const txt = await r.text().catch(()=> '');
    const err = new Error(`HTTP ${r.status} al obtener CSV`);
    err.details = txt.slice(0, 500);
    throw err;
  }
  return await r.text();
}

function buildCsvUrl() {
  if (CATALOG_CSV_URL) return CATALOG_CSV_URL;
  if (CATALOG_SHEET_ID && CATALOG_GID) {
    // gviz CSV
    return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(CATALOG_SHEET_ID)}/gviz/tq?tqx=out:csv&gid=${encodeURIComponent(CATALOG_GID)}`;
  }
  return '';
}

function loadLocalFallback(){
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'knowledge', 'catalog.json'), 'utf8');
    const j = JSON.parse(raw);
    return Array.isArray(j) ? j : [];
  } catch { return []; }
}

app.get('/api/catalog', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const override = String(req.query.csv || '').trim();
    const url = override || buildCsvUrl();
    if (!url) {
      throw new Error('CATALOG_CSV_URL o (CATALOG_SHEET_ID + CATALOG_GID) no configurados');
    }

    const csv = await fetchCSV(url);
    const { head, rows } = parseCSV(csv);

    // Log suave si faltan columnas (no cortamos la respuesta)
    const expected = ['sku','nombre','categoria','ingrediente_activo','formulacion','dosis','plaga','presentaciones','imagen'];
    const headSet = new Set(head);
    const missing = expected.filter(h => !headSet.has(h));
    if (missing.length) {
      console.warn('[catalog] columnas faltantes:', missing.join(', '));
    }

    const list = normalizeRows(rows);
    return res.json(list);
  } catch (e) {
    console.error('[catalog] error:', e?.message || e, e?.details ? `\n${e.details}` : '');
    const fallback = loadLocalFallback();
    if (fallback.length) return res.json(fallback);
    return res.status(500).json({ error: 'No se pudo cargar catálogo' });
  }
});

// Helper de diagnóstico rápido (opcional)
app.get('/api/catalog/debug', async (req, res) => {
  try {
    const url = String(req.query.csv || buildCsvUrl());
    if (!url) return res.status(400).json({ error:'faltan envs o ?csv=' });
    const csv = await fetchCSV(url);
    const { head, rows } = parseCSV(csv);
    res.json({ ok:true, url, head, sample: rows.slice(0, 3) });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message || String(e) });
  }
});

/* ==========================  AUTH simple para Inbox  ========================== */
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

/* ===============================  SSE (EventSource)  =============================== */
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

/* =======================  Estado efímero para UI / Inbox  ======================= */
const STATE = new Map(); // id -> { human:boolean, unread:number, last?:string, name?:string }

/* ======================  API del Inbox (Sheets Hoja 4)  ====================== */

// Importar todos los chats desde Sheets (para el botón "Importar WA")
app.post('/wa/agent/import-whatsapp', auth, async (req, res) => {
  try {
    const days = Number(req.body?.days || 3650);       // ~10 años
    const items = await summariesLastNDays(days);      // [{ id, name, last, lastTs }]
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

// Lista de conversaciones (une Sheets + STATE)
app.get('/wa/agent/convos', auth, async (_req, res) => {
  try {
    // 1) Trae de Sheets (hasta ~10 años)
    const items = await summariesLastNDays(3650); // [{ id, name, last, lastTs }]

    // 2) Indexa por id lo que vino de Sheets
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

    // 3) Mezcla con STATE (lo importado queda visible aunque Sheets no responda)
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

    // 4) Ordena por último ts (si lo hay) y devuelve sin lastTs
    const convos = [...byId.values()]
      .sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0))
      .map(({ lastTs, ...rest }) => rest);

    res.json({ convos });
  } catch (e) {
    console.error('[convos]', e);
    res.status(500).json({ error: 'no se pudo leer Hoja 4' });
  }
});

// Historial por chat
app.get('/wa/agent/history/:id', auth, async (req, res) => {
  const id = String(req.params.id || '');
  try {
    const rows = await historyForIdLastNDays(id, 3650);
    const memory = rows.map(r => ({ role:r.role, content:r.content, ts:r.ts }));
    const name = STATE.get(id)?.name || rows[rows.length-1]?.name || id;

    // actualizar estado efímero para UI
    const last = memory[memory.length-1]?.content || '';
    const st = STATE.get(id) || { human:false, unread:0 };
    STATE.set(id, { ...st, last, name, unread:0 });

    res.json({ id, name, human: !!st.human, memory });
  } catch (e) {
    console.error('[history]', e);
    res.status(500).json({ error: 'no se pudo leer historial' });
  }
});

// Enviar texto (agente) -> guarda en Hoja 4 y emite SSE
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

// Marcar leído
app.post('/wa/agent/read', auth, (req, res) => {
  const id = String(req.body?.to || '');
  if (!id) return res.status(400).json({ error:'to requerido' });
  const st = STATE.get(id) || { human:false, unread:0 };
  STATE.set(id, { ...st, unread:0 });
  res.json({ ok:true });
});

// Tomar/soltar humano
app.post('/wa/agent/handoff', auth, (req, res) => {
  const id = String(req.body?.to || '');
  const mode = String(req.body?.mode || '');
  if (!id) return res.status(400).json({ error:'to requerido' });
  const st = STATE.get(id) || { human:false, unread:0 };
  STATE.set(id, { ...st, human: mode === 'human' });
  res.json({ ok:true });
});

// Enviar media (log en Hoja 4 para que quede trazabilidad)
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
  console.log('   • Catalog JSON:     GET       /api/catalog   (?csv=override)');
  console.log('   • Health:           GET       /healthz');
});
