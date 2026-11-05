// Interface do Precim (JavaScript puro, sem build).
const $ = (sel, root = document) => root.querySelector(sel);
const brl = (n) => (n == null ? '—' : n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
const when = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : 'nunca');
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    ...opts,
    headers: { 'content-type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.needsLogin) showLogin();
  if (!res.ok) throw new Error(data.error || `Erro HTTP ${res.status}`);
  return data;
}

let state = { watches: [], stores: [], settings: null };
const setStatus = (text) => ($('#status').textContent = text);

// ---------- login ----------
function showLogin() {
  $('#app').hidden = true;
  $('#login-screen').hidden = false;
  $('#login-form').elements.password.focus();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#login-msg');
  try {
    await api('/login', { method: 'POST', body: { password: e.target.elements.password.value } });
    e.target.reset();
    msg.textContent = '';
    await start();
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'msg error';
  }
});

$('#btn-logout').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' });
  showLogin();
});

// ---------- abas ----------
function openTab(name) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  for (const t of ['produtos', 'alertas', 'config']) $(`#tab-${t}`).hidden = t !== name;
  if (name === 'alertas') loadAlerts();
  if (name === 'config') fillSettings();
}
document.querySelectorAll('.tab').forEach((btn) => btn.addEventListener('click', () => openTab(btn.dataset.tab)));

// ---------- peças reutilizadas ----------

/** Preço usado na comparação: total ou por unidade (mesma regra do servidor). */
const effPrice = (w, o) => (w.compareUnitPrice && o.units > 1 ? o.price / o.units : o.price);
const unitLine = (o) => (o.units > 1 ? `<span class="unit">${o.units} un. · ${brl(o.price / o.units)}/un.</span>` : '');
const thumb = (o) =>
  o?.image ? `<img class="thumb" src="${esc(o.image)}" alt="" loading="lazy">` : '<span class="thumb empty-thumb">🛒</span>';
const tags = (list) => (list.length ? `<div class="tags">${list.join('')}</div>` : '');
const offerBadges = (o) =>
  (o.badges ?? []).map((b) => `<span class="badge ${b.startsWith('-') ? 'good' : ''}">${esc(b)}</span>`);

/** Oferta do Mercado Livre? (só elas têm link de afiliado) */
const isMl = (o) => o.hasAffiliateLink !== undefined;
const pendingText = () =>
  state.generator?.local
    ? 'Link de afiliado pendente: clique em ↻ Atualizar ofertas'
    : 'Link de afiliado pendente: gere no Precim do seu PC';

/** Campo com o link (de afiliado, quando houver) e botão Copiar. */
function linkBox(o) {
  if (isMl(o) && o.affiliateBlocked) {
    return `<div class="pending">Este produto não participa do programa de afiliados do Mercado Livre.</div>
      <div class="linkbox">
        <input readonly value="${esc(o.url)}" aria-label="Link comum" onclick="this.select()">
        <button data-copy="${esc(o.url)}">Copiar link comum</button>
      </div>`;
  }
  if (isMl(o) && !o.hasAffiliateLink) return `<div class="pending">${pendingText()}</div>`;
  return `<div class="linkbox">
    <input readonly value="${esc(o.url)}" aria-label="Link" onclick="this.select()">
    <button class="primary" data-copy="${esc(o.url)}">Copiar</button>
  </div>`;
}

// Botões "Copiar": copiam o link (já com o afiliado).
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  const old = btn.textContent;
  try {
    await navigator.clipboard.writeText(btn.dataset.copy);
    btn.textContent = 'Copiado!';
  } catch {
    window.prompt('Copie o link:', btn.dataset.copy);
  }
  setTimeout(() => (btn.textContent = old), 1500);
});

// ---------- produtos ----------
async function refresh() {
  state = await api('/state');
  renderWatches();
  $('#btn-logout').hidden = !state.authEnabled;
}

function renderWatches() {
  $('#empty').hidden = state.watches.length > 0;
  $('#watch-list').innerHTML = state.watches.map(cardHtml).join('');
}

function cardHtml(w) {
  const best = w.best;
  const hit = best && w.targetPrice && effPrice(w, best) <= w.targetPrice;
  const body = best
    ? `${tags([hit ? '<span class="badge good">🎯 no preço alvo</span>' : '', ...offerBadges(best)].filter(Boolean))}
       ${linkBox(best)}`
    : `<div class="${w.failed ? 'warn' : 'pending'}">${
        w.failed ? 'Nenhuma loja respondeu na última busca. Tente ↻ Atualizar ofertas.' : 'Ainda sem ofertas: clique em ↻ Atualizar ofertas.'
      }</div>`;
  return `
    <article class="card ${w.active ? '' : 'inactive'}" data-id="${w.id}">
      <div class="card-head">
        ${thumb(best)}
        <div>
          <h3>${esc(w.name)}</h3>
          ${best ? `<div class="offer-title" title="${esc(best.title)}">${esc(best.store)} · ${esc(best.title)}</div>` : ''}
        </div>
        <div class="price">${brl(best?.price)}${best ? unitLine(best) : ''}</div>
      </div>
      ${body}
      <div class="card-foot">
        <button class="link" data-act="detail">Ofertas${w.offersCount ? ` (${w.offersCount})` : ''}</button>
        <button class="link" data-act="edit">Editar</button>
        <button class="link danger" data-act="delete">Excluir</button>
      </div>
    </article>`;
}

$('#watch-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('.card').dataset.id;
  const act = btn.dataset.act;
  if (act === 'edit') return openWatchForm(state.watches.find((w) => w.id === id));
  if (act === 'detail') return openDetail(id);
  if (act === 'delete') {
    // Confirmação no próprio botão (sem janelas do navegador).
    if (btn.dataset.confirm !== '1') {
      btn.dataset.confirm = '1';
      btn.textContent = 'Clique de novo para excluir';
      setTimeout(() => {
        btn.dataset.confirm = '';
        btn.textContent = 'Excluir';
      }, 3000);
      return;
    }
    await api(`/watches/${id}`, { method: 'DELETE' });
    await refresh();
  }
});

/**
 * Botão principal: busca as ofertas de todos os produtos e, no seu PC (com a sessão do
 * Mercado Livre configurada), gera em seguida os links de afiliado que faltam.
 */
$('#btn-update').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  const summary = [];
  try {
    setStatus('Buscando ofertas…');
    const r = await api('/check-all', { method: 'POST' });
    summary.push(`${r.checked.length} produto(s) atualizado(s)`);
    if (r.pending) summary.push(`${r.pending} ficaram para depois (clique de novo)`);
    await refresh();

    const pending = state.watches.reduce((n, w) => n + (w.pendingLinks || 0), 0);
    if (pending && state.generator?.local) {
      if (!state.generator.cookies?.configured) {
        summary.push(`${pending} link(s) pendente(s): configure a sessão do Mercado Livre em Configurações`);
      } else {
        setStatus(`Gerando ${pending} link(s) de afiliado… (cerca de ${Math.ceil((pending * 3) / 60)} min)`);
        const g = await api('/affiliate/generate', { method: 'POST' });
        summary.push(`${g.generated.length} link(s) de afiliado gerado(s)`);
        if (g.blocked?.length) summary.push(`${g.blocked.length} produto(s) fora do programa de afiliados`);
        if (g.failed.length) summary.push(`${g.failed.length} falha(s): ${g.failed[0].error}`);
        if (g.stopped) summary.push(`parado: ${g.stopped}`);
      }
    }
    setStatus(summary.join(' · '));
  } catch (err) {
    setStatus(`Erro: ${err.message}`);
  } finally {
    btn.disabled = false;
    await refresh().catch(() => {});
  }
});

// ---------- adicionar / editar produto ----------
const watchDialog = $('#watch-dialog');
const watchForm = $('#watch-form');
let editingId = null;

function openWatchForm(watch) {
  editingId = watch?.id ?? null;
  $('#watch-form-title').textContent = watch ? 'Editar produto' : 'Adicionar produto';
  $('#watch-msg').textContent = '';
  // Produto novo: só o Mercado Livre marcado (é onde sai o link de afiliado).
  const checked = (id) => (watch ? watch.stores.includes(id) : id === 'mercadolivre' || !state.ml.configured);
  $('#store-checks').innerHTML = state.stores
    .map((s) => `<label class="check"><input type="checkbox" name="store" value="${s.id}" ${checked(s.id) ? 'checked' : ''}/> ${esc(s.label)}</label>`)
    .join('');
  const f = watchForm.elements;
  f.name.value = watch?.name ?? '';
  f.query.value = watch?.query ?? '';
  f.urls.value = (watch?.urls ?? []).join('\n');
  f.requiredWords.value = (watch?.requiredWords ?? []).join(', ');
  f.excludeWords.value = (watch?.excludeWords ?? ['capa', 'película', 'case', 'usado', 'recondicionado']).join(', ');
  for (const k of ['minPrice', 'maxPrice', 'targetPrice', 'dropPercent']) f[k].value = watch?.[k] ?? '';
  f.compareUnitPrice.checked = Boolean(watch?.compareUnitPrice);
  f.active.checked = watch?.active ?? true;
  watchForm.querySelector('details').open = Boolean(
    watch && (watch.requiredWords.length || watch.urls.length || watch.minPrice || watch.maxPrice || watch.dropPercent || !watch.active),
  );
  watchDialog.showModal();
  f.query.focus();
}

$('#btn-new').addEventListener('click', () => openWatchForm(null));
$('#btn-cancel').addEventListener('click', () => watchDialog.close());

watchForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = watchForm.elements;
  const body = {
    name: f.name.value,
    query: f.query.value,
    stores: [...watchForm.querySelectorAll('input[name=store]:checked')].map((i) => i.value),
    urls: f.urls.value,
    requiredWords: f.requiredWords.value,
    excludeWords: f.excludeWords.value,
    minPrice: f.minPrice.value,
    maxPrice: f.maxPrice.value,
    targetPrice: f.targetPrice.value,
    dropPercent: f.dropPercent.value,
    compareUnitPrice: f.compareUnitPrice.checked,
    active: f.active.checked,
  };
  const btn = $('#btn-save');
  btn.disabled = true;
  btn.textContent = 'Buscando ofertas…';
  try {
    if (editingId) {
      await api(`/watches/${editingId}`, { method: 'PUT', body });
      await api(`/watches/${editingId}/check`, { method: 'POST' }); // já mostra o resultado com os filtros novos
    } else {
      await api('/watches', { method: 'POST', body });
    }
    watchDialog.close();
    await refresh();
  } catch (err) {
    $('#watch-msg').textContent = err.message;
    $('#watch-msg').className = 'msg error';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Salvar';
  }
});

// ---------- ofertas de um produto ----------
let detailId = null;

function offerAction(o) {
  if (!isMl(o) || o.hasAffiliateLink) return `<button class="primary" data-copy="${esc(o.url)}">Copiar link</button>`;
  if (o.affiliateBlocked) {
    return `<span class="muted">fora do programa de afiliados</span>
      <button data-copy="${esc(o.url)}">Copiar link comum</button>`;
  }
  // Sem link de afiliado: alternativa manual (gerar no site e colar aqui).
  return `<details class="manual">
    <summary class="muted">link pendente</summary>
    <a href="${esc(o.shareUrl)}" target="_blank" rel="noopener">Abrir no Mercado Livre ↗</a>
    <form class="paste" data-aff-form="${esc(o.rawUrl)}">
      <input name="link" placeholder="cole o meli.la" autocomplete="off">
      <button type="submit">Salvar</button>
    </form>
  </details>`;
}

async function openDetail(id) {
  detailId = id;
  const { watch, report, history } = await api(`/watches/${id}`);
  const offers = report?.offers ?? [];
  const errors = (report?.sources ?? []).filter((s) => s.error);
  $('#detail').innerHTML = `
    <h2>${esc(watch.name)}</h2>
    ${chart(history, watch.targetPrice)}
    ${errors.length ? `<div class="warn">${errors.map((s) => `${esc(s.source)}: ${esc(s.error)}`).join('<br>')}</div>` : ''}
    ${
      offers.length
        ? `<div class="offer-list">${offers
            .map(
              (o) => `<div class="offer-row">
                ${thumb(o)}
                <div>
                  <a class="title" href="${esc(o.url)}" target="_blank" rel="noopener">${esc(o.title)}</a>
                  <div class="muted">${esc(o.store)}</div>
                  ${tags(offerBadges(o))}
                </div>
                <div class="side">
                  <b>${brl(o.price)}</b>${unitLine(o)}
                  ${offerAction(o)}
                </div>
              </div>`,
            )
            .join('')}</div>`
        : `<p class="muted">${report ? 'Nenhuma oferta passou pelos filtros. Revise o produto em Editar.' : 'Ainda sem ofertas: clique em ↻ Atualizar ofertas.'}</p>`
    }
    ${report ? `<p class="muted">Atualizado em ${when(report.at)}</p>` : ''}`;
  if (!$('#detail-dialog').open) $('#detail-dialog').showModal();
}
$('#btn-close-detail').addEventListener('click', () => $('#detail-dialog').close());

$('#detail').addEventListener('submit', async (e) => {
  const form = e.target.closest('[data-aff-form]');
  if (!form) return;
  e.preventDefault();
  try {
    await api('/affiliate-links', { method: 'PUT', body: { productUrl: form.dataset.affForm, link: form.elements.link.value } });
    await openDetail(detailId);
    refresh().catch(() => {});
  } catch (err) {
    form.elements.link.setCustomValidity(err.message);
    form.elements.link.reportValidity();
    form.elements.link.addEventListener('input', () => form.elements.link.setCustomValidity(''), { once: true });
  }
});

function chart(history, target) {
  if (history.length < 2) return '';
  const W = 800, H = 120, P = { l: 70, r: 10, t: 8, b: 20 };
  const xs = history.map((h) => Date.parse(h.at));
  const ys = history.map((h) => h.price);
  const lo = Math.min(...ys, target ?? Infinity) * 0.97;
  const hi = Math.max(...ys) * 1.03;
  const x = (t) => P.l + ((t - xs[0]) / (xs.at(-1) - xs[0] || 1)) * (W - P.l - P.r);
  const y = (v) => P.t + (1 - (v - lo) / (hi - lo || 1)) * (H - P.t - P.b);
  const pts = history.map((h, i) => `${x(xs[i]).toFixed(1)},${y(ys[i]).toFixed(1)}`).join(' ');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Histórico do menor preço">
    <text x="4" y="${y(hi) + 10}">${brl(hi)}</text>
    <text x="4" y="${y(lo)}">${brl(lo)}</text>
    <text x="${P.l}" y="${H - 4}">${when(history[0].at)}</text>
    <text x="${W - P.r}" y="${H - 4}" text-anchor="end">${when(history.at(-1).at)}</text>
    ${target ? `<line class="target" x1="${P.l}" x2="${W - P.r}" y1="${y(target)}" y2="${y(target)}"/>` : ''}
    <polyline class="line" points="${pts}"/>
  </svg>`;
}

// ---------- alertas ----------
function alertHtml(a) {
  return `<div class="alert">
    <b>${esc(a.watchName ?? '')}</b> ${brl(a.offer.price)} · <span class="muted">${esc(a.offer.store)} · ${when(a.at)}</span><br>
    <a href="${esc(a.offer.url)}" target="_blank" rel="noopener">${esc(a.offer.title)}</a><br>
    <span class="muted">${esc(a.reason)}</span>
    ${a.sent.length ? `<span class="badge good">enviado: ${a.sent.join(', ')}</span>` : ''}
    ${a.errors.length ? `<div class="warn">${a.errors.map(esc).join('<br>')}</div>` : ''}
  </div>`;
}

async function loadAlerts() {
  const alerts = await api('/alerts');
  $('#alert-list').innerHTML = alerts.length
    ? alerts.map(alertHtml).join('')
    : '<p class="empty">Nenhum alerta ainda. Eles aparecem aqui quando um produto chega ao preço que você definiu.</p>';
}

// ---------- configurações ----------
const settingsForm = $('#settings-form');
const setMsg = (text, kind = '') => {
  $('#settings-msg').textContent = text;
  $('#settings-msg').className = `msg ${kind}`;
};

function fillSettings() {
  const s = state.settings;
  const f = settingsForm.elements;
  const aff = new URLSearchParams(s.affiliate?.mlParams ?? '');
  f.affiliateTag.value = aff.get('matt_word') ?? '';
  $('#affiliate-tool').textContent = aff.get('matt_tool')
    ? `Código da ferramenta de afiliado: ${aff.get('matt_tool')}.`
    : 'Dica: cole aqui um link de afiliado completo (com matt_tool=…) para salvar também o código da sua ferramenta.';
  f.intervalMinutes.value = s.intervalMinutes;
  f['telegram.enabled'].checked = s.telegram.enabled;
  f['telegram.botToken'].value = s.telegram.botToken;
  f['telegram.chatId'].value = s.telegram.chatId;
  f['whatsapp.enabled'].checked = s.whatsapp.enabled;
  f['whatsapp.phone'].value = s.whatsapp.phone;
  f['whatsapp.apiKey'].value = s.whatsapp.apiKey;
  $('#tg-state').textContent = s.telegram.enabled ? '· ativo' : '· desligado';
  $('#wa-state').textContent = s.whatsapp.enabled ? '· ativo' : '· desligado';
  $('#schedule-info').textContent = state.scheduleInfo;
  $('#ml-warning').innerHTML = state.ml.configured
    ? ''
    : '<div class="warn">Mercado Livre sem credenciais: defina ML_CLIENT_ID e ML_CLIENT_SECRET nas variáveis de ambiente.</div>';
  renderGenerator();
  setMsg('');
}

function renderGenerator() {
  const g = state.generator;
  if (!g?.local) {
    $('#gen-box').innerHTML =
      '<p class="hint">Os links de afiliado são gerados pelo Precim no seu PC (<code>npm start</code> → <code>localhost:3000</code>), onde fica a sua sessão do Mercado Livre.</p>';
    return;
  }
  $('#gen-box').innerHTML = `
    <p class="msg ${g.cookies.configured ? 'ok' : ''}">${
      g.cookies.configured
        ? `✔ Sessão do Mercado Livre salva neste PC (${when(g.cookies.savedAt)})`
        : 'Sessão do Mercado Livre não configurada: os links de afiliado não serão gerados.'
    }</p>
    <details ${g.cookies.configured ? '' : 'open'}>
      <summary>${g.cookies.configured ? 'Atualizar sessão' : 'Configurar sessão'}</summary>
      <p class="hint">
        1) Instale a extensão <b>Cookie-Editor</b> no Chrome.
        2) Abra <b>mercadolivre.com.br</b> logado na sua conta.
        3) 🧩 → <b>Cookie-Editor</b> → <b>Export</b> → <b>JSON</b>.
        4) Cole abaixo e salve. Fica só neste PC.
      </p>
      <textarea id="gen-cookies" rows="3" placeholder="cole aqui o JSON exportado"></textarea>
      <button type="button" id="btn-save-cookies">Salvar sessão</button>
    </details>`;
}

$('#gen-box').addEventListener('click', async (e) => {
  if (e.target.id !== 'btn-save-cookies') return;
  try {
    await api('/local/ml-cookies', { method: 'PUT', body: { cookies: $('#gen-cookies').value } });
    await refresh();
    renderGenerator();
    setMsg('Sessão do Mercado Livre salva.', 'ok');
  } catch (err) {
    setMsg(err.message, 'error');
  }
});

function readSettings() {
  const f = settingsForm.elements;
  return {
    intervalMinutes: Number(f.intervalMinutes.value),
    telegram: { enabled: f['telegram.enabled'].checked, botToken: f['telegram.botToken'].value, chatId: f['telegram.chatId'].value },
    whatsapp: { enabled: f['whatsapp.enabled'].checked, phone: f['whatsapp.phone'].value, apiKey: f['whatsapp.apiKey'].value },
    affiliate: { mlParams: f.affiliateTag.value },
  };
}

settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/settings', { method: 'PUT', body: readSettings() });
    await refresh();
    fillSettings();
    setMsg('Configurações salvas.', 'ok');
  } catch (err) {
    setMsg(err.message, 'error');
  }
});

$('#btn-test').addEventListener('click', async () => {
  try {
    await api('/settings', { method: 'PUT', body: readSettings() });
    setMsg('Enviando…');
    const r = await api('/notify/test', { method: 'POST' });
    const parts = [];
    if (r.sent.length) parts.push(`Enviado: ${r.sent.join(', ')}.`);
    if (r.errors.length) parts.push(r.errors.join(' | '));
    setMsg(parts.join(' '), r.errors.length ? 'error' : 'ok');
  } catch (err) {
    setMsg(err.message, 'error');
  }
});

$('#btn-find-chat').addEventListener('click', async () => {
  try {
    const chats = await api('/telegram/chats', { method: 'POST', body: { botToken: settingsForm.elements['telegram.botToken'].value } });
    if (!chats.length) return setMsg('Nenhuma conversa encontrada. Mande uma mensagem para o seu bot e tente de novo.', 'error');
    settingsForm.elements['telegram.chatId'].value = chats[0].id;
    setMsg(`Chat encontrado: ${chats.map((c) => `${c.name} (${c.id})`).join(', ')}. Clique em Salvar.`, 'ok');
  } catch (err) {
    setMsg(err.message, 'error');
  }
});

// ---------- início ----------
async function start() {
  const session = await api('/session');
  if (!session.loggedIn) return showLogin();
  $('#login-screen').hidden = true;
  $('#app').hidden = false;
  await refresh();
}

start().catch((err) => setStatus(`Erro: ${err.message}`));
setInterval(() => {
  if (!$('#app').hidden && !$('#btn-update').disabled) refresh().catch(() => {});
}, 60_000);
