import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import { appendFromSession } from './sheets.js'; 

const router = express.Router();
router.use(express.json());

// ===== ENV =====
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'VERIFY_123';
const WA_TOKEN     = process.env.WHATSAPP_TOKEN || '';
const WA_PHONE_ID  = process.env.WHATSAPP_PHONE_ID || '';
const CATALOG_URL  = process.env.CATALOG_URL || 'https://tinyurl.com/PORTAFOLIO-NEWCHEM';
const STORE_LAT    = process.env.STORE_LAT || '-17.7580406';
const STORE_LNG    = process.env.STORE_LNG || '-63.1532503';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/,'');

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
  { title:'Invierno', payload:'CAMP_INVIERNO' },
  { title:'Otra',     payload:'CAMP_OTRA'     }
];
const linkMaps  = () => `https://www.google.com/maps?q=${encodeURIComponent(`${STORE_LAT},${STORE_LNG}`)}`;

// Límites visuales de WhatsApp List
const LIST_TITLE_MAX = 24;
const LIST_DESC_MAX  = 72;

// ===== MODO HUMANO (mute 4h) =====
const humanSilence = new Map();
const HOURS = (h)=> h*60*60*1000;
const humanOn  = (id, hours=4)=> humanSilence.set(id, Date.now()+HOURS(hours));
const humanOff = (id)=> humanSilence.delete(id);
const isHuman  = (id)=> (humanSilence.get(id)||0) > Date.now();

// ===== SESIONES =====
const sessions = new Map();
function S(id){
  if(!sessions.has(id)){
    sessions.set(id,{
      greeted:false,
      stage: 'discovery',
      pending: null,
      asked: { nombre:false, departamento:false, subzona:false, cultivo:false, hectareas:false, campana:false, categoria:false, cantidad:false },
      vars: {
        departamento:null, subzona:null, category:null,
        cultivos: [],
        hectareas:null,
        campana:null, // Verano/Invierno/Otra
        last_product:null, last_sku:null, last_presentacion:null,
        cantidad:null, phone:null,
        last_detail_sku:null, last_detail_ts:0,
        candidate_sku:null,
        catOffset:0,
        cart: [] // {sku,nombre,presentacion?,cantidad}
      },
      profileName: null,
      memory: [],
      lastPrompt: null,
      lastPromptTs: 0,
      meta: { origin:null, referral:null, referralHandled:false },
      _savedToSheet: false // ← ★ bandera anti-doble escritura
    });
  }
  return sessions.get(id);
}
function clearS(id){ sessions.delete(id); }

// ===== HELPERS =====
const norm  = (t='') => t.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu,'');
const title = s => String(s||'').replace(/\w\S*/g, w => w[0].toUpperCase()+w.slice(1).toLowerCase());
const clamp = (t, n=20) => (String(t).length<=n? String(t) : String(t).slice(0,n-1)+'…');
const clampN = (t, n) => clamp(t, n);
const upperNoDia = (t='') => t.normalize('NFD').replace(/\p{Diacritic}/gu,'').toUpperCase();

const b64u = s => Buffer.from(String(s),'utf8').toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const ub64u = s => Buffer.from(String(s).replace(/-/g,'+').replace(/_/g,'/'), 'base64').toString('utf8');

function remember(id, role, content){
  const s=S(id); s.memory.push({role,content,ts:Date.now()});
  if(s.memory.length>12) s.memory=s.memory.slice(-12);
}

// ===== BÚSQUEDA / PARSERS =====
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

// ===== REFERAL FB / LEAD =====
function parseMessengerLead(text){
  const t = String(text || '');
  if(!/\b(v[ií]a|via)\s*messenger\b/i.test(t)) return null;
  const pick = (re)=>{ const m=t.match(re); return m? m[1].trim() : null; };
  const name  = pick(/Hola,\s*soy\s*([^(•\n]+?)(?=\s*\(|\s*\.|\s*Me|$)/i);
  const prod  = pick(/Producto:\s*([^•\n]+)/i);
  const qty   = pick(/Cantidad:\s*([^•\n]+)/i);
  const crops = pick(/Cultivos?:\s*([^•\n]+)/i);
  const dptoZ = pick(/Departamento(?:\/Zona)?:\s*([^•\n]+)/i);
  const zona  = pick(/Zona:\s*([^•\n]+)/i);
  return { name, prod, qty, crops, dptoZ, zona };
}
function productFromReferral(ref){
  try{
    const bits = [ref?.headline, ref?.body, ref?.source_url, ref?.adgroup_name, ref?.campaign_name]
      .filter(Boolean).join(' ');
    let byQS=null;
    try{
      const u = new URL(ref?.source_url||'');
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
    const byText = findProduct(bits) || ((fuzzyCandidate(bits)||{}).prod) || null;
    return byQS || byText || null;
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

// ===== ENVÍO WA =====
const sendQueues = new Map();
const sleep = (ms=350)=>new Promise(r=>setTimeout(r,ms));
async function waSendQ(to, payload){
  const exec = async ()=>{
    const url = `https://graph.facebook.com/v20.0/${WA_PHONE_ID}/messages`;
    const r = await fetch(url,{ method:'POST', headers:{ 'Authorization':`Bearer ${WA_TOKEN}`, 'Content-Type':'application/json' }, body:JSON.stringify(payload) });
    if(!r.ok) console.error('WA send error', r.status, await r.text());
  };
  const prev = sendQueues.get(to) || Promise.resolve();
  const next = prev.then(exec).then(()=>sleep(350));
  sendQueues.set(to, next);
  return next;
}
const toText = (to, body) => waSendQ(to,{
  messaging_product:'whatsapp', to, type:'text',
  text:{ body: String(body).slice(0,4096), preview_url: true }
});
const toButtons = (to, body, buttons=[]) => waSendQ(to,{
  messaging_product:'whatsapp', to, type:'interactive',
  interactive:{ type:'button', body:{ text: String(body).slice(0,1024) },
    action:{ buttons: buttons.slice(0,3).map(b=>({ type:'reply', reply:{ id:b.payload || b.id, title: clamp(b.title) }})) }
  }
});
const toList = (to, body, title, rows=[]) => waSendQ(to,{
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

// Upload local file to WhatsApp Cloud and return media id
async function waUploadMediaFromFile(filePath){
  const url = `https://graph.facebook.com/v20.0/${encodeURIComponent(WA_PHONE_ID)}/media`;
  const ext = (filePath.split('.').pop() || '').toLowerCase();
  const mime = ext==='png' ? 'image/png' : (ext==='jpg'||ext==='jpeg') ? 'image/jpeg' : ext==='webp' ? 'image/webp' : 'application/octet-stream';
  const buf = fs.readFileSync(filePath);
  const blob = new Blob([buf], { type: mime });
  const form = new FormData();
  form.append('file', blob, filePath.split(/[\\/]/).pop());
  form.append('type', mime);
  form.append('messaging_product', 'whatsapp');
  const r = await fetch(url,{ method:'POST', headers:{ 'Authorization':`Bearer ${WA_TOKEN}` }, body: form });
  if(!r.ok){ console.error('waUploadMediaFromFile', await r.text()); return null; }
  const j = await r.json();
  return j?.id || null;
}
async function toImage(to, source){
  if(source?.url) return waSendQ(to,{ messaging_product:'whatsapp', to, type:'image', image:{ link: source.url } });
  if(source?.path){
    const id = await waUploadMediaFromFile(source.path);
    if(id) return waSendQ(to,{ messaging_product:'whatsapp', to, type:'image', image:{ id } });
  }
}

// ===== PREGUNTAS ATÓMICAS =====
async function markPrompt(s, key){ s.lastPrompt = key; s.lastPromptTs = Date.now(); }
async function askNombre(to){
  const s=S(to); if (s.lastPrompt==='nombre' || s.asked.nombre) return;
  await markPrompt(s,'nombre'); s.pending='nombre'; s.asked.nombre=true;
  await toText(to,'Para personalizar tu atención, ¿cuál es tu *nombre completo*?');
}
async function askDepartamento(to){
  const s=S(to); if (s.lastPrompt==='departamento') return;
  await markPrompt(s,'departamento'); s.pending='departamento'; s.asked.departamento=true;
  await toList(to,'¡Perfecto! Para orientarte mejor, ¿en qué *departamento* produces?','Elegir departamento',
    DEPARTAMENTOS.map(d=>({ title:d, payload:`DPTO_${d.toUpperCase().replace(/\s+/g,'_')}` }))
  );
}
async function askSubzonaSCZ(to){
  const s=S(to); if (s.lastPrompt==='subzona') return;
  await markPrompt(s,'subzona'); s.pending='subzona'; s.asked.subzona=true;
  await toList(to,'Gracias. ¿Qué *zona de Santa Cruz*?','Elegir zona',
    [{title:'Norte',payload:'SUBZ_NORTE'},{title:'Este',payload:'SUBZ_ESTE'},{title:'Sur',payload:'SUBZ_SUR'},{title:'Valles',payload:'SUBZ_VALLES'},{title:'Chiquitania',payload:'SUBZ_CHIQUITANIA'}]
  );
}
async function askSubzonaLibre(to){
  const s=S(to); if (s.lastPrompt==='subzona_libre') return;
  await markPrompt(s,'subzona_libre'); s.pending='subzona_libre'; s.asked.subzona=true;
  const dep = s.vars.departamento || 'tu departamento';
  await toText(to, `Perfecto. ¿Para qué *zona* de *${dep}* quisieras?`);
}
async function askCultivo(to){
  const s=S(to); if (s.lastPrompt==='cultivo') return;
  await markPrompt(s,'cultivo'); s.pending='cultivo'; s.asked.cultivo=true;
  await toList(to,'Perfecto 🙌. Elige tu *cultivo*','Elegir cultivo', CROP_OPTIONS);
}
async function askHectareas(to){
  const s=S(to); if (s.lastPrompt==='hectareas') return;
  await markPrompt(s,'hectareas'); s.pending='hectareas'; s.asked.hectareas=true;
  await toText(to,'¿Cuántas *hectáreas* vas a tratar? (ej. 50 ha)');
}
async function askCampana(to){
  const s=S(to); if (s.lastPrompt==='campana') return;
  await markPrompt(s,'campana'); s.pending='campana'; s.asked.campana=true;
  await toButtons(to,'¿Para qué *campaña* es? (siembra)', CAMP_BTNS);
}
async function askCampanaLibre(to){
  const s=S(to); if (s.lastPrompt==='campana_text') return;
  await markPrompt(s,'campana_text'); s.pending='campana_text';
  await toText(to,'Escribe tu campaña (por ejemplo: *Invierno Chico*).');
}
async function askCategory(to){
  const s=S(to); if (s.lastPrompt==='categoria') return;
  s.stage='product'; await markPrompt(s,'categoria'); s.pending='categoria'; s.asked.categoria=true;
  await toButtons(to,'¿Qué tipo de producto necesitas?', CAT_QR.map(c=>({ title:c.title, payload:c.payload })));
}

// ===== Presentaciones =====
function productHasMultiPres(prod){
  const pres = Array.isArray(prod?.presentaciones) ? prod.presentaciones.filter(Boolean) : [];
  return pres.length > 1;
}
function productSinglePres(prod){
  const pres = Array.isArray(prod?.presentaciones) ? prod.presentaciones.filter(Boolean) : [];
  return pres.length === 1 ? pres[0] : null;
}
async function askPresentacion(to, prod){
  const pres = (prod?.presentaciones||[]).filter(Boolean);
  if(pres.length <= 1) return;
  const rows = pres.map(p => ({
    title: String(p),
    payload: `PRES_${prod.sku}__${b64u(String(p))}`
  }));
  await toList(to, `¿En qué *presentación* deseas *${prod.nombre}*?`, 'Elegir presentación', rows);
}

// ===== Fila de producto con ingrediente activo (para listas)
function productListRow(p){
  const nombre = p?.nombre || '';
  const ia     = p?.ingrediente_activo || p?.formulacion || p?.categoria || '';
  return {
    title: nombre,
    description: ia ? `IA: ${ia}` : undefined,
    payload: `PROD_${p.sku}`
  };
}

// ===== Listado por categoría (paginado) =====
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
  s.vars.last_presentacion = null; // reset presentación al cambiar de producto

  const catNorm = normalizeCatLabel(prod.categoria||'');
  if(catNorm && !s.vars.category) s.vars.category = catNorm;

  if (shouldShowDetail(s, prod.sku)) {
    const linkFicha = prod.link_ficha || CATALOG_URL;
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

  // Si solo hay una presentación, la fijamos; si hay varias, preguntamos
  const single = productSinglePres(prod);
  if(single && !s.vars.last_presentacion){
    s.vars.last_presentacion = single;
  } else if (productHasMultiPres(prod) && !s.vars.last_presentacion){
    await askPresentacion(to, prod);
  }
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

// ===== Orquestador =====
async function nextStep(to){
  const s=S(to);
  const stale = (key)=> s.lastPrompt===key && (Date.now()-s.lastPromptTs>25000);
  if (s.pending && !stale(s.pending)) return;

  // (0) Nombre
  if(s.meta.origin!=='messenger' && !s.asked.nombre){
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
  const prod = (CATALOG||[]).find(p=>p.sku===s.vars.last_sku);
  if(prod && productHasMultiPres(prod) && !s.vars.last_presentacion){
    return askPresentacion(to, prod);
  }
  if(prod && productSinglePres(prod) && !s.vars.last_presentacion){
    s.vars.last_presentacion = productSinglePres(prod);
  }

  // (9) Cantidad
  if(!s.vars.cantidad){
    if (!s.asked.cantidad){
      s.pending='cantidad'; await markPrompt(s,'cantidad'); s.asked.cantidad=true;
      return toText(to,'Para poder realizar tu cotización, ¿qué *cantidad* necesitas *(L/KG o unidades)*?');
    }
    return;
  }
}

// ===== VERIFY =====
router.get('/wa/webhook',(req,res)=>{
  const mode=req.query['hub.mode'];
  const token=req.query['hub.verify_token'];
  const chall=req.query['hub.challenge'];
  if(mode==='subscribe' && token===VERIFY_TOKEN && chall) return res.status(200).send(String(chall));
  return res.sendStatus(403);
});

// ===== RECEIVE =====
router.post('/wa/webhook', async (req,res)=>{
  try{
    const entry  = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value  = change?.value;
    const msg    = value?.messages?.[0];
    const from   = msg?.from;
    if(!msg || !from){ res.sendStatus(200); return; }

    const s = S(from);
    const textRaw = (msg.type==='text' ? (msg.text?.body || '').trim() : '');

    if (isHuman(from)) {
      if (textRaw && wantsBotBack(textRaw)) {
        humanOff(from);
        const quien = s.profileName ? `, ${s.profileName}` : '';
        await toText(from, `Listo${quien} 🙌. Reactivé el *asistente automático*. ¿En qué puedo ayudarte?`);
      }
      res.sendStatus(200); return;
    }

    const contactName = value?.contacts?.[0]?.profile?.name;
    if(contactName && !s.profileName) s.profileName = contactName;

    const referral = msg?.referral;
    if (referral && !s.meta.referralHandled){
      s.meta.referralHandled = true;
      s.meta.origin = 'facebook';
      s.meta.referral = referral;
      const prod = productFromReferral(referral);
      if (prod){
        s.vars.candidate_sku = prod.sku;
        await toButtons(from, `Gracias por escribirnos desde Facebook. ¿La consulta es sobre *${prod.nombre}*?`, [
          { title:`Sí, ${prod.nombre}`, payload:`REF_YES_${prod.sku}` },
          { title:'No, otro producto',  payload:'REF_NO' }
        ]);
        res.sendStatus(200); return;
      }
    }

    const isLeadMsg = msg.type==='text' && !!parseMessengerLead(msg.text?.body);
    if(!s.greeted){
      if(!isLeadMsg){
        await toText(from, PLAY?.greeting || '¡Qué gusto saludarte!, Soy el asistente virtual de *New Chem*. Estoy para ayudarte 🙂');
      }
      s.greeted = true;
      if(!isLeadMsg && !s.asked.nombre){
        await askNombre(from);
        res.sendStatus(200); return;
      }
    }

    // ===== INTERACTIVOS =====
    if(msg.type==='interactive'){
      const br = msg.interactive?.button_reply;
      const lr = msg.interactive?.list_reply;
      const id = br?.id || lr?.id;

      if(id==='QR_FINALIZAR'){
        try {
          if (!s._savedToSheet) {
            const cotId = await appendFromSession(s, from, 'nuevo');
            s.vars.cotizacion_id = cotId;
            s._savedToSheet = true;
          }
        } catch (err) {
          console.error('Sheets append error:', err);
          // No bloquear al usuario si falla Sheets
        }
        await toText(from,'¡Gracias por escribirnos! Nuestro encargado de negocios te enviará la cotización en breve. Si requieres más información, estamos a tu disposición.');
        await toText(from,'Para volver a activar el asistente, por favor, escribe *Asistente New Chem*.');
        humanOn(from, 4); clearS(from); res.sendStatus(200); return;
      }
      if(id==='QR_SEGUIR'){ await toText(from,'Perfecto, seguimos por aquí 🙌. ¿En qué más te puedo ayudar?'); await askCategory(from); res.sendStatus(200); return; }
      if(id==='ADD_MORE'){ s.vars.catOffset=0; s.vars.last_product=null; s.vars.last_sku=null; s.vars.last_presentacion=null; s.vars.cantidad=null; s.asked.cantidad=false; await toButtons(from,'Dime el *nombre del otro producto* o elige una categoría 👇', CAT_QR.map(c=>({title:c.title,payload:c.payload}))); res.sendStatus(200); return; }
      if(id==='NO_MORE'){ await afterSummary(from, 'help'); res.sendStatus(200); return; }

      if(/^REF_YES_/.test(id)){
        const sku = id.replace('REF_YES_','');
        const prod = (CATALOG||[]).find(p=>String(p.sku)===String(sku));
        if(prod){
          s.vars.last_product = prod.nombre; s.vars.last_sku = prod.sku; s.vars.last_presentacion=null;
          const catNorm = normalizeCatLabel(prod.categoria||''); if(catNorm) s.vars.category = catNorm;
          await showProduct(from, prod);
          await nextStep(from);
        }
        res.sendStatus(200); return;
      }
      if(id==='REF_NO'){
        s.pending='product_name'; s.lastPrompt='product_name'; s.lastPromptTs=Date.now();
        await toText(from,'Claro, indícame por favor el *nombre del producto* que te interesa y te paso el detalle.');
        res.sendStatus(200); return;
      }

      if(/^DPTO_/.test(id)){
        const depRaw = id.replace('DPTO_','').replace(/_/g,' ');
        const dep = (()=>{ const t=norm(depRaw); for(const d of DEPARTAMENTOS) if(norm(d)===t) return d; return title(depRaw); })();
        s.vars.departamento = dep; s.asked.departamento=true; s.pending=null; s.lastPrompt=null;
        s.vars.subzona = null;
        if(dep==='Santa Cruz'){ await askSubzonaSCZ(from); } else { await askSubzonaLibre(from); }
        res.sendStatus(200); return;
      }
      if(/^SUBZ_/.test(id)){
        const z = id.replace('SUBZ_','').toLowerCase();
        const mapa = { norte:'Norte', este:'Este', sur:'Sur', valles:'Valles', chiquitania:'Chiquitania' };
        if (s.vars.departamento==='Santa Cruz') s.vars.subzona = mapa[z] || null;
        s.pending=null; s.lastPrompt=null;
        await nextStep(from); res.sendStatus(200); return;
      }
      if(/^CROP_/.test(id)){
        const code = id.replace('CROP_','').toLowerCase();
        const map  = { soya:'Soya', maiz:'Maíz', trigo:'Trigo', arroz:'Arroz', girasol:'Girasol' };
        const val  = map[code] || null;
        if(val){
          s.vars.cultivos = [val]; s.pending=null; s.lastPrompt=null;
          await nextStep(from);
        }
        res.sendStatus(200); return;
      }
      if(/^CAMP_/.test(id)){
        const code = id.replace('CAMP_','').toLowerCase();
        if(code==='verano') s.vars.campana='Verano';
        else if(code==='invierno') s.vars.campana='Invierno';
        else if(code==='otra'){ await askCampanaLibre(from); res.sendStatus(200); return; }
        s.pending=null; s.lastPrompt=null;
        await nextStep(from); res.sendStatus(200); return;
      }
      if(/^CAT_/.test(id)){
        const key = id.replace('CAT_','').toLowerCase();
        s.vars.category = key==='herbicida' ? 'Herbicida' : key==='insecticida' ? 'Insecticida' : 'Fungicida';
        s.vars.catOffset = 0; s.stage='product'; s.pending=null; s.lastPrompt=null;
        await nextStep(from); res.sendStatus(200); return;
      }
      if(/^CAT_MORE_/.test(id)){
        const next = parseInt(id.replace('CAT_MORE_',''),10) || 0;
        s.vars.catOffset = next;
        await listByCategory(from); res.sendStatus(200); return;
      }
      if(/^PROD_/.test(id)){
        const sku = id.replace('PROD_','');
        const prod = (CATALOG||[]).find(p=>p.sku===sku);
        if(prod){
          s.vars.last_product = prod.nombre; s.vars.last_sku = prod.sku; s.vars.last_presentacion=null;
          const catNorm = normalizeCatLabel(prod.categoria||''); if(catNorm) s.vars.category = catNorm;
          await showProduct(from, prod);
          // flujo: si hay multi presentación, la pido; si no, pido cantidad
          if(productHasMultiPres(prod)){
            // no hacer nada, ya se pidió dentro de showProduct
          } else if (!s.vars.cantidad && !s.asked.cantidad){
            s.pending='cantidad'; s.lastPrompt='cantidad'; s.lastPromptTs=Date.now(); s.asked.cantidad=true;
            await toText(from,'¿Qué *cantidad* necesitas *(L/KG o unidades)* para este producto?');
          }
        }
        res.sendStatus(200); return;
      }
      if(/^PRES_/.test(id)){
        // id = PRES_<sku>__<b64url(presentacion)>
        const m = id.match(/^PRES_(.+?)__(.+)$/);
        if(m){
          const sku = m[1];
          const pres = ub64u(m[2]);
          if(s.vars.last_sku===sku){
            s.vars.last_presentacion = pres;
            // Luego de elegir presentación, pedimos cantidad si falta
            if(!s.vars.cantidad){
              s.pending='cantidad'; s.lastPrompt='cantidad'; s.lastPromptTs=Date.now(); s.asked.cantidad=true;
              await toText(from,'Perfecto. ¿Qué *cantidad* necesitas *(L/KG o unidades)* para este producto?');
            }
          }
        }
        res.sendStatus(200); return;
      }
    }

    // ===== TEXTO =====
    if(msg.type==='text'){
      const text = (msg.text?.body||'').trim();
      remember(from,'user',text);
      const tnorm = norm(text);

      // Lead de Messenger
      const lead = parseMessengerLead(text);
      if (lead){
        s.meta.origin = 'messenger';
        s.greeted = true;
        if (lead.name) s.profileName = title(lead.name);
        if (lead.dptoZ){
          const dep = detectDepartamento(lead.dptoZ) || title(lead.dptoZ.split('/')[0]||'');
          s.vars.departamento = dep || s.vars.departamento;
          const zonaFromSlash = (lead.dptoZ.split('/')[1]||'').trim();
          if (!s.vars.subzona && zonaFromSlash) s.vars.subzona = title(zonaFromSlash);
          if((/santa\s*cruz/i.test(lead.dptoZ)) && detectSubzona(lead.dptoZ)) s.vars.subzona = detectSubzona(lead.dptoZ);
        }
        if (!s.vars.subzona && lead.zona) s.vars.subzona = title(lead.zona);
        if (lead.crops){
          const picks = (lead.crops||'').split(/[,\s]+y\s+|,\s*|\s+y\s+/i).map(t=>norm(t.trim())).filter(Boolean);
          const mapped = Array.from(new Set(picks.map(x=>CROP_SYN[x]).filter(Boolean)));
          if (mapped.length) s.vars.cultivos = [mapped[0]];
        }
        const quien = s.profileName ? ` ${s.profileName}` : '';
        await toText(from, `👋 Hola${quien}, gracias por continuar con *New Chem* vía WhatsApp.\nAquí encontrarás los agroquímicos esenciales para tu cultivo, al mejor precio. 🌱`);
        await askCultivo(from); res.sendStatus(200); return;
      }

      // Nombre
      if (S(from).pending==='nombre'){
        S(from).profileName = title(text.toLowerCase());
        S(from).pending=null; S(from).lastPrompt=null;
        await nextStep(from); res.sendStatus(200); return;
      }

      // Subzona libre
      if (S(from).pending==='subzona_libre'){
        S(from).vars.subzona = title(text.toLowerCase());
        S(from).pending=null; S(from).lastPrompt=null;
        await nextStep(from); res.sendStatus(200); return;
      }

      // Hectáreas
      if (S(from).pending==='hectareas'){
        const ha = parseHectareas(text);
        if(ha){
          S(from).vars.hectareas = ha;
          S(from).pending=null; S(from).lastPrompt=null;
          await nextStep(from);
          res.sendStatus(200); return;
        } else {
          await toText(from,'Por favor ingresa un número válido de *hectáreas* (ej. 50 ha).');
          res.sendStatus(200); return;
        }
      }

      // Campaña libre
      if (S(from).pending==='campana_text'){
        S(from).vars.campana = title(text);
        S(from).pending=null; S(from).lastPrompt=null;
        await nextStep(from); res.sendStatus(200); return;
      }

      // ASESOR
      if (wantsAgentPlus(text)) {
        const quien = s.profileName ? `, ${s.profileName}` : '';
        await toText(from, `¡Perfecto${quien}! Ya notifiqué a nuestro equipo. Un **asesor comercial** se pondrá en contacto contigo por este chat en unos minutos para ayudarte con tu consulta y la cotización. Desde ahora **pauso el asistente automático** para que te atienda una persona. 🙌`);
        humanOn(from, 4); res.sendStatus(200); return;
      }

      // Globales
      if(/horario|atienden|abren|cierran/i.test(tnorm)){ await toText(from, `Atendemos ${FAQS?.horarios || 'Lun–Vie 8:00–17:00'} 🙂`); res.sendStatus(200); return; }
      if(wantsLocation(text)){ await toText(from, `Nuestra ubicación en Google Maps 👇\nVer ubicación: ${linkMaps()}`); await toButtons(from,'¿Hay algo más en lo que pueda ayudarte?',[{title:'Seguir',payload:'QR_SEGUIR'},{title:'Finalizar',payload:'QR_FINALIZAR'}]); res.sendStatus(200); return; }
      if(wantsCatalog(text)){
        await toText(from, `Este es nuestro catálogo completo\n${CATALOG_URL}`);
        await toButtons(from,'¿Quieres que te ayude a elegir o añadir un producto ahora?',[{title:'Añadir producto', payload:'ADD_MORE'},{title:'Finalizar', payload:'QR_FINALIZAR'}]);
        res.sendStatus(200); return;
      }
      if(wantsClose(text)){
        await toText(from,'¡Gracias por escribirnos! Si más adelante te surge algo, aquí estoy para ayudarte. 👋');
        humanOn(from, 4); clearS(from); res.sendStatus(200); return;
      }
      if(wantsAnother(text)){ await askAddMore(from); res.sendStatus(200); return; }

      // CAPTURA PASIVA
      const ha   = parseHectareas(text); if(ha && !S(from).vars.hectareas) S(from).vars.hectareas = ha;
      const phone= parsePhone(text);     if(phone) S(from).vars.phone = phone;

      let cant = parseCantidad(text);
      if(!cant && (S(from).pending==='cantidad')){
        const mOnly = text.match(/^\s*(\d{1,6}(?:[.,]\d{1,2})?)\s*$/);
        if(mOnly){ const unit = inferUnitFromProduct(S(from)).toLowerCase(); cant = `${mOnly[1].replace(',','.') } ${unit}`; }
      }
      if(cant) S(from).vars.cantidad = cant;

      // Producto exacto
      const prodExact = findProduct(text);
      if (prodExact){
        S(from).vars.last_product = prodExact.nombre;
        S(from).vars.last_sku = prodExact.sku;
        S(from).vars.last_presentacion = null;
        const catFromProd = normalizeCatLabel(prodExact.categoria||''); if (catFromProd) S(from).vars.category = catFromProd;
        S(from).stage='product'; S(from).vars.catOffset=0;
      }

      // Categoría por texto
      const catTyped2 = detectCategory(text);
      if(catTyped2){
        S(from).vars.category=catTyped2; S(from).vars.catOffset=0; S(from).asked.categoria=true; S(from).stage='product';
        if (mentionsAcaricida(text) && catTyped2==='Insecticida') await toText(from,'Te muestro Insecticidas que cubren ácaros.');
      }

      // Ubicación
      const depTyped = detectDepartamento(text);
      const subOnly  = detectSubzona(text);
      if(depTyped){ S(from).vars.departamento = depTyped; S(from).vars.subzona=null; }
      if((S(from).vars.departamento==='Santa Cruz' || depTyped==='Santa Cruz') && subOnly){ S(from).vars.subzona = subOnly; }

      // Cultivo por texto (mapeo a opciones)
      if (S(from).pending==='cultivo'){
        const picked = Object.keys(CROP_SYN).find(k=>tnorm.includes(k));
        if (picked){
          S(from).vars.cultivos = [CROP_SYN[picked]];
          S(from).pending=null; S(from).lastPrompt=null;
          await askHectareas(from);
          res.sendStatus(200); return;
        } else {
          await toText(from, 'Por favor, *elige una opción del listado* para continuar.');
          await askCultivo(from); res.sendStatus(200); return;
        }
      }

      // Campaña si el usuario escribió directamente "verano"/"invierno"
      if(!S(from).vars.campana){
        if(/\bverano\b/i.test(text)) S(from).vars.campana='Verano';
        else if(/\binvierno\b/i.test(text)) S(from).vars.campana='Invierno';
      }

      // COTIZACIÓN
      if(asksPrice(text)){
        if (mentionsAcaricida(text)) await toText(from, 'Te muestro Insecticidas que cubren ácaros.');
        await toText(from,'Con gusto te preparo una *cotización* con un precio a medida. Solo necesito que me compartas unos datos para poder recomendarte la mejor opción para tu zona y cultivo');
      }

      // Si llegó la cantidad y hay producto → carrito + “otro”
      if(S(from).vars.cantidad && S(from).vars.last_sku){
        addCurrentToCart(S(from));
        await askAddMore(from);
        res.sendStatus(200); return;
      }

      const productIntent = prodExact || catTyped2 || asksPrice(text) || wantsBuy(text) || /producto|herbicida|insecticida|fungicida|acaricida|informaci[oó]n/i.test(tnorm);
      if (S(from).stage === 'discovery' && productIntent) S(from).stage = 'product';

      if (S(from).vars.last_product && S(from).vars.departamento && S(from).vars.subzona){
        const prod = findProduct(S(from).vars.last_product) || prodExact;
        if (prod) {
          await showProduct(from, prod);
          // Si faltó presentación, se pedirá. Si ya hay, pedir cantidad.
          if (productHasMultiPres(prod) && !S(from).vars.last_presentacion) {
            // se pidió en showProduct
          } else if (!S(from).vars.cantidad && !S(from).asked.cantidad) {
            S(from).pending='cantidad'; S(from).lastPrompt='cantidad'; S(from).lastPromptTs=Date.now(); S(from).asked.cantidad=true;
            await toText(from,'¿Qué *cantidad* necesitas *(L/KG o unidades)* para este producto?');
          }
        }
      }

      await nextStep(from);
      res.sendStatus(200); return;
    }

    await nextStep(from);
    res.sendStatus(200);
  }catch(e){
    console.error('WA webhook error', e);
    res.sendStatus(500);
  }
});

export default router;
