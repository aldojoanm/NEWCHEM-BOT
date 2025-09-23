// routes/catalog.api.js
import express from 'express';
import fs from 'fs';

const router = express.Router();

// ENV: usa UNO de estos enfoques
// 1) URL publicada (Archivo → Compartir → Publicar en la web → CSV)
const CATALOG_CSV_URL = process.env.CATALOG_CSV_URL || '';
// 2) O usa ID + GID (sin publicar, pero con “cualquiera con el enlace”):
const SHEET_ID = process.env.CATALOG_SHEET_ID || '';
const GID = process.env.CATALOG_GID || ''; // pestaña

// Fallback local por si todo falla (opcional)
function loadLocalFallback(){
  try {
    const raw = fs.readFileSync('./knowledge/catalog.json', 'utf8');
    const j = JSON.parse(raw);
    return Array.isArray(j) ? j : [];
  } catch { return []; }
}

function csvSplit(line=''){
  const out=[]; let cur='', q=false;
  for(let i=0;i<line.length;i++){
    const ch=line[i];
    if(ch==='"'){
      if(q && line[i+1]==='"'){ cur+='"'; i++; }
      else q=!q;
    }else if(ch===',' && !q){
      out.push(cur); cur='';
    }else cur+=ch;
  }
  out.push(cur);
  return out;
}

function parseCSV(text=''){
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const lines = text.split(/\r?\n/).filter(l => l.trim().length);
  if (!lines.length) return { head:[], rows:[] };
  const head = csvSplit(lines.shift()).map(h => h.trim().toLowerCase());
  const rows = lines.map(l => {
    const c = csvSplit(l);
    const o = {};
    head.forEach((h,i)=> o[h] = (c[i]||'').trim());
    return o;
  });
  return { head, rows };
}

function presentList(x){ return String(x||'').split(/[,|]/).map(s=>s.trim()).filter(Boolean); }

function normalizeRows(rows){
  return rows.map(r => ({
    sku: r.sku || r.SKU || '',
    nombre: r.nombre || r.Nombre || '',
    categoria: r.categoria || r.Categoria || '',
    ingrediente_activo: r.ingrediente_activo || r.ia || '',
    formulacion: r.formulacion || r.Formulacion || r['formulación'] || '',
    dosis: r.dosis || r.Dosis || '',
    plaga: r.plaga || r.Plaga || '',
    presentaciones: Array.isArray(r.presentaciones) ? r.presentaciones : presentList(r.presentaciones || r.Presentaciones || ''),
    imagen: r.imagen || r.Imagen || ''
  })).filter(p => p.sku && p.nombre);
}

async function fetchCSV(url){
  const r = await fetch(url, { cache: 'no-store' });
  if(!r.ok) throw new Error('HTTP '+r.status);
  return await r.text();
}

router.get('/catalog', async (req,res) => {
  res.set('Cache-Control', 'no-store');
  try {
    let url = CATALOG_CSV_URL;
    if (!url && SHEET_ID && GID){
      url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(SHEET_ID)}/gviz/tq?tqx=out:csv&gid=${encodeURIComponent(GID)}`;
    }
    if (!url) throw new Error('CATALOG_CSV_URL o (CATALOG_SHEET_ID+CATALOG_GID) no configurados');

    const csv = await fetchCSV(url);
    const { head, rows } = parseCSV(csv);

    // columnas mínimas
    const required = ['sku','nombre','categoria','ingrediente_activo','formulacion','dosis','plaga','presentaciones','imagen'];
    const miss = required.filter(h => !head.includes(h));
    if (miss.length) {
      // Seguimos igual, pero logueamos (y devolvemos lo que haya)
      console.warn('[catalog] columnas faltantes:', miss.join(', '));
    }

    const list = normalizeRows(rows);
    return res.json(list);
  } catch (e) {
    console.error('[catalog] error', e);
    const fallback = loadLocalFallback();
    if (fallback.length) return res.json(fallback);
    return res.status(500).json({ error: 'No se pudo cargar catálogo' });
  }
});

export default router;
