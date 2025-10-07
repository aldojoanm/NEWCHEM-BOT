// quote.js — generación y envío de cotización en PDF (lee precios desde Sheets)
import fs from 'fs';
import path from 'path';
import { buildQuoteFromSession } from './quote-engine.js';
import { renderQuotePDF } from './quote-pdf.js';

// ===== ENV =====
const WA_TOKEN        = process.env.WHATSAPP_TOKEN || '';
const WA_PHONE_ID     = process.env.WHATSAPP_PHONE_ID || '';
const QUOTES_DIR      = path.resolve('./data/quotes');
const MAX_CONCURRENCY = parseInt(process.env.QUOTE_MAX_CONCURRENCY || '3', 10);
const DELETE_AFTER_MS = parseInt(process.env.QUOTE_DELETE_AFTER_MS || (10 * 60 * 1000), 10);
const MAX_FILE_AGE_MS = parseInt(process.env.QUOTE_MAX_FILE_AGE_MS || (2 * 60 * 60 * 1000), 10);
const MAX_FILES_KEEP  = parseInt(process.env.QUOTE_MAX_FILES_KEEP || '200', 10);

try { fs.mkdirSync(QUOTES_DIR, { recursive:true }); } catch {}

// ===== Concurrencia simple =====
let _active = 0;
const _waiters = [];
function _acquire() {
  if (_active < MAX_CONCURRENCY) { _active++; return Promise.resolve(); }
  return new Promise(resolve => _waiters.push(resolve));
}
function _release() {
  _active = Math.max(0, _active - 1);
  const next = _waiters.shift();
  if (next) { _active++; next(); }
}

// Limpieza periódica
function _cleanupOldQuotes() {
  try{
    const files = fs.readdirSync(QUOTES_DIR)
      .filter(f => f.toLowerCase().endsWith('.pdf'))
      .map(f => {
        const p = path.join(QUOTES_DIR, f);
        const st = fs.statSync(p);
        return { p, mtime: st.mtimeMs, birth: st.birthtimeMs };
      })
      .sort((a,b)=> (a.mtime - b.mtime));
    const now = Date.now();
    for (const it of files) {
      if (now - (it.mtime || it.birth || now) > MAX_FILE_AGE_MS) {
        try { fs.unlinkSync(it.p); } catch {}
      }
    }
    const left = fs.readdirSync(QUOTES_DIR).filter(f => f.toLowerCase().endsWith('.pdf')).sort();
    const overflow = left.length - MAX_FILES_KEEP;
    if (overflow > 0) {
      const toDrop = left.slice(0, overflow);
      for (const f of toDrop) { try { fs.unlinkSync(path.join(QUOTES_DIR, f)); } catch {} }
    }
  }catch{}
}
setInterval(_cleanupOldQuotes, 30 * 60 * 1000).unref?.();

// ===== Helpers WhatsApp =====
function hasWaCreds() {
  return Boolean(WA_TOKEN && WA_PHONE_ID);
}
function isValidTo(to) {
  return /^\+?\d{8,15}$/.test(String(to || '').trim());
}

async function waUploadMediaFromFile(filePath, mime='application/pdf'){
  if (!hasWaCreds()) return null; // sin credenciales, no subimos aquí
  const url = `https://graph.facebook.com/v20.0/${encodeURIComponent(WA_PHONE_ID)}/media`;
  const buf = fs.readFileSync(filePath);
  const blob = new Blob([buf], { type: mime });
  const form = new FormData();
  form.append('file', blob, path.basename(filePath));
  form.append('type', mime);
  form.append('messaging_product', 'whatsapp');
  const r = await fetch(url, { method:'POST', headers:{ 'Authorization':`Bearer ${WA_TOKEN}` }, body: form });
  if (!r.ok){
    const t = await r.text().catch(()=> '');
    console.error('upload error', r.status, t);
    return null;
  }
  const j = await r.json().catch(()=>null);
  return j?.id || null;
}

async function waSendDocument(to, mediaId, filename, caption=''){
  if (!hasWaCreds()) return false;
  const url = `https://graph.facebook.com/v20.0/${encodeURIComponent(WA_PHONE_ID)}/messages`;
  const payload = {
    messaging_product:'whatsapp',
    to,
    type:'document',
    document: { id: mediaId, filename, caption }
  };
  const r = await fetch(url, {
    method:'POST',
    headers:{ 'Authorization':`Bearer ${WA_TOKEN}`,'Content-Type':'application/json' },
    body: JSON.stringify(payload)
  });
  if (!r.ok){
    console.error('send doc error', r.status, await r.text().catch(()=>''), 'payload=', JSON.stringify(payload).slice(0,400));
    return false;
  }
  return true;
}

/**
 * Genera un PDF de cotización y, si corresponde, lo envía por WhatsApp.
 *
 * @param {string|null} to  Número destino (WhatsApp). Si es null/ inválido, NO se envía.
 * @param {object} session  Objeto de sesión/estado.
 * @returns {Promise<{ok:boolean, sent:boolean, mediaId:string|null, path:string, filename:string, caption:string, quoteId?:string}>}
 */
export async function sendAutoQuotePDF(to, session){
  await _acquire();
  try{
    const quote = await buildQuoteFromSession(session, opts);
    const cleanName = (s='') =>
      String(s)
        .normalize('NFD').replace(/\p{Diacritic}/gu,'')
        .replace(/[\\/:*?"<>|]+/g,'')
        .replace(/\s+/g,' ')
        .trim()
        .slice(0,80);

    const clienteName = cleanName(quote?.cliente?.nombre || session?.profileName || 'Cliente');

    // Archivo en disco (único por timestamp)
    const stamp = new Date().toISOString().replace(/[:.]/g,'-');
    const filenameFS = `${cleanName(`COT - ${clienteName} - ${stamp}`)}.pdf`;

    // Nombre visible para WhatsApp
    const filenameDisplay = (cleanName(`COT NEW CHEM AGROQUIMICOS - ${clienteName}`)).toUpperCase() + `.pdf`;

    const outDir = QUOTES_DIR;
    try { fs.mkdirSync(outDir, { recursive:true }); } catch {}
    const filePath = path.join(outDir, filenameFS);

    // Render del PDF
    await renderQuotePDF(quote, filePath, { brand: 'New Chem Agroquímicos' });

    // Subimos a WhatsApp (si hay credenciales) para obtener mediaId reutilizable
    let mediaId = null;
    try { mediaId = await waUploadMediaFromFile(filePath, 'application/pdf'); }
    catch (e) { console.error('upload to WA failed:', e); }

    const caption = `Cotización - ${clienteName}`;

    // Envío directo SOLO si 'to' parece válido
    let sent = false;
    if (isValidTo(to) && mediaId) {
      try { sent = await waSendDocument(to, mediaId, filenameDisplay, caption); }
      catch (e) { console.error('send to WA failed:', e); sent = false; }
    } else if (isValidTo(to) && !mediaId) {
      // Sin mediaId (p.ej. sin credenciales). Lo marcamos como no enviado; el caller puede subir y mandar.
      sent = false;
    }

    // Limpieza diferida del archivo local
    if (DELETE_AFTER_MS > 0) {
      setTimeout(() => { try { fs.unlinkSync(filePath); } catch {} }, DELETE_AFTER_MS).unref?.();
    }

    return {
      ok: true,
      sent,
      mediaId: mediaId || null,
      path: filePath,
      filename: filenameDisplay,
      caption,
      quoteId: quote?.id
    };
  } finally {
    _release();
  }
}
