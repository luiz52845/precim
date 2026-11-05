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

// ---------- login ----------
function showLogin() {
  $('#app').hidden = true;
  $('#login-screen').hidden = false;
  $('#login-form').elements.password.focus();
}

function showApp() {
  $('#login-screen').hidden = true;
  $('#app').hidden = false;
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

let state = { watches: [], stores: [], settings: null };

// ---------- abas ----------
document.querySelectorAll('.tab').forEach((btn) =>
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    for (const t of ['produtos', 'alertas', 'config']) $(`#tab-${t}`).hidden = t !== btn.dataset.tab;
    if (btn.dataset.tab === 'alertas') loadAlerts();
    if (btn.dataset.tab === 'config') fillSettings();
  }),
);

// ---------- produtos ----------

/** Preço usado na comparação: total ou por unidade (mesma regra do servidor). */
const effPrice = (w, o) => (w.compareUnitPrice && o.units > 1 ? o.price / o.units : o.price);

/** " · 4 un. · R$ 70,00/un." para kits. */
const unitInfo = (o) =>
  o.units > 1 ? ` <span class="unit">${o.units} un. · ${brl(o.price / o.units)}/un.</span>` : '';

const badgesHtml = (o) =>
  o.badges?.length
    ? `<div class="badges">${o.badges
        .map((b) => `<span class="badge ${b.startsWith('-') ? 'good' : ''}">${esc(b)}</span>`)
        .join(' ')}</div>`
    : '';

async function refresh() {
  state = await api('/state');
  renderWatches();
  $('#btn-logout').hidden = !state.authEnabled;
}

function renderWatches() {
  const list = $('#watch-list');
  $('#empty').hidden = state.watches.length > 0;
  list.innerHTML = state.watches
    .map((w) => {
      const best = w.best;
      const hit = best && w.targetPrice && effPrice(w, best) <= w.targetPrice;
      const where = [w.query ? `busca “${esc(w.query)}” em ${w.stores.length} loja(s)` : '', w.urls.length ? `${w.urls.length} link(s)` : '']
        .filter(Boolean)
        .join(' + ');
      return `
      <article class="card ${w.active ? '' : 'inactive'}" data-id="${w.id}">
        <h3>${esc(w.name)}</h3>
        <div class="muted">${where}</div>
        <div class="price">${brl(best?.price)}${best ? unitInfo(best) : ''}</div>
        ${best ? `<div class="best-title" title="${esc(best.title)}"><a href="${esc(best.url)}" target="_blank" rel="noopener">${esc(best.store)} · ${esc(best.title)}</a></div>` : ''}
        ${best ? badgesHtml(best) : ''}
        <div>
          ${w.targetPrice ? `<span class="badge ${hit ? 'good' : ''}">alvo ${brl(w.targetPrice)}${w.compareUnitPrice ? '/un.' : ''}</span>` : ''}
          ${w.compareUnitPrice ? '<span class="badge">por unidade</span>' : ''}
          ${w.dropPercent ? `<span class="badge">queda ≥ ${w.dropPercent}%</span>` : ''}
          ${w.active ? '' : '<span class="badge">pausado</span>'}
        </div>
        <div class="muted">Verificado: ${when(w.lastCheckAt)}</div>
        ${w.lastError ? `<div class="error-box">⚠ ${esc(w.lastError)}</div>` : ''}
        <div class="actions">
          <button class="small" data-act="detail">Ver ofertas</button>
          <button class="small" data-act="check">Verificar</button>
          <button class="small" data-act="edit">Editar</button>
          <button class="small danger" data-act="delete">Excluir</button>
        </div>
      </article>`;
    })
    .join('');
}

$('#watch-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('.card').dataset.id;
  const watch = state.watches.find((w) => w.id === id);
  const act = btn.dataset.act;

  if (act === 'edit') return openWatchForm(watch);
  if (act === 'detail') return openDetail(id);
  if (act === 'delete') {
    // confirm() pode ser bloqueado em alguns contextos; usa confirmação no próprio botão.
    if (btn.dataset.confirm !== '1') {
      btn.dataset.confirm = '1';
      btn.textContent = 'Confirmar exclusão';
      setTimeout(() => { btn.dataset.confirm = ''; btn.textContent = 'Excluir'; }, 3000);
      return;
    }
    await api(`/watches/${id}`, { method: 'DELETE' });
    return refresh();
  }
  if (act === 'check') {
    btn.disabled = true;
    btn.textContent = 'Verificando…';
    try {
      await api(`/watches/${id}/check`, { method: 'POST' });
    } catch (err) {
      alertError(err);
    }
    await refresh();
  }
});

$('#btn-check-all').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Verificando…';
  try {
    const r = await api('/check-all', { method: 'POST' });
    const alerts = r.checked.reduce((n, c) => n + c.alerts, 0);
    $('#status').textContent =
      `${r.checked.length} produto(s) verificado(s), ${alerts} alerta(s)` +
      (r.pending ? `. Faltaram ${r.pending} (limite de tempo): clique de novo.` : '.');
  } catch (err) {
    alertError(err);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Verificar todos agora';
  }
  await refresh();
});

// ---------- formulário de produto ----------
const watchDialog = $('#watch-dialog');
const watchForm = $('#watch-form');
let editingId = null;

function openWatchForm(watch) {
  editingId = watch?.id ?? null;
  $('#watch-form-title').textContent = watch ? 'Editar produto' : 'Adicionar produto';
  $('#watch-msg').textContent = '';
  $('#store-checks').innerHTML = state.stores
    .map(
      (s) => `<label class="check"><input type="checkbox" name="store" value="${s.id}"
        ${!watch || watch.stores.includes(s.id) ? 'checked' : ''}/> ${esc(s.label)}</label>`,
    )
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
  watchDialog.showModal();
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
  btn.textContent = editingId ? 'Salvando…' : 'Buscando preços…';
  try {
    if (editingId) await api(`/watches/${editingId}`, { method: 'PUT', body });
    else await api('/watches', { method: 'POST', body });
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

// ---------- detalhes ----------
async function openDetail(id) {
  const { watch, report, history, alerts } = await api(`/watches/${id}`);
  const offers = report?.offers;
  $('#detail').innerHTML = `
    <h2>${esc(watch.name)}</h2>
    <h3 class="muted">Histórico do menor preço${watch.compareUnitPrice ? ' (por unidade)' : ''}</h3>
    ${chart(history, watch.targetPrice)}
    <h3 class="muted">Ofertas da última verificação ${report ? `(${when(report.at)})` : ''}</h3>
    ${
      report
        ? `<p class="muted">${report.sources
            .map((s) => `${esc(s.source)}: ${s.error ? `⚠ ${esc(s.error)}` : `${s.relevant} de ${s.found} resultados relevantes`}`)
            .join(' · ')}</p>`
        : ''
    }
    ${
      offers
        ? offers.length
          ? `<div class="table-wrap"><table>
              <thead><tr><th></th><th>Produto</th><th>Loja</th><th class="num">Preço</th></tr></thead>
              <tbody>${offers
                .map(
                  (o) => `<tr>
                  <td>${o.image ? `<img src="${esc(o.image)}" alt="" loading="lazy">` : ''}</td>
                  <td><a href="${esc(o.url)}" target="_blank" rel="noopener">${esc(o.title)}</a>${badgesHtml(o)}</td>
                  <td>${esc(o.store)}</td>
                  <td class="num"><b>${brl(o.price)}</b>${o.oldPrice > o.price ? `<br><s>${brl(o.oldPrice)}</s>` : ''}${
                    o.units > 1 ? `<br><span class="unit">${brl(o.price / o.units)}/un.</span>` : ''
                  }</td>
                </tr>`,
                )
                .join('')}</tbody></table></div>`
          : '<p class="muted">Nenhum resultado passou pelos filtros. Revise o termo de busca e as palavras obrigatórias/excluídas.</p>'
        : '<p class="muted">Clique em “Verificar” para buscar as ofertas atuais.</p>'
    }
    ${
      alerts.length
        ? `<h3 class="muted">Alertas recentes</h3>${alerts.map(alertHtml).join('')}`
        : ''
    }`;
  $('#detail-dialog').showModal();
}
$('#btn-close-detail').addEventListener('click', () => $('#detail-dialog').close());

function chart(history, target) {
  if (history.length < 2) return '<p class="muted">O gráfico aparece depois de algumas verificações.</p>';
  const W = 800, H = 160, P = { l: 70, r: 10, t: 10, b: 22 };
  const xs = history.map((h) => Date.parse(h.at));
  const ys = history.map((h) => h.price);
  const lo = Math.min(...ys, target ?? Infinity) * 0.97;
  const hi = Math.max(...ys) * 1.03;
  const x = (t) => P.l + ((t - xs[0]) / (xs.at(-1) - xs[0] || 1)) * (W - P.l - P.r);
  const y = (v) => P.t + (1 - (v - lo) / (hi - lo || 1)) * (H - P.t - P.b);
  const pts = history.map((h, i) => `${x(xs[i]).toFixed(1)},${y(ys[i]).toFixed(1)}`).join(' ');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Histórico de preço">
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
    <b>${esc(a.watchName ?? '')}</b> ${brl(a.offer.price)} — ${esc(a.offer.store)} · <span class="muted">${when(a.at)}</span><br>
    <a href="${esc(a.offer.url)}" target="_blank" rel="noopener">${esc(a.offer.title)}</a><br>
    <span class="muted">${esc(a.reason)}</span>
    ${a.sent.length ? `<span class="badge good">enviado: ${a.sent.join(', ')}</span>` : ''}
    ${a.errors.length ? `<div class="error-box">⚠ ${a.errors.map(esc).join('<br>')}</div>` : ''}
  </div>`;
}

async function loadAlerts() {
  const alerts = await api('/alerts');
  $('#alert-list').innerHTML = alerts.length
    ? alerts.map(alertHtml).join('')
    : '<p class="empty">Nenhum alerta ainda. Eles aparecem aqui quando um preço atinge o alvo.</p>';
}

// ---------- configurações ----------
const settingsForm = $('#settings-form');

function fillSettings() {
  const s = state.settings;
  const f = settingsForm.elements;
  f.intervalMinutes.value = s.intervalMinutes;
  f['telegram.enabled'].checked = s.telegram.enabled;
  f['telegram.botToken'].value = s.telegram.botToken;
  f['telegram.chatId'].value = s.telegram.chatId;
  f['whatsapp.enabled'].checked = s.whatsapp.enabled;
  f['whatsapp.phone'].value = s.whatsapp.phone;
  f['whatsapp.apiKey'].value = s.whatsapp.apiKey;
  f['affiliate.mlParams'].value = s.affiliate?.mlParams ?? '';
  $('#schedule-info').textContent = state.scheduleInfo;
  renderMl();
  setMsg('');
}

function renderMl() {
  $("#ml-box").innerHTML = state.ml.configured
    ? "<p class=\"msg ok\">✔ Mercado Livre configurado. Marque a loja ao adicionar um produto.</p>"
    : "<p class=\"hint\">Defina <code>ML_CLIENT_ID</code> e <code>ML_CLIENT_SECRET</code> nas variáveis de ambiente (Dev Center do Mercado Livre) e faça um novo deploy.</p>";
}

function readSettings() {
  const f = settingsForm.elements;
  return {
    intervalMinutes: Number(f.intervalMinutes.value),
    telegram: { enabled: f['telegram.enabled'].checked, botToken: f['telegram.botToken'].value, chatId: f['telegram.chatId'].value },
    whatsapp: { enabled: f['whatsapp.enabled'].checked, phone: f['whatsapp.phone'].value, apiKey: f['whatsapp.apiKey'].value },
    affiliate: { mlParams: f['affiliate.mlParams'].value },
  };
}

const setMsg = (text, kind = '') => {
  $('#settings-msg').textContent = text;
  $('#settings-msg').className = `msg ${kind}`;
};

settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/settings', { method: 'PUT', body: readSettings() });
    await refresh();
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

function alertError(err) {
  $('#status').textContent = `Erro: ${err.message}`;
}

async function start() {
  const session = await api('/session');
  if (!session.loggedIn) return showLogin();
  showApp();
  await refresh();
}

start().catch(alertError);
setInterval(() => {
  if (!$('#app').hidden) refresh().catch(() => {});
}, 60_000);
