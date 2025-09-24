import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { appendFromSession, parseAndAppendClientResponse } from './sheets.js';
import { appendChatHistoryRow, purgeOldChatHistory } from './sheets.js'; // ← NUEVO (Hoja 4)
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
const PRICE_LIST_URL = process.env.PRICE_LIST_URL || 'https://tinyurl.com/z8yxwcn9';
const STORE_LAT       = process.env.STORE_LAT || '-17.7580406';
const STORE_LNG       = process.env.STORE_LNG || '-63.1532503';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const AGENT_TOKEN     = process.env.AGENT_TOKEN || '';

const DEBUG_LOGS = process.env.DEBUG_LOGS === '1';
const dbg = (...args) => { if (DEBUG_LOGS) console.log(...args); };
const ADVISOR_NAME = process.env.ADVISOR_NAME || 'Jonathan Arteaga';
const ADVISOR_ROLE = process.env.ADVISOR_ROLE || 'Encargado de Negocios de New Chem Agroquímicos';

function advisorProductList(s){
  const items = (s.vars.cart && s.vars.cart.length)
    ? s.vars.cart
    : (s.vars.last_product ? [{
        nombre: s.vars.last_product,
        presentacion: s.vars.last_presentacion,
        cantidad: s.vars.cantidad
      }] : []);
  return items
    .filter(it => it && it.nombre)
    .map(it => `• ${it.nombre}${it.presentacion ? ` (${it.presentacion})` : ''} — ${it.cantidad || 'ND'}`)
    .join('\n');
}

// Mensaje prellenado que quieres en el link del asesor
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

// ===== DATA =====
function loadJSON(p){ try { return JSON.parse(fs.readFileSync(p,'utf8')); } catch { return {}; } }
const CATALOG = loadJSON('./knowledge/catalog.json');
const PLAY    = loadJSON('./knowledge/playbooks.json');
const FAQS    = loadJSON('./knowledge/faqs.json');

// ===== CONSTANTES =====
const DEPARTAMENTOS = ['Santa Cruz','Cochabamba','La Paz','Chuquisaca','Tarija','Oruro','Potosí','Beni','Pando'];
const SUBZONAS_SCZ  = ['Norte','Este','Sur','Valles','Chiquitania'];
const CAT_QR = [
  { title: 'Herbicida',   payload: 'CAT_HERBICIDA' },
  { title: 'Insecticida', payload: 'CAT_INSECTICIDA' },
  { title: 'Fungicida',   payload: 'CAT_FUNGICIDA' }
];
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
  { title:'Otras cantidades', payload:'HA_OTRA' } // mantiene el flujo de entrada libre
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

const LIST_TITLE_MAX = 24;
const LIST_DESC_MAX  = 72;

// ===== MODO HUMANO (mute 4h) =====
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
  }catch(e){ /* no romper flujo si falla IO */ }
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
      asked: { nombre:false, departamento:false, subzona:false, cultivo:false, hectareas:false, campana:false, categoria:false, cantidad:false },
      vars: {
        departamento:null, subzona:null, category:null,
        cultivos: [],
        hectareas:null,
        campana:null, 
        last_product:null, last_sku:null, last_presentacion:null,
        cantidad:null, phone:null,
        last_detail_sku:null, last_detail_ts:0,
        candidate_sku:null,
        catOffset:0,
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
  return 'document'; // pdf/doc/xls/etc.
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


function remember(id, role, content){
  const s = S(id);
  const now = Date.now();

  if (role === 'user' && s._closedAt) delete s._closedAt;

  // Memoria local (para tu panel)
  s.memory.push({ role, content, ts: now });
  if (s.memory.length > 500) s.memory = s.memory.slice(-500);

  s.meta = s.meta || {};
  s.meta.lastMsg = { role, content, ts: now };
  s.meta.lastAt  = now;
  if (role === 'user') s.meta.unread = (s.meta.unread || 0) + 1;

  persistS(id);
  broadcastAgent('msg', { id, role, content, ts: now });

  // === Respaldo en Google Sheets: Hoja 4 (wa_id | nombre | ts_iso | role | content)
  try {
    const nombre = s.profileName || '';
    const ts_iso = new Date(now).toISOString();
    // ⚠️ NO esperes esta promesa para no frenar el flujo de WhatsApp
    appendChatHistoryRow({ wa_id: id, nombre, ts_iso, role, content }).catch(() => {});
  } catch {}
}

// purga automática cada 6h (borra filas con ts_iso > 7 días)
setInterval(() => {
  try { purgeOldChatHistory(7).catch(() => {}); } catch {}
}, 6 * 60 * 60 * 1000).unref?.();


const normalizeCatLabel = (c='')=>{
  const t=norm(c);
  if(t.includes('fungicida')) return 'Fungicida';
  if(t.includes('herbicida')) return 'Herbicida';
  if(t.includes('insecticida')||t.includes('acaricida')) return 'Insecticida';
  return null;
};
function findProduct(text){
  const nt = norm(text);
  return (CATALOG||[]).find(p=>{
    const n = norm(p.nombre||''); if(nt.includes(n)) return true;
    return n.split(/\s+/).filter(Boolean).every(tok=>nt.includes(tok));
  }) || null;
}

function hasEarlyIntent(t=''){
  return wantsCatalog(t) || wantsLocation(t) || asksPrice(t) || wantsAgentPlus(t) || wantsBuy(t)
      || !!findProduct(t) || findProductsByIA(t).length>0 || !!detectCategory(t);
}

const IA_SYNONYMS = {
  'glifo':'glifosato', 'glifosate':'glifosato', 'glyphosate':'glifosato',
  'paraquat':'paraquat', 'paraquat dichloride':'paraquat',
  'dicloruro de paraquat':'paraquat', 'paraquat dicloruro':'paraquat',
  'atrazina':'atrazine',
  'clethodim':'clethodim', 'cletodim':'clethodim', 'cleto':'clethodim',
  'abamectina':'abamectin', 'abamectin':'abamectin',
  'emamectina':'emamectin', 'emamectin':'emamectin',
  'tiametoxam':'thiametoxam', 'thiametoxam':'thiametoxam',
  'thiamethoxam':'thiametoxam', 'tiametoxan':'thiametoxam', 'thiametoxan':'thiametoxam',
  'bifentrina':'bifenthrin', 'bifentrin':'bifenthrin', 'bifenthrin':'bifenthrin',
  'fipronil':'fipronil',
  'mancoceb':'mancozeb', 'mancozeb':'mancozeb'
};

function canonIA(t){
  const x = norm(t).replace(/[^a-z0-9\s\.,\/\-\+]/g,' ').replace(/\s+/g,' ').trim();
  return IA_SYNONYMS[x] || x;
}
function splitIAText(ia=''){
  const t = canonIA(ia);
  return t.split(/[,\+\/;]| y | con /g).map(s=>s.trim()).filter(w=>w.length>=3);
}

function findProductsByIA(text){
  const q = String(text || '');
  if (!/[a-z]/i.test(q) || isLikelyQuantity(q)) return [];
  const qAlpha = alphaIA(q);
  if (!qAlpha || qAlpha.length < 3) return [];
  const qTokens = qAlpha.split(' ').filter(t => t.length >= 3);
  const hits = [];
  for (const p of (CATALOG || [])){
    const iaAlpha = alphaIA(p?.ingrediente_activo || p?.formulacion || '');
    if (!iaAlpha) continue;
    const match = qTokens.every(tok => iaAlpha.includes(tok));
    if (match) hits.push(p);
  }
  return hits;
}

function levenshtein(a='', b=''){
  const m=a.length, n=b.length;
  const dp=Array.from({length:m+1},()=>Array(n+1).fill(0));
  for(let i=0;i<=m;i++) dp[i][0]=i;
  for(let j=0;j<=n;j++) dp[0][j]=j;
  for(let i=1;i<=m;i++){
    for(let j=1;j<=n;j++){
      const cost = a[i-1]===b[j-1]?0:1;
      dp[i][j]=Math.min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1]+cost);
    }
  }
  return dp[m][n];
}
function fuzzyCandidate(text){
  const qRaw = norm(text).replace(/[^a-z0-9\s]/g,'').trim();
  if(!qRaw) return null;
  let best=null, bestScore=-1;
  for(const p of (CATALOG||[])){
    const name = norm(p.nombre||'');
    const dist = levenshtein(qRaw, name);
    const sim  = 1 - dist/Math.max(qRaw.length, name.length);
    if (sim > bestScore){ best = p; bestScore = sim; }
  }
  if (best && bestScore >= 0.75) return { prod: best, score: bestScore };
  return null;
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


function getProductsByCategory(cat){
  const key = norm(cat||'');
  return (CATALOG||[]).filter(p=>{
    const c = norm(p.categoria||'');
    if(key==='herbicida') return c.includes('herbicida');
    if(key==='insecticida') return c.includes('insecticida') || c.includes('acaricida') || c.includes('insecticida-acaricida');
    if(key==='fungicida')   return c.includes('fungicida');
    return false;
  });
}
const parseCantidad = text=>{
  const m = String(text).match(/(\d{1,6}(?:[.,]\d{1,2})?)\s*(l|lt|lts|litro?s|kg|kilos?|unid|unidad(?:es)?)/i);
  return m ? `${m[1].replace(',','.') } ${m[2].toLowerCase()}` : null;
};
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
function detectCategory(text){
  const t = norm(text);
  if (/fungicida/.test(t)) return 'Fungicida';
  if (/insecticida\s*\+\s*acaricida|ins\.\s*\+\s*acaricida|insecticida-?acaricida|acaricida/.test(t)) return 'Insecticida';
  if (/herbicida/.test(t)) return 'Herbicida';
  if (/insecticida/.test(t)) return 'Insecticida';
  return null;
}
const mentionsAcaricida = t => /acaricida|insecticida\s*\+\s*acaricida|insecticida-?acaricida/i.test(norm(t));
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
  return valid.length >= 2 && s.length <= 60; // nombre + apellido
}

function productFromReferral(ref){
  try{
    const bits = [
     ref?.headline, ref?.body, ref?.source_url, ref?.adgroup_name, ref?.campaign_name,
     ref?.deeplink_url, ref?.image_url, ref?.video_url
    ]
      .filter(Boolean).join(' ');
    let byQS=null;
    try{
      const u = new URL(ref?.deeplink_url || ref?.source_url || '');
      const q = (k)=>u.searchParams.get(k);
      const sku = q('sku') || q('SKU');
      const pn  = q('product') || q('producto') || q('p') || q('ref');
      if(sku){
        byQS = (CATALOG||[]).find(p=>String(p.sku).toLowerCase()===String(sku).toLowerCase());
      }
      if(!byQS && pn){
        byQS = findProduct(pn) || (fuzzyCandidate(pn)||{}).prod || null;
      }
    }catch{}
    // extra: intenta con nombre de archivo de imagen/video del anuncio
    let byMedia = null;
    const mediaUrl = ref?.image_url || ref?.video_url || '';
    if (mediaUrl) {
      const base = mediaUrl.split('/').pop() || '';
      const stem = base.replace(/\.[a-z0-9]+$/i,'').replace(/[_\-]/g,' ');
      byMedia = findProduct(stem) || ((fuzzyCandidate(stem)||{}).prod) || null;
    }
    const byText = findProduct(bits) || ((fuzzyCandidate(bits)||{}).prod) || null;
    return byQS || byMedia || byText || null;
  }catch{ return null; }
}

// ===== RESUMEN =====
function inferUnitFromProduct(s){
  const name = s?.vars?.last_product || '';
  const prod = name ? (CATALOG||[]).find(p => norm(p.nombre||'')===norm(name)) : null;
  const pres = (prod?.presentaciones||[]).join(' ').toLowerCase();
  if(/kg/.test(pres)) return 'Kg';
  if(/\b(l|lt|lts|litro)s?\b/.test(pres)) return 'L';
  const cat = (prod?.categoria || s?.vars?.category || '').toLowerCase();
  if(/herbicida|insecticida|fungicida/.test(cat)) return 'L';
  return 'Kg';
}
function summaryText(s){
  const nombre = s.profileName || 'Cliente';
  const dep    = s.vars.departamento || 'ND';
  const zona   = s.vars.subzona || 'ND';
  const cultivo= s.vars.cultivos?.[0] || 'ND';
  const ha     = s.vars.hectareas || 'ND';
  const camp   = s.vars.campana || 'ND';

  let linesProductos = [];
  if ((s.vars.cart||[]).length){
    linesProductos = s.vars.cart.map(it=>{
      const pres = it.presentacion ? ` (${it.presentacion})` : '';
      return `* ${it.nombre}${pres} — ${it.cantidad}`;
    });
  } else {
    const p = s.vars.last_product || 'ND';
    const pres = s.vars.last_presentacion ? ` (${s.vars.last_presentacion})` : '';
    const c = s.vars.cantidad || 'ND';
    linesProductos = [`* ${p}${pres} — ${c}`];
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
function isLikelyQuantity(text=''){
  return /^\s*\d{1,6}(?:[.,]\d{1,2})?\s*(l|lt|lts|litro?s|kg|kilos?|unid|unidad(?:es)?)?\s*$/i.test(text);
}

function escRe(s=''){ return String(s).replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }

function alphaIA(str=''){
  let x = norm(str);
  for (const [k,v] of Object.entries(IA_SYNONYMS)){
    const re = new RegExp(`\\b${escRe(k)}\\b`, 'g');
    x = x.replace(re, v);
  }
  return x
    .replace(/\d+(?:[.,]\d+)?/g, ' ')
    .replace(/\b(l|lt|lts|litros?|kg|kilos?|g|gr|ha|wg|wp|sc|sl|ec|ew|cs|od|gr)\b/g,' ')
    .replace(/[^a-z\s]/g,' ')
    .replace(/\s+/g,' ')
    .trim();
}

// ===== IMÁGENES =====
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

// ===== RESET PRODUCT STATE =====
function resetProductState(s, { clearCategory = true } = {}) {
  if (!s || !s.vars) return;

  // Limpiar únicamente lo relacionado a productos
  s.vars.last_product = null;
  s.vars.last_sku = null;
  s.vars.last_presentacion = null;
  s.vars.cantidad = null;
  s.vars.cart = [];
  s.vars.catOffset = 0;

  // Aux de detalle/candidato
  s.vars.candidate_sku = null;
  s.vars.last_detail_sku = null;
  s.vars.last_detail_ts = 0;

  // Re-preguntar categoría en el nuevo flujo
  if (clearCategory) {
    s.vars.category = null;
    s.asked.categoria = false;
  }

  // Volver a pedir cantidad cuando corresponda
  s.asked.cantidad = false;

  // Reset de control de flujo (sin tocar nombre/dpto/zona/cultivo/ha/campaña)
  s.stage = 'product';
  s.pending = null;
  s.lastPrompt = null;
}


// ===== ENVÍO WA =====
const sendQueues = new Map();
const sleep = (ms=350)=>new Promise(r=>setTimeout(r,ms));
// mejora waSendQ para devolver false si la API responde con error
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

// usa el mime correcto al subir (si lo tienes desde multer, úsalo; si no, adivina por extensión)
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

// ===== PREGUNTAS ATÓMICAS =====
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
  const s=S(to); 
  if (s.lastPrompt==='categoria') return;
  s.stage='product'; 
  await markPrompt(s,'categoria'); 
  s.pending='categoria'; 
  s.asked.categoria=true;
  persistS(to); 

  await toText(to, `Te dejo nuestro *catálogo* para que puedas ver nuestras opciones \nhttps://tinyurl.com/f4euhvzk`);
  await toText(to, `Y nuestra *lista de precios* actualizada:\n${PRICE_LIST_URL}`);

  await toButtons(
    to,
    '¿Qué tipo de producto necesitas?',
    CAT_QR.map(c=>({ title:c.title, payload:c.payload }))
  );
}

function productHasMultiPres(prod){
  const pres = Array.isArray(prod?.presentaciones) ? prod.presentaciones.filter(Boolean) : [];
  return pres.length > 1;
}
function productSinglePres(prod){
  const pres = Array.isArray(prod?.presentaciones) ? prod.presentaciones.filter(Boolean) : [];
  return pres.length === 1 ? pres[0] : null;
}
async function askPresentacion(to, prod){
  const s = S(to);

  const pres = (prod?.presentaciones || []).filter(Boolean);
  if (pres.length <= 1) return;

  // evita duplicados: si ya estás en "presentacion" y no está "stale", no repitas
  const fresh = s.lastPrompt === 'presentacion' && (Date.now() - (s.lastPromptTs || 0)) < 25000;
  if (fresh) return;

  await markPrompt(s, 'presentacion'); // <-- importante
  s.pending = 'presentacion';
  persistS(to);

  const rows = pres.map(p => ({
    title: String(p),
    payload: `PRES_${prod.sku}__${b64u(String(p))}`
  }));
  await toList(to, `¿En qué *presentación* deseas *${prod.nombre}*?`, 'Elegir presentación', rows);
}


function productListRow(p){
  const nombre = p?.nombre || '';
  const ia     = p?.ingrediente_activo || p?.formulacion || p?.categoria || '';
  return {
    title: nombre,
    description: ia ? `${ia}` : undefined,
    payload: `PROD_${p.sku}`
  };
}

async function listByIA(to, products, iaText){
  const rows = products.slice(0,9).map(productListRow);
  await toList(to, `Productos con IA: ${title(iaText)}`, 'Elegir producto', rows);
  await toText(to, `Decime cuál te interesa y te paso el detalle. *Compra mínima: US$ 3.000*`);
}

async function listByCategory(to){
  const s=S(to);
  const all = getProductsByCategory(s.vars.category||'');
  if(!all.length){ await toText(to,'Por ahora no tengo productos en esa categoría. ¿Querés ver el catálogo completo?'); return; }
  const offset = s.vars.catOffset || 0;
  const remaining = all.length - offset;
  const show = remaining > 9 ? 9 : remaining;

  const rows = all.slice(offset, offset+show).map(productListRow);
  if(remaining > show) rows.push({ title:'Ver más…', payload:`CAT_MORE_${offset+show}` });

  await toList(to, `${s.vars.category} disponibles`, 'Elegir producto', rows);
  if(offset===0) await toText(to, `Decime cuál te interesa y te paso el detalle. *Compra mínima: US$ 3.000*`);
}

const shouldShowDetail = (s, sku) => s.vars.last_detail_sku !== sku || (Date.now() - (s.vars.last_detail_ts||0)) > 60000;
const markDetailShown = (s, sku) => { s.vars.last_detail_sku = sku; s.vars.last_detail_ts = Date.now(); };

async function showProduct(to, prod){
  const s=S(to);
  s.vars.last_product = prod.nombre;
  s.vars.last_sku = prod.sku;
  s.vars.last_presentacion = null; 
  persistS(to); 

  const catNorm = normalizeCatLabel(prod.categoria||'');
  if(catNorm && !s.vars.category) s.vars.category = catNorm;

  if (shouldShowDetail(s, prod.sku)) {
    await toText(to, `Aquí tienes la ficha técnica de *${prod.nombre}* 📄`);

    const src = productImageSource(prod);
    if (src) {
      await toImage(to, src);
    } else {
      const plagas=(prod.plaga||[]).slice(0,5).join(', ')||'-';
      const present=(prod.presentaciones||[]).join(', ')||'-';
      const ia = prod.ingrediente_activo || '-';
      await toText(to,
        `Sobre *${prod.nombre}* (${prod.categoria}):`+
        `\n• Ingrediente activo: ${ia}`+
        `\n• Formulación / acción: ${prod.formulacion}`+
        `\n• Dosis de referencia: ${prod.dosis}`+
        `\n• Espectro objetivo: ${plagas}`+
        `\n• Presentaciones: ${present}`
      );
    }
    markDetailShown(s, prod.sku);
  }

    const single = productSinglePres(prod);
    if (single && !s.vars.last_presentacion) {
      s.vars.last_presentacion = single;
    } else if (productHasMultiPres(prod) && !s.vars.last_presentacion) {
      await askPresentacion(to, prod);   // <-- ya desduplica y marca lastPrompt
    }
    persistS(to);
}

// ===== CARRITO =====
function addCurrentToCart(s){
  if(!s.vars.last_sku || !s.vars.last_product || !s.vars.cantidad) return false;
  const exists = (s.vars.cart||[]).find(it=>it.sku===s.vars.last_sku);
  const pres = s.vars.last_presentacion || undefined;
  if(exists){
    exists.cantidad = s.vars.cantidad;
    exists.presentacion = pres;
  } else {
    s.vars.cart.push({ sku:s.vars.last_sku, nombre:s.vars.last_product, presentacion:pres, cantidad:s.vars.cantidad });
  }
  s.vars.last_product=null; s.vars.last_sku=null; s.vars.cantidad=null; s.vars.last_presentacion=null;
  s.asked.cantidad=false;
  return true;
}
async function askAddMore(to){
  await toButtons(to,'¿Deseas añadir otro producto?', [
    { title:'Sí, añadir otro', payload:'ADD_MORE' },
    { title:'No, continuar',  payload:'NO_MORE' }
  ]);
}
async function afterSummary(to, variant='cart'){
  const s=S(to);
  await toText(to, summaryText(s));

  if (s.meta?.origin === 'messenger') {
    const quien = s.profileName ? `, ${s.profileName}` : '';
    await toText(to, `¡Excelente${quien}! Tomo estos datos y preparo tu cotización personalizada. Te la enviamos enseguida por este chat.`);
  }

  if (variant === 'help') {
    await toButtons(to,'¿Necesitas ayuda en algo más?', [
      { title:'Añadir producto', payload:'QR_SEGUIR' },
      { title:'Cotizar',         payload:'QR_FINALIZAR' }
    ]);
  } else {
    await toButtons(to,'¿Deseas añadir otro producto o finalizamos?', [
      { title:'Añadir otro', payload:'ADD_MORE' },
      { title:'Finalizar',   payload:'QR_FINALIZAR' }
    ]);
  }
}

const busy = new Set(); 
async function nextStep(to){
  if (busy.has(to)) return;
  busy.add(to);
  try{
    const s=S(to);
    const stale = (key)=> s.lastPrompt===key && (Date.now()-s.lastPromptTs>25000);
    if (s.pending && !stale(s.pending)) return;

    // (0) Nombre
    if ((!s.asked.nombre) && (s.meta.origin!=='messenger' || !s.profileName)) {
      if(stale('nombre') || s.lastPrompt!=='nombre') return askNombre(to);
      return;
    }

    // (1) Departamento
    if(!s.vars.departamento){
      if(stale('departamento') || s.lastPrompt!=='departamento') return askDepartamento(to);
      return;
    }

    // (2) Subzona
    if(!s.vars.subzona){
      if(s.vars.departamento==='Santa Cruz'){
        if(stale('subzona') || s.lastPrompt!=='subzona') return askSubzonaSCZ(to);
      }else{
        if(stale('subzona_libre') || s.lastPrompt!=='subzona_libre') return askSubzonaLibre(to);
      }
      return;
    }

    // (3) Cultivo (opciones)
    if(!s.vars.cultivos || s.vars.cultivos.length===0){
      if(stale('cultivo') || s.lastPrompt!=='cultivo') return askCultivo(to);
      return;
    }

    // (4) Hectáreas
    if(!s.vars.hectareas){
      if(stale('hectareas') || s.lastPrompt!=='hectareas') return askHectareas(to);
      return;
    }

    // (5) Campaña
    if(!s.vars.campana){
      if(stale('campana') || s.lastPrompt!=='campana') return askCampana(to);
      return;
    }

    // (6) Categoría / producto
    if(s.vars.last_product && !s.vars.category){
      const p=(CATALOG||[]).find(pp=>norm(pp.nombre||'')===norm(s.vars.last_product));
      const c=normalizeCatLabel(p?.categoria||''); if(c) s.vars.category=c;
    }

    if(!s.vars.last_product && !s.vars.category){
    if(stale('categoria') || s.lastPrompt!=='categoria') return askCategory(to);
    return;
    }
    // (7) Listado por categoría si aún no hay producto elegido
    if(!s.vars.last_product) return listByCategory(to);

    // (8) Presentación (si hay varias y aún no se eligió)
    const prod = (CATALOG||[]).find(p => p.sku === s.vars.last_sku);
    if (prod && productHasMultiPres(prod) && !s.vars.last_presentacion) {
      return askPresentacion(to, prod);
    }
    if(prod && productSinglePres(prod) && !s.vars.last_presentacion){
      s.vars.last_presentacion = productSinglePres(prod);
    }

    // (9) Cantidad
    if(!s.vars.cantidad){
      if (!s.asked.cantidad){
        s.pending='cantidad'; await markPrompt(s,'cantidad'); s.asked.cantidad=true;
        persistS(to); // ★
        return toText(to,'Para poder realizar tu cotización, ¿qué *cantidad* necesitas *(L/KG o unidades)*?');
      }
      return;
    }
  } finally {
    persistS(to); 
    busy.delete(to);
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
  const camp    = s.vars.campana || 'ND';
  const prod    = s.vars.last_product || (s.vars.cart?.[0]?.nombre || '—');
  const cant    = s.vars.cantidad || (s.vars.cart?.[0]?.cantidad || '—');

  const baseChat     = `https://wa.me/${customerWa}`;
  const presetText   = buildAdvisorPresetText(s);             // ← tu mensaje
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
    s.meta = s.meta || {};
    if (msg.id) { s.meta.last_wamid = msg.id; persistS(fromId); } // para "marcar leído"

    const textRaw = (msg.type==='text' ? (msg.text?.body || '').trim() : '');
    const leadData = (msg.type === 'text') ? parseMessengerLead(textRaw) : null;


    // ===== Precarga desde WA_CLIENTES (si ya existe el número) =====
try {
  if (!s.meta) s.meta = {};
  if (!s.meta.preloadedFromSheet) {
    const rec = await getClientByPhone(fromId);
    s.meta.preloadedFromSheet = true; // para no repetir lecturas en cada msg
    if (rec) {
      // Poblar sesión
      if (rec.nombre) s.profileName = rec.nombre;
      if (rec.dep)    s.vars.departamento = rec.dep;
      if (rec.subzona) s.vars.subzona = rec.subzona;
      if (rec.cultivo) s.vars.cultivos = [rec.cultivo];
      if (rec.hectareas) s.vars.hectareas = rec.hectareas;
      if (rec.campana)  s.vars.campana  = rec.campana;

      // Marcar preguntas como respondidas (para saltarlas)
      s.asked = s.asked || {};
      if (s.profileName) s.asked.nombre = true;
      if (s.vars.departamento) s.asked.departamento = true;
      if (s.vars.subzona) s.asked.subzona = true;
      if (s.vars.cultivos?.length) s.asked.cultivo = true;
      if (s.vars.hectareas) s.asked.hectareas = true;
      if (s.vars.campana) s.asked.campana = true;

      // Marca saludado y persiste
      s.greeted = true;
      persistS(fromId);

      // Saludo breve con nombre (sin confirmar nada)
      if (s.profileName) {
        await toText(fromId, `Hola *${s.profileName}*. ¡Qué gusto saludarte nuevamente! Soy el asistente virtual de *New Chem Agroquímicos*.`);
      }

      // Salta directo al siguiente paso de producto/cotización
      await nextStep(fromId);
      return res.sendStatus(200);
    } else {
      persistS(fromId); // ya marcamos preloadedFromSheet
    }
  }
} catch (e) {
  console.error('preload WA_CLIENTES error:', e);
}


   // 🙋 Modo humano (bot pausado)
if (isHuman(fromId)) {
  if (textRaw) remember(fromId, 'user', textRaw);

  // ⬇️ EXCEPCIÓN: aunque esté en modo humano, si está abierta la ventana
  // de facturación/recojo, parsea y guarda, y confirma al cliente.
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
        // cierra la ventana para evitar duplicados
        s.meta.awaitBillingPickupUntil = 0;
        persistS(fromId);

        // confirma al cliente en el mismo chat
        await toAgentText(fromId, '✅ Recibimos los datos para facturación/entrega. ¡Gracias!');
      }
    }
  } catch (err) {
    console.error('guardar Hoja 2 (modo humano) error:', err);
  }

  if (textRaw && wantsBotBack(textRaw)) {
    humanOff(fromId);
    resetProductState(s, { clearCategory: true });
    persistS(fromId);
    const quien = s.profileName ? `, ${s.profileName}` : '';
    await toText(fromId, `Listo${quien} 🙌. Reactivé el *Asistente Virtual de New Chem Agroquímicos*.`);
    await askCategory(fromId);

    return res.sendStatus(200);
  }

  persistS(fromId);
  return res.sendStatus(200);
}

// 👤 Si escribe el asesor, solo abrir ventana 24h y salir
if (isAdvisor(fromId)) {
  console.log('[HOOK] Mensaje del asesor — abriendo ventana 24h');
  advisorWindowTs = Date.now();
  persistS(fromId);
  return res.sendStatus(200);
}



    // 🧲 Referral (Facebook Ads)
    const referral = msg?.referral;
    if (referral && !s.meta.referralHandled){
      s.meta.referralHandled = true;
      s.meta.origin = 'facebook';
      s.meta.referral = referral;
      resetProductState(s, { clearCategory: true });
      persistS(fromId);
      const prod = productFromReferral(referral);
      if (prod){
        s.vars.candidate_sku = prod.sku;
        persistS(fromId);
        await toButtons(fromId, `Gracias por escribirnos desde Facebook. ¿La consulta es sobre *${prod.nombre}*?`, [
          { title:`Sí, ${prod.nombre}`, payload:`REF_YES_${prod.sku}` },
          { title:'No, otro producto',  payload:'REF_NO' }
        ]);
        res.sendStatus(200); return;
      }
    }

    const isLeadMsg = !!leadData;
    if(!s.greeted){
      s.greeted = true; 
      persistS(fromId);
      resetProductState(s, { clearCategory: true });

      if(!isLeadMsg){
        await toText(fromId, PLAY?.greeting || '¡Qué gusto saludarte!, Soy el asistente virtual de *New Chem*. Estoy para ayudarte 🙂');
      }
      if(!isLeadMsg && !s.asked.nombre){
        await askNombre(fromId);
        res.sendStatus(200); 
        return;
      }
    }

    // ===== INTERACTIVOS =====
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
        // 1) Generar y ENVIAR PDF al cliente, y obtener info para reenvío
        let pdfInfo = null;
        try {
          pdfInfo = await sendAutoQuotePDF(fromId, S(fromId)); // { mediaId? , path?, filename? }
        } catch (err) {
          console.error('AutoQuote error:', err);
        }

        // 2) Guardar en Google Sheets (igual que antes)
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
      campana: s?.vars?.campana || ''
    };
    await upsertClientByPhone(rec);
  } catch (e) {
    console.error('upsert WA_CLIENTES al finalizar error:', e);
  }

        // 3) Mensajes al cliente (igual que antes)
        await toText(fromId, '¡Gracias por escribirnos! Te envió la *cotización en PDF*. Si requieres mas información, estamos a tu disposición.');
        await toText(fromId, 'Para volver a activar el asistente, por favor, escribe *Asistente New Chem*.');

        // 4) Aviso al/los asesores + REENVÍO DEL PDF
        if (ADVISOR_WA_NUMBERS.length) {
          const txt = compileAdvisorAlert(S(fromId), fromId);

          // (4.1) Aviso de texto (como antes)
          for (const advisor of ADVISOR_WA_NUMBERS) {
            const okTxt = await waSendQ(advisor, {
              messaging_product: 'whatsapp',
              to: advisor,
              type: 'text',
              text: { body: txt.slice(0, 4096) }
            });
            if (okTxt) console.log('[ADVISOR] alerta enviada a', advisor);
            else console.warn('[ADVISOR] no se pudo enviar alerta a', advisor, '(prob. fuera de 24h / sin sesión abierta).');
          }

          // (4.2) Reenviar el PDF
          try {
            // Intenta reutilizar mediaId; si no hay, sube desde path
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
                if (!okDoc) console.warn('[ADVISOR] PDF no enviado a', advisor, '(prob. fuera de 24h / sin sesión abierta).');
              }
            } else {
              console.warn('[ADVISOR] No se obtuvo mediaId ni path del PDF para reenviar al asesor.');
            }
          } catch (err) {
            console.error('[ADVISOR] error al reenviar PDF:', err);
          }
        }


        // 5) Cierre (igual que antes)
        humanOn(fromId, 4);
        s._closedAt = Date.now();
        s.stage = 'closed';
        persistS(fromId);
        broadcastAgent('convos', { id: fromId });
        res.sendStatus(200);
        return;
      }


      if(id==='QR_SEGUIR'){ await toText(fromId,'Perfecto, vamos a añadir un nuevo producto 🙌.'); await askCategory(fromId); res.sendStatus(200); return; }
      if(id==='ADD_MORE'){ s.vars.catOffset=0; s.vars.last_product=null; s.vars.last_sku=null; s.vars.last_presentacion=null; s.vars.cantidad=null; s.asked.cantidad=false; persistS(fromId); await toButtons(fromId,'Dime el *nombre del otro producto* o elige una categoría 👇', CAT_QR.map(c=>({title:c.title,payload:c.payload}))); res.sendStatus(200); return; }
      if(id==='NO_MORE'){ await afterSummary(fromId, 'help'); res.sendStatus(200); return; }

      if(/^REF_YES_/.test(id)){
        const sku = id.replace('REF_YES_','');
        const prod = (CATALOG||[]).find(p=>String(p.sku)===String(sku));
        if(prod){
          s.vars.last_product = prod.nombre; s.vars.last_sku = prod.sku; s.vars.last_presentacion=null;
          const catNorm = normalizeCatLabel(prod.categoria||''); if(catNorm) s.vars.category = catNorm;
          persistS(fromId);
          await showProduct(fromId, prod);
          await nextStep(fromId);
        }
        res.sendStatus(200); return;
      }
      if(id==='REF_NO'){
        s.pending='product_name'; s.lastPrompt='product_name'; s.lastPromptTs=Date.now(); persistS(fromId);
        await toText(fromId,'Claro, indícame por favor el *nombre del producto* que te interesa y te paso el detalle.');
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
      if(/^CAT_/.test(id)){
        const key = id.replace('CAT_','').toLowerCase();
        s.vars.category = key==='herbicida' ? 'Herbicida' : key==='insecticida' ? 'Insecticida' : 'Fungicida';
        s.vars.catOffset = 0; s.stage='product'; s.pending=null; s.lastPrompt=null; persistS(fromId);
        await nextStep(fromId); res.sendStatus(200); return;
      }
      if(/^CAT_MORE_/.test(id)){
        const next = parseInt(id.replace('CAT_MORE_',''),10) || 0;
        s.vars.catOffset = next; persistS(fromId);
        await listByCategory(fromId); res.sendStatus(200); return;
      }
      if(/^PROD_/.test(id)){
        const sku = id.replace('PROD_','');
        const prod = (CATALOG||[]).find(p=>p.sku===sku);
        if(prod){
          s.vars.last_product = prod.nombre; s.vars.last_sku = prod.sku; s.vars.last_presentacion=null;
          const catNorm = normalizeCatLabel(prod.categoria||''); if(catNorm) s.vars.category = catNorm;
          persistS(fromId);
          await showProduct(fromId, prod);
          if(productHasMultiPres(prod)){
            // se pidió en showProduct
          } else if (!s.vars.cantidad && !s.asked.cantidad){
            s.pending='cantidad'; s.lastPrompt='cantidad'; s.lastPromptTs=Date.now(); s.asked.cantidad=true; persistS(fromId);
            await toText(fromId,'¿Qué *cantidad* necesitas *(L/KG o unidades)* para este producto?');
          }
        }
        res.sendStatus(200); return;
      }
      if(/^PRES_/.test(id)){
        const m = id.match(/^PRES_(.+?)__(.+)$/);
        if(m){
          const sku = m[1];
          const pres = ub64u(m[2]);
          if(s.vars.last_sku===sku){
            s.vars.last_presentacion = pres; persistS(fromId);
            if(!s.vars.cantidad){
              s.pending='cantidad'; s.lastPrompt='cantidad'; s.lastPromptTs=Date.now(); s.asked.cantidad=true; persistS(fromId);
              await toText(fromId,'Perfecto. ¿Qué *cantidad* necesitas *(L/KG o unidades)* para este producto?');
            }
          }
        }
        res.sendStatus(200); return;
      }
    }

    // ===== TEXTO =====
    if(msg.type==='text'){
      const text = (msg.text?.body||'').trim();
      remember(fromId,'user',text);
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

      // Hectáreas libre (activado desde HA_OTRA)
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

      // Subzona libre
      if (S(fromId).pending==='subzona_libre'){
        S(fromId).vars.subzona = title(text.toLowerCase());
        S(fromId).pending=null; S(fromId).lastPrompt=null; persistS(fromId);
        await nextStep(fromId); res.sendStatus(200); return;
      }

      // Hectáreas
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

      // ASESOR
      if (wantsAgentPlus(text)) {
        const quien = s.profileName ? `, ${s.profileName}` : '';
        await toText(fromId, `¡Perfecto${quien}! Ya notifiqué a nuestro equipo. Un **asesor comercial** se pondrá en contacto contigo por este chat en unos minutos para ayudarte con tu consulta y la cotización. Desde ahora **pauso el asistente automático** para que te atienda una persona. 🙌`);
        humanOn(fromId, 4); persistS(fromId); res.sendStatus(200); return;
      }

      if(/horario|atienden|abren|cierran/i.test(tnorm)){ await toText(fromId, `Atendemos ${FAQS?.horarios || 'Lun–Vie 8:00–17:00'} 🙂`); res.sendStatus(200); return; }
      if(wantsLocation(text)){ await toText(fromId, `Nuestra ubicación en Google Maps 👇\nVer ubicación: ${linkMaps()}`); await toButtons(fromId,'¿Hay algo más en lo que pueda ayudarte?',[{title:'Seguir',payload:'QR_SEGUIR'},{title:'Finalizar',payload:'QR_FINALIZAR'}]); res.sendStatus(200); return; }
      if(wantsCatalog(text)){
        await toText(fromId, `Este es nuestro catálogo completo\nhttps://tinyurl.com/f4euhvzk`);
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

      let cant = parseCantidad(text);
      if(!cant && (S(fromId).pending==='cantidad')){
        const mOnly = text.match(/^\s*(\d{1,6}(?:[.,]\d{1,2})?)\s*$/);
        if(mOnly){ const unit = inferUnitFromProduct(S(fromId)).toLowerCase(); cant = `${mOnly[1].replace(',','.') } ${unit}`; }
      }
      if(cant){ S(fromId).vars.cantidad = cant; persistS(fromId); }
      const prodExact = findProduct(text);
      const iaHits = findProductsByIA(text);
      if (prodExact){
        S(fromId).vars.last_product = prodExact.nombre;
        S(fromId).vars.last_sku = prodExact.sku;
        S(fromId).vars.last_presentacion = null;
        const catFromProd = normalizeCatLabel(prodExact.categoria||''); if (catFromProd) S(fromId).vars.category = catFromProd;
        S(fromId).stage='product'; S(fromId).vars.catOffset=0; persistS(fromId);
      } else if (iaHits.length === 1){
        const prod = iaHits[0];
        S(fromId).vars.last_product = prod.nombre;
        S(fromId).vars.last_sku = prod.sku;
        S(fromId).vars.last_presentacion = null;
        const catFromProd = normalizeCatLabel(prod.categoria||''); if (catFromProd) S(fromId).vars.category = catFromProd;
        S(fromId).stage='product'; S(fromId).vars.catOffset=0; persistS(fromId);
      } else if (iaHits.length > 1){
        await listByIA(fromId, iaHits, text);
        res.sendStatus(200); return;
      }

      const catTyped2 = detectCategory(text);
      if(catTyped2){
        S(fromId).vars.category=catTyped2; S(fromId).vars.catOffset=0; S(fromId).asked.categoria=true; S(fromId).stage='product';
        persistS(fromId);
        if (mentionsAcaricida(text) && catTyped2==='Insecticida') await toText(fromId,'Te muestro Insecticidas que cubren ácaros.');
      }

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

      if(asksPrice(text)){
        if (mentionsAcaricida(text)) await toText(fromId, 'Te muestro Insecticidas que cubren ácaros.');
        await toText(fromId,'Con gusto te preparo una *cotización* con un precio a medida. Solo necesito que me compartas unos datos para poder recomendarte la mejor opción para tu zona y cultivo');
      }

      if(S(fromId).vars.cantidad && S(fromId).vars.last_sku){
        addCurrentToCart(S(fromId)); persistS(fromId);
        await askAddMore(fromId);
        res.sendStatus(200); return;
      }

      const productIntent = prodExact || (iaHits.length>0) || catTyped2 || asksPrice(text) || wantsBuy(text) || /producto|herbicida|insecticida|fungicida|acaricida|informaci[oó]n/i.test(tnorm);
      if (S(fromId).stage === 'discovery' && productIntent) { S(fromId).stage = 'product'; persistS(fromId); }

      if (S(fromId).vars.last_product && S(fromId).vars.departamento && S(fromId).vars.subzona){
        const prod = findProduct(S(fromId).vars.last_product) || prodExact || iaHits[0];
        if (prod) {
          await showProduct(fromId, prod);
          if (productHasMultiPres(prod) && !S(fromId).vars.last_presentacion) {
          } else if (!S(fromId).vars.cantidad && !S(fromId).asked.cantidad) {
            S(fromId).pending='cantidad'; S(fromId).lastPrompt='cantidad'; S(fromId).lastPromptTs=Date.now(); S(fromId).asked.cantidad=true; persistS(fromId);
            await toText(fromId,'¿Qué *cantidad* necesitas *(L/KG o unidades)* para este producto?');
          }
        }
      }
        try {
          const s = S(fromId);
          const deadline = s?.meta?.awaitBillingPickupUntil || 0;
          const withinWindow = deadline > Date.now();

          if (withinWindow) {
            const parsed = await parseAndAppendClientResponse({
              text,
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

// ===== AGENT =====
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

// b) Listado de conversaciones
router.get('/wa/agent/convos', agentAuth, (_req,res)=>{
  const list = loadAllSessionIds().map(convoSummaryFrom)
    .sort((a,b)=> (b.lastTs||0)-(a.lastTs||0));
  res.json({convos:list});
});

// c) Historial
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

// d) Enviar como humano (pausa bot 4h)
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

// e) Marcar leído
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

// f) Handoff (pausar/reanudar bot)
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

// g) Enviar media como humano (multiparte)
// en el endpoint, pásale el mimetype de multer y NO registres en memoria si falla el envío
router.post('/wa/agent/send-media', agentAuth, upload.array('files', 10), async (req, res) => {
  try{
    const to = req.body?.to;
    const caption = (req.body?.caption || '').slice(0, 1024);
    const files = req.files || [];
    if(!to || !files.length) return res.status(400).json({error:'to y files son requeridos'});

    humanOn(to, 4); // pausa bot

    let sent = 0;
    for (const f of files){
      const kind = mediaKindFromMime(f.mimetype);
      const id = await waUploadMediaFromFile(f.path, f.mimetype);
      if(!id){
        console.error('Upload falló para', f.originalname);
        try{ fs.unlinkSync(f.path); }catch{}
        continue; // no intentes enviar si no hay id
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

      // si waSendQ detecta error, marca ok=false (ver cambio abajo)
      if (resp === false) ok = false;

      if (ok){
        sent++;
        // registra solo si se envió con éxito
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