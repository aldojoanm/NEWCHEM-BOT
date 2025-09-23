(() => {
  const byId = (x) => document.getElementById(x);
  const $cards = byId('cards');
  const $cart = byId('cart');
  const $send = byId('send');
  const $q = byId('q');
  const $cat = byId('cat');
  const $chips = byId('chips');

  const CSV_URL = document.body.dataset.csvUrl || '';
  const WA_NUMBER = (document.body.dataset.waNumber || '').replace(/[^\d]/g, '');

  if (!CSV_URL) console.warn('⚠️ data-csv-url no configurado en <body>');
  if (!WA_NUMBER) console.warn('⚠️ data-wa-number no configurado en <body>');

  const state = {
    all: [],
    view: [],
    cart: [],
    tags: [] // chips rápidos por IA/plaga
  };

  // --- UTILS ---
  function csvToRows(csv) {
    const lines = csv.split(/\r?\n/).filter(Boolean);
    const head = lines.shift().split(',').map(s => s.trim());
    const rows = lines.map(line => {
      // soporte comillas con coma
      const cells = [];
      let cur = '', quoted = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"' ) {
          if (quoted && line[i+1] === '"') { cur += '"'; i++; }
          else quoted = !quoted;
        } else if (ch === ',' && !quoted) {
          cells.push(cur); cur = '';
        } else {
          cur += ch;
        }
      }
      cells.push(cur);
      const obj = {};
      head.forEach((h, idx) => obj[h] = (cells[idx] || '').trim());
      return obj;
    });
    return rows;
  }

  function alpha(s=''){ return String(s).normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase(); }
  function uniq(arr){ return [...new Set(arr.filter(Boolean))]; }
  function presentList(x){ return (x||'').split(/[,|]/).map(s => s.trim()).filter(Boolean); }
  function plagaList(x){ return (x||'').split(/[;,\|]/).map(s => s.trim()).filter(Boolean); }
  function clamp(t, n){ return String(t).length<=n ? t : String(t).slice(0,n-1)+'…'; }

  function renderChips(products){
    const acc = new Map(); // label->count
    products.forEach(p => {
      plagaList(p.plaga).forEach(tag => {
        const k = tag && tag.length>1 ? tag : null;
        if(!k) return;
        acc.set(k, (acc.get(k)||0) + 1);
      });
      const ia = (p.ingrediente_activo||'').split(/[+\/,]/).map(s=>s.trim()).filter(Boolean);
      ia.forEach(tag => {
        if(!tag) return;
        acc.set(tag, (acc.get(tag)||0) + 1);
      });
    });
    const top = [...acc.entries()]
      .sort((a,b)=> b[1]-a[1])
      .slice(0, 14)
      .map(([label]) => label);

    state.tags = top;
    $chips.innerHTML = '';
    top.forEach(t => {
      const b = document.createElement('button');
      b.className = 'pill';
      b.textContent = clamp(t, 22);
      b.addEventListener('click', () => {
        const active = b.classList.toggle('active');
        // solo un chip activo a la vez
        [...$chips.querySelectorAll('.pill')].forEach(el => { if (el!==b) el.classList.remove('active'); });
        if (active) { $q.value = t; applyFilters(); }
        else { $q.value=''; applyFilters(); }
      });
      $chips.appendChild(b);
    });
  }

  // --- FETCH ---
  async function loadCSV(){
    const r = await fetch(CSV_URL, { cache:'no-store' });
    if(!r.ok) throw new Error('No se pudo descargar el CSV');
    const text = await r.text();
    const rows = csvToRows(text);

    // normaliza productos
    const products = rows.map(r => ({
      sku: r.sku || r.SKU || r.Sku || '',
      nombre: r.nombre || r.Nombre || '',
      categoria: r.categoria || r.Categoria || '',
      ingrediente_activo: r.ingrediente_activo || r.ia || r.ingrediente || '',
      formulacion: r.formulacion || r.Formulacion || r.formulación || '',
      dosis: r.dosis || r.Dosis || '',
      plaga: r.plaga || r.Plaga || '',
      presentaciones: presentList(r.presentaciones || r.Presentaciones || ''),
      imagen: r.imagen || r.Imagen || ''
    })).filter(p => p.nombre && p.sku);

    state.all = products;
    state.view = products;
    renderChips(products);
    renderList();
  }

  // --- RENDER ---
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
      plagaList(p.plaga).slice(0,2).forEach(tag => {
        const c = document.createElement('span');
        c.className = 'chip';
        c.textContent = clamp(tag, 22);
        chips.appendChild(c);
      });

      const row = document.createElement('div');
      row.className = 'row';

      const sel = document.createElement('select');
      sel.innerHTML = '<option value="">Presentación…</option>' +
        p.presentaciones.map(x => `<option>${x}</option>`).join('');
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
        const pres = sel.value || (p.presentaciones[0] || '');
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

  // --- FILTERS ---
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

  // --- WHATSAPP ---
  function buildWaText(){
    const lines = [];
    lines.push(`Hola, me interesa cotizar los siguientes productos:`);
    state.cart.forEach(it => {
      // Formato compatible con tu flujo/asesor: "• Nombre (Presentación) — 10 L"
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
  loadCSV().catch(err => {
    console.error(err);
    $cards.innerHTML = `<div class="muted">No se pudo cargar el catálogo.</div>`;
  });
})();
