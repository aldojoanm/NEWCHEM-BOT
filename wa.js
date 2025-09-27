import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { appendFromSession, parseAndAppendClientResponse } from './sheets.js';
import { appendChatHistoryRow, purgeOldChatHistory } from './sheets.js';
import { sendAutoQuotePDF } from './quote.js';
import { getClientByPhone, upsertClientByPhone } from './sheets.js';

const router = express.Router();
router.use(express.json());

const TMP_DIR = path.resolve('./data/tmp');
fs.mkdirSync(TMP_DIR, { recursive: true });

import multer from 'multer';
const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: 100 * 1024 * 1024 }
});

const VERIFY_TOKEN    = process.env.VERIFY_TOKEN || 'VERIFY_123';
const WA_TOKEN        = process.env.WHATSAPP_TOKEN || '';
const WA_PHONE_ID     = process.env.WHATSAPP_PHONE_ID || '';
const CATALOG_URL     = process.env.CATALOG_URL || 'https://tinyurl.com/f4euhvzk';
const STORE_LAT       = process.env.STORE_LAT || '-17.7580406';
const STORE_LNG       = process.env.STORE_LNG || '-63.1532503';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const AGENT_TOKEN     = process.env.AGENT_TOKEN || '';

const DEBUG_LOGS = process.env.DEBUG_LOGS === '1';
const dbg = (...args) => { if (DEBUG_LOGS) console.log(...args); };
const ADVISOR_NAME = process.env.ADVISOR_NAME || 'Jonathan Arteaga';
const ADVISOR_ROLE = process.env.ADVISOR_ROLE || 'Encargado de Negocios de New Chem Agroquímicos';

const CAMP_VERANO_MONTHS = (process.env.CAMPANA_VERANO_MONTHS || '10,11,12,1,2,3')
  .split(',').map(n => +n.trim()).filter(Boolean);
const CAMP_INVIERNO_MONTHS = (process.env.CAMPANA_INVIERNO_MONTHS || '4,5,6,7,8,9')
  .split(',').map(n => +n.trim()).filter(Boolean);

/* ========= utilidades (¡ahora primero!) ========= */
const norm  = (t='') => t.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu,'');
const title = s => String(s||'').replace(/\w\S*/g, w => w[0].toUpperCase()+w.slice(1).toLowerCase());
const clamp = (t, n=20) => (String(t).length<=n? String(t) : String(t).slice(0,n-1)+'…');
const clampN = (t, n) => clamp(t, n);
const upperNoDia = (t='') => t.normalize('NFD').replace(/\p{Diacritic}/gu,'').toUpperCase();
const canonName = (s='') => title(String(s||'').trim().replace(/\s+/g,' ').toLowerCase());

const b64u = s => Buffer.from(String(s),'utf8').toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const ub64u = s => Buffer.from(String(s).replace(/-/g,'+').replace(/_/g,'/'), 'base64').toString('utf8');

function mediaKindFromMime(mime = '') {
  const m = String(mime).toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return 'document';
}

function guessMimeByExt(filePath='') {
  const ext = (filePath.split('.').pop() || '').toLowerCase();
  const map = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg:'image/jpeg',
    webp:'image/webp',
    gif: 'image/gif',
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    csv: 'text/csv',
    txt: 'text/plain',
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    mov: 'video/quicktime',
    mp3: 'audio/mpeg',
    aac: 'audio/aac',
    ogg: 'audio/ogg',
    opus:'audio/ogg',
    amr: 'audio/amr'
  };
  return map[ext] || 'application/octet-stream';
}
/* =============================================== */

function monthInTZ(tz = TZ){
  try{
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, month:'2-digit' })
      .formatToParts(new Date());
    return +parts.find(p => p.type === 'month').value;
  }catch{
    return (new Date()).getMonth() + 1; // 1..12
  }
}

function currentCampana(){
  const m = monthInTZ(TZ);
  return CAMP_VERANO_MONTHS.includes(m) ? 'Verano' : 'Invierno';
}

function advisorProductList(s){
  const items = (s.vars.cart && s.vars.cart.length) ? s.vars.cart : [];
  return items
    .filter(it => it && it.nombre)
    .map(it => `• ${it.nombre}${it.presentacion ? ` (${it.presentacion})` : ''} — ${it.cantidad || 'ND'}`)
    .join('\n');
}

function buildAdvisorPresetText(s){
  const quien = s.profileName || 'Cliente';
  const lines = advisorProductList(s);
  return [
    `Hola ${quien}, soy ${ADVISOR_NAME}, ${ADVISOR_ROLE}.`,
    `Te escribo por tu cotización con los siguientes productos:`,
    lines
  ].join('\n');
}
const agentClients = new Set();
function sseSend(res, event, payload){
  try{
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }catch{}
}
function broadcastAgent(event, payload){
  for (const res of agentClients) sseSend(res, event, payload);
}
function agentAuth(req,res,next){
  const header = req.headers.authorization || '';
  const bearer = header.replace(/^Bearer\s+/i,'').trim();
  const token  = bearer || String(req.query.token||'');
  if(!AGENT_TOKEN || token!==AGENT_TOKEN) return res.sendStatus(401);
  next();
}

function loadJSON(p){ try { return JSON.parse(fs.readFileSync(p,'utf8')); } catch { return {}; } }
const CATALOG = loadJSON('./knowledge/catalog.json');

/* ========= índice por ingrediente activo (usa norm ya definida) ========= */
function buildActiveIndex(list){
  const map = new Map();
  for (const p of list){
    const bucket = new Set();
    const raw = [
      p.activo, p.ingrediente_activo, p.ingrediente, p.ia,
      ...(Array.isArray(p.activos) ? p.activos : []),
      ...(Array.isArray(p.syns_activo) ? p.syns_activo : [])
    ].filter(Boolean);

    for (const r of raw){
      const clean = norm(String(r)
        .replace(/\b\d+([.,]\d+)?\s*(g\/l|g\/kg|%|sl|ec|sc|wg|wp)\b/gi,'')
        .replace(/\s{2,}/g,' ')
        .trim());
      if (clean) bucket.add(clean);
    }

    for (const key of bucket){
      const arr = map.get(key) || [];
      arr.push(p);
      map.set(key, arr);
    }
  }

  // Sinónimos y mapeos esperados con tus productos actuales
  const EXTRA = {
    'glifosato': ['GLISATO'],
    'paraquat':  ['DRIER', 'paraquat'],               // por si viene solo "paraquat"
    'abamectina':['MEXIN', 'abamectin'],
    'atrazina':  ['SEAL', 'atrazine'],
    'clethodim': ['SINERGY'],
    'thiametoxam':['NICOXAM','thiametoxan'],          // corrige variación ortográfica en datos
    'bifenthrin':['TRENCH','bifentrin'],
    'fipronil':  ['FENPRONIL'],
    'emamectin': ['NOATO','emamectin benzoate'],
    'mancozeb':  ['LAYER']
  };
  for (const [ia, prodNames] of Object.entries(EXTRA)){
    const iaKey = norm(ia);
    for (const name of prodNames){
      const prod = list.find(p => norm(p.nombre) === norm(name));
      if (prod){
        const arr = map.get(iaKey) || [];
        if (!arr.includes(prod)) arr.push(prod);
        map.set(iaKey, arr);
      }
    }
  }
  return map;
}
const ACTIVE_INDEX = buildActiveIndex(Array.isArray(CATALOG) ? CATALOG : []);

function findByActiveIngredient(text){
  const t = norm(text);
  // intenta match exacto de palabra
  for (const key of ACTIVE_INDEX.keys()){
    if (new RegExp(`\\b${key}\\b`).test(t)) {
      const arr = ACTIVE_INDEX.get(key);
      if (arr && arr[0]) return arr[0]; // primer producto asociado
    }
  }
  return null;
}

const PLAY    = loadJSON('./knowledge/playbooks.json');
const FAQS = loadJSON('./knowledge/faqs.json');
const DEPARTAMENTOS = ['Santa Cruz','Cochabamba','La Paz','Chuquisaca','Tarija','Oruro','Potosí','Beni','Pando'];
const SUBZONAS_SCZ  = ['Norte','Este','Sur','Valles','Chiquitania'];
const CROP_OPTIONS = [
  { title:'Soya',     payload:'CROP_SOYA'     },
  { title:'Maíz',     payload:'CROP_MAIZ'     },
  { title:'Trigo',    payload:'CROP_TRIGO'    },
  { title:'Arroz',    payload:'CROP_ARROZ'    },
  { title:'Girasol',  payload:'CROP_GIRASOL'  }
];
const CROP_SYN = {
  'soya':'Soya','soja':'Soya',
  'maiz':'Maíz','maíz':'Maíz',
  'trigo':'Trigo','arroz':'Arroz','girasol':'Girasol'
};
const CAMP_BTNS = [
  { title:'Verano',   payload:'CAMP_VERANO'   },
  { title:'Invierno', payload:'CAMP_INVIERNO' }
];

const HECTARE_OPTIONS = [
  { title:'0–100 ha',        payload:'HA_0_100' },
  { title:'101–300 ha',      payload:'HA_101_300' },
  { title:'301–500 ha',      payload:'HA_301_500' },
  { title:'1,000–3,000 ha',  payload:'HA_1000_3000' },
  { title:'3,001–5,000 ha',  payload:'HA_3001_5000' },
  { title:'+5,000 ha',       payload:'HA_5000_MAS' },
  { title:'Otras cantidades', payload:'HA_OTRA' }
];

const HA_LABEL = {
  HA_0_100:      '0–100 ha',
  HA_101_300:    '101–300 ha',
  HA_301_500:    '301–500 ha',
  HA_1000_3000:  '1,000–3,000 ha',
  HA_3001_5000:  '3,001–5,000 ha',
  HA_5000_MAS:   '+5,000 ha'
};

const linkMaps  = () => `https://www.google.com/maps?q=${encodeURIComponent(`${STORE_LAT},${STORE_LNG}`)}`;

const isKnownClient = (s) => Boolean(
  (s?.meta?.preloadedFromSheet && (
    s?.profileName ||
    s?.vars?.departamento ||
    (s?.vars?.cultivos && s.vars.cultivos.length) ||
    s?.vars?.hectareas
  )) || s?._savedToSheet
);

const discoveryComplete = (s) => Boolean(
  s?.profileName &&
  s?.vars?.departamento &&
  s?.vars?.subzona &&
  (s?.vars?.cultivos && s.vars.cultivos.length) &&
  s?.vars?.hectareas
);

const LIST_TITLE_MAX = 24;
const LIST_DESC_MAX  = 72;

const humanSilence = new Map();
const HOURS = (h)=> h*60*60*1000;
const humanOn  = (id, hours=4)=> humanSilence.set(id, Date.now()+HOURS(hours));
const humanOff = (id)=> humanSilence.delete(id);
const isHuman  = (id)=> (humanSilence.get(id)||0) > Date.now();

const SESSION_TTL_DAYS = parseInt(process.env.SESSION_TTL_DAYS || '7', 10);
const SESSION_TTL_MS   = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
const SESSION_DIR = path.resolve('./data/sessions');
fs.mkdirSync(SESSION_DIR, { recursive: true });

const sessions = new Map();
const sessionTouched = new Map();
function sessionPath(id){ return path.join(SESSION_DIR, `${id}.json`); }
function loadSessionFromDisk(id){
  try{
    const raw = fs.readFileSync(sessionPath(id),'utf8');
    const obj = JSON.parse(raw);
    if (obj?._expiresAt && Date.now() > obj._expiresAt) return null;
    return obj;
  }catch{ return null; }
}
function persistSessionToDisk(id, s){
  try{
    const slim = {
      greeted: s.greeted,
      stage: s.stage,
      pending: s.pending,
      asked: s.asked,
      vars: s.vars,
      profileName: s.profileName,
      memory: s.memory,
      lastPrompt: s.lastPrompt,
      lastPromptTs: s.lastPromptTs,
      meta: s.meta,
      _savedToSheet: s._savedToSheet,
      _closedAt: s._closedAt || null,
      _expiresAt: Date.now() + SESSION_TTL_MS
    };
    const tmp = sessionPath(id)+'.tmp';
    fs.writeFileSync(tmp, JSON.stringify(slim));
    fs.renameSync(tmp, sessionPath(id));
  }catch(e){}
}
function deleteSessionFromDisk(id){ try{ fs.unlinkSync(sessionPath(id)); }catch{} }

setInterval(()=>{
  const now = Date.now();
  for(const [id, ts] of sessionTouched){
    if (now - ts > SESSION_TTL_MS) { sessions.delete(id); sessionTouched.delete(id); }
  }
}, 10*60*1000);

setInterval(()=>{
  try{
    const now = Date.now();
    for(const f of fs.readdirSync(SESSION_DIR)){
      const p = path.join(SESSION_DIR, f);
      const st = fs.statSync(p);
      if (now - st.mtimeMs > SESSION_TTL_MS) fs.unlinkSync(p);
    }
  }catch{}
}, 60*60*1000);

function S(id){
  if(!sessions.has(id)){
    const fromDisk = loadSessionFromDisk(id);
    sessions.set(id, fromDisk || {
      greeted:false,
      stage: 'discovery',
      pending: null,
      asked: { nombre:false, departamento:false, subzona:false, cultivo:false, hectareas:false, campana:false },
      vars: {
        departamento:null, subzona:null,
        cultivos: [],
        hectareas:null,
        campana:null,
        phone:null,
        cart: []
      },
      profileName: null,
      memory: [],
      lastPrompt: null,
      lastPromptTs: 0,
      meta: { origin:null, referral:null, referralHandled:false },
      _savedToSheet: false
    });
  }
  sessionTouched.set(id, Date.now());
  return sessions.get(id);
}
function persistS(id){ persistSessionToDisk(id, S(id)); }
function clearS(id){ sessions.delete(id); sessionTouched.delete(id); deleteSessionFromDisk(id); }

function remember(id, role, content){
  const s = S(id);
  const now = Date.now();
  if (role === 'user' && s._closedAt) delete s._closedAt;
  s.memory.push({ role, content, ts: now });
  if (s.memory.length > 500) s.memory = s.memory.slice(-500);
  s.meta = s.meta || {};
  s.meta.lastMsg = { role, content, ts: now };
  s.meta.lastAt  = now;
  if (role === 'user') s.meta.unread = (s.meta.unread || 0) + 1;
  persistS(id);
  broadcastAgent('msg', { id, role, content, ts: now });
  try {
    const nombre = s.profileName || '';
    const ts_iso = new Date(now).toISOString();
    appendChatHistoryRow({ wa_id: id, nombre, ts_iso, role, content }).catch(() => {});
  } catch {}
}

setInterval(() => {
  try { purgeOldChatHistory(7).catch(() => {}); } catch {}
}, 6 * 60 * 60 * 1000).unref?.();

function hasEarlyIntent(t=''){
  return wantsCatalog(t) || wantsLocation(t) || asksPrice(t) || wantsAgentPlus(t) || wantsBuy(t);
}

function buildClientRecordFromSession(s, phoneDigits) {
  const dep  = s?.vars?.departamento || '';
  const zona = s?.vars?.subzona || '';
  const ubicacion = [dep, zona].filter(Boolean).join(' - ');
  return {
    telefono: String(phoneDigits || '').trim(),
    nombre: s?.profileName || '',
    ubicacion,
    cultivo: (s?.vars?.cultivos && s.vars.cultivos[0]) || '',
    hectareas: s?.vars?.hectareas || '',
    campana: s?.vars?.campana || ''
  };
}

const parseHectareas = text=>{
  const m = String(text).match(/(\d{1,6}(?:[.,]\d{1,2})?)\s*(ha|hect[aá]reas?)/i);
  if(m) return m[1].replace(',','.');
  const only = String(text).match(/^\s*(\d{1,6}(?:[.,]\d{1,2})?)\s*$/);
  return only ? only[1].replace(',','.') : null;
};
const parsePhone = text=>{
  const m = String(text).match(/(\+?\d[\d\s\-]{6,17}\d)/);
  return m ? m[1].replace(/[^\d+]/g,'') : null;
};
function detectDepartamento(text){
  const t = norm(text);
  for (const d of DEPARTAMENTOS) if (t.includes(norm(d))) return d;
  return null;
}
function detectSubzona(text){
  const t = norm(text);
  for (const z of SUBZONAS_SCZ) if (t.includes(norm(z))) return z;
  return null;
}

const wantsCatalog  = t => /cat[aá]logo|portafolio|lista de precios/i.test(t) || /portafolio[- _]?newchem/i.test(norm(t));
const wantsLocation = t => /(ubicaci[oó]n|direcci[oó]n|mapa|d[oó]nde est[aá]n|donde estan)/i.test(t);
const wantsClose    = t => /(no gracias|gracias|eso es todo|listo|nada m[aá]s|ok gracias|est[aá] bien|finalizar)/i.test(norm(t));
const wantsBuy      = t => /(comprar|cerrar pedido|prepara pedido|proforma)/i.test(t);
const asksPrice     = t => /(precio|cu[aá]nto vale|cu[aá]nto cuesta|cotizar|costo)/i.test(t);
const wantsAgentPlus = t => /asesor(a)?|agente|ejecutiv[oa]|vendedor(a)?|representante|soporte|hablar con (alguien|una persona|humano)|persona real|humano|contact(a|o|arme|en)|que me (llamen|llamen)|llamada|ll[aá]mame|me pueden (contactar|llamar)|comercial/i.test(norm(t));
const wantsAnother  = t => /(otro|agregar|añadir|sumar|incluir).*(producto|art[ií]culo|item)|cotizar otro/i.test(norm(t));
const wantsBotBack = t => /([Aa]sistente [Nn]ew [Cc]hem)/i.test(t);

function parseMessengerLead(text){
  const t = String(text || '');
  if(!/\b(v[ií]a|via)\s*messenger\b/i.test(t)) return null;
  const pick = (re)=>{ const m=t.match(re); return m? m[1].trim() : null; };
  const nameHola  = pick(/Hola,\s*soy\s*([^(•\n]+?)(?=\s*\(|\s*\.|\s*Me|$)/i);
  const nameCampo = pick(/Nombre:\s*([^\n•]+)/i);
  const name  = nameHola || nameCampo || null;
  const prod  = pick(/Producto:\s*([^•\n]+)/i);
  const qty   = pick(/Cantidad:\s*([^•\n]+)/i);
  const crops = pick(/Cultivos?:\s*([^•\n]+)/i);
  const dptoZ = pick(/Departamento(?:\/Zona)?:\s*([^•\n]+)/i);
  const zona  = pick(/Zona:\s*([^•\n]+)/i);
  return { name, prod, qty, crops, dptoZ, zona };
}

function isLikelyGreeting(t=''){
  const x = norm(String(t)).replace(/[^a-z\s]/g,'').trim();
  return /^(hola|buenas|ola|buenos dias|buen dia|buenas tardes|buenas noches|saludos|que tal|qué tal|como estas|cómo estás|hey|ola|ok|okay|gracias|listo|si|sí|no)$/.test(x);
}

function looksLikeFullName(t=''){
  const s = String(t||'').trim();
  if (!s) return false;
  if (isLikelyGreeting(s)) return false;
  const parts = s.split(/\s+/).filter(Boolean);
  const valid = parts.filter(w => /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ][A-Za-zÁÉÍÓÚÜÑáéíóúüñ'’\-\.]{1,}$/.test(w));
  return valid.length >= 2 && s.length <= 60;
}

function productImageSource(prod){
  const direct = prod.image_url || prod.imagen || (Array.isArray(prod.images)&&prod.images[0]) || prod.img;
  if (direct && /^https?:\/\//i.test(direct)) return { url: direct };
  const name = upperNoDia(prod?.nombre || '').trim();
  if(!name) return null;
  const baseA = name.replace(/[^A-Z0-9]/g,'');
  const baseB = name.replace(/[^A-Z0-9]+/g,'_');
  const exts = ['.png','.jpg','.jpeg','.webp'];
  for(const b of [baseA, baseB]){
    for(const ext of exts){
      const localPath = `image/${b}${ext}`;
      if (fs.existsSync(localPath)) {
        if (PUBLIC_BASE_URL) return { url: `${PUBLIC_BASE_URL}/image/${b}${ext}` };
        else return { path: localPath };
      }
    }
  }
  return null;
}

function resetProductState(s) {
  if (!s || !s.vars) return;
  s.vars.cart = [];
  s.stage = 'product';
  s.pending = null;
  s.lastPrompt = null;
}

const sendQueues = new Map();
const sleep = (ms=350)=>new Promise(r=>setTimeout(r,ms));
async function waSendQ(to, payload){
  const exec = async ()=>{
    const url = `https://graph.facebook.com/v20.0/${WA_PHONE_ID}/messages`;
    const r = await fetch(url,{
      method:'POST',
      headers:{ 'Authorization':`Bearer ${WA_TOKEN}`, 'Content-Type':'application/json' },
      body: JSON.stringify(payload)
    });
    if(!r.ok){
      console.error('WA send error', r.status, await r.text().catch(()=>''), 'payload=', JSON.stringify(payload).slice(0,500));
      return false;
    }
    return true;
  };
  const prev = sendQueues.get(to) || Promise.resolve(true);
  const next = prev.then(exec).then((ok)=>{ return sleep(350).then(()=>ok); });
  sendQueues.set(to, next);
  return next;
}

const toText = (to, body) => {
  remember(to,'bot', String(body));
  return waSendQ(to,{
    messaging_product:'whatsapp', to, type:'text',
    text:{ body: String(body).slice(0,4096), preview_url: true }
  });
};
const toButtons = (to, body, buttons=[]) => {
  remember(to,'bot', `${String(body)} [botones]`);
  return waSendQ(to,{
    messaging_product:'whatsapp', to, type:'interactive',
    interactive:{ type:'button', body:{ text: String(body).slice(0,1024) },
      action:{ buttons: buttons.slice(0,3).map(b=>({ type:'reply', reply:{ id:b.payload || b.id, title: clamp(b.title) }})) }
    }
  });
};
const toList = (to, body, title, rows=[]) => {
  remember(to,'bot', `${String(body)} [lista: ${title}]`);
  return waSendQ(to,{
    messaging_product:'whatsapp', to, type:'interactive',
    interactive:{ type:'list', body:{ text:String(body).slice(0,1024) }, action:{
      button: title.slice(0,20),
      sections:[{ title, rows: rows.slice(0,10).map(r=>{
        const id = r.payload || r.id;
        const t  = clampN(r.title ?? '', LIST_TITLE_MAX);
        const d  = r.description ? clampN(r.description, LIST_DESC_MAX) : undefined;
        return d ? { id, title: t, description: d } : { id, title: t };
      }) }]
    }}
  });
};

async function waUploadMediaFromFile(filePath, mimeHint){
  const url = `https://graph.facebook.com/v20.0/${encodeURIComponent(WA_PHONE_ID)}/media`;
  const mime = mimeHint || guessMimeByExt(filePath);
  const buf = fs.readFileSync(filePath);
  const blob = new Blob([buf], { type: mime });
  const form = new FormData();
  form.append('file', blob, filePath.split(/[\\/]/).pop());
  form.append('type', mime);
  form.append('messaging_product', 'whatsapp');
  const r = await fetch(url,{ method:'POST', headers:{ 'Authorization':`Bearer ${WA_TOKEN}` }, body: form });
  if(!r.ok){
    const errTxt = await r.text().catch(()=> '');
    console.error('waUploadMediaFromFile ERROR', r.status, errTxt);
    return null;
  }
  const j = await r.json().catch(()=>null);
  return j?.id || null;
}

async function toImage(to, source){
  if(source?.url) return waSendQ(to,{ messaging_product:'whatsapp', to, type:'image', image:{ link: source.url } });
  if(source?.path){
    const id = await waUploadMediaFromFile(source.path);
    if(id) return waSendQ(to,{ messaging_product:'whatsapp', to, type:'image', image:{ id } });
  }
}

async function toAgentText(to, body){
  await waSendQ(to,{
    messaging_product:'whatsapp', to, type:'text',
    text:{ body: String(body).slice(0,4096), preview_url: true }
  });
  remember(to,'agent', String(body));
}

async function markPrompt(s, key){ s.lastPrompt = key; s.lastPromptTs = Date.now(); }
async function askNombre(to){
  const s=S(to); if (s.lastPrompt==='nombre' || s.asked.nombre) return;
  await markPrompt(s,'nombre'); s.pending='nombre'; s.asked.nombre=true;
  persistS(to);
  await toText(to,'Para personalizar tu atención, ¿cuál es tu *nombre completo*?');
}
async function askDepartamento(to){
  const s=S(to); if (s.lastPrompt==='departamento') return;
  await markPrompt(s,'departamento'); s.pending='departamento'; s.asked.departamento=true;
  persistS(to);
  await toList(to,'📍 Cuéntanos, ¿desde qué *departamento* de Bolivia nos escribes?','Elegir departamento',
    DEPARTAMENTOS.map(d=>({ title:d, payload:`DPTO_${d.toUpperCase().replace(/\s+/g,'_')}` }))
  );
}
async function askSubzonaSCZ(to){
  const s=S(to); if (s.lastPrompt==='subzona') return;
  await markPrompt(s,'subzona'); s.pending='subzona'; s.asked.subzona=true;
  persistS(to);
  await toList(to,'Gracias. ¿En qué *zona de Santa Cruz*?','Elegir zona',
    [{title:'Norte',payload:'SUBZ_NORTE'},{title:'Este',payload:'SUBZ_ESTE'},{title:'Sur',payload:'SUBZ_SUR'},{title:'Valles',payload:'SUBZ_VALLES'},{title:'Chiquitania',payload:'SUBZ_CHIQUITANIA'}]
  );
}
async function askSubzonaLibre(to){
  const s=S(to); if (s.lastPrompt==='subzona_libre') return;
  await markPrompt(s,'subzona_libre'); s.pending='subzona_libre'; s.asked.subzona=true;
  persistS(to);
  const dep = s.vars.departamento || 'tu departamento';
  await toText(to, `Perfecto. ¿En qué *zona* de *${dep}* trabajas?`);
}
async function askCultivo(to){
  const s=S(to); if (s.lastPrompt==='cultivo') return;
  await markPrompt(s,'cultivo'); s.pending='cultivo'; s.asked.cultivo=true;
  persistS(to);
  const rows = [...CROP_OPTIONS, { title:'Otro', payload:'CROP_OTRO' }];
  await toList(to,'📋 ¿Para qué *cultivo* necesitas el producto?','Elegir cultivo', rows);
}
async function askCultivoLibre(to){
  const s=S(to); if (s.lastPrompt==='cultivo_text') return;
  await markPrompt(s,'cultivo_text'); s.pending='cultivo_text';
  persistS(to);
  await toText(to,'Que *cultivo* manejas?');
}
async function askHectareas(to){
  const s=S(to); if (s.lastPrompt==='hectareas') return;
  await markPrompt(s,'hectareas'); s.pending='hectareas'; s.asked.hectareas=true;
  persistS(to);
  await toList(
    to,
    '¿Cuántas *hectáreas* vas a tratar?',
    'Elegir hectáreas',
    HECTARE_OPTIONS
  );
}
async function askHectareasLibre(to){
  const s=S(to); if (s.lastPrompt==='hectareas_text') return;
  await markPrompt(s,'hectareas_text'); s.pending='hectareas_text';
  persistS(to);
  await toText(to,'Podrias escribir el total de *hectáreas*.');
}
async function askCampana(to){
  const s=S(to); if (s.lastPrompt==='campana') return;
  await markPrompt(s,'campana'); s.pending='campana'; s.asked.campana=true;
  persistS(to);
  await toButtons(to,'¿En qué *campaña* te encuentras? ', CAMP_BTNS);
}
async function askCategory(to){
  const s = S(to);
  if (s.lastPrompt === 'catalog_link') return;
  s.stage = 'product';
  s.pending = 'catalog_link';
  await markPrompt(s, 'catalog_link');
  persistS(to);
  await toText(to,
    `Te dejo nuestro *catálogo*.\n` +
    `${CATALOG_URL}\n\n` +
    `👉 Añade tus productos y toca *Enviar a WhatsApp*. Yo recibiré tu pedido y te preparé tu cotización.`
  );
}

function toNumberFlexible(x=''){
  const s = String(x).trim();
  const hasDot = s.includes('.');
  const hasComma = s.includes(',');

  if (hasDot && hasComma){
    const lastDot = s.lastIndexOf('.');
    const lastComma = s.lastIndexOf(',');
    if (lastComma > lastDot){
      return Number(s.replace(/\./g,'').replace(',','.'));
    } else {
      return Number(s.replace(/,/g,''));
    }
  } else if (hasComma){
    return /,\d{1,2}$/.test(s) ? Number(s.replace(',','.')) : Number(s.replace(/,/g,''));
  } else if (hasDot){
    return /\.\d{1,2}$/.test(s) ? Number(s) : Number(s.replace(/\./g,''));
  }
  return Number(s);
}

function parseCartFromText(text=''){
  const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const headerOK = /^(CART_V1 NEWCHEM|CARRITO NEW CHEM)/i.test(lines[0] || '');
  if (!headerOK) return null;
  const items = [];
  let totalUsd = null, totalBs = null;
  const reItem = /^\*\s*(.+?)(?:\s*\((.+?)\))?\s*—\s*([\d.,]+)\s*(l|lt|lts|litros?|kg|kilos?|unid|unidad(?:es)?)?(?:\s*—\s*SUBTOTAL:\s*\$?\s*([\d.,]+))?$/i;
  for (const l of lines.slice(1)){
    const mUsd = l.match(/TOTAL[_ ]USD\s*:\s*([\d.,]+)/i);
    const mBs  = l.match(/TOTAL[_ ]BS\s*:\s*([\d.,]+)/i);
    if (mUsd) { totalUsd = toNumberFlexible(mUsd[1]); continue; }
    if (mBs)  { totalBs  = toNumberFlexible(mBs[1]);  continue; }
    const m = l.match(reItem);
    if (m){
      const nombre = m[1].trim();
      const presentacion = m[2]?.trim() || null;
      const qty = toNumberFlexible(m[3] || '0');
      const uRaw = (m[4]||'').toLowerCase();
      const subtotalUsd = m[5] ? toNumberFlexible(m[5]) : null;
      const unidad = /kg|kilo/.test(uRaw) ? 'Kg'
                   : /l|lt|lts|litro/.test(uRaw) ? 'L'
                   : uRaw ? 'unid' : null;
      items.push({
        nombre,
        presentacion,
        cantidad: unidad ? `${qty} ${unidad}` : String(qty),
        cantidad_num: qty,
        unidad: unidad || undefined,
        subtotal_usd: subtotalUsd ?? undefined
      });
    }
  }
  return items.length ? { items, totalUsd, totalBs } : null;
}

function summaryText(s){
  const nombre = s.profileName || 'Cliente';
  const dep    = s.vars.departamento || 'ND';
  const zona   = s.vars.subzona || 'ND';
  const cultivo= s.vars.cultivos?.[0] || 'ND';
  const ha     = s.vars.hectareas || 'ND';
  const camp   = s.vars.campana || currentCampana();  // ← auto

  let linesProductos = [];
  if ((s.vars.cart||[]).length){
    linesProductos = s.vars.cart.map(it=>{
      const pres = it.presentacion ? ` (${it.presentacion})` : '';
      return `* ${it.nombre}${pres} — ${it.cantidad}`;
    });
  } else {
    linesProductos = ['* (pendiente: añade productos desde el catálogo)'];
  }
  return [
    'Perfecto, enseguida te enviaremos una cotización con estos datos:',
    `* ${nombre}`,
    `* Departamento: ${dep}`,
    `* Zona: ${zona}`,
    `* Cultivo: ${cultivo}`,
    `* Hectáreas: ${ha}`,
    `* Campaña: ${camp}`,
    ...linesProductos,
    '*Compra mínima: US$ 3.000 (puedes combinar productos).',
    '*La entrega de tu pedido se realiza en nuestro almacén*.'
  ].join('\n');
}

async function askAddMore(to){
  await toButtons(to, '¿Listo para *cotizar*?', [
    { title:'Cotizar',      payload:'QR_FINALIZAR' }
  ]);
}

const busy = new Set();
async function nextStep(to){
  if (busy.has(to)) return;
  busy.add(to);
  try{
    const s=S(to);
    const stale = (key)=> s.lastPrompt===key && (Date.now()-s.lastPromptTs>25000);
    if (s.pending && !stale(s.pending)) return;

    // nombre
    if ((!s.asked.nombre) && (s.meta.origin!=='messenger' || !s.profileName)) {
      if(stale('nombre') || s.lastPrompt!=='nombre') return askNombre(to);
      return;
    }
    // departamento
    if(!s.vars.departamento){
      if(stale('departamento') || s.lastPrompt!=='departamento') return askDepartamento(to);
      return;
    }
    // subzona
    if(!s.vars.subzona){
      if(s.vars.departamento==='Santa Cruz'){
        if(stale('subzona') || s.lastPrompt!=='subzona') return askSubzonaSCZ(to);
      }else{
        if(stale('subzona_libre') || s.lastPrompt!=='subzona_libre') return askSubzonaLibre(to);
      }
      return;
    }
    // cultivo
    if(!s.vars.cultivos || s.vars.cultivos.length===0){
      if(stale('cultivo') || s.lastPrompt!=='cultivo') return askCultivo(to);
      return;
    }
    // hectáreas
    if(!s.vars.hectareas){
      if(stale('hectareas') || s.lastPrompt!=='hectareas') return askHectareas(to);
      return;
    }

    // Campaña: siempre se autocalcula, nunca se pregunta
    s.vars.campana = currentCampana();

    await askCategory(to);
    return;
  } finally {
    persistS(to);
    busy.delete(to);
  }
}

function findProduct(text){
  const nt = norm(text);
  const list = Array.isArray(CATALOG) ? CATALOG : [];
  let hit = list.find(p=>{
    const n = norm(p.nombre||'');
    if (!n) return false;
    if (nt.includes(n)) return true;
    const toks = n.split(/\s+/).filter(Boolean);
    return toks.every(t=>nt.includes(t));
  });
  if (hit) return hit;
  const words = nt.split(/\s+/).filter(w=>w.length>=4);
  hit = list.find(p=>{
    const n = norm(p.nombre||'');
    return words.length && words.every(w=>n.includes(w));
  });
  return hit || null;
}

async function showProduct(to, prod, { withLink = true, preface = null } = {}) {
  if (preface) {
    await toText(to, preface);
  }

  const src = productImageSource(prod);
  if (src) await toImage(to, src);
  const base = `Te envío la ficha técnica de *${prod.nombre}*.`;
  if (withLink) {
    await toText(to, `${base}\nPara cotizar, ábrelo en el catálogo, añádelo al carrito y toca *Enviar a WhatsApp*:\n${CATALOG_URL}`);
  } else {
    await toText(to, base);
  }
}

router.get('/wa/webhook',(req,res)=>{
  const mode=req.query['hub.mode'];
  const token=req.query['hub.verify_token'];
  const chall=req.query['hub.challenge'];
  if(mode==='subscribe' && token===VERIFY_TOKEN && chall) return res.status(200).send(String(chall));
  return res.sendStatus(403);
});

const digits = s => String(s||'').replace(/[^\d]/g,'');
const ADVISOR_WA_NUMBERS = String(
  process.env.ADVISOR_WA_NUMBER ?? process.env.ADVISOR_WA_NUMBERS ?? ''
)
  .split(/[,\s]+/)
  .map(digits)
  .filter(Boolean);

const isAdvisor = (id) => ADVISOR_WA_NUMBERS.includes(digits(id));

if (!ADVISOR_WA_NUMBERS.length) console.warn('ADVISOR_WA_NUMBER(S) vacío(s). No se avisará al asesor.');
console.log('[BOOT] ADVISOR_WA_NUMBERS =', ADVISOR_WA_NUMBERS.length ? ADVISOR_WA_NUMBERS.join(',') : '(vacío)');

let advisorWindowTs = 0;
const MS24H = 24*60*60*1000;
const isAdvisorWindowOpen = () => (Date.now() - advisorWindowTs) < MS24H;

const TZ = process.env.TIMEZONE || 'America/La_Paz';

function formatStamp() {
  try {
    return new Intl.DateTimeFormat('es-BO', {
      timeZone: TZ,
      dateStyle: 'short',
      timeStyle: 'short'
    }).format(new Date());
  } catch {
    const d = new Date();
    const pad = n => String(n).padStart(2,'0');
    return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${String(d.getFullYear()).slice(-2)} ` +
           `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
}

function compileAdvisorAlert(s, customerWa){
  const stamp   = formatStamp();
  const nombre  = s.profileName || 'Cliente';
  const dep     = s.vars.departamento || 'ND';
  const zona    = s.vars.subzona || 'ND';
  const cultivo = s.vars.cultivos?.[0] || 'ND';
  const camp    = s.vars.campana || currentCampana(); // ← auto
  const prod    = (s.vars.cart?.[0]?.nombre || '—');
  const cant    = (s.vars.cart?.[0]?.cantidad || '—');
  const baseChat     = `https://wa.me/${customerWa}`;
  const presetText   = buildAdvisorPresetText(s);
  const replyWithMsg = `${baseChat}?text=${encodeURIComponent(presetText)}`;
  return [
    `🕒 ${stamp}`,
    `🆕 *Nuevo lead*`,
    `*Nombre:* ${nombre}`,
    `*Ubicación:* ${dep} - ${zona}`,
    `*Cultivo:* ${cultivo}`,
    `*Campaña:* ${camp}`,
    `*Producto:* ${prod}`,
    `*Cantidad:* ${cant}`,
    ``,
    `Abrir chat: ${baseChat}`,
    `Responder con mensaje: ${replyWithMsg}`
  ].join('\n');
}


const processed = new Map();
const PROCESSED_TTL = 5 * 60 * 1000;
setInterval(()=>{ const now=Date.now(); for(const [k,ts] of processed){ if(now-ts>PROCESSED_TTL) processed.delete(k); } }, 60*1000);
function seenWamid(id){ if(!id) return false; const now=Date.now(); const old=processed.get(id); processed.set(id,now); return !!old && (now-old)<PROCESSED_TTL; }

router.post('/wa/webhook', async (req,res)=>{
  try{
    const entry  = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value  = change?.value;
    const msg    = value?.messages?.[0];

    const rawFrom = msg?.from || value?.contacts?.[0]?.wa_id || '';
    const fromId  = digits(rawFrom);

    dbg('[HOOK]', { rawFrom, fromId, advisors: ADVISOR_WA_NUMBERS, isAdvisor: isAdvisor(fromId) });

    if(!msg || !fromId){ return res.sendStatus(200); }
    if (seenWamid(msg.id)) { return res.sendStatus(200); }

    const s = S(fromId);
    s.vars = s.vars || {};
    s.vars.campana = currentCampana();
    persistS(fromId);
    s.meta = s.meta || {};
    if (msg.id) { s.meta.last_wamid = msg.id; persistS(fromId); }

    const textRaw = (msg.type==='text' ? (msg.text?.body || '').trim() : '');
    const leadData = (msg.type === 'text') ? parseMessengerLead(textRaw) : null;
    const parsedCart = parseCartFromText(textRaw);
    if (parsedCart) {
      const s0 = S(fromId);
      s0.vars.cart = parsedCart.items || [];
      s0.pending = null;
      s0.lastPrompt = null;
      s0.stage = 'checkout';
      persistS(fromId);
      await toText(fromId, summaryText(s0));
      await toButtons(fromId, '¿Listo para *cotizar*?', [
        { title:'Cotizar', payload:'QR_FINALIZAR' }
      ]);
      res.sendStatus(200);
      return;
    }

    try {
      if (!s.meta) s.meta = {};
      if (!s.meta.preloadedFromSheet) {
        const rec = await getClientByPhone(fromId);
        s.meta.preloadedFromSheet = true;
        if (rec) {
          if (rec.nombre) s.profileName = rec.nombre;
          if (rec.dep)    s.vars.departamento = rec.dep;
          if (rec.subzona) s.vars.subzona = rec.subzona;
          if (rec.cultivo) s.vars.cultivos = [rec.cultivo];
          if (rec.hectareas) s.vars.hectareas = rec.hectareas;
          if (rec.campana)  s.vars.campana  = rec.campana;
          s.asked = s.asked || {};
          if (s.profileName) s.asked.nombre = true;
          if (s.vars.departamento) s.asked.departamento = true;
          if (s.vars.subzona) s.asked.subzona = true;
          if (s.vars.cultivos?.length) s.asked.cultivo = true;
          if (s.vars.hectareas) s.asked.hectareas = true;
          if (s.vars.campana) s.asked.campana = true;
          s.greeted = true;
          persistS(fromId);
          if (s.profileName) {
            await toText(fromId, `Hola *${s.profileName}*. ¡Qué gusto saludarte nuevamente! Soy el asistente virtual de *New Chem Agroquímicos*.`);
          }
          await nextStep(fromId);
          return res.sendStatus(200);
        } else {
          persistS(fromId);
        }
      }
    } catch (e) {
      console.error('preload WA_CLIENTES error:', e);
    }

    if (isHuman(fromId)) {
      if (textRaw) remember(fromId, 'user', textRaw);
      try {
        const deadline = s?.meta?.awaitBillingPickupUntil || 0;
        const withinWindow = deadline > Date.now();
        const looksLikeBillingData =
          /\bnit\b/i.test(textRaw) ||
          /raz[oó]n\s*social|^rs\b/i.test(textRaw) ||
          /chofer|conductor/i.test(textRaw) ||
          /placa/i.test(textRaw) ||
          /fecha\s*(de)?\s*(recojo|retiro)/i.test(textRaw);
        if (textRaw && withinWindow && looksLikeBillingData) {
          const parsed = await parseAndAppendClientResponse({
            text: textRaw,
            clientName: s?.profileName || ''
          });
          const captured =
            parsed?.nit ||
            parsed?.razonSocial ||
            parsed?.placa ||
            parsed?.fechaRecojo ||
            parsed?.nombreChofer;
          if (captured) {
            s.meta.awaitBillingPickupUntil = 0;
            persistS(fromId);
            await toAgentText(fromId, '✅ Recibimos los datos para facturación/entrega. ¡Gracias!');
          }
        }
      } catch (err) {
        console.error('guardar Hoja 2 (modo humano) error:', err);
      }
      if (textRaw && wantsBotBack(textRaw)) {
        humanOff(fromId);
        resetProductState(s);
        persistS(fromId);
        const quien = s.profileName ? `, ${s.profileName}` : '';
        await toText(fromId, `Listo${quien} 🙌. Reactivé el *Asistente Virtual de New Chem Agroquímicos*.`);
        await askCategory(fromId);
        return res.sendStatus(200);
      }
      persistS(fromId);
      return res.sendStatus(200);
    }

    if (isAdvisor(fromId)) {
      console.log('[HOOK] Mensaje del asesor — abriendo ventana 24h');
      advisorWindowTs = Date.now();
      persistS(fromId);
      return res.sendStatus(200);
    }

    const referral = msg?.referral;
    if (referral && !s.meta.referralHandled){
      s.meta.referralHandled = true;
      s.meta.origin = 'facebook';
      s.meta.referral = referral;
      resetProductState(s);
      persistS(fromId);
      let prod = null;
      try{
        const bits = [
          referral?.headline, referral?.body, referral?.source_url, referral?.adgroup_name, referral?.campaign_name,
          referral?.deeplink_url, referral?.image_url, referral?.video_url
        ].filter(Boolean).join(' ');
        let byQS=null;
        try{
          const u = new URL(referral?.deeplink_url || referral?.source_url || '');
          const q = (k)=>u.searchParams.get(k);
          const sku = q('sku') || q('SKU');
          const pn  = q('product') || q('producto') || q('p') || q('ref');
          if(sku){
            byQS = (Array.isArray(CATALOG)?CATALOG:[]).find(p=>String(p.sku).toLowerCase()===String(sku).toLowerCase()) || null;
          }
          if(!byQS && pn){
            byQS = findProduct(pn);
          }
        }catch{}
        let byMedia = null;
        const mediaUrl = referral?.image_url || referral?.video_url || '';
        if (mediaUrl) {
          const base = mediaUrl.split('/').pop() || '';
          const stem = base.replace(/\.[a-z0-9]+$/i,'').replace(/[_\-]/g,' ');
          byMedia = findProduct(stem);
        }
        const byText = findProduct(bits);
        prod = byQS || byMedia || byText || null;
      }catch{}
        if (prod) {
          const known = isKnownClient(s) || discoveryComplete(s);

          if (!known) {
            s.greeted = true;
            persistS(fromId);

            await toText(fromId, PLAY?.greeting || '¡Qué gusto saludarte! Soy el asistente virtual de *New Chem*. Estoy para ayudarte 🙂');
            await showProduct(fromId, prod, {
              withLink: false,
              preface: `Con mucho gusto te envío la *ficha técnica* de *${prod.nombre}* 👇`
            });
            await askNombre(fromId);
            return res.sendStatus(200);
          }

          await showProduct(fromId, prod, { withLink: true });
          await nextStep(fromId);
          return res.sendStatus(200);
        }
    }

    const isLeadMsg = !!leadData;
    if(!s.greeted){
      s.greeted = true;
      persistS(fromId);
      resetProductState(s);
      if(!isLeadMsg){
        await toText(fromId, PLAY?.greeting || '¡Qué gusto saludarte!, Soy el asistente virtual de *New Chem*. Estoy para ayudarte 🙂');
      }
      if(!isLeadMsg && !s.asked.nombre){
        await askNombre(fromId);
        res.sendStatus(200);
        return;
      }
    }

    if(msg.type==='interactive'){
      const br = msg.interactive?.button_reply;
      const lr = msg.interactive?.list_reply;
      const id = br?.id || lr?.id;
      const selTitle = br?.title || lr?.title || null;
      if (selTitle) {
        remember(fromId, 'user', `✅ ${selTitle}`);
      } else {
        remember(fromId, 'user', `✅ ${id}`);
      }
      if (id === 'QR_FINALIZAR') {
        let pdfInfo = null;
        try {
          pdfInfo = await sendAutoQuotePDF(fromId, S(fromId));
        } catch (err) {
          console.error('AutoQuote error:', err);
        }
        try {
          if (!s._savedToSheet) {
            const cotId = await appendFromSession(s, fromId, 'nuevo');
            s.vars.cotizacion_id = cotId; s._savedToSheet = true; persistS(fromId);
          }
        } catch (err) {
          console.error('Sheets append error:', err);
        }
        try {
          const rec = {
            telefono: String(fromId),
            nombre: s.profileName || '',
            ubicacion: [s?.vars?.departamento || '', s?.vars?.subzona || ''].filter(Boolean).join(' - '),
            cultivo: (s?.vars?.cultivos && s.vars.cultivos[0]) || '',
            hectareas: s?.vars?.hectareas || '',
            campana: currentCampana() 
          };
          await upsertClientByPhone(rec);
        } catch (e) {
          console.error('upsert WA_CLIENTES al finalizar error:', e);
        }
        await toText(fromId, '¡Gracias por escribirnos! Te envió la *cotización en PDF*. Si requieres mas información, estamos a tu disposición.');
        await toText(fromId, 'Para volver a activar el asistente, por favor, escribe *Asistente New Chem*.');
        if (ADVISOR_WA_NUMBERS.length) {
          const txt = compileAdvisorAlert(S(fromId), fromId);
          for (const advisor of ADVISOR_WA_NUMBERS) {
            const okTxt = await waSendQ(advisor, {
              messaging_product: 'whatsapp',
              to: advisor,
              type: 'text',
              text: { body: txt.slice(0, 4096) }
            });
            if (okTxt) console.log('[ADVISOR] alerta enviada a', advisor);
            else console.warn('[ADVISOR] no se pudo enviar alerta a', advisor);
          }
          try {
            let mediaId = pdfInfo?.mediaId || null;
            let filename = pdfInfo?.filename ||
              `Cotizacion_${(s.profileName || String(fromId)).replace(/[^\w\s\-.]/g,'').replace(/\s+/g,'_')}.pdf`;
            const caption = `Cotización — ${s.profileName || fromId}`;
            if (!mediaId && pdfInfo?.path) {
              mediaId = await waUploadMediaFromFile(pdfInfo.path, 'application/pdf');
            }
            if (mediaId) {
              for (const advisor of ADVISOR_WA_NUMBERS) {
                const okDoc = await waSendQ(advisor, {
                  messaging_product: 'whatsapp',
                  to: advisor,
                  type: 'document',
                  document: { id: mediaId, filename, caption }
                });
                if (!okDoc) console.warn('[ADVISOR] PDF no enviado a', advisor);
              }
            } else {
              console.warn('[ADVISOR] No se obtuvo mediaId ni path del PDF para reenviar al asesor.');
            }
          } catch (err) {
            console.error('[ADVISOR] error al reenviar PDF:', err);
          }
        }
        humanOn(fromId, 4);
        s._closedAt = Date.now();
        s.stage = 'closed';
        persistS(fromId);
        broadcastAgent('convos', { id: fromId });
        res.sendStatus(200);
        return;
      }
      if (id === 'OPEN_CATALOG') {
        await toText(fromId, CATALOG_URL);
        res.sendStatus(200); return;
      }
      if(id==='QR_SEGUIR'){ await toText(fromId,'Perfecto, vamos a añadir un nuevo producto 🙌.'); await askCategory(fromId); res.sendStatus(200); return; }
      if (id==='ADD_MORE') {
        await toButtons(fromId,'¿Listo para *cotizar*?', [
          { title:'Cotizar', payload:'QR_FINALIZAR' }
        ]);
        res.sendStatus(200); return;
      }
      if(/^DPTO_/.test(id)){
        const depRaw = id.replace('DPTO_','').replace(/_/g,' ');
        const dep = (()=>{ const t=norm(depRaw); for(const d of DEPARTAMENTOS) if(norm(d)===t) return d; return title(depRaw); })();
        s.vars.departamento = dep; s.asked.departamento=true; s.pending=null; s.lastPrompt=null;
        s.vars.subzona = null; persistS(fromId);
        if(dep==='Santa Cruz'){ await askSubzonaSCZ(fromId); } else { await askSubzonaLibre(fromId); }
        res.sendStatus(200); return;
      }
      if(/^SUBZ_/.test(id)){
        const z = id.replace('SUBZ_','').toLowerCase();
        const mapa = { norte:'Norte', este:'Este', sur:'Sur', valles:'Valles', chiquitania:'Chiquitania' };
        if (s.vars.departamento==='Santa Cruz') s.vars.subzona = mapa[z] || null;
        s.pending=null; s.lastPrompt=null; persistS(fromId);
        await nextStep(fromId); res.sendStatus(200); return;
      }
      if (id === 'CROP_OTRO'){
        await askCultivoLibre(fromId);
        res.sendStatus(200); return;
      }
      if (id === 'HA_OTRA'){
        await askHectareasLibre(fromId);
        res.sendStatus(200); return;
      }
      if (/^HA_/.test(id)){
        s.vars.hectareas = HA_LABEL[id] || (selTitle || '');
        s.pending=null; s.lastPrompt=null; persistS(fromId);
        await nextStep(fromId);
        res.sendStatus(200); return;
      }
      if(/^CROP_/.test(id)){
        const code = id.replace('CROP_','').toLowerCase();
        const map  = { soya:'Soya', maiz:'Maíz', trigo:'Trigo', arroz:'Arroz', girasol:'Girasol' };
        const val  = map[code] || null;
        if(val){
          s.vars.cultivos = [val]; s.pending=null; s.lastPrompt=null; persistS(fromId);
          await nextStep(fromId);
        }
        res.sendStatus(200); return;
      }
      if(/^CAMP_/.test(id)){
        const code = id.replace('CAMP_','').toLowerCase();
        if(code==='verano') s.vars.campana='Verano';
        else if(code==='invierno') s.vars.campana='Invierno';
        s.pending=null; s.lastPrompt=null; persistS(fromId);
        await nextStep(fromId); res.sendStatus(200); return;
      }
    }

    if(msg.type==='text'){
      const text = (msg.text?.body||'').trim();
      remember(fromId,'user',text);

      const prodByIA = findByActiveIngredient(text);
      if (prodByIA){
        if (!s.greeted){
          await showProduct(fromId, prodByIA, { withLink: false });
          await nextStep(fromId);
          return res.sendStatus(200);
        } else {
          await showProduct(fromId, prodByIA, { withLink: true });
        }
      }
      const tnorm = norm(text);
      if (leadData) {
        s.meta.origin = 'messenger';
        s.greeted = true;
        if (leadData.name) {
          s.profileName = canonName(leadData.name);
          s.asked.nombre = true;
          if (s.pending === 'nombre') s.pending = null;
          if (s.lastPrompt === 'nombre') s.lastPrompt = null;
        }
        if (leadData.dptoZ) {
          const dep = detectDepartamento(leadData.dptoZ) || title((leadData.dptoZ.split('/')[0] || ''));
          if (dep) s.vars.departamento = dep;
          const zonaFromSlash = (leadData.dptoZ.split('/')[1] || '').trim();
          if (!s.vars.subzona && zonaFromSlash) s.vars.subzona = title(zonaFromSlash);
          if ((/santa\s*cruz/i.test(leadData.dptoZ)) && detectSubzona(leadData.dptoZ)) {
            s.vars.subzona = detectSubzona(leadData.dptoZ);
          }
        }
        if (!s.vars.subzona && leadData.zona) s.vars.subzona = title(leadData.zona);
        if (leadData.crops) {
          const picks = (leadData.crops || '')
            .split(/[,\s]+y\s+|,\s*|\s+y\s+/i)
            .map(t => norm(t.trim()))
            .filter(Boolean);
          const mapped = Array.from(new Set(picks.map(x => CROP_SYN[x]).filter(Boolean)));
          if (mapped.length) s.vars.cultivos = [mapped[0]];
        }
        persistS(fromId);
        const quien = s.profileName ? ` ${s.profileName}` : '';
        await toText(fromId, `👋 Hola${quien}, gracias por continuar con *New Chem* vía WhatsApp.\nAquí encontrarás los agroquímicos esenciales para tu cultivo, al mejor precio. 🌱`);
        await askCultivo(fromId);
        res.sendStatus(200);
        return;
      }

      if (!s.asked.nombre && s.pending !== 'nombre' && !leadData) {
        if (!hasEarlyIntent(text)) {
          await askNombre(fromId);
          res.sendStatus(200);
          return;
        }
      }

      if (s.pending === 'nombre') {
        const cleaned = text.trim();
        if (looksLikeFullName(cleaned)) {
          s.profileName = canonName(cleaned);
          s.pending = null;
          s.lastPrompt = null;
          persistS(fromId);
          await nextStep(fromId);
        } else {
          await toText(fromId, 'Para continuar, por favor escribe tu *nombre y apellido*.');
        }
        res.sendStatus(200);
        return;
      }

      if (S(fromId).pending==='cultivo_text'){
        S(fromId).vars.cultivos = [title(text)];
        S(fromId).pending=null; S(fromId).lastPrompt=null; persistS(fromId);
        await askHectareas(fromId);
        res.sendStatus(200); return;
      }

      if (S(fromId).pending==='hectareas_text'){
        const ha = parseHectareas(text);
        if (ha){
          S(fromId).vars.hectareas = ha;
          S(fromId).pending=null; S(fromId).lastPrompt=null; persistS(fromId);
          await nextStep(fromId);
        } else {
          await toText(fromId,'Por favor escribe un número válido de *hectáreas* (ej. 50).');
        }
        res.sendStatus(200); return;
      }

      if (S(fromId).pending==='subzona_libre'){
        S(fromId).vars.subzona = title(text.toLowerCase());
        S(fromId).pending=null; S(fromId).lastPrompt=null; persistS(fromId);
        await nextStep(fromId); res.sendStatus(200); return;
      }

      if (S(fromId).pending==='hectareas'){
        const ha = parseHectareas(text);
        if(ha){
          S(fromId).vars.hectareas = ha;
          S(fromId).pending=null; S(fromId).lastPrompt=null; persistS(fromId);
          await nextStep(fromId);
          res.sendStatus(200); return;
        } else {
          await toText(fromId,'Por favor ingresa un número válido de *hectáreas* (ej. 50 ha).');
          res.sendStatus(200); return;
        }
      }

      if (wantsAgentPlus(text)) {
        const quien = s.profileName ? `, ${s.profileName}` : '';
        await toText(fromId, `¡Perfecto${quien}! Ya notifiqué a nuestro equipo. Un **asesor comercial** se pondrá en contacto contigo por este chat en unos minutos para ayudarte con tu consulta y la cotización. Desde ahora **pauso el asistente automático** para que te atienda una persona. 🙌`);
        humanOn(fromId, 4); persistS(fromId); res.sendStatus(200); return;
      }

      if(/horario|atienden|abren|cierran/i.test(tnorm)){ await toText(fromId, `Atendemos ${FAQS?.horarios || 'Lun–Vie 8:00–17:00'} 🙂`); res.sendStatus(200); return; }
      if(wantsLocation(text)){ await toText(fromId, `Nuestra ubicación en Google Maps 👇\nVer ubicación: ${linkMaps()}`); await toButtons(fromId,'¿Hay algo más en lo que pueda ayudarte?',[{title:'Seguir',payload:'QR_SEGUIR'},{title:'Finalizar',payload:'QR_FINALIZAR'}]); res.sendStatus(200); return; }
      if(wantsCatalog(text)){
        await toText(fromId, `Este es nuestro catálogo completo\n${CATALOG_URL}`);
        await toButtons(fromId,'¿Quieres que te ayude a elegir o añadir un producto ahora?',[{title:'Añadir producto', payload:'ADD_MORE'},{title:'Finalizar', payload:'QR_FINALIZAR'}]);
        res.sendStatus(200); return;
      }
      if(wantsClose(text)){
        await toText(fromId,'¡Gracias por escribirnos! Si más adelante te surge algo, aquí estoy para ayudarte. 👋');
        humanOn(fromId, 4);
        s._closedAt = Date.now();
        s.stage = 'closed';
        persistS(fromId);
        broadcastAgent('convos', { id: fromId });
        res.sendStatus(200);
        return;
      }
      if(wantsAnother(text)){ await askAddMore(fromId); res.sendStatus(200); return; }

      const ha   = parseHectareas(text); if(ha && !S(fromId).vars.hectareas){ S(fromId).vars.hectareas = ha; persistS(fromId); }
      const phone= parsePhone(text);     if(phone){ S(fromId).vars.phone = phone; persistS(fromId); }

      const depTyped = detectDepartamento(text);
      const subOnly  = detectSubzona(text);
      if(depTyped){ S(fromId).vars.departamento = depTyped; S(fromId).vars.subzona=null; persistS(fromId); }
      if((S(fromId).vars.departamento==='Santa Cruz' || depTyped==='Santa Cruz') && subOnly){ S(fromId).vars.subzona = subOnly; persistS(fromId); }

      if (S(fromId).pending==='cultivo'){
        const picked = Object.keys(CROP_SYN).find(k=>tnorm.includes(k));
        if (picked){
          S(fromId).vars.cultivos = [CROP_SYN[picked]];
          S(fromId).pending=null; S(fromId).lastPrompt=null; persistS(fromId);
          await askHectareas(fromId);
          res.sendStatus(200); return;
        } else {
          await toText(fromId, 'Por favor, *elige una opción del listado* para continuar.');
          await askCultivo(fromId); res.sendStatus(200); return;
        }
      }

      if(!S(fromId).vars.campana){
        if(/\bverano\b/i.test(text)) S(fromId).vars.campana='Verano';
        else if(/\binvierno\b/i.test(text)) S(fromId).vars.campana='Invierno';
      }

      if (asksPrice(text)){
        await toText(fromId, `Para cotizar, por favor añade tus productos en el catálogo y toca *Enviar a WhatsApp*:\n${CATALOG_URL}`);
      }

      const prodByName = findProduct(text);
      if (prodByName) {
        const sNow = S(fromId);
        const known = isKnownClient(sNow) || discoveryComplete(sNow);

        if (!known) {
          if (!sNow.greeted) {
            await toText(fromId, PLAY?.greeting || '¡Qué gusto saludarte! Soy el asistente virtual de *New Chem*. Estoy para ayudarte 🙂');
            sNow.greeted = true; persistS(fromId);
          }
          await showProduct(fromId, prodByName, {
            withLink: false,
            preface: `Con mucho gusto te envío la *ficha técnica* de *${prodByName.nombre}* 👇`
          });
          if (!sNow.asked?.nombre && sNow.pending !== 'nombre') {
            await askNombre(fromId);
            return res.sendStatus(200);
          }
        } else {
          // Cliente conocido
          await showProduct(fromId, prodByName, { withLink: true });
        }
      }

      try {
        const s2 = S(fromId);
        const deadline = s2?.meta?.awaitBillingPickupUntil || 0;
        const withinWindow = deadline > Date.now();
        if (withinWindow) {
          const parsed = await parseAndAppendClientResponse({
            text,
            clientName: s2?.profileName || ''
          });
          const captured =
            parsed?.nit ||
            parsed?.razonSocial ||
            parsed?.placa ||
            parsed?.fechaRecojo ||
            parsed?.nombreChofer;
          if (captured) {
            s2.meta.awaitBillingPickupUntil = 0;
            persistS(fromId);
            await toAgentText(fromId, '✅ Recibimos los datos para facturación/entrega. ¡Gracias!');
          }
        }
      } catch (err) {
        console.error('guardar Hoja 2 error:', err);
      }

      await nextStep(fromId);
      res.sendStatus(200); return;
    }

    await nextStep(fromId);
    res.sendStatus(200);
  }catch(e){
    console.error('WA webhook error', e);
    res.sendStatus(500);
  }
});

router.get('/wa/agent/stream', agentAuth, (req,res)=>{
  res.writeHead(200, {
    'Content-Type':'text/event-stream',
    'Cache-Control':'no-cache',
    'Connection':'keep-alive',
    'X-Accel-Buffering':'no'
  });
  res.write(':\n\n');
  agentClients.add(res);
  const ping = setInterval(()=> sseSend(res,'ping',{t:Date.now()}), 25000);
  req.on('close', ()=>{ clearInterval(ping); agentClients.delete(res); });
});

function loadAllSessionIds(){
  const ids = new Set([...sessions.keys()]);
  try{
    for(const f of fs.readdirSync(SESSION_DIR)){
      if (f.endsWith('.json')) ids.add(f.replace(/\.json$/,''));
    }
  }catch{}
  return [...ids];
}

function convoSummaryFrom(id){
  const s = S(id);
  const name = s.profileName || id;
  const last = s.meta?.lastMsg?.content || (s.memory?.[s.memory.length-1]?.content) || '';
  const lastTs = s.meta?.lastAt || 0;
  return {
    id, name,
    human: isHuman(id),
    unread: s.meta?.unread || 0,
    last, lastTs,
    closed: !!s._closedAt
  };
}

router.get('/wa/agent/convos', agentAuth, (_req,res)=>{
  const list = loadAllSessionIds().map(convoSummaryFrom)
    .sort((a,b)=> (b.lastTs||0)-(a.lastTs||0));
  res.json({convos:list});
});

router.get('/wa/agent/history/:id', agentAuth, (req,res)=>{
  const id = req.params.id;
  const s = S(id);
  res.json({
    id,
    name: s.profileName || id,
    human: isHuman(id),
    unread: s.meta?.unread || 0,
    memory: s.memory || []
  });
});

router.post('/wa/agent/send', agentAuth, async (req,res)=>{
  try{
    const { to, text } = req.body || {};
    if(!to || !text) return res.status(400).json({error:'to y text son requeridos'});
    humanOn(to, 4);
    try {
      const wantsBillingPickup = /raz[oó]n social/i.test(text)
        && /nombre del chofer/i.test(text)
        && /placa/i.test(text)
        && /fecha de recojo/i.test(text);
      if (wantsBillingPickup) {
        const s = S(to);
        s.meta = s.meta || {};
        s.meta.awaitBillingPickupUntil = Date.now() + 72 * 60 * 60 * 1000;
        persistS(to);
      }
    } catch {}
    await toAgentText(to, text);
    res.json({ ok:true });
  }catch(e){
    console.error('agent/send', e);
    res.status(500).json({ok:false});
  }
});

router.post('/wa/agent/read', agentAuth, async (req,res)=>{
  try{
    const { to } = req.body || {};
    if(!to) return res.status(400).json({error:'to requerido'});
    const s = S(to);
    s.meta = s.meta || {};
    s.meta.unread = 0; persistS(to);
    if (s.meta.last_wamid){
      const url = `https://graph.facebook.com/v20.0/${WA_PHONE_ID}/messages`;
      const r = await fetch(url,{
        method:'POST',
        headers:{ 'Authorization':`Bearer ${WA_TOKEN}`, 'Content-Type':'application/json' },
        body: JSON.stringify({ messaging_product:'whatsapp', status:'read', message_id: s.meta.last_wamid })
      });
      if(!r.ok) console.error('mark read error', await r.text());
    }
    broadcastAgent('convos', { id: to });
    res.json({ok:true});
  }catch(e){
    console.error('agent/read', e);
    res.status(500).json({ok:false});
  }
});

router.post('/wa/agent/handoff', agentAuth, async (req,res)=>{
  try{
    const { to, mode } = req.body || {};
    if(!to || !mode) return res.status(400).json({error:'to y mode son requeridos'});
    if (mode==='human'){
      humanOn(to, 4);
      remember(to,'system','⏸️ Bot pausado por agente (4h).');
    } else if (mode==='bot'){
      humanOff(to);
      remember(to,'system','▶️ Bot reactivado por agente.');
      await toText(to,'He reactivado el *asistente automático*.');
    } else return res.status(400).json({error:'mode debe ser human|bot'});
    res.json({ok:true});
  }catch(e){
    console.error('agent/handoff', e);
    res.status(500).json({ok:false});
  }
});

router.post('/wa/agent/send-media', agentAuth, upload.array('files', 10), async (req, res) => {
  try{
    const to = req.body?.to;
    const caption = (req.body?.caption || '').slice(0, 1024);
    const files = req.files || [];
    if(!to || !files.length) return res.status(400).json({error:'to y files son requeridos'});
    humanOn(to, 4);
    let sent = 0;
    for (const f of files){
      const kind = mediaKindFromMime(f.mimetype);
      const id = await waUploadMediaFromFile(f.path, f.mimetype);
      if(!id){
        console.error('Upload falló para', f.originalname);
        try{ fs.unlinkSync(f.path); }catch{}
        continue;
      }
      const base = { messaging_product:'whatsapp', to, type: kind };
      let ok = true;
      let resp;
      if (kind === 'image'){
        resp = await waSendQ(to, { ...base, image: { id, caption } });
      } else if (kind === 'video'){
        resp = await waSendQ(to, { ...base, video: { id, caption } });
      } else if (kind === 'audio'){
        resp = await waSendQ(to, { ...base, audio: { id } });
      } else {
        const filename = (f.originalname || 'archivo.pdf').slice(0, 255);
        resp = await waSendQ(to, { ...base, document: { id, caption, filename } });
      }
      if (resp === false) ok = false;
      if (ok){
        sent++;
        const filename = (f.originalname || '').trim();
        const label = filename ? filename : (kind==='image'?'[imagen]': kind==='video'?'[video]': kind==='audio'?'[audio]':'[documento]');
        const memo = (kind==='image'?'🖼️ ':'') + (kind==='video'?'🎬 ':'') + (kind==='audio'?'🎧 ':'') + (kind==='document'?'📎 ':'') + (filename || '') + (caption?` — ${caption}`:'');
        remember(to,'agent', memo || label);
      }
      try{ fs.unlinkSync(f.path); }catch{}
    }
    res.json({ ok: sent>0, sent });
  }catch(e){
    console.error('agent/send-media', e);
    res.status(500).json({ok:false});
  }
});

export default router;
