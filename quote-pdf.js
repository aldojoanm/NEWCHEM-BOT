// quote-pdf.js
import fs from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';

const TZ = process.env.TIMEZONE || 'America/La_Paz';

// Paleta base (suave)
const BRAND = {
  purple: '#8364a2',
  indigo: '#5a66ac',
  cyan:   '#46acc4',
};

// Tonos más sobrios
const TINT = {
  headerPurple: '#F1F5F9', // gris claro para encabezado
  rowPurple:    '#FFFFFF', // filas sin fondo (blanco)
  totalBlue:    '#F6E3A1', // amarillo suave para total
};

// Color de grilla (más claro)
const GRID = '#A3A3A3';

/* ========= Helpers de color ========= */
function normalizeHex(s, fallback = null) {
  let v = String(s ?? '').trim();
  if (!v) return fallback;
  const m = v.match(/^#?([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/);
  if (!m) return fallback;
  let hex = m[1];
  if (hex.length === 3) hex = hex.split('').map(ch => ch + ch).join('');
  return `#${hex.toUpperCase()}`;
}
const SAFE = {
  headerBG: normalizeHex(TINT.headerPurple, '#F1F5F9'),
  rowBG:    normalizeHex(TINT.rowPurple,    '#FFFFFF'),
  totalBG:  normalizeHex(TINT.totalBlue,    '#F6E3A1'),
  grid:     normalizeHex(GRID,              '#A3A3A3'),
};
function fillRect(doc, x, y, w, h, color) {
  doc.save(); doc.fillColor(color); doc.rect(x, y, w, h).fill(); doc.restore();
}
function strokeRect(doc, x, y, w, h, color = SAFE.grid, width = 0.6) {
  doc.save(); doc.strokeColor(color).lineWidth(width); doc.rect(x, y, w, h).stroke(); doc.restore();
}

/* ========= Helpers de formato ========= */
function fmtDateTZ(date = new Date(), tz = TZ) {
  try {
    return new Intl.DateTimeFormat('es-BO', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric' }).format(date);
  } catch {
    const d = new Date(date); const pad = n => String(n).padStart(2,'0');
    return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()}`;
  }
}
function money(n){
  const s = (Number(n||0)).toFixed(2);
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function round2(n){ return Math.round((Number(n)||0) * 100) / 100; }
function toCents(n){ return Math.round((Number(n)||0) * 100); }
function ensure(v, def){ return v==null || v==='' ? def : v; }
function findAsset(...relPaths){
  for (const r of relPaths){ const p = path.resolve(r); if (fs.existsSync(p)) return p; }
  return null;
}

/* ========= Lookup de precios / packs ========= */
function canonSku(s=''){
  return String(s||'').trim().toUpperCase().replace(/\s+/g,'')
    .replace(/LTS?|LT|LITROS?/g,'L').replace(/KGS?|KILOS?/g,'KG');
}
function normName(s=''){
  return String(s||'').normalize('NFD').replace(/\p{Diacritic}/gu,'')
    .replace(/[^A-Z0-9]/gi,'').toUpperCase();
}
function parsePackFromText(t=''){
  const m = String(t||'').match(/(\d+(?:[.,]\d+)?)\s*(L|LT|LTS|LITROS?|KG|KGS?|KILOS?)/i);
  if (!m) return null;
  const size = parseFloat(m[1].replace(',','.'));
  const unit = /KG|KGS?|KILOS?/i.test(m[2]) ? 'KG' : 'L';
  if (!Number.isFinite(size) || size<=0) return null;
  return { size, unit };
}
function splitSku(s=''){
  const raw = String(s||'').trim();
  const i = raw.lastIndexOf('-');
  if (i < 0) return { base: raw, pack: null, canon: canonSku(raw) };
  const base = raw.slice(0, i);
  const tail = raw.slice(i+1);
  const pack = parsePackFromText(tail) || parsePackFromText('-'+tail) || parsePackFromText(tail.replace(/-/g,' '));
  return { base, pack, canon: canonSku(raw) };
}
function lookupFromCatalog(priceList=[], item={}){
  if (!Array.isArray(priceList) || !priceList.length) return 0;
  const cs = canonSku(item.sku||'');
  let row = priceList.find(r => canonSku(r.sku||'') === cs);
  if (!row && item.nombre && item.envase){
    const cs2 = canonSku(`${item.nombre}-${item.envase}`);
    row = priceList.find(r => canonSku(r.sku||'') === cs2);
  }
  if (!row){
    const nm = String(item.nombre||'').trim() || splitSku(String(item.sku||'')).base;
    const pack = parsePackFromText(String(item.envase||'')) || splitSku(String(item.sku||'')).pack;
    if (nm && pack){
      const nn = normName(nm);
      row = priceList.find(r=>{
        const { base, pack: p2 } = splitSku(String(r.sku||''));
        return base && p2 && normName(base)===nn && p2.unit===pack.unit && Math.abs(p2.size-pack.size)<1e-9;
      });
    }
  }
  if (!row) return 0;
  const usd = Number(row?.precio_usd||0);
  return Number.isFinite(usd) ? usd : 0;
}
function detectPackSize(it = {}){
  if (it.envase) {
    const m = String(it.envase).match(/(\d+(?:[.,]\d+)?)\s*(l|lt|lts|litros?|kg|kilos?)/i);
    if (m) { const size = parseFloat(m[1].replace(',','.')); const unit = /kg/i.test(m[2]) ? 'KG' : 'L';
      if (!isNaN(size) && size > 0) return { size, unit }; }
  }
  if (it.sku) {
    const m = String(it.sku).match(/-(\d+(?:\.\d+)?)(?:\s?)(l|kg)\b/i);
    if (m) { const size = parseFloat(m[1]); const unit = m[2].toUpperCase();
      if (!isNaN(size) && size > 0) return { size, unit }; }
  }
  if (it.nombre) {
    const m = String(it.nombre).match(/(\d+(?:[.,]\d+)?)\s*(l|lt|lts|kg)\b/i);
    if (m) { const size = parseFloat(m[1].replace(',','.')); const unit = /kg/i.test(m[2]) ? 'KG' : 'L';
      if (!isNaN(size) && size > 0) return { size, unit }; }
  }
  return null;
}
function roundQuantityByPack(originalQty, pack, itemUnitRaw){
  if (!pack || !(originalQty > 0)) return originalQty;
  const itemUnit = String(itemUnitRaw || '').toUpperCase();
  if (itemUnit && itemUnit !== pack.unit) return originalQty;
  const ratio = originalQty / pack.size;
  if (pack.unit === 'KG' && Math.abs(pack.size - 1) < 1e-9) return originalQty; // 1 Kg no redondea
  if (pack.unit === 'L' && pack.size >= 200) {
    if (ratio < 1) return pack.size;
    const mult = Math.floor(ratio + 1e-9);
    return mult * pack.size;
  }
  const mult = Math.ceil(ratio - 1e-9);
  return mult * pack.size;
}

/* ========= Render PDF ========= */
export async function renderQuotePDF(quote, outPath, company = {}){
  const dir = path.dirname(outPath);
  try{ fs.mkdirSync(dir, { recursive:true }); }catch{}

  const doc = new PDFDocument({ size: 'A4', margin: 36 });
  const stream = fs.createWriteStream(outPath);
  doc.pipe(stream);

  const pageW = doc.page.width;
  const pageH = doc.page.height;
  const xMargin = 36;
  const usableW = pageW - xMargin*2;

  // Assets
  const logoPath = company.logoPath
    || findAsset('./public/logo_newchem.png','./logo_newchem.png','./image/logo_newchem.png');
  const qrPath = company.qrPath
    || findAsset('./public/qr-pagos.png','./public/qr.png','./public/privacidad.png','./image/qr.png');

  // Marca de agua (muy tenue)
  if (logoPath){
    doc.save(); doc.opacity(0.08);
    const mw = 420;
    const mx = (pageW - mw) / 2;
    const my = (pageH - mw*0.45) / 2;
    try { doc.image(logoPath, mx, my, { width: mw }); } catch {}
    doc.restore();
  }

  // Header superior
  let y = 32;
  if (logoPath){ try { doc.image(logoPath, xMargin, y, { width: 120 }); } catch {} }
  doc.font('Helvetica-Bold').fontSize(14).fillColor('#111').text('COTIZACIÓN', 0, y+10, { align: 'center' });
  doc.font('Helvetica').fontSize(9).fillColor('#666')
     .text(fmtDateTZ(quote.fecha || new Date(), TZ), 0, y+14, { align: 'right' })
     .fillColor('black');

  y = 100;

  // Cliente
  const c = quote.cliente || {};
  const L = (label, val) => {
    doc.font('Helvetica-Bold').text(`${label}: `, xMargin, y, { continued: true });
    doc.font('Helvetica').text(ensure(val,'-'));
    y += 16;
  };
  L('Cliente', c.nombre);
  L('Departamento', c.departamento);
  L('Zona', c.zona);
  L('Pago', 'Contado');

  y += 16;

  /* ===== Tabla ===== */
  const rate = Number(process.env.USD_BOB_RATE || quote.rate || 6.96);

  const cols = [
    { key:'nombre',             label:'Producto',           w:90,  align:'left'  },
    { key:'ingrediente_activo', label:'Ingrediente activo', w:104, align:'left'  },
    { key:'envase',             label:'Envase',             w:48,  align:'left'  },
    { key:'cantidad',           label:'Cantidad',           w:56,  align:'right' },
    { key:'precio_usd',         label:'Precio (USD)',       w:55,  align:'right' },
    { key:'precio_bs',          label:'Precio (Bs)',        w:50,  align:'right' },
    { key:'subtotal_usd',       label:'Subtotal (USD)',     w:60,  align:'right' },
    { key:'subtotal_bs',        label:'Subtotal (Bs)',      w:60,  align:'right' },
  ];
  const tableX = xMargin;
  const tableW = cols.reduce((a,c)=>a+c.w,0);

  // Encabezado
  const headerH = 26;
  fillRect(doc, tableX, y, tableW, headerH, SAFE.headerBG);
  doc.fillColor('#111').font('Helvetica-Bold').fontSize(9);
  {
    let cx = tableX;
    for (const cdef of cols){
      const innerX = cx + 6;
      doc.text(cdef.label, innerX, y + (headerH-10)/2, { width: cdef.w-12, align: 'center' });
      strokeRect(doc, cx, y, cdef.w, headerH, SAFE.grid, 0.6);
      cx += cdef.w;
    }
  }
  y += headerH;

  const ensureSpace = (need = 90) => {
    if (y + need > (pageH - 60)){
      doc.addPage(); y = 42;
      if (logoPath){
        doc.save(); doc.opacity(0.08);
        const mw = 420; const mx = (pageW - mw) / 2; const my = (pageH - mw*0.45) / 2;
        try { doc.image(logoPath, mx, my, { width: mw }); } catch {}
        doc.restore();
      }
    }
  };

  const rowPadV = 6;
  const minRowH = 20;

  doc.fontSize(9).fillColor('black');

  // Acumuladores exactos
  let accUsdCents = 0;
  let accBsCents  = 0;

  for (const itRaw of (quote.items || [])){
    // 1) Precio unitario
    let precioUSD = Number(itRaw.precio_usd || 0);
    if (!(precioUSD > 0)) precioUSD = lookupFromCatalog(quote.price_catalog || company.priceList || [], itRaw) || 0;
    precioUSD = round2(precioUSD);
    const precioBsUnit  = round2(precioUSD * rate);

    // 2) Cantidad (respeta redondeo por pack)
    const cantOrig  = Number(itRaw.cantidad || 0);
    const pack      = detectPackSize(itRaw);
    let cantidad = cantOrig;
    if (pack) cantidad = roundQuantityByPack(cantOrig, pack, itRaw.unidad);

    // 3) Subtotales
    const subUSD = round2(precioUSD   * cantidad);
    const subBs  = round2(precioBsUnit * cantidad);

    accUsdCents += toCents(subUSD);
    accBsCents  += toCents(subBs);

    const cellTexts = [
      String(itRaw.nombre || ''),
      String(itRaw.ingrediente_activo || ''),
      String(itRaw.envase || ''),
      money(cantidad),
      money(precioUSD),
      money(precioBsUnit),
      money(subUSD),
      money(subBs),
    ];

    // Altura de fila
    const cellHeights = [];
    for (let i=0; i<cols.length; i++){
      const w = cols[i].w - 12;
      const h = doc.heightOfString(cellTexts[i], { width: w, align: cols[i].align || 'left' });
      cellHeights.push(Math.max(h + rowPadV*2, minRowH));
    }
    const rowH = Math.max(...cellHeights);
    ensureSpace(rowH + 10);

    // Fondo fila (blanco para look limpio)
    fillRect(doc, tableX, y, tableW, rowH, SAFE.rowBG);

    // Contenido + bordes
    let tx = tableX;
    for (let i=0; i<cols.length; i++){
      const cdef = cols[i];
      const innerX = tx + 6;
      const innerW = cdef.w - 12;
      strokeRect(doc, tx, y, cdef.w, rowH, SAFE.grid, 0.5);
      doc.fillColor('#111')
         .font(cdef.key==='nombre' ? 'Helvetica-Bold' : 'Helvetica')
         .text(cellTexts[i], innerX, y + rowPadV, { width: innerW, align: cdef.align || 'left' });
      tx += cdef.w;
    }
    y += rowH;
  }

  // Totales
  const totalUSD = accUsdCents / 100;
  const totalBs  = accBsCents  / 100;

  ensureSpace(56);

  const wUntilCol6 = cols.slice(0,6).reduce((a,c)=>a+c.w,0);
  const wCol7      = cols[6].w;
  const wCol8      = cols[7].w;

  // Línea superior separadora
   // Línea superior separadora
  doc.save();
  doc.moveTo(tableX, y).lineTo(tableX + tableW, y).strokeColor(SAFE.grid).lineWidth(0.6).stroke();
  doc.restore();

  // Altura mayor para 2 líneas
  const totalRowH = 28;

  // Celda "Total"
  strokeRect(doc, tableX, y, wUntilCol6, totalRowH, SAFE.grid, 0.6);
  doc.font('Helvetica-Bold').fillColor('#111')
     .text('Total', tableX, y + (totalRowH - 10) / 2, { width: wUntilCol6, align: 'center' });

  // === Celda de totales en DOS LÍNEAS (USD arriba, Bs abajo) ===
  const totalX = tableX + wUntilCol6;
  const totalW = wCol7 + wCol8;

  fillRect(doc, totalX, y, totalW, totalRowH, SAFE.totalBG);
  strokeRect(doc, totalX, y, totalW, totalRowH, SAFE.grid, 0.6);

  const padX = 8;
  const padY = 4;

  // Línea 1: USD (arriba)
  doc.font('Helvetica-Bold').fillColor('#111')
     .text(`$ ${money(totalUSD)}`, totalX + padX, y + padY, {
       width: totalW - padX * 2,
       align: 'right'
     });

  // Línea 2: Bs (abajo)
  doc.font('Helvetica-Bold').fillColor('#111')
     .text(`Bs ${money(totalBs)}`, totalX + padX, y + padY + 11, {
       width: totalW - padX * 2,
       align: 'right'
     });

  y += totalRowH + 14;


  // Nota precios
  ensureSpace(22);
  doc.font('Helvetica').fontSize(9).fillColor('#444')
     .text('*Nuestros precios incluyen impuestos de ley.', xMargin, y, { width: usableW });
  doc.fillColor('black');
  y += 20;

  // Lugar de entrega + link
  const drawH2 = (t)=>{
    ensureSpace(22);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#000').text(t, xMargin, y);
    doc.font('Helvetica').fontSize(10).fillColor('#000');
    y = doc.y + 10;
  };
  drawH2('Lugar de entrega');
  const entrega = [
    'Almacén Central',
    'Horarios de atención: 08:00 - 17:00'
  ];
  for (const line of entrega){ ensureSpace(16); doc.text(line, xMargin, y); y = doc.y; }

  // Link clickeable Google Maps
  const mapsUrl = 'https://maps.app.goo.gl/UPSh75QbWpfWccgz9';
  ensureSpace(16);
  doc.fillColor('#2563EB')
     .text('Ver ubicación en Google Maps', xMargin, y, { width: usableW, link: mapsUrl, underline: true });
  doc.fillColor('black');
  y = doc.y + 10;

  // Condiciones
  drawH2('Condiciones y validez de la oferta');
  const conds = [
    '1.- Oferta válida por 1 día a partir de la fecha, sujeta a la disponibilidad de productos.',
    '2.- Solicite su cotización acorde al volumen requerido antes de realizar cualquier pago.',
    '3.- La única manera de fijar precio y reservar volumen, es con el pago 100% y facturado.',
    '4.- Una vez facturado, no se aceptan cambios ni devoluciones. Excepto por producto dañado.'
  ];
  for (const line of conds){ ensureSpace(16); doc.font('Helvetica').text(line, xMargin, y); y = doc.y; }

  // Aviso de facturación (más discreto)
  y += 14;
  ensureSpace(30);
  const important = 'IMPORTANTE: LA FACTURACIÓN DEBE EMITIRSE A NOMBRE DE QUIEN REALIZA EL PAGO.';
  const pad = 10;
  const maxW = usableW;
  const textH = doc.heightOfString(important, { width: maxW - pad*2, align: 'center' });
  const boxH = Math.max(24, textH + pad*2);
  doc.save();
  doc.roundedRect(xMargin, y, maxW, boxH, 6).strokeColor('#D1D5DB').lineWidth(0.8).stroke();
  doc.font('Helvetica-Bold').fillColor('#111')
     .text(important, xMargin + pad, y + (boxH - textH)/2, { width: maxW - pad*2, align: 'center' });
  doc.restore();
  y += boxH + 14;

  // Datos bancarios y QR
  drawH2('Datos bancarios y QR');

  const rightBoxW = 150;
  const rightX    = xMargin + usableW - rightBoxW;
  const colW      = rightX - xMargin - 16;
  const bankTopY  = y;

  if (qrPath){
    try { doc.image(qrPath, rightX, bankTopY, { width: rightBoxW }); }
    catch {
      strokeRect(doc, rightX, bankTopY, rightBoxW, rightBoxW, '#CCCCCC', 1);
      doc.font('Helvetica').fontSize(9).fillColor('#666')
         .text('QR no disponible', rightX, bankTopY + rightBoxW/2 - 6, { width: rightBoxW, align:'center' })
         .fillColor('black');
    }
  } else {
    strokeRect(doc, rightX, bankTopY, rightBoxW, rightBoxW, '#CCCCCC', 1);
    doc.font('Helvetica').fontSize(9).fillColor('#666')
       .text('QR aquí', rightX, bankTopY + rightBoxW/2 - 6, { width: rightBoxW, align:'center' })
       .fillColor('black');
  }

  // Tabla bancaria (compacta y sin duplicados)
  y = bankTopY;
  const bankRow = (label, value, strong=false)=>{
    ensureSpace(30);
    doc.font('Helvetica-Bold').fillColor('#000').text(label, xMargin, y, { width: 100 });
    doc.font(strong ? 'Helvetica-Bold' : 'Helvetica').fillColor('#000').text(value, xMargin+100, y, { width: colW-100 });
    y = doc.y + 6;
    doc.save(); doc.moveTo(xMargin, y-2).lineTo(xMargin+colW, y-2).strokeColor('#E5E7EB').lineWidth(0.6).stroke(); doc.restore();
  };

  // Nombre + NIT + Moneda (en ese orden)
  bankRow('Titular:', 'New Chem Agroquímicos SRL', true);
  bankRow('NIT:', '154920027');
  bankRow('Moneda:', 'Bolivianos');

  // Bancos / Cuentas
  bankRow('Banco:', 'BCP', true);
  bankRow('Cuenta Corriente:', '701-5096500-3-34');
  bankRow('Banco:', 'BANCO UNIÓN', true);
  bankRow('Cuenta Corriente:', '10000047057563');
  bankRow('Banco:', 'BANCO SOL', true);
  bankRow('Cuenta Corriente:', '2784368-000-001');

  // Cierre/flush
  doc.end();
  await new Promise((res, rej)=>{ stream.on('finish', res); stream.on('error', rej); });
  return outPath;
}
