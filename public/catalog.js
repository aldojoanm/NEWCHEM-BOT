(() => {
  const byId = (x) => document.getElementById(x);
  const $cards = byId('cards');
  const $cart = byId('cart');
  const $send = byId('send');
  const $q = byId('q');
  const $cat = byId('cat');
  const $chips = byId('chips');
  const $err = byId('err');

  // Permite override por ?csv= o ?json=
  const params = new URLSearchParams(location.search);
  const CSV_URL =
    params.get('csv') ||
    document.body.dataset.csvUrl ||
    '';
  const JSON_URL =
    params.get('json') ||
    document.body.dataset.jsonUrl ||
    '';

  const WA_NUMBER = (document.body.dataset.waNumber || '').replace(/[^\d]/g, '');

  const REQUIRED_HEADERS = [
    'sku', 'nombre', 'categoria', 'ingrediente_activo',
    'formulacion', 'dosis', 'plaga', 'presentaciones', 'imagen'
  ];

  const state = { all: [], view: [], cart: [], tags: [] };

  // --- helpers ---
  function showError(html) {
    $err.style.display = 'block';
    $err.innerHTML = html;
    if (!$cards.innerHTML.trim()) {
      $cards.innerHTML = `<div class="muted">No se pudo cargar el catálogo.</div>`;
    }
  }
  function clearError(){ $err.style.display = 'none'; $err.innerHTML=''; }

  function alpha(s=''){ return String(s).normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase(); }
  function uniq(arr){ return [...new Set(arr.filter(Boolean))]; }
  function presentList(x){ return (x||'').split(/[,|]/).map(s => s.trim()).filter(Boolean); }
  function plagaList(x){ return (x||'').split(/[;,\|]/).map(s => s.trim()).filter(Boolean); }
  function clamp(t, n){ return String(t).length<=n ? t : String(t).slice(0,n-1)+'…'; }

  function csvToRows(csv) {
    // BOM friendly
    if (csv.charCodeAt(0) === 0xFEFF) csv = csv.slice(1);
    const lines = csv.split(/\r?\n/);
    // quita líneas vacías al final
    while(lines.length && !lines[lines.length-1].trim()) lines.pop();
    if (!lines.length) return [];

    // parse comas con comillas
    function splitCSV(line){
      const out = [];
      let cur = '', q = false;
      for (let i=0;i<line.length;i++){
        const ch=line[i];
        if (ch === '"'){
          if (q && line[i+1] === '"'){ cur+='"'; i++; }
          else q = !q;
        } else if (ch === ',' && !q){
          out.push(cur); cur='';
        } else cur+=ch;
      }
      out.push(cur);
      return out;
    }

    const head = splitCSV(lines.shift()).map(h => h.trim().toLowerCase());
    const rows = lines.map(l => {
      const cells = splitCSV(l);
      const o = {};
      head.forEach((h, i) => o[h] = (cells[i] || '').trim());
      return o;
    });
    return { head, rows };
  }

  function validateHeaders(head){
    const hset = new Set(head);
    const missing = REQUIRED_HEADERS.filter(h => !hset.has(h));
    return missing;
  }

  function normalizeRows(rows){
    return rows.map(r => ({
      sku: r.sku || r.SKU || r.Sku || '',
      nombre: r.nombre || r.Nombre || '',
      categoria: r.categoria || r.Categoria || '',
      ingrediente_activo: r.ingrediente_activo || r.ia || r.ingrediente || '',
      formulacion: r.formulacion || r.Formulacion || r['formulación'] || '',
      dosis: r.dosis || r.Dosis || '',
      plaga: r.plaga || r.Plaga || '',
      presentaciones: presentList(r.presentaciones || r.Presentaciones || ''),
      imagen: r.imagen || r.Imagen || ''
    })).filter(p => p.nombre && p.sku);
  }

  // --- chips ---
  function renderChips(products){
    const acc = new Map();
    products.forEach(p => {
      plagaList(p.plaga).forEach(tag => { if(tag) acc.set(tag, (acc.get(tag)||0)+1); });
      (p.ingrediente_activo||'').split(/[+\/,]/).map(s=>s.trim()).filter(Boolean)
        .forEach(tag => acc.set(tag, (acc.get(tag)||0)+1));
    });
    const top = [...acc.entries()].sort((a,b)=>b[1]-a[1]).slice(0,14).map(([k])=>k);
    state.tags = top;
    $chips.innerHTML = '';
    top.forEach(t => {
      const b = document.createElement('button');
      b.className = 'pill';
      b.textContent = clamp(t, 22);
      b.addEventListener('click', () => {
        const active = b.classList.toggle('active');
        [...$chips.querySelectorAll('.pill')].forEach(el => { if (el!==b) el.classList.remove('active'); });
        if (active) { $q.value = t; applyFilters(); }
        else { $q.value=''; applyFilters(); }
      });
      $chips.appendChild(b);
    });
  }

  // --- fetchers ---
  async function loadFromCSV(url){
    const r = await fetch(url, { cache:'no-store' });
    if(!r.ok) throw new Error(`HTTP ${r.status} al obtener CSV`);
    const text = await r.text();
    const parsed = csvToRows(text);
    if (!parsed || !parsed.rows) throw new Error('CSV vacío o malformado');

    // valida cabeceras
    const missing = validateHeaders(parsed.head);
    if (missing.length){
      throw new Error(`Faltan estas columnas en la hoja: ${missing.join(', ')}`);
    }

    return normalizeRows(parsed.rows);
  }

  async function loadFromJSON(url){
    const r = await fetch(url, { cache:'no-store' });
    if(!r.ok) throw new Error(`HTTP ${r.status} al obtener JSON`);
    const data = await r.json();
    if (!Array.isArray(data)) throw new Error('JSON inválido: se esperaba un array de productos');
    // admite claves camelCase o snake
    const rows = data.map(p => ({
      sku: p.sku || '',
      nombre: p.nombre || p.name || '',
      categoria: p.categoria || p.category || '',
      ingrediente_activo: p.ingrediente_activo || p.ingredienteActivo || p.ia || '',
      formulacion: p.formulacion || p.formulation || '',
      dosis: p.dosis || p.dose || '',
      plaga: p.plaga || p.pests || '',
      presentaciones: Array.isArray(p.presentaciones) ? p.presentaciones : presentList(p.presentaciones || ''),
      imagen: p.imagen || p.image || ''
    }));
    return rows.filter(p => p.nombre && p.sku);
  }

  async function loadCatalog(){
    clearError();

    // detección de mixed content / CORS
    if (!CSV_URL && !JSON_URL) {
      showError(`No hay fuente configurada.<br>
      <b>Soluciones:</b>
      <ul>
        <li>Agrega <code>data-csv-url="https://docs.google.com/spreadsheets/d/ID/pub?output=csv"</code> en &lt;body&gt;</li>
        <li>o abre: <code>?csv=URL</code> como querystring</li>
        <li>o usa un JSON propio con <code>data-json-url</code></li>
      </ul>`);
      return [];
    }

    try {
      let products = [];
      if (JSON_URL) products = await loadFromJSON(JSON_URL);
      else products = await loadFromCSV(CSV_URL);

      if (!products.length) {
        showError('El catálogo quedó vacío. Revisa que la hoja tenga filas con <code>sku</code> y <code>nombre</code>.');
      }
      return products;
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      const hint = `
        <div style="margin-top:6px" class="small">
          Revisa:
          <ul>
            <li>La URL termina en <code>output=csv</code> o usas <code>gviz</code> correctamente.</li>
            <li>La hoja está <b>Publicada en la web</b> (Archivo → Compartir → Publicar en la web).</li>
            <li>Evita <b>mixed content</b>: si el sitio es HTTPS, usa URL HTTPS.</li>
          </ul>
          Puedes probar rápido con: <code>?csv=URL</code> al final de esta página.
        </div>`;
      showError(`Error al cargar catálogo: <code>${msg}</code>${hint}`);
      return [];
    }
  }

  // --- render ---
  function renderList(){
    $cards.innerHTML = '';
    state.view.forEach(p => {
      const card = document.createElement('article');
      card.className = 'card';

      const imgbox = document.createElement('div');
      imgbox.className = 'imgbox';
      if (p.imagen) {
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.src = p.imagen;
        img.alt = p.nombre;
        imgbox.appendChild(img);
      } else {
        const span = document.createElement('span');
        span.className = 'muted';
        span.textContent = 'Sin imagen';
        imgbox.appendChild(span);
      }

      const body = document.createElement('div');
      body.className = 'card-body';

      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = p.nombre;

      const meta = document.createElement('div');
      meta.className = 'muted';
      const line = [];
      if (p.categoria) line.push(p.categoria);
      if (p.formulacion) line.push(p.formulacion);
      meta.textContent = line.join(' • ');

      const chips = document.createElement('div');
      chips.className = 'row';
      if (p.ingrediente_activo) {
        const c = document.createElement('span');
        c.className = 'chip';
        c.textContent = clamp(p.ingrediente_activo, 40);
        chips.appendChild(c);
      }
      (p.plaga || '').split(/[;,\|]/).map(s=>s.trim()).filter(Boolean).slice(0,2).forEach(tag => {
        const c = document.createElement('span');
        c.className = 'chip';
        c.textContent = clamp(tag, 22);
        chips.appendChild(c);
      });

      const row = document.createElement('div');
      row.className = 'row';

      const sel = document.createElement('select');
      sel.innerHTML = '<option value="">Presentación…</option>' +
        (p.presentaciones || []).map(x => `<option>${x}</option>`).join('');
      row.appendChild(sel);

      const qty = document.createElement('input');
      qty.type = 'number';
      qty.min = '0';
      qty.step = '0.01';
      qty.placeholder = 'Cant.';
      row.appendChild(qty);

      const add = document.createElement('button');
      add.className = 'btn';
      add.textContent = 'Agregar';
      add.addEventListener('click', () => {
        const pres = sel.value || ((p.presentaciones||[])[0] || '');
        const cant = qty.value.trim();
        if (!pres) { alert('Elegí una presentación'); return; }
        if (!cant || isNaN(Number(cant)) || Number(cant) <= 0) { alert('Cantidad inválida'); return; }
        pushToCart(p, pres, cant);
        qty.value = '';
      });
      row.appendChild(add);

      body.appendChild(name);
      body.appendChild(meta);
      body.appendChild(chips);
      body.appendChild(row);

      card.appendChild(imgbox);
      card.appendChild(body);
      $cards.appendChild(card);
    });
  }

  function pushToCart(p, presentacion, cant){
    const key = `${p.sku}__${presentacion}`;
    const found = state.cart.find(x => x.key === key);
    const qtyNum = Number(cant);
    if (found) found.cantidad = qtyNum;
    else state.cart.push({ key, sku: p.sku, nombre: p.nombre, presentacion, cantidad: qtyNum });
    renderCart();
  }

  function renderCart(){
    if (!state.cart.length) {
      $cart.innerHTML = '<div class="small">Tu carrito está vacío.</div>';
      return;
    }
    $cart.innerHTML = '';
    state.cart.forEach((it, idx) => {
      const row = document.createElement('div');
      row.className = 'cart-item';

      const left = document.createElement('div');
      const nm = document.createElement('div');
      nm.className = 'cart-name';
      nm.textContent = `${it.nombre} (${it.presentacion})`;
      const sm = document.createElement('div');
      sm.className = 'small';
      sm.textContent = `SKU: ${it.sku}`;
      left.appendChild(nm); left.appendChild(sm);

      const right = document.createElement('div');
      right.className = 'row';
      const qty = document.createElement('input');
      qty.type = 'number'; qty.min='0'; qty.step='0.01';
      qty.value = it.cantidad;
      qty.addEventListener('input', () => {
        const n = Number(qty.value);
        if (!isNaN(n) && n>=0) it.cantidad = n;
      });

      const del = document.createElement('button');
      del.className = 'btn';
      del.textContent = 'Quitar';
      del.addEventListener('click', () => {
        state.cart.splice(idx,1);
        renderCart();
      });

      right.appendChild(qty);
      right.appendChild(del);

      row.appendChild(left);
      row.appendChild(right);
      $cart.appendChild(row);
    });
  }

  // filtros
  function applyFilters(){
    const q = alpha($q.value || '');
    const cat = $cat.value || '';
    state.view = state.all.filter(p => {
      const byCat = !cat || alpha(p.categoria) === alpha(cat);
      const hay = !q || (
        alpha(p.nombre).includes(q) ||
        alpha(p.ingrediente_activo).includes(q) ||
        alpha(p.formulacion).includes(q) ||
        alpha(p.plaga).includes(q)
      );
      return byCat && hay;
    });
    renderList();
  }
  $q.addEventListener('input', applyFilters);
  $cat.addEventListener('change', applyFilters);

  // WhatsApp (lo dejaremos listo, pero la integración completa la hacemos luego)
  function buildWaText(){
    const lines = [];
    lines.push(`Hola, me interesa cotizar los siguientes productos:`);
    state.cart.forEach(it => {
      const unitGuess = /kg/i.test(it.presentacion) ? 'Kg' : 'L';
      const cantidad = `${it.cantidad} ${unitGuess}`;
      lines.push(`• ${it.nombre} (${it.presentacion}) — ${cantidad}`);
    });
    lines.push('');
    lines.push('Por favor, continúen con mi cotización. Gracias.');
    return lines.join('\n');
  }
  $send.addEventListener('click', () => {
    if (!state.cart.length) { alert('Agrega al menos un producto.'); return; }
    if (!WA_NUMBER) { alert('No hay número WA configurado en data-wa-number'); return; }
    const text = buildWaText();
    const url = `https://wa.me/${WA_NUMBER}?text=${encodeURIComponent(text)}`;
    window.open(url, '_blank');
  });

  // GO
  (async () => {
    state.all = await loadCatalog();
    state.view = state.all;
    renderChips(state.all);
    applyFilters();
  })();
})();
