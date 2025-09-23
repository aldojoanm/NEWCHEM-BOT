(function(){
  const root = document.documentElement;
  const JSON_URL  = root.getAttribute('data-json-url') || '/api/catalog';
  const WA_NUMBER = (root.getAttribute('data-wa-number') || '').replace(/[^\d]/g,'');

  const $ = s => document.querySelector(s);
  const listEl  = $('#list');
  const cartEl  = $('#cart');
  const totalsEl= $('#totals');
  const qEl     = $('#q');
  const catEl   = $('#cat');
  const sendEl  = $('#send');
  const tcEl    = $('#tc');

  let ALL = [];       // [{nombre,categoria,imagen,variantes:[{presentacion,unidad,precio_usd,precio_bs}]}]
  let RATE = 6.96;
  let CART = [];      // [{nombre,presentacion,unidad,cantidad,precio_usd,precio_bs}]

  const esc = s => String(s ?? '').replace(/[&<>"]/g,m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[m]));
  const norm = s => String(s||'').toLowerCase();
  const num  = v => {
    if (typeof v === 'number') return v;
    const n = String(v||'').replace(',', '.').match(/-?\d+(\.\d+)?/);
    return n ? Number(n[0]) : 0;
  };
  const fmt2 = n => (Number(n)||0).toFixed(2);

  function renderCats(items){
    const cats = Array.from(new Set(items.map(x => String(x.categoria||'').trim()).filter(Boolean))).sort((a,b)=>a.localeCompare(b,'es'));
    catEl.innerHTML = `<option value="">Todas las categorías</option>` + cats.map(c=>`<option>${esc(c)}</option>`).join('');
  }

  function renderList(){
    const q = norm(qEl.value);
    const sel = catEl.value;

    const rows = ALL.filter(p=>{
      const okCat = !sel || p.categoria === sel;
      const okQ = !q || norm(p.nombre).includes(q);
      return okCat && okQ;
    });

    if (!rows.length){
      listEl.innerHTML = `<div class="empty">No se encontraron productos.</div>`;
      return;
    }

    listEl.innerHTML = rows.map(item=>{
      const v = item.variantes || [];
      const opts = v.map((vx, i) =>
        `<option value="${i}" data-usd="${vx.precio_usd}" data-bs="${vx.precio_bs}" data-un="${esc(vx.unidad)}">${esc(vx.presentacion||'')}</option>`
      ).join('') || `<option value="">—</option>`;

      // precio del primero
      const first = v[0] || { precio_usd:0, precio_bs:0, unidad:'' };
      const imgSrc = item.imagen || '';

      return `
        <div class="prod" data-name="${esc(item.nombre)}">
          <img src="${esc(imgSrc)}" alt="${esc(item.nombre)}"
               onerror="this.src='/image/placeholder.png'">
          <div>
            <div class="name">${esc(item.nombre)}</div>
            <div class="pill">${esc(item.categoria || '')}</div>
            <div class="sub">Precio unidad: <span class="price">US$ ${fmt2(first.precio_usd)} · Bs ${fmt2(first.precio_bs||first.precio_usd*RATE)}</span></div>
          </div>
          <div>
            <select class="pres">${opts}</select>
          </div>
          <div>
            <input class="qty" placeholder="Cant." inputmode="decimal">
            <div class="sub">Subt.: <span class="subt">US$ 0.00 · Bs 0.00</span></div>
          </div>
          <div><button class="btn add">Añadir</button></div>
        </div>`;
    }).join('');

    // Binds por tarjeta
    listEl.querySelectorAll('.prod').forEach(row=>{
      const presSel = row.querySelector('.pres');
      const qtyEl   = row.querySelector('.qty');
      const priceEl = row.querySelector('.price');
      const subtEl  = row.querySelector('.subt');

      function updatePrice(){
        const itemName = row.getAttribute('data-name');
        const p = ALL.find(x=>x.nombre===itemName);
        const v = p?.variantes?.[num(presSel.value)] || { precio_usd:0, precio_bs:0, unidad:'' };
        const usd = v.precio_usd || 0;
        const bs  = v.precio_bs || +(usd * RATE).toFixed(2);
        priceEl.textContent = `US$ ${fmt2(usd)} · Bs ${fmt2(bs)}`;
        // subtotal:
        const qn = num(qtyEl.value);
        subtEl.textContent = `US$ ${fmt2(usd*qn)} · Bs ${fmt2(bs*qn)}`;
      }
      presSel.addEventListener('change', updatePrice);
      qtyEl.addEventListener('input', updatePrice);
      updatePrice();

      row.querySelector('.add').addEventListener('click', ()=>{
        const itemName = row.getAttribute('data-name');
        const p = ALL.find(x=>x.nombre===itemName);
        const v = p?.variantes?.[num(presSel.value)];
        const cantidad = num(qtyEl.value);
        if (!p || !v || !cantidad){ qtyEl.focus(); return; }

        upsertCart({
          nombre: p.nombre,
          presentacion: v.presentacion || '',
          unidad: v.unidad || '',
          cantidad,
          precio_usd: v.precio_usd || 0,
          precio_bs:  v.precio_bs  || +( (v.precio_usd||0) * RATE ).toFixed(2)
        });

        qtyEl.value = '';
        updateCart();
      });
    });
  }

  function upsertCart(it){
    // clave: nombre + presentacion
    const ix = CART.findIndex(x => x.nombre===it.nombre && x.presentacion===it.presentacion);
    if (ix>=0) CART[ix].cantidad = it.cantidad;
    else CART.push(it);
  }

  function removeAt(i){
    CART.splice(i,1);
    updateCart();
  }

  function updateCart(){
    if (!CART.length){
      cartEl.innerHTML = `<div class="empty">Tu carrito está vacío.</div>`;
      totalsEl.innerHTML = '';
      sendEl.disabled = true;
      return;
    }
    sendEl.disabled = false;

    cartEl.innerHTML = CART.map((it,i)=>{
      const subU = it.precio_usd * it.cantidad;
      const subB = it.precio_bs  * it.cantidad;
      return `
        <div class="item">
          <div>
            <div><strong>${esc(it.nombre)}</strong> ${it.presentacion?`<span class="pill">${esc(it.presentacion)}</span>`:''}</div>
            <div class="pill">US$ ${fmt2(it.precio_usd)} · Bs ${fmt2(it.precio_bs)} ${it.unidad?`/ ${esc(it.unidad)}`:''}</div>
          </div>
          <div>
            <input class="qcart" data-i="${i}" value="${esc(it.cantidad)}" inputmode="decimal" style="width:100%;padding:6px 8px;background:#0b141a;border:1px solid var(--ring);border-radius:8px;color:var(--txt)">
          </div>
          <div style="text-align:right">US$ ${fmt2(subU)}<br><span class="pill">Bs ${fmt2(subB)}</span></div>
          <div><button class="rm" data-i="${i}">×</button></div>
        </div>`;
    }).join('');

    // binds
    cartEl.querySelectorAll('.rm').forEach(b=> b.addEventListener('click',()=> removeAt(+b.getAttribute('data-i'))));
    cartEl.querySelectorAll('.qcart').forEach(inp=>{
      inp.addEventListener('input', ()=>{
        const i = +inp.getAttribute('data-i');
        CART[i].cantidad = num(inp.value);
        updateCart();
      });
    });

    // Totales
    const tUsd = CART.reduce((a,x)=> a + x.precio_usd * x.cantidad, 0);
    const tBs  = CART.reduce((a,x)=> a + x.precio_bs  * x.cantidad, 0);
    totalsEl.innerHTML = `Total: US$ ${fmt2(tUsd)} · Bs ${fmt2(tBs)}<br><span class="muted">TC ${fmt2(RATE)}</span>`;
  }

  function buildWaText(){
    const lines = CART.map(it => {
      const subU = it.precio_usd * it.cantidad;
      const subB = it.precio_bs  * it.cantidad;
      return `• ${it.nombre}${it.presentacion?` (${it.presentacion})`:''} — ${fmt2(it.cantidad)} ${it.unidad || ''}\n  Precio: US$ ${fmt2(it.precio_usd)} · Bs ${fmt2(it.precio_bs)}  |  Subt.: US$ ${fmt2(subU)} · Bs ${fmt2(subB)}`;
    });
    const tUsd = CART.reduce((a,x)=> a + x.precio_usd * x.cantidad, 0);
    const tBs  = CART.reduce((a,x)=> a + x.precio_bs  * x.cantidad, 0);

    return [
      `Hola, quiero cotizar los siguientes productos:`,
      ...lines,
      ``,
      `TOTAL: US$ ${fmt2(tUsd)} · Bs ${fmt2(tBs)} (TC ${fmt2(RATE)})`
    ].join('\n');
  }

  function goWhatsApp(){
    const txt = buildWaText();
    if (WA_NUMBER) window.location.href = `https://wa.me/${WA_NUMBER}?text=${encodeURIComponent(txt)}`;
    else           window.location.href = `https://wa.me/?text=${encodeURIComponent(txt)}`;
  }

  qEl.addEventListener('input', renderList);
  catEl.addEventListener('change', renderList);
  sendEl.addEventListener('click', goWhatsApp);

  // Init
  (async function init(){
    try{
      const r = await fetch(JSON_URL, { cache: 'no-store' });
      if(!r.ok) throw new Error('HTTP '+r.status);
      const { items=[], rate=6.96 } = await r.json();
      ALL = items;
      RATE = Number(rate) || 6.96;
      tcEl.textContent = `TC ${fmt2(RATE)}`;
      if (!ALL.length) throw new Error('cat vacío');
      renderCats(ALL);
      renderList();
      updateCart();
    }catch(e){
      console.error(e);
      listEl.innerHTML = `<div class="empty">Error al cargar catálogo.</div>`;
      cartEl.innerHTML = `<div class="empty">Tu carrito está vacío.</div>`;
      totalsEl.innerHTML = '';
      sendEl.disabled = true;
    }
  })();
})();
