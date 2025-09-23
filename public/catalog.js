(function(){
  const MIN_ORDER_USD = 3000;

  const root      = document.documentElement;
  const JSON_URL  = root.getAttribute('data-json-url') || '/api/catalog';
  const WA_NUMBER = (root.getAttribute('data-wa-number') || '').replace(/[^\d]/g,'');

  // DOM
  const $       = s => document.querySelector(s);
  const secEl   = $('#sections');
  const cartEl  = $('#cart');
  const totalsEl= $('#totals');
  const sendEl  = $('#send');
  const tcEl    = $('#tc');

  // móvil
  const fab       = $('#cartFab');
  const cartBadge = $('#cartCount');
  const modal     = $('#cartModal');
  const cartM     = $('#cartM');
  const totalsM   = $('#totalsM');
  const sendM     = $('#sendM');
  $('#closeModal').addEventListener('click', ()=> modal.classList.remove('show'));
  modal.querySelector('.backdrop').addEventListener('click', ()=> modal.classList.remove('show'));
  fab.addEventListener('click', ()=> modal.classList.add('show'));

  const toastEl = $('#toast');
  function toast(msg){
    toastEl.textContent = msg || 'Acción realizada';
    toastEl.classList.add('show');
    setTimeout(()=> toastEl.classList.remove('show'), 1300);
  }

  // estado
  let ALL  = [];    // [{nombre,categoria,variantes:[{presentacion,unidad,precio_usd,precio_bs}], imagen?}]
  let RATE = 6.96;
  let CART = [];    // [{nombre,presentacion,unidad,cantidad,precio_usd,precio_bs}]

  // utils
  const esc  = s => String(s ?? '').replace(/[&<>"]/g,m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[m]));
  const num  = v => {
    if (typeof v === 'number') return v;
    const m = String(v||'').replace(',', '.').match(/-?\d+(\.\d+)?/);
    return m ? Number(m[0]) : 0;
  };
  const fmt2 = n => (Number(n)||0).toFixed(2);

  /* ===================== UI: secciones ===================== */
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

    bindCards();
  }

  function guessImagePath(name){
    // intenta /image/DRIER.png, etc.
    return `/image/${String(name||'').replace(/\s+/g,'').toUpperCase()}.png`;
  }

  function renderCard(item){
    const v = item.variantes || [];
    const first = v[0] || { precio_usd:0, precio_bs:0, unidad:'', presentacion:'' };

    const opts = v.map((vx, i) =>
      `<option value="${i}" data-usd="${vx.precio_usd}" data-bs="${vx.precio_bs}" data-un="${esc(vx.unidad)}">${esc(vx.presentacion||'')}</option>`
    ).join('') || `<option value="">—</option>`;

    const bs = first.precio_bs || +(first.precio_usd * RATE).toFixed(2);
    const imgSrc = item.imagen || guessImagePath(item.nombre);

    return `
      <div class="prod" data-name="${esc(item.nombre)}">
        <div class="name">
          <div class="name">${esc(item.nombre)}</div>
          <div class="cat"><span class="tag">${esc(item.categoria||'')}</span></div>
        </div>
        <div class="img"><img src="${esc(imgSrc)}" alt="${esc(item.nombre)}" onerror="this.src='/image/placeholder.png'"></div>
        <div class="price-note">Precio unidad: <strong>US$ ${fmt2(first.precio_usd)}</strong> · <strong>Bs ${fmt2(bs)}</strong></div>
        <div class="pres-wrap"><select class="pres">${opts}</select></div>
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
      const subtEl  = row.querySelector('.subt');
      const addBtn  = row.querySelector('.add');
      const name    = row.getAttribute('data-name');

      function currentVar(){
        const p = ALL.find(x=>x.nombre===name);
        const v = p?.variantes?.[num(presSel.value)] || { precio_usd:0, precio_bs:0, unidad:'', presentacion:'' };
        return { p, v };
      }

      function updatePriceAndState(){
        const { v } = currentVar();
        const usd = v.precio_usd || 0;
        const bs  = v.precio_bs || +(usd * RATE).toFixed(2);
        // subtotal con cantidad
        const qn = num(qtyEl.value);
        subtEl.textContent = `US$ ${fmt2(usd*qn)} · Bs ${fmt2(bs*qn)}`;
        // nota de precio
        const pn = row.querySelector('.price-note');
        pn.innerHTML = `Precio unidad: <strong>US$ ${fmt2(usd)}</strong> · <strong>Bs ${fmt2(bs)}</strong>`;
        // disponibilidad
        const available = usd > 0 || bs > 0;
        addBtn.disabled = !available;
      }

      presSel.addEventListener('change', updatePriceAndState);
      qtyEl.addEventListener('input', updatePriceAndState);
      updatePriceAndState();

      addBtn.addEventListener('click', ()=>{
        const { p, v } = currentVar();
        const cantidad = num(qtyEl.value);
        const available = (v.precio_usd || 0) > 0 || (v.precio_bs || 0) > 0;

        if (!available){
          alert('Este producto no está disponible en este momento.');
          return;
        }
        if (!cantidad){ qtyEl.focus(); return; }

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
        toast('Se añadió a tu carrito');
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

  function totals(){
    const usd = CART.reduce((a,x)=> a + x.precio_usd * x.cantidad, 0);
    const bs  = CART.reduce((a,x)=> a + x.precio_bs  * x.cantidad, 0);
    return { usd, bs };
  }

  function updateCart(){
    // panel derecho (desktop)
    if (!CART.length){
      cartEl.innerHTML = `<div class="empty">Tu carrito está vacío.</div>`;
      totalsEl.innerHTML = '';
    } else {
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

      const t = totals();
      totalsEl.innerHTML = `Total: US$ ${fmt2(t.usd)} · Bs ${fmt2(t.bs)}<br><span class="muted">TC ${fmt2(RATE)}</span>`;
    }

    // modal (móvil)
    cartM.innerHTML = cartEl.innerHTML || `<div class="empty">Tu carrito está vacío.</div>`;
    totalsM.innerHTML = totalsEl.innerHTML || '';
    // los inputs del modal deben re-enlazar
    cartM.querySelectorAll('.rm').forEach(b=> b.addEventListener('click',()=> removeAt(+b.getAttribute('data-i'))));
    cartM.querySelectorAll('.qcart').forEach(inp=>{
      inp.addEventListener('input', ()=>{
        const i = +inp.getAttribute('data-i');
        CART[i].cantidad = num(inp.value);
        updateCart();
      });
    });

    // badge en FAB
    const count = CART.reduce((a,x)=> a + (num(x.cantidad) ? 1 : 0), 0);
    if (count > 0){
      cartBadge.style.display = 'inline-block';
      cartBadge.textContent = String(count);
    } else {
      cartBadge.style.display = 'none';
    }

    // habilitar / deshabilitar CTA por mínimo
    const t = totals();
    const okMin = t.usd >= MIN_ORDER_USD;
    sendEl.disabled = !okMin || CART.length===0;
    sendM.disabled  = !okMin || CART.length===0;
  }

  /* ===================== WhatsApp ===================== */
  function buildWaText(){
    const lines = CART.map(it => {
      const subU = it.precio_usd * it.cantidad;
      const subB = it.precio_bs  * it.cantidad;
      return `• ${it.nombre}${it.presentacion?` (${it.presentacion})`:''} — ${fmt2(it.cantidad)} ${it.unidad || ''}\n  Precio: US$ ${fmt2(it.precio_usd)} · Bs ${fmt2(it.precio_bs)}  |  Subt.: US$ ${fmt2(subU)} · Bs ${fmt2(subB)}`;
    });
    const t = totals();
    return [
      `Hola, quiero cotizar los siguientes productos de NEW CHEM AGROQUÍMICOS:`,
      ...lines,
      ``,
      `TOTAL: US$ ${fmt2(t.usd)} · Bs ${fmt2(t.bs)} (TC ${fmt2(RATE)})`
    ].join('\n');
  }

  function trySend(){
    const t = totals();
    if (t.usd < MIN_ORDER_USD){
      alert('La compra mínima es de US$ 3.000.');
      return;
    }
    const txt = buildWaText();
    if (WA_NUMBER) window.location.href = `https://wa.me/${WA_NUMBER}?text=${encodeURIComponent(txt)}`;
    else           window.location.href = `https://wa.me/?text=${encodeURIComponent(txt)}`;
  }

  sendEl.addEventListener('click', trySend);
  sendM.addEventListener('click', trySend);

  /* ===================== Init ===================== */
  (async function init(){
    try{
      const r = await fetch(JSON_URL, { cache: 'no-store' });
      if(!r.ok) throw new Error('HTTP '+r.status);
      const { items=[], rate=6.96 } = await r.json();

      // Adaptar datos del API /api/catalog -> tarjetas (con variantes por presentación)
      // items esperado: [{ nombre, categoria, presentaciones:[...], unidad, precio_usd, precio_bs, imagen? }]
      // Si ya viene con {variantes:[]}, lo respetamos.
      ALL = items.map(it=>{
        if (Array.isArray(it.variantes)) return it;
        // convertir del formato plano sku -> variantes
        const presentaciones = it.presentaciones || it.presentacion || it.pres || [];
        const v = Array.isArray(presentaciones) && presentaciones.length
          ? presentaciones.map(p => ({
              presentacion: p,
              unidad: it.unidad || '',
              precio_usd: num(it.precio_usd),
              precio_bs : num(it.precio_bs)
            }))
          : [{
              presentacion: it.presentacion || '',
              unidad: it.unidad || '',
              precio_usd: num(it.precio_usd),
              precio_bs : num(it.precio_bs)
            }];
        return {
          nombre: it.nombre || it.sku || '',
          categoria: it.categoria || it.tipo || '',
          variantes: v,
          imagen: it.imagen
        };
      });

      RATE = Number(rate) || 6.96;
      tcEl.textContent = `TC ${fmt2(RATE)}`;

      renderSections();
      updateCart();
    }catch(e){
      console.error(e);
      secEl.innerHTML = `<div class="empty">Error al cargar catálogo.</div>`;
      cartEl.innerHTML = `<div class="empty">Tu carrito está vacío.</div>`;
      totalsEl.innerHTML = '';
      sendEl.disabled = true;
      sendM.disabled  = true;
    }
  })();
})();
