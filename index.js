// index.js (Messenger Router) — flujo robusto con anti-dobles + sesiones efímeras (TTL/LRU)
import 'dotenv/config';
import express from 'express';
import fs from 'fs';

const router = express.Router();
router.use(express.json());

// ===== ENV =====
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const CATALOG_URL = process.env.CATALOG_URL || 'https://tinyurl.com/f4euhvzk';
const WA_SELLER_NUMBER = (process.env.WA_SELLER_NUMBER || '').replace(/\D/g,'');
const STORE_LAT = process.env.STORE_LAT || '-17.7580406';
const STORE_LNG = process.env.STORE_LNG || '-63.1532503';

// ===== DATA =====
function loadJSON(p){ try { return JSON.parse(fs.readFileSync(p,'utf8')); } catch { return {}; } }
let FAQS = loadJSON('./knowledge/faqs.json');
let CATALOG = loadJSON('./knowledge/catalog.json'); // para reconocer productos

// ===== CONSTANTES =====
const DEPARTAMENTOS = ['Santa Cruz','Cochabamba','La Paz','Chuquisaca','Tarija','Oruro','Potosí','Beni','Pando'];
const SUBZONAS_SCZ  = ['Norte','Este','Sur','Valles','Chiquitania'];

// sinónimos para texto libre
const DPTO_SYNONYMS = {
  'Santa Cruz' : ['scz','sta cruz','santa cruz de la sierra','santa-cruz','santacruz'],
  'Cochabamba' : ['cbba','cbb','cba'],
  'La Paz'     : ['lp','lapaz','la-paz','el alto','alto'],
  'Chuquisaca' : ['sucre'],
  'Tarija'     : ['tja'],
  'Oruro'      : [],
  'Potosí'     : ['potosi','ptsi'],
  'Beni'       : [],
  'Pando'      : []
};

// ===== SESIONES (efímeras con TTL + LRU) =====
const SESSION_TTL_MS = 48 * 60 * 60 * 1000; // 48h
const SESSIONS_MAX   = 500;
const sessions = new Map();

function newSession(){
  return {
    pending: null,  // 'nombre' | 'departamento' | 'subzona' | 'subzona_free' | 'prod_from_catalog'
    vars: {
      departamento:null, subzona:null,
      hectareas:null, phone:null,
      productIntent:null,
      intent:null
    },
    profileName: null,
    flags: { greeted:false, finalShown:false, finalShownAt:0, justOpenedAt:0, helpShownAt:0 },
    memory: [],
    lastPrompt: null, // { key, at }
    lastSeen: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS,
    meta: { source:null, first_message_text:null, referral_raw:null } 
  };
}
// Detecta cualquier variante del "Get Started" de Messenger
function isGetStartedEvent(ev) {
  const payload = (ev.postback?.payload || '').trim();
  const title   = (ev.postback?.title   || '').trim().toLowerCase();
  const text    = (ev.message?.text     || '').trim().toLowerCase();

  // 1) Postbacks típicos
  if (payload === 'GET_STARTED') return true;
  if (/^(get_?started|start|empezar)$/i.test(payload)) return true;

  // 2) Algunos botones envían title (localizado) o texto simple
  if (/^(get started|start|empezar)$/.test(title)) return true;
  if (/^(get started|start|empezar)$/.test(text))  return true;

  // 3) Aperturas por referral del short link o chat plugin
  if (ev.referral && ev.referral.type === 'OPEN_THREAD') return true;

  // 4) Opt-ins antiguos
  if (ev.optin) return true;

  return false;
}


function getSession(psid){
  let s = sessions.get(psid);
  if(!s){ s = newSession(); sessions.set(psid, s); }
  s.lastSeen = Date.now();
  s.expiresAt = s.lastSeen + SESSION_TTL_MS;
  return s;
}
function clearSession(psid){ sessions.delete(psid); }
function remember(psid, role, content){
  const s=getSession(psid);
  s.memory.push({role,content,ts:Date.now()});
  if(s.memory.length>10) s.memory=s.memory.slice(-10); // límite estricto
}
// Purga periódica: TTL + LRU
setInterval(() => {
  const now = Date.now();
  // TTL
  for (const [id, s] of sessions) if ((s.expiresAt || 0) <= now) sessions.delete(id);
  // LRU si supera SESSIONS_MAX
  if (sessions.size > SESSIONS_MAX) {
    const sorted = [...sessions.entries()].sort((a,b) => (a[1].lastSeen||0) - (b[1].lastSeen||0));
    const drop = sessions.size - SESSIONS_MAX;
    for (let i = 0; i < drop; i++) sessions.delete(sorted[i][0]);
  }
}, 10 * 60 * 1000);

// ===== De-dup de mensajes FB (message.mid) =====
const seenMIDs = [];
const seenSet = new Set();
function alreadyProcessed(mid){
  if(!mid) return false;
  if(seenSet.has(mid)) return true;
  seenSet.add(mid);
  seenMIDs.push(mid);
  if(seenMIDs.length>300){ const old = seenMIDs.shift(); seenSet.delete(old); }
  return false;
}

// ===== HELPERS =====
const norm  = (t='') => t.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu,'');
const title = s => s.replace(/\w\S*/g, w => w[0].toUpperCase()+w.slice(1).toLowerCase());
const clamp = (t, n=20) => (t.length<=n? t : t.slice(0,n-1)+'…');
const linkMaps  = () => `https://www.google.com/maps?q=${encodeURIComponent(`${STORE_LAT},${STORE_LNG}`)}`;

function canonicalizeDepartamento(raw=''){
  const t = norm(raw);
  for(const d of DEPARTAMENTOS) if (t.includes(norm(d))) return d;
  for(const [name, arr] of Object.entries(DPTO_SYNONYMS)){
    if (arr.some(alias => t.includes(norm(alias)))) return name;
  }
  return null;
}
function detectSubzonaSCZ(text){
  const t = norm(text);
  for (const z of SUBZONAS_SCZ) if (t.includes(norm(z))) return z;
  return null;
}
function parseHectareas(text){
  const m = String(text).match(/(\d{1,6}(?:[.,]\d{1,2})?)\s*(ha|hect[aá]reas?)/i);
  return m ? m[1].replace(',','.') : null;
}
function parsePhone(text){
  const m = String(text).match(/(\+?\d[\d\s\-]{6,17}\d)/);
  return m ? m[1].replace(/[^\d+]/g,'') : null;
}

// Intenciones globales
const wantsCatalog  = t => /cat[aá]logo|portafolio|lista de precios/i.test(t) || /portafolio[- _]?newchem/i.test(norm(t));
const wantsLocation = t => /(ubicaci[oó]n|direcci[oó]n|mapa|d[oó]nde est[aá]n|donde estan)/i.test(t);
const wantsClose    = t => /(no gracias|gracias|eso es todo|listo|nada m[aá]s|ok gracias|est[aá] bien|finalizar)/i.test(norm(t));
const asksPrice     = t => /(precio|presio|cu[aá]nto vale|cu[aá]nto cuesta|cotizar|costo|proforma|cotizaci[oó]n)/i.test(t);
const wantsAgent    = t => /asesor|humano|ejecutivo|vendedor|representante|agente|contact(a|o|arme)|whats?app|wasap|wsp|wpp|n[uú]mero|telefono|tel[eé]fono|celular/i.test(norm(t));
// Saludos
const isGreeting = (t='') => {
  const s = String(t || '')
    .toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu,'')
    .replace(/[^a-z\s]/g,' ')
    .replace(/([a-z])\1{1,}/g,'$1')
    .replace(/\s+/g,' ')
    .trim();
  if (!s) return false;
  const sNoSpace = s.replace(/\s+/g,'');
  const reWithSpace = /\b(?:ola|hola|holi|holis|holu|hello|helo|hey|hi|wena|wenas|wuenas|buen(?:os|as)?(?:\s*(?:d(?:ia|ias)|tard(?:e|es)|n(?:och|coh)e?s?))?)\b/;
  const reNoSpace   = /^(?:hola|holi|holis|hello|hey|hi|wenas|wuenas|buen(?:os|as)?(?:d(?:ia|ias)|tard(?:e|es)|n(?:och|coh)e?s?)|bn(?:d(?:ia|ias)|tard(?:e|es)|n(?:och|coh)e?s?)|bns(?:d(?:ia|ias)|tard(?:e|es)|n(?:och|coh)e?s?))$/;
  if (/^(?:bn|bns)\b/.test(s)) {
    const rest = s.replace(/^(?:bn|bns)\b\s*/, '');
    if (/^(?:d(?:ia|ias)|tard(?:e|es)|n(?:och|coh)e?s?)$/.test(rest) || rest==='') return true;
  }
  return reWithSpace.test(s) || reNoSpace.test(sNoSpace);
};
// “Quiero seguir / otra duda”
const wantsMoreHelp = t => /(otra\s+(duda|consulta|pregunta)|tengo\s+otra\s+duda|algo\s+m[aá]s|m[aá]s\s+ayuda|seguir|continuar)/i.test(norm(t));

const asksProducts  = t => /(qu[eé] productos tienen|que venden|productos disponibles|l[ií]nea de productos)/i.test(t);
const asksShipping  = t => /(env[ií]os?|env[ií]an|hacen env[ií]os|delivery|entrega|env[ií]an hasta|mandan|env[ií]o a)/i.test(norm(t));
const wantsAdInfo = t => /(anuncio|publicidad|aviso|post|camp[aá]na).*(m[aá]s|mas|info|informaci[oó]n|contar|detalle|detalles)|pueden\s+contarme\s+algo\s+m[aá]s\s+sobre\s+el\s+anuncio/i.test(norm(t));
const AUTOFAQ_PATTERNS = [
  /podr[ií]an darme m[aá]s informaci[oó]n del negocio/i,
  /m[aá]s informaci[oó]n/i,
  /quiero saber m[aá]s/i,
  /me interesa/i,
  /informaci[oó]n por favor/i,
  /enviar mensaje/i,
  /cu[eé]ntenos/i,
  /chat(ea|ea)? con nosotros/i,
  /hay alguien con quien (pueda|puedo) chatear/i,
  /pueden contarme algo m[aá]s sobre el anuncio/i,
  /m[aá]s (info|informaci[oó]n) sobre el anuncio/i
];
function isAutoFAQ(text=''){
  const t = String(text || '').trim();
  if (!t) return false;
  return AUTOFAQ_PATTERNS.some(re => re.test(t));
}

// ===== Meta de origen para auditoría =====
function markSource(s, src){
  s.meta = s.meta || {};
  if (!s.meta.source) s.meta.source = src; // fija solo la primera vez
}
// Reconocer producto (catálogo)
function findProduct(text){
  const q = norm(text).replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim();
  if(!CATALOG || !Array.isArray(CATALOG)) return null;
  let best=null, bestScore=0;
  for(const p of CATALOG){
    const name = norm(p.nombre||'').trim(); if(!name) continue;
    if(q.includes(name)) return p; // contains
    const qTok = new Set(q.split(' '));
    const nTok = new Set(name.split(' '));
    const inter = [...qTok].filter(x=>nTok.has(x)).length;
    const score = inter / Math.max(1,[...nTok].length);
    if(score>bestScore){ best=p; bestScore=score; }
  }
  return bestScore>=0.6 ? best : null;
}

// ===== FB SENDERS =====
async function httpFetchAny(...args){ const f=globalThis.fetch||(await import('node-fetch')).default; return f(...args); }
async function sendText(psid, text){
  const url=`https://graph.facebook.com/v20.0/me/messages?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`;
  const payload={ recipient:{id:psid}, message:{ text:String(text).slice(0,2000) } };
  const r=await httpFetchAny(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  if(!r.ok) console.error('sendText', await r.text());
}
async function sendQR(psid, text, options=[]){
  const quick_replies=(options||[]).slice(0,11).map(o=>{
    if(typeof o==='string'){
      return { content_type:'text', title: clamp(o), payload:`QR_${o.replace(/\s+/g,'_').toUpperCase()}` };
    }
    return { content_type:'text', title: clamp(o.title), payload: o.payload || `QR_${o.title.replace(/\s+/g,'_').toUpperCase()}` };
  });
  const url=`https://graph.facebook.com/v20.0/me/messages?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`;
  const payload={ recipient:{id:psid}, message:{ text, quick_replies } };
  const r=await httpFetchAny(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  if(!r.ok) console.error('sendQR', await r.text());
}
async function sendButtons(psid, text, buttons=[]){
  const url=`https://graph.facebook.com/v20.0/me/messages?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`;
  const payload={
    recipient:{id:psid},
    message:{ attachment:{ type:'template', payload:{
      template_type:'button',
      text:text.slice(0,640),
      buttons: buttons.slice(0,3).map(b=>{
        if(b.type==='web_url') return { type:'web_url', url:b.url, title:clamp(b.title) };
        if(b.type==='postback') return { type:'postback', payload:b.payload.slice(0,1000), title:clamp(b.title) };
        return null;
      }).filter(Boolean)
    } } }
  };
  const r=await httpFetchAny(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  if(!r.ok) console.error('sendButtons', await r.text());
}

// ===== Helper para no repetir prompts =====
function shouldPrompt(s, key, ttlMs=8000){
  if(s.lastPrompt && s.lastPrompt.key===key && (Date.now()-s.lastPrompt.at)<ttlMs) return false;
  s.lastPrompt = { key, at: Date.now() };
  return true;
}

async function replyHumanChat(psid){
  await sendQR(psid,
    'Puedo ayudarte con:\n• Cotizaciones \n• Catálogo de productos\n• Ubicación y horarios\n\n',
    [
      { title:'Cotización', payload:'QR_COTIZACION' },
      { title:'Ver catálogo', payload:'OPEN_CATALOG' },
      { title:'Ubicación', payload:'OPEN_LOCATION' },
      { title:'Horario', payload:'OPEN_HORARIOS' }
    ]
  );
}

async function replyAdInfo(psid){
  await sendText(psid,
    '¡Claro! Somos New Chem. Ofrecemos **agroquímicos** (herbicidas, insecticidas y fungicidas) de alta eficacia. ' +
    'La compra mínima es **US$ 3.000** y la entrega se realiza en nuestro **almacén de Santa Cruz**. ' +
    'Puedo ayudarte con **precios, disponibilidad y dosis** según tu zona.'
  );
}

// ===== Perfil de FB: traer nombre por PSID =====
async function fetchFBProfileName(psid){
  try{
    const url = `https://graph.facebook.com/v20.0/${psid}?fields=name,first_name,last_name&access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`;
    const r = await httpFetchAny(url, { method:'GET' });
    if(!r.ok) return null;
    const j = await r.json();
    const raw = (j.name || [j.first_name, j.last_name].filter(Boolean).join(' ')).trim();
    if(!raw) return null;
    // Normaliza/capitaliza y limita tamaño
    return title(raw).slice(0,80);
  }catch{ return null; }
}

async function ensureProfileName(psid){
  const s = getSession(psid);
  if (s.profileName) return s.profileName;
  const n = await fetchFBProfileName(psid);
  if (n) s.profileName = n;
  return s.profileName || null;
}

// ===== PREGUNTAS ATÓMICAS =====
async function askName(psid){
  const s=getSession(psid);
  if (s.pending!=='nombre') s.pending='nombre';
  if (!shouldPrompt(s,'askName')) return;
  await sendText(psid, 'Antes de continuar, ¿Cuál es tu nombre completo? ✍️');
}
async function askDepartamento(psid){
  const s=getSession(psid);
  if (s.pending!=='departamento') s.pending='departamento';
  if (!shouldPrompt(s,'askDepartamento')) return;
  const nombre = s.profileName ? `${s.profileName}. 😊\n` : '';
  await sendQR(psid,
    `${nombre}📍 Cuéntanos, ¿desde qué *departamento* de Bolivia nos escribes?, \n Selecciona tu *departamento*:`,
    DEPARTAMENTOS.map(d => ({title:d, payload:`DPTO_${d.toUpperCase().replace(/\s+/g,'_')}`}))
  );
}

async function askSubzonaSCZ(psid){
  const s=getSession(psid);
  if (s.pending!=='subzona') s.pending='subzona';
  if (!shouldPrompt(s,'askSubzonaSCZ')) return;
  await sendQR(psid,'Gracias. ¿Qué *zona de Santa Cruz*?', [
    { title:'Norte',       payload:'SUBZ_NORTE'       },
    { title:'Este',        payload:'SUBZ_ESTE'        },
    { title:'Sur',         payload:'SUBZ_SUR'         },
    { title:'Valles',      payload:'SUBZ_VALLES'      },
    { title:'Chiquitania', payload:'SUBZ_CHIQUITANIA' }
  ]);
}
async function askSubzonaLibre(psid){
  const s=getSession(psid);
  if (s.pending!=='subzona_free') s.pending='subzona_free';
  if (!shouldPrompt(s,'askSubzonaLibre')) return;
  await sendText(psid, `Perfecto. ¿En qué *zona / municipio* de *${s.vars.departamento}* te encuentras? ✍️`);
}

// ===== RESUMEN / WHATSAPP / AYUDA =====
function summaryTextForFinal(s){
  const nombre = s.profileName || 'Cliente';
  const dep = s.vars.departamento || 'ND';
  const zona = s.vars.subzona || 'ND';
  const extraLines = [
    s.vars.productIntent ? `• Producto de interés: ${s.vars.productIntent}` : null,
    s.vars.hectareas ? `• Hectáreas: ${s.vars.hectareas}` : null,
    s.vars.phone ? `• Teléfono: ${s.vars.phone}` : null
  ].filter(Boolean).join('\n');

  return `¡Excelente, ${nombre}! 🚜 
• Departamento: ${dep}
• Zona: ${zona}
${extraLines ? extraLines + '\n' : ''}Ten en cuenta que nuestra compra mínima es de USD 3.000 y la entrega del producto se realiza en nuestro almacén de Santa Cruz.
Continuemos en WhatsApp para coordinar tu cotización.`;
}
function whatsappLinkFromSession(s){
  if(!WA_SELLER_NUMBER) return null;
  const nombre = s.profileName || 'Cliente';
  const dep    = s.vars.departamento || 'ND';
  const zona   = s.vars.subzona || 'ND';

  const txt = [
    `Hola, soy ${nombre} (vía Messenger). Me gustaría realizar una cotización con New Chem:`,
    `Nombre: ${nombre}`,
    `Departamento: ${dep}`,
    `Zona: ${zona}`,
    s.vars.productIntent ? `Producto: ${s.vars.productIntent}` : null,
    s.vars.hectareas     ? `Hectáreas: ${s.vars.hectareas}`     : null,
    s.vars.phone         ? `Teléfono: ${s.vars.phone}`           : null,
    `Entiendo la compra mínima de US$ 3.000.`,
    `La entrega del pedido se realiza en el almacén de Santa Cruz.`
  ].filter(Boolean).join('\n');

  return `https://wa.me/${WA_SELLER_NUMBER}?text=${encodeURIComponent(txt)}`;
}

async function finishAndWhatsApp(psid){
  const s=getSession(psid);
  if (s.flags.finalShown && Date.now()-s.flags.finalShownAt < 60000) return; // anti-duplicados
  s.flags.finalShown = true; s.flags.finalShownAt = Date.now();

  // 1) Resumen
  await sendText(psid, summaryTextForFinal(s));

  // 2) NUEVO: texto amable ofreciendo ver el catálogo (con el link)
  await sendText(psid, `Si quieres ir viendo opciones, aquí está nuestro catálogo 📘:\nhttps://tinyurl.com/f4euhvzk`);

  // 3) Luego el link/botón de WhatsApp
  const wa = whatsappLinkFromSession(s);
  if (wa){
    await sendButtons(psid, 'Enviar cotización', [
      { type:'web_url', url: wa, title:'Enviar a WhatsApp' }
    ]);
  } else {
    await sendText(psid, 'Comparte un número de contacto y te escribimos por WhatsApp.');
  }

  // 4) Ayuda adicional
  await sendQR(psid, '¿Necesitas ayuda en algo mas?', [
    { title:'Si, tengo otra duda', payload:'QR_CONTINUAR' },
    { title:'Finalizar', payload:'QR_FINALIZAR' }
  ]);
}

// Debounce de showHelp para evitar dobles
async function showHelp(psid){
  const s = getSession(psid);
  const COOLDOWN = 7000; // 7s
  if (Date.now() - (s.flags.helpShownAt || 0) < COOLDOWN) return;
  s.flags.helpShownAt = Date.now();

  await sendQR(psid, '¿En qué más te puedo ayudar?', [
    { title:'Catálogo',  payload:'OPEN_CATALOG'  },
    { title:'Ubicación', payload:'OPEN_LOCATION' },
    { title:'Horario',   payload:'OPEN_HORARIOS' },
    { title:'Hablar con Asesor Comercial', payload:'OPEN_WHATSAPP' },
    { title:'Finalizar', payload:'QR_FINALIZAR' }
  ]);
}

// ===== Orquestador =====
async function nextStep(psid){
  const s=getSession(psid);
  if(!s.profileName) await ensureProfileName(psid);
  if(!s.vars.departamento) return askDepartamento(psid);
  if(s.vars.departamento==='Santa Cruz' && !s.vars.subzona) return askSubzonaSCZ(psid);
  if(s.vars.departamento!=='Santa Cruz' && !s.vars.subzona) return askSubzonaLibre(psid);
  return finishAndWhatsApp(psid);
}

// ===== VERIFY =====
router.get('/webhook',(req,res)=>{
  const { ['hub.mode']:mode, ['hub.verify_token']:token, ['hub.challenge']:challenge } = req.query;
  if(mode==='subscribe' && token===VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

// ===== Aperturas inteligentes (antes de pedir nombre) =====
// ===== Aperturas inteligentes (antes de pedir nombre) =====
async function handleOpeningIntent(psid, text){
  const s = getSession(psid);

    if (wantsAdInfo(text)) {
      markSource(s, s.meta?.source || 'AD_INFO');
      s.meta.first_message_text = s.meta.first_message_text || text;

      await replyAdInfo(psid);
      await ensureProfileName(psid);
      await askDepartamento(psid);
      return true;
    }

  if (isAutoFAQ(text)) {
    markSource(s, s.meta?.source || 'AUTOFAQ');
    s.meta.first_message_text = s.meta.first_message_text || text;
    await ensureProfileName(psid);
    await askDepartamento(psid);
    return true;
  }

  // 1) Ignorar saludos vacíos aquí (para no disparar flujos dobles)
  if (isGreeting(text)) return false;

  // 2) Producto explícito
  const prod = findProduct(text);
  if (prod){
    markSource(s, s.meta?.source || 'TEXT_PRODUCT');
    s.meta.first_message_text = s.meta.first_message_text || text;

    s.vars.productIntent = prod.nombre;
    s.vars.intent = asksPrice(text) ? 'quote' : 'product';
    await sendText(psid,
      `¡Excelente! Sobre *${prod.nombre}* puedo ayudarte con **precios, disponibilidad y dosis**. ` +
      `Para enviarte una **cotización sin compromiso**, primero te ubico con unos datos rápidos.`
    );
    await ensureProfileName(psid);
    await askDepartamento(psid);
    return true;
  }

  // 3) Intención de cotización genérica
  if (asksPrice(text)){
    markSource(s, s.meta?.source || 'TEXT_QUOTE');
    s.meta.first_message_text = s.meta.first_message_text || text;

    s.vars.intent = 'quote';
    await sendText(psid,
      '¡Con gusto te preparo una **cotización personalizada**! ' +
      'Me podrías ayudar con algunos datos para asignarte el asesor correcto.'
    );
    await ensureProfileName(psid);
    await askDepartamento(psid);
    return true;
  }

  // 4) Piden catálogo o productos
  if (asksProducts(text)){
    markSource(s, s.meta?.source || 'TEXT_PRODUCTS');
    s.meta.first_message_text = s.meta.first_message_text || text;

    await sendButtons(psid,
      'Contamos con **herbicidas, insecticidas y fungicidas** de alta eficacia. ' +
      'Puedes abrir el catálogo o, si me dices el producto, te preparo una cotización.',
      [{ type:'web_url', url: CATALOG_URL, title:'Ver catálogo' }]
    );
    await sendText(psid, 'Si algo del catálogo te llamó la atención, cuéntame el *nombre del producto* y lo avanzamos de inmediato. 🙂');
    getSession(psid).pending = 'prod_from_catalog';
    await ensureProfileName(psid);
    await askDepartamento(psid);
    return true;
  }

  if (wantsCatalog(text)){
    markSource(s, s.meta?.source || 'TEXT_CATALOG');
    s.meta.first_message_text = s.meta.first_message_text || text;

    await sendButtons(psid, 'Aquí tienes nuestro catálogo digital 👇', [
      { type:'web_url', url: CATALOG_URL, title:'Ver catálogo' }
    ]);
    await sendText(psid, '¿Qué *producto* te interesó del catálogo? Si me dices el nombre, te ayudo con precio y disponibilidad. 🙂');
    getSession(psid).pending = 'prod_from_catalog';
    await ensureProfileName(psid);
    await askDepartamento(psid);
    return true;
  }

  return false;
}

// ===== RECEIVE =====
router.post('/webhook', async (req,res)=>{
  try{
    if(req.body.object!=='page') return res.sendStatus(404);

    for(const entry of (req.body.entry||[])){
      for(const ev of (entry.messaging||[])){
        const psid = ev?.sender?.id; if(!psid) continue;

        // FB puede reintentar: de-dup por MID
        const mid = ev.message?.mid || ev.postback?.mid || null;
        if (alreadyProcessed(mid)) continue;

        if(ev.message?.is_echo) continue;

        const s = getSession(psid);
        // Marcar origen por referral/postback si viene
        if (ev.referral){
          s.meta = s.meta || {};
          s.meta.referral_raw = s.meta.referral_raw || ev.referral;
          markSource(s, s.meta.source || 'ADS_REFERRAL');
        }
        if (ev.postback && ev.postback.payload === 'GET_STARTED'){
          markSource(s, s.meta?.source || 'GET_STARTED');
        }


        // === GET_STARTED (postback, referral, opt-in) ===
        if (isGetStartedEvent(ev)) {
          s.flags.greeted = true;
          s.flags.justOpenedAt = Date.now();
          await sendText(psid, '👋 ¡Hola! Bienvenido(a) a New Chem.\nTenemos agroquímicos al mejor precio y calidad para tu campaña. 🌱');
          await ensureProfileName(psid);
          await askDepartamento(psid);
          continue;
        }

        
        // INPUT
        let text = (ev.message?.text||'').trim();
        const qr = ev.message?.quick_reply?.payload || null;
        
        if(qr){
          if(qr==='QR_FINALIZAR'){
            await sendText(psid, '¡Gracias por escribirnos! Si más adelante te surge algo, aquí estoy para ayudarte. 👋');
            clearSession(psid);
            continue;
          }
          if(qr==='QR_CONTINUAR'){ await showHelp(psid); continue; }

          if(qr==='OPEN_CATALOG'){
            await sendButtons(psid, 'Abrir catálogo completo', [{type:'web_url', url: 'https://tinyurl.com/f4euhvzk', title:'Ver catálogo'}]);
            await sendText(psid, '¿Te interesó algún producto del catálogo?');
            s.pending = 'prod_from_catalog';
            await showHelp(psid); continue;
          }
          if(qr==='OPEN_LOCATION'){
            await sendButtons(psid, 'Nuestra ubicación en Google Maps 👇', [{type:'web_url', url: linkMaps(), title:'Ver ubicación'}]);
            await showHelp(psid); continue;
          }
          if(qr==='OPEN_HORARIOS'){
            await sendText(psid, `Nuestro horario: ${FAQS?.horarios || 'Lun–Vie 8:00–17:00'} 🙂`);
            await showHelp(psid); continue;
          }
          if(qr==='OPEN_WHATSAPP'){
            const wa = whatsappLinkFromSession(s);
            if (wa) await sendButtons(psid,'Te atiende un asesor por WhatsApp 👇',[{type:'web_url', url: wa, title:'📲 Abrir WhatsApp'}]);
            else await sendText(psid,'Compártenos un número de contacto y seguimos por WhatsApp.');
            await showHelp(psid); continue;
          }

          if(/^DPTO_/.test(qr)){
            const depRaw = qr.replace('DPTO_','').replace(/_/g,' ');
            const dep = canonicalizeDepartamento(depRaw);
            s.vars.departamento = dep; s.vars.subzona = null; s.pending=null;
            if(dep==='Santa Cruz') await askSubzonaSCZ(psid); else await askSubzonaLibre(psid);
            continue;
          }
          if(/^SUBZ_/.test(qr)){
            const z = qr.replace('SUBZ_','').toLowerCase();
            const mapa = { norte:'Norte', este:'Este', sur:'Sur', valles:'Valles', chiquitania:'Chiquitania' };
            if (s.vars.departamento==='Santa Cruz') s.vars.subzona = mapa[z] || null;
            s.pending=null; await nextStep(psid); continue;
          }

          text = qr.replace(/^QR_/,'').replace(/_/g,' ').trim() || text;
        }

        if (!s.meta?.first_message_text) {
          s.meta = s.meta || {};
          s.meta.first_message_text = text;

          // Sólo etiquetar como TEXT_FIRST si NO cae en alguna intención conocida
          const looksAutoFAQ = isAutoFAQ(text);
          const looksGreeting = isGreeting(text);
          const looksProduct  = !!findProduct(text);
          const looksQuote    = asksPrice(text);
          const looksCatalog  = wantsCatalog(text) || asksProducts(text);

          if (!s.meta?.source && !looksAutoFAQ && !looksGreeting && !looksProduct && !looksQuote && !looksCatalog) {
            markSource(s, 'TEXT_FIRST');
          }
        }

        // 1) Usuario escribe sin tocar “Empezar”
        if (!s.flags.greeted && (isGreeting(text) || isAutoFAQ(text))) {
          s.flags.greeted = true;
          s.flags.justOpenedAt = Date.now();
          markSource(s, s.meta?.source || (isAutoFAQ(text) ? 'AUTOFAQ' : 'GREETING_TEXT'));

          await sendText(psid, '👋 ¡Hola! Bienvenido(a) a New Chem.\nTenemos agroquímicos al mejor precio y calidad para tu campaña. 🌱');

          const handled = await handleOpeningIntent(psid, text); // si es AutoFAQ/producto, sigue
          if(!handled){ 
            await ensureProfileName(psid); 
            await askDepartamento(psid); 
          }
          continue;
        }

        if (wantsAdInfo(text) && s.flags.greeted) {
          await replyAdInfo(psid);
          await nextStep(psid);
          continue;
        }

        // 2) Anti-spam de saludos durante la apertura (8s)
        if(!s.profileName && s.pending==='nombre' && isGreeting(text)){
          if (Date.now() - (s.flags.justOpenedAt||0) < 8000) continue;
        }

        // “Quiero seguir / otra duda” escrito como texto
        if (wantsMoreHelp(text)){
          await showHelp(psid);
          continue;
        }

        // === PRODUCTO desde catálogo (captura antes del nombre)
        if(s.pending==='prod_from_catalog'){
          const prod = findProduct(text);
          if (prod){
            s.vars.productIntent = prod.nombre;
            s.pending=null;
            await ensureProfileName(psid);
            await nextStep(psid);
            continue;
          }else{
            await sendText(psid,'No identifiqué el producto. ¿Podrías escribir el *nombre exacto* tal como aparece en el catálogo?');
            continue;
          }
        }

        // === APERTURA INTELIGENTE cuando aún no tenemos nombre ===
        if(!s.profileName){
          const handled = await handleOpeningIntent(psid, text);
          if(handled) continue;
        }

        // Captura pasiva
        const ha   = parseHectareas(text); if(ha) s.vars.hectareas = ha;
        const phone= parsePhone(text);     if(phone) s.vars.phone = phone;

        // === PREGUNTAS DE ENVÍO (en cualquier etapa)
        if(asksShipping(text)){
          await sendText(psid,
            'Realizamos la **entrega en nuestro almacén de Santa Cruz de la Sierra**. ' +
            'Si lo necesitas, **podemos ayudarte a coordinar la logística del transporte** hasta tu zona, ' +
            'pero este servicio no viene incluido 🙂'
          );
          await nextStep(psid);
          continue;
        }

        // === CAPTURA DE NOMBRE (sin aceptar saludos como nombre) ===
          if(!s.profileName){
            await ensureProfileName(psid);
            if(s.profileName){ await askDepartamento(psid); continue; }
          }

        // === DEPARTAMENTO (acepta texto aunque espere QR) ===
        if(!s.vars.departamento || s.pending==='departamento'){
          const depTyped = canonicalizeDepartamento(text);
          if(depTyped){
            s.vars.departamento = depTyped; s.vars.subzona=null; s.pending=null;
            if(depTyped==='Santa Cruz') await askSubzonaSCZ(psid); else await askSubzonaLibre(psid);
            continue;
          }else if(s.pending==='departamento'){
            await askDepartamento(psid);
            continue;
          }
        }

        // === SUBZONA SCZ (texto o QR) ===
        if(s.vars.departamento==='Santa Cruz' && (!s.vars.subzona || s.pending==='subzona')){
          const z = detectSubzonaSCZ(text);
          if(z){ s.vars.subzona = z; s.pending=null; await nextStep(psid); continue; }
          if(s.pending==='subzona'){ await askSubzonaSCZ(psid); continue; }
        }

        // === SUBZONA libre para otros dptos ===
        if(s.pending==='subzona_free' && !s.vars.subzona){
          const z = title(text.trim());
          if (z){ s.vars.subzona = z; s.pending=null; await nextStep(psid); }
          else { await askSubzonaLibre(psid); }
          continue;
        }

        // Intenciones globales (responden siempre)
        if(wantsLocation(text)){ await sendButtons(psid, 'Nuestra ubicación en Google Maps 👇', [{type:'web_url', url: linkMaps(), title:'Ver ubicación'}]); await showHelp(psid); continue; }
        if(wantsCatalog(text)){  await sendButtons(psid, 'Abrir catálogo completo', [{type:'web_url', url: CATALOG_URL, title:'Ver catálogo'}]); await sendText(psid,'¿Qué *producto* te interesó del catálogo?'); s.pending='prod_from_catalog'; await showHelp(psid); continue; }
        if(asksPrice(text)){
          const prodHit = findProduct(text);
          if (prodHit) s.vars.productIntent = prodHit.nombre;
          await sendText(psid, 'Con gusto te preparamos una *cotización*. Primero confirmemos tu ubicación para asignarte el asesor correcto.');
          await nextStep(psid);
          continue;
        }
        if(wantsAgent(text)){    const wa = whatsappLinkFromSession(s); if (wa) await sendButtons(psid,'Te atiende un asesor por WhatsApp 👇',[{type:'web_url', url: wa, title:'📲 Abrir WhatsApp'}]); else await sendText(psid,'Compártenos un número de contacto y seguimos por WhatsApp.'); await showHelp(psid); continue; }
        if(wantsClose(text)){    await sendText(psid, '¡Gracias por escribirnos! Si más adelante te surge algo, aquí estoy para ayudarte. 👋'); clearSession(psid); continue; }

        // Si hay etapa pendiente, re-pregunta con TTL
        if(s.pending==='departamento'){ await askDepartamento(psid); continue; }
        if(s.pending==='subzona'){ await askSubzonaSCZ(psid); continue; }
        if(s.pending==='subzona_free'){ await askSubzonaLibre(psid); continue; }

        // Si nada aplica, ofrece ayuda amable
        await sendText(psid, 'Puedo ayudarte con *cotizaciones, catálogo, horarios, ubicación y envíos*.');
        await showHelp(psid);
      }
    }

    res.sendStatus(200);
  }catch(e){
    console.error('❌ /webhook', e);
    res.sendStatus(500);
  }
});

export default router;
