(function(){
  const MIN_ORDER_USD = 3000;

  // Enviar SIEMPRE a este número
  const WA_NUMBER = '59162239865';

  const root      = document.documentElement;
  const JSON_URL  = root.getAttribute('data-json-url') || '/api/catalog';

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
  function toast(msg, ms=3000){
    toastEl.textContent = msg || 'Acción realizada';
    toastEl.classList.add('show');
    setTimeout(()=> toastEl.classList.remove('show'), ms);
  }

  // estado
  let ALL  = [];
  let RATE = 6.96;
  let CART = [];

  // utils
  const esc  = s => String(s ?? '').replace(/[&<>"]/g,m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[m]));
  const num  = v => {
    if (typeof v === 'number') return v;
    const m = String(v||'').replace(',', '.').match(/-?\d+(\.\d+)?/);
    return m ? Number(m[0]) : 0;
  };
  const fmt2 = n => (Number(n)||0).toFixed(2);
  const packFromPres = pres => {
    const m = String(pres||'').match(/(\d+(?:\.\d+)?)/);
    return m ? Number(m[1]) : 1;
  };
  const guessImagePath = name => `/image/${String(name||'').replace(/\s+/g,'').toUpperCase()}.png`;

  /* ===================== UI: secciones ===================== */
  function renderSections(){
    const cats = {};
    for (const it of ALL){
      const k = String(it.categoria||'').trim() || 'SIN CATEGORÍA';
      (cats[k] ||= []).push(it);
    }
    Object.values(cats).forEach(arr => arr.sort((a,b)=>a.nombre.localeCompare(b.nombre,'es')));

    secEl.innerHTML = Object.entries(cats).map(([cat, items])=>`
      <div class="section-block">
        <div class="section-title"><span class="dot"></span>${esc(cat)}</div>
        <div class="list">
          ${items.map(renderCard).join('')}
        </div>
      </div>`).join('');

    bindCards();
  }

  function renderCard(item){
    const v = item.variantes || [];
    const first = v[0] || { precio_usd:0, precio_bs:0, unidad:'', presentacion:'' };

    const opts = v.map((vx, i) =>
      `<option value="${i}" data-usd="${vx.precio_usd}" data-bs="${vx.precio_bs}" data-un="${esc(vx.unidad)}">${esc(vx.presentacion||'')}</option>`
    ).join('') || `<option value="">—</option>`;

    const usd0 = num(first.precio_usd);
    const bs0  = num(first.precio_bs) || +(usd0 * RATE).toFixed(2);
    const imgSrc = item.imagen || guessImagePath(item.nombre);

    return `
      <div class="prod" data-name="${esc(item.nombre)}">
        <div class="name">
          <div class="name">${esc(item.nombre)}</div>
          <div class="cat"><span class="tag">${esc(item.categoria||'')}</span></div>
        </div>
        <div class="img"><img src="${esc(imgSrc)}" alt="${esc(item.nombre)}" onerror="this.src='/image/placeholder.png'"></div>
        <div class="price-note">Precio unidad: <strong>US$ ${fmt2(usd0)}</strong> · <strong>Bs ${fmt2(bs0)}</strong></div>
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
      const btnWrap = row.querySelector('.btn-wrap');
      const name    = row.getAttribute('data-name');

      // auto-seleccionar primera presentación disponible
      selectFirstAvailable();

      function getData(){
        const p = ALL.find(x=>x.nombre===name);
        const v = p?.variantes?.[num(presSel.value)] || { precio_usd:0, precio_bs:0, unidad:'', presentacion:'' };
        return { p, v };
      }
      function isAvailable(v){
        return (num(v.precio_usd) > 0) || (num(v.precio_bs) > 0);
      }

      function updatePriceAndState(showToastIfUnavailable=false){
        const { v } = getData();
        const usd = num(v.precio_usd);
        const bs  = num(v.precio_bs) || +(usd * RATE).toFixed(2);

        const qn = num(qtyEl.value);
        subtEl.textContent = `US$ ${fmt2(usd*qn)} · Bs ${fmt2(bs*qn)}`;

        const pn = row.querySelector('.price-note');
        pn.innerHTML = `Precio unidad: <strong>US$ ${fmt2(usd)}</strong> · <strong>Bs ${fmt2(bs)}</strong>`;

        const available = isAvailable(v);
        addBtn.disabled = !available;
        if (!available && showToastIfUnavailable){
          toast('En estos momentos no tenemos disponible esta presentación');
        }

        const pack = packFromPres(v.presentacion);
        qtyEl.placeholder = pack > 1 ? `Cantidad (múltiplos de ${pack})` : 'Cantidad';
      }

      function selectFirstAvailable(){
        const p = ALL.find(x=>x.nombre===name);
        if (!p || !Array.isArray(p.variantes)) return;
        const idxOk = p.variantes.findIndex(v => isAvailable(v));
        if (idxOk >= 0) presSel.value = String(idxOk);
        updatePriceAndState(false);
      }

      presSel.addEventListener('change', ()=> updatePriceAndState(true));
      qtyEl.addEventListener('input', ()=>{
        qtyEl.classList.remove('invalid');
        updatePriceAndState(false);
      });
      btnWrap.addEventListener('click', (e)=>{
        if (addBtn.disabled){
          e.preventDefault();
          toast('Este producto no está disponible en este momento');
        }
      });

      addBtn.addEventListener('click', ()=>{
        const { p, v } = getData();
        const cantidad = num(qtyEl.value);
        if (!isAvailable(v)) { toast('Este producto no está disponible en este momento'); return; }
        if (!cantidad){ qtyEl.focus(); return; }

        const pack = packFromPres(v.presentacion);
        if (pack > 0 && cantidad % pack !== 0){
          qtyEl.classList.add('invalid');
          toast(`La cantidad debe ser múltiplo de ${pack}`);
          return;
        }

        upsertCart({
          nombre: p.nombre,
          presentacion: v.presentacion || '',
          unidad: v.unidad || '',
          cantidad,
          precio_usd: num(v.precio_usd) || 0,
          precio_bs:  num(v.precio_bs)  || +((num(v.precio_usd)||0) * RATE).toFixed(2),
          pack
        });

        qtyEl.value = '';
        updateCart();
        toast('Se añadió a tu carrito', 1300);
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
  const totals = () => ({
    usd: CART.reduce((a,x)=> a + x.precio_usd * x.cantidad, 0),
    bs : CART.reduce((a,x)=> a + x.precio_bs  * x.cantidad, 0)
  });

  function updateCart(){
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
              <strong>${esc(it.nombre)}</strong> ${it.presentacion?`<span class="pill">${esc(it.presentacion)}</span>`:''}
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
          const v = num(inp.value);
          CART[i].cantidad = v;
          const pack = CART[i].pack || packFromPres(CART[i].presentacion);
          if (pack > 0 && v % pack !== 0){ inp.classList.add('invalid'); } else { inp.classList.remove('invalid'); }
          paintTotals();
        });
      });

      paintTotals();
    }

    // modal (móvil): clona el mismo HTML (misma grilla; en CSS se permite nombre completo)
    cartM.innerHTML = cartEl.innerHTML || `<div class="empty">Tu carrito está vacío.</div>`;
    totalsM.innerHTML = totalsEl.innerHTML || '';
    cartM.querySelectorAll('.rm').forEach(b=> b.addEventListener('click',()=> removeAt(+b.getAttribute('data-i'))));
    cartM.querySelectorAll('.qcart').forEach(inp=>{
      inp.addEventListener('input', ()=>{
        const i = +inp.getAttribute('data-i');
        const v = num(inp.value);
        CART[i].cantidad = v;
        const pack = CART[i].pack || packFromPres(CART[i].presentacion);
        if (pack > 0 && v % pack !== 0){ inp.classList.add('invalid'); } else { inp.classList.remove('invalid'); }
        updateCart();
      });
    });

    // badge
    const count = CART.reduce((a,x)=> a + (num(x.cantidad) ? 1 : 0), 0);
    cartBadge.style.display = count>0 ? 'inline-block' : 'none';
    if (count>0) cartBadge.textContent = String(count);

    // habilitar / deshabilitar CTA por mínimo
    const t = totals();
    const okMin = t.usd >= MIN_ORDER_USD;
    sendEl.disabled = !okMin || CART.length===0;
    sendM.disabled  = !okMin || CART.length===0;
  }

  function paintTotals(){
    const t = totals();
    totalsEl.innerHTML = `Total: US$ ${fmt2(t.usd)} · Bs ${fmt2(t.bs)}<br><span class="muted">TC ${fmt2(RATE)}</span>`;
  }


function buildWaText() {
  const lines = CART.map(it => {
    const cant   = fmt2(it.cantidad);
    const unidad = it.unidad ? ` ${it.unidad}` : '';
    const pres   = it.presentacion ? ` (${it.presentacion})` : '';
    const subtotal = (it.subtotal_usd != null)
      ? Number(it.subtotal_usd)
      : (it.precio_usd != null ? Number(it.precio_usd) * Number(it.cantidad || 0) : null);
    const subTxt = (subtotal != null) ? ` — SUBTOTAL: $${fmt2(subtotal)}` : '';
    return `* ${it.nombre}${pres} — ${cant}${unidad}${subTxt}`;
  });

  const t = totals(); 
  return [
    'CARRITO NEW CHEM',
    ...lines,
    `TOTAL_USD: ${fmt2(t.usd)}`,
    `TOTAL_BS: ${fmt2(t.bs)}`
    // (sin TC)
  ].join('\n');
}



  function trySend(){
    const t = totals();
    if (t.usd < MIN_ORDER_USD){
      toast('La compra mínima es de 3000$');
      return;
    }
    const txt = buildWaText();

    // limpiar el carrito ANTES de redirigir (para no ocupar memoria)
    const url = `https://wa.me/${WA_NUMBER}?text=${encodeURIComponent(txt)}`;
    CART = [];
    updateCart();
    modal.classList.remove('show');

    // redirigir a WhatsApp
    window.location.href = url;
  }
  sendEl.addEventListener('click', trySend);
  sendM.addEventListener('click', trySend);

  /* ===================== Init ===================== */
  (async function init(){
    try{
      const r = await fetch(JSON_URL, { cache: 'no-store' });
      if(!r.ok) throw new Error('HTTP '+r.status);
      const { items=[], rate=6.96 } = await r.json();

      // normaliza items al formato con variantes
      ALL = items.map(it=>{
        if (Array.isArray(it.variantes)) return it;
        const v = [{
          presentacion: it.presentacion || it.pres || '',
          unidad: it.unidad || '',
          precio_usd: num(it.precio_usd),
          precio_bs : num(it.precio_bs)
        }];
        return {
          nombre: it.nombre || it.sku || '',
          categoria: it.categoria || it.tipo || '',
          variantes: v,
          imagen: it.imagen || null
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
