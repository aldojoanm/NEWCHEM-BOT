(function(){
  const root = document.documentElement;
  const JSON_URL  = root.getAttribute('data-json-url') || '/api/catalog';
  const WA_NUMBER = (root.getAttribute('data-wa-number') || '').replace(/[^\d]/g,'');

  const $  = s => document.querySelector(s);
  const secEl   = $('#sections');
  const cartEl  = $('#cart');
  const totalsEl= $('#totals');
  const sendEl  = $('#send');
  const tcEl    = $('#tc');

  let ALL = [];       // [{nombre,categoria,imagen,variantes:[{presentacion,unidad,precio_usd,precio_bs}]}]
  let RATE = 6.96;
  let CART = [];      // [{nombre,presentacion,unidad,cantidad,precio_usd,precio_bs}]

  const esc = s => String(s ?? '').replace(/[&<>"]/g,m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[m]));
  const num = v => {
    if (typeof v === 'number') return v;
    const n = String(v||'').replace(',', '.').match(/-?\d+(\.\d+)?/);
    return n ? Number(n[0]) : 0;
  };
  const fmt2 = n => (Number(n)||0).toFixed(2);

  /* ===================== Render por secciones ===================== */
  function renderSections(){
    // agrupar por categoría
    const cats = {};
    for (const it of ALL){
      const k = String(it.categoria||'').trim() || 'SIN CATEGORÍA';
      (cats[k] ||= []).push(it);
    }
    // ordenar por nombre
    Object.values(cats).forEach(arr => arr.sort((a,b)=>a.nombre.localeCompare(b.nombre,'es')));

    secEl.innerHTML = Object.entries(cats).map(([cat, items])=>{
      return `
        <div class="section-block">
          <div class="section-title"><span class="dot"></span>${esc(cat)}</div>
          <div class="list">
            ${items.map(renderCard).join('')}
          </div>
        </div>`;
    }).join('');

    // Bind por tarjeta
    bindCards();
  }

  function renderCard(item){
    const v = item.variantes || [];
    const first = v[0] || { precio_usd:0, precio_bs:0, unidad:'' };
    const opts = v.map((vx, i) =>
      `<option value="${i}" data-usd="${vx.precio_usd}" data-bs="${vx.precio_bs}" data-un="${esc(vx.unidad)}">${esc(vx.presentacion||'')}</option>`
    ).join('') || `<option value="">—</option>`;

    const bs = first.precio_bs || +(first.precio_usd * RATE).toFixed(2);

    return `
      <div class="prod" data-name="${esc(item.nombre)}">
        <div class="img"><img src="${esc(item.imagen||'')}" alt="${esc(item.nombre)}" onerror="this.src='/image/placeholder.png'"></div>
        <div class="info">
          <div class="name">${esc(item.nombre)}</div>
          <div class="cat"><span class="tag">${esc(item.categoria||'')}</span></div>
          <div class="price-note">Precio unidad: <strong>US$ ${fmt2(first.precio_usd)}</strong> · <strong>Bs ${fmt2(bs)}</strong></div>
        </div>
        <div class="pres-wrap">
          <select class="pres">${opts}</select>
        </div>
        <div class="qty-wrap">
          <input class="qty" placeholder="Cantidad" inputmode="decimal">
          <div class="sub">Subt.: <span class="subt">US$ 0.00 · Bs 0.00</span></div>
        </div>
        <div class="btn-wrap"><button class="btn add">Añadir</button></div>
      </div>`;
  }

  function bindCards(){
    secEl.querySelectorAll('.prod').forEach(row=>{
      const presSel = row.querySelector('.pres');
      const qtyEl   = row.querySelector('.qty');
      const priceEl = row.querySelector('.price-note strong'); // first strong is USD (optional)
      const subtEl  = row.querySelector('.subt');

      function currentVar(){
        const name = row.getAttribute('data-name');
        const p = ALL.find(x=>x.nombre===name);
        return { p, v: p?.variantes?.[num(presSel.value)] || { precio_usd:0, precio_bs:0, unidad:'', presentacion:'' } };
      }

      function updatePrice(){
        const { v } = currentVar();
        const usd = v.precio_usd || 0;
        const bs  = v.precio_bs || +(usd * RATE).toFixed(2);
        // subtotal:
        const qn = num(qtyEl.value);
        subtEl.textContent = `US$ ${fmt2(usd*qn)} · Bs ${fmt2(bs*qn)}`;
        // update text in note:
        const pn = row.querySelector('.price-note');
        pn.innerHTML = `Precio unidad: <strong>US$ ${fmt2(usd)}</strong> · <strong>Bs ${fmt2(bs)}</strong>`;
      }

      presSel.addEventListener('change', updatePrice);
      qtyEl.addEventListener('input', updatePrice);
      updatePrice();

      row.querySelector('.add').addEventListener('click', ()=>{
        const { p, v } = currentVar();
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

  /* ===================== Carrito ===================== */
  function upsertCart(it){
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
            <div class="muted">US$ ${fmt2(it.precio_usd)} · Bs ${fmt2(it.precio_bs)} ${it.unidad?`/ ${esc(it.unidad)}`:''}</div>
          </div>
          <div><input class="qcart" data-i="${i}" value="${esc(it.cantidad)}" inputmode="decimal"></div>
          <div style="text-align:right"><strong>US$ ${fmt2(subU)}</strong><br><span class="muted">Bs ${fmt2(subB)}</span></div>
          <div><button class="rm" data-i="${i}">×</button></div>
        </div>`;
    }).join('');

    cartEl.querySelectorAll('.rm').forEach(b=> b.addEventListener('click',()=> removeAt(+b.getAttribute('data-i'))));
    cartEl.querySelectorAll('.qcart').forEach(inp=>{
      inp.addEventListener('input', ()=>{
        const i = +inp.getAttribute('data-i');
        CART[i].cantidad = num(inp.value);
        updateCart();
      });
    });

    const tUsd = CART.reduce((a,x)=> a + x.precio_usd * x.cantidad, 0);
    const tBs  = CART.reduce((a,x)=> a + x.precio_bs  * x.cantidad, 0);
    totalsEl.innerHTML = `Total: US$ ${fmt2(tUsd)} · Bs ${fmt2(tBs)}<br><span class="muted">TC ${fmt2(RATE)}</span>`;
  }

  /* ===================== WhatsApp ===================== */
  function buildWaText(){
    const lines = CART.map(it => {
      const subU = it.precio_usd * it.cantidad;
      const subB = it.precio_bs  * it.cantidad;
      return `• ${it.nombre}${it.presentacion?` (${it.presentacion})`:''} — ${fmt2(it.cantidad)} ${it.unidad || ''}\n  Precio: US$ ${fmt2(it.precio_usd)} · Bs ${fmt2(it.precio_bs)}  |  Subt.: US$ ${fmt2(subU)} · Bs ${fmt2(subB)}`;
    });
    const tUsd = CART.reduce((a,x)=> a + x.precio_usd * x.cantidad, 0);
    const tBs  = CART.reduce((a,x)=> a + x.precio_bs  * x.cantidad, 0);
    return [
      `Hola, quiero cotizar los siguientes productos de NEW CHEM AGROQUÍMICOS:`,
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
  sendEl.addEventListener('click', goWhatsApp);

  /* ===================== Init ===================== */
  (async function init(){
    try{
      const r = await fetch(JSON_URL, { cache: 'no-store' });
      if(!r.ok) throw new Error('HTTP '+r.status);
      const { items=[], rate=6.96 } = await r.json();
      ALL = items;
      RATE = Number(rate) || 6.96;
      tcEl.textContent = `TC ${fmt2(RATE)}`;
      if (!ALL.length) throw new Error('cat vacío');
      renderSections();
      updateCart();
    }catch(e){
      console.error(e);
      secEl.innerHTML = `<div class="empty">Error al cargar catálogo.</div>`;
      cartEl.innerHTML = `<div class="empty">Tu carrito está vacío.</div>`;
      totalsEl.innerHTML = '';
      sendEl.disabled = true;
    }
  })();
})();
