// public/catalog.js
(function(){
  const root = document.documentElement;
  const JSON_URL = root.getAttribute('data-json-url') || '/api/catalog';
  const WA_NUMBER = (root.getAttribute('data-wa-number') || '').replace(/[^\d]/g,''); // 5917xxxxxx

  const $ = s => document.querySelector(s);
  const listEl = $('#list');
  const cartEl = $('#cart');
  const qEl = $('#q');
  const catEl = $('#cat');
  const sendEl = $('#send');

  let ALL = [];
  let CART = []; // { nombre, presentacion, cantidad }

  function esc(s){ return String(s ?? '').replace(/[&<>"]/g,m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[m])); }
  function norm(s){ return String(s||'').toLowerCase(); }

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
      const presOpts = (item.presentaciones || []).map(p => `<option>${esc(p)}</option>`).join('') || `<option value="">—</option>`;
      return `
        <div class="prod" data-name="${esc(item.nombre)}">
          <div class="name">
            ${esc(item.nombre)}
            <div class="pill">${esc(item.categoria || '')}</div>
          </div>
          <div><select class="pres">${presOpts}</select></div>
          <div><input class="qty" placeholder="Cant. (L/Kg/u)" /></div>
          <div><button class="btn add">Añadir</button></div>
        </div>`;
    }).join('');

    // bind
    listEl.querySelectorAll('.add').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const row = btn.closest('.prod');
        const nombre = row.getAttribute('data-name');
        const pres = row.querySelector('.pres')?.value || '';
        const qty  = (row.querySelector('.qty')?.value || '').trim();
        if (!nombre) return;
        if (!qty) { row.querySelector('.qty')?.focus(); return; }
        upsertCart({ nombre, presentacion: pres, cantidad: qty });
      });
    });
  }

  function upsertCart(item){
    const ix = CART.findIndex(x => x.nombre === item.nombre && x.presentacion === item.presentacion);
    if (ix >= 0) CART[ix].cantidad = item.cantidad;
    else CART.push(item);
    renderCart();
  }

  function rmFromCart(idx){
    CART.splice(idx,1);
    renderCart();
  }

  function renderCart(){
    if (!CART.length){
      cartEl.innerHTML = `<div class="empty">Tu carrito está vacío.</div>`;
      sendEl.disabled = true;
      return;
    }
    sendEl.disabled = false;
    cartEl.innerHTML = CART.map((it,i)=>`
      <div class="item">
        <div>${esc(it.nombre)} ${it.presentacion?`<span class="pill">${esc(it.presentacion)}</span>`:''}</div>
        <div class="pill" style="text-align:right">${esc(it.cantidad)}</div>
        <div><button class="rm" data-i="${i}">×</button></div>
      </div>
    `).join('');
    cartEl.querySelectorAll('.rm').forEach(b=> b.addEventListener('click',()=> rmFromCart(+b.getAttribute('data-i'))));
  }

  function buildWaText(){
    const lines = CART.map(it => `• ${it.nombre}${it.presentacion?` (${it.presentacion})`:''} — ${it.cantidad}`);
    const body = [
      `Hola, quiero cotizar los siguientes productos:`,
      ...lines
    ].join('\n');
    return body;
  }

  function goWhatsApp(){
    const txt = buildWaText();
    if (WA_NUMBER) {
      window.location.href = `https://wa.me/${WA_NUMBER}?text=${encodeURIComponent(txt)}`;
    } else {
      // sin número → solo compartir
      window.location.href = `https://wa.me/?text=${encodeURIComponent(txt)}`;
    }
  }

  qEl.addEventListener('input', renderList);
  catEl.addEventListener('change', renderList);
  sendEl.addEventListener('click', goWhatsApp);

  (async function init(){
    try{
      const r = await fetch(JSON_URL, { cache: 'no-store' });
      if(!r.ok) throw new Error('HTTP '+r.status);
      const { items=[] } = await r.json();
      ALL = items;
      if (!ALL.length) throw new Error('cat vacío');
      renderCats(ALL);
      renderList();
      renderCart();
    }catch(e){
      console.error(e);
      listEl.innerHTML = `
        <div class="empty">
          Error al cargar catálogo.<br>
          Revisa que /api/catalog responda y que /api/prices funcione.
        </div>`;
      cartEl.innerHTML = `<div class="empty">Tu carrito está vacío.</div>`;
      sendEl.disabled = true;
    }
  })();
})();
