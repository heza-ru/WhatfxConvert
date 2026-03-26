// ── State ──────────────────────────────────────────────────────────
const S = {
  items:          [],          // current session's items
  fileStore:      new Map(),   // id → File object
  convertedStore: new Map(),   // id → { printUrl, topics }
  tab:            'all',
  query:          '',
  sortKey:        'updatedAt',
  sortDir:        -1,
  page:           1,
  perPage:        100,
  file:           null,
  availTopics:    [],
  selectedTopics: new Set(),
};

// ── DOM ────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ── Utils ──────────────────────────────────────────────────────────
const esc = s => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
}

function statusBadge(item) {
  const s = item.conversionStatus;
  if (s === 'pending')    return `<span class="badge badge-pending">Pending</span>`;
  if (s === 'converting') return `<span class="badge badge-converting"><span class="spinner"></span> Converting…</span>`;
  if (s === 'done')       return `<span class="badge badge-done">✓ PDF Ready</span>`;
  if (s === 'error')      return `<span class="badge badge-error">✕ Failed</span>`;
  return '';
}

function rowActions(item) {
  const isDone     = item.conversionStatus === 'done' && S.convertedStore.has(item.id);
  const converting = item.conversionStatus === 'converting';
  const canRetry   = item.conversionStatus === 'error' && S.fileStore.has(item.id);

  const previewBtn = isDone ? `
    <button class="act-btn preview" title="Interactive Preview" onclick="openPreview('${item.id}')">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path d="M1 7s2.5-4.5 6-4.5S13 7 13 7s-2.5 4.5-6 4.5S1 7 1 7z" stroke="currentColor" stroke-width="1.3"/>
        <circle cx="7" cy="7" r="2" stroke="currentColor" stroke-width="1.3"/>
      </svg>
    </button>` : '';

  const convertBtn = (!converting && canRetry) ? `
    <button class="act-btn" title="Retry conversion" onclick="retryConvert('${item.id}')">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path d="M2.5 4A5 5 0 0111.5 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
        <path d="M11.5 10A5 5 0 012.5 10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
        <path d="M10 2l1.5 2-2 1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M4 12L2.5 10l2-1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>` : '';

  const dlBtn = isDone ? `
    <button class="act-btn download" title="Open for Print / PDF" onclick="openPrint('${item.id}')">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path d="M7 2v7M4 7l3 3 3-3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M2 11.5h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
      </svg>
    </button>` : '';

  const delBtn = `
    <button class="act-btn danger" title="Delete" onclick="deleteItem('${item.id}')">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path d="M2 4h10M5 4V3a1 1 0 011-1h2a1 1 0 011 1v1M3.5 4l.5 7a1 1 0 001 1h4a1 1 0 001-1l.5-7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>`;

  return `<div class="row-actions">${previewBtn}${convertBtn}${dlBtn}${delBtn}</div>`;
}

// ── Render ─────────────────────────────────────────────────────────
function render() {
  const q = S.query.toLowerCase();
  let items = S.items.filter(it => {
    if (S.tab === 'pending') return it.conversionStatus === 'pending' || it.conversionStatus === 'converting';
    if (S.tab === 'done')    return it.conversionStatus === 'done';
    return true;
  }).filter(it => !q || it.name.toLowerCase().includes(q));

  items.sort((a, b) => {
    const va = a[S.sortKey] || '', vb = b[S.sortKey] || '';
    return va < vb ? S.sortDir : va > vb ? -S.sortDir : 0;
  });

  const total = items.length;
  const start = (S.page - 1) * S.perPage;
  const paged = items.slice(start, start + S.perPage);

  $('pageCount').textContent = total ? `${total} guide${total !== 1 ? 's' : ''}` : '';

  const body = $('tableBody');

  if (!total) {
    body.innerHTML = `<tr><td colspan="6">
      <div class="empty-wrap">
        <div class="empty-icon">
          <svg width="52" height="52" viewBox="0 0 52 52" fill="none">
            <rect x="8" y="10" width="36" height="32" rx="4" stroke="#e5e7eb" stroke-width="2"/>
            <path d="M17 21h18M17 27h12" stroke="#e5e7eb" stroke-width="2" stroke-linecap="round"/>
            <circle cx="38" cy="38" r="8" fill="#f9fafb" stroke="#e5e7eb" stroke-width="1.5"/>
            <path d="M38 35v3l2 2" stroke="#9ca3af" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <p class="empty-title">No guides yet</p>
        <p class="empty-sub">Upload an .odarc file to get started</p>
        <button class="btn-primary" onclick="openModal()">Upload .odarc</button>
      </div>
    </td></tr>`;
    $('pagination').style.display = 'none';
    return;
  }

  body.innerHTML = paged.map(item => `
    <tr data-id="${item.id}">
      <td class="th-check"><input type="checkbox"/></td>
      <td class="th-name">
        <div class="name-cell">
          <svg class="flow-icon" viewBox="0 0 20 20" fill="none">
            <circle cx="5" cy="10" r="2.5" stroke="currentColor" stroke-width="1.5"/>
            <circle cx="15" cy="5"  r="2.5" stroke="currentColor" stroke-width="1.5"/>
            <circle cx="15" cy="15" r="2.5" stroke="currentColor" stroke-width="1.5"/>
            <path d="M7.5 10h4M12.5 5.8L7.5 9.3M12.5 14.2L7.5 10.7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
          </svg>
          <span class="item-name">${esc(item.name)}</span>
        </div>
      </td>
      <td>${statusBadge(item)}</td>
      <td>${fmtDate(item.updatedAt)}</td>
      <td>${esc(item.createdBy || '—')}</td>
      <td>${rowActions(item)}</td>
    </tr>`).join('');

  const totalPages = Math.ceil(total / S.perPage);
  $('pagination').style.display = 'flex';
  $('paginationInfo').textContent = `${start + 1}–${Math.min(start + S.perPage, total)} of ${total}`;
  $('pageNumbers').innerHTML = Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
    const n = i + 1;
    return `<button class="pag-num${S.page === n ? ' active' : ''}" onclick="goPage(${n})">${n}</button>`;
  }).join('');
  $('pagePrev').disabled = S.page <= 1;
  $('pageNext').disabled = S.page >= totalPages;
}

function goPage(n) { S.page = n; render(); }

// ── Init (no backend needed) ────────────────────────────────────────
function loadContent() { render(); }

// ── Upload modal ────────────────────────────────────────────────────
function openModal() {
  $('uploadModal').classList.add('open');
  $('fileChip').style.display    = 'none';
  $('contentName').value         = '';
  $('fileInput').value           = '';
  $('modalUpload').disabled      = true;
  $('topicSection').style.display   = 'none';
  $('inspectSpinner').style.display = 'none';
  $('topicList').innerHTML = '';
  S.file = null;
  S.availTopics   = [];
  S.selectedTopics = new Set();
}
function closeModal() { $('uploadModal').classList.remove('open'); S.file = null; }

async function pickFile(file) {
  if (!file) return;
  if (!file.name.endsWith('.odarc')) return alert('Please select an .odarc file.');
  S.file = file;
  $('chipName').textContent = file.name;
  $('fileChip').style.display = 'inline-flex';
  if (!$('contentName').value) $('contentName').value = file.name.replace('.odarc', '');

  $('inspectSpinner').style.display = 'flex';
  $('topicSection').style.display   = 'none';
  $('modalUpload').disabled = true;

  try {
    const topics = await OdarcConverter.inspectOdarc(file);
    S.availTopics    = topics;
    S.selectedTopics = new Set(topics.map(t => t.id));
    renderTopicList();
  } catch (e) {
    S.availTopics = [];
    console.warn('Inspect failed:', e);
  } finally {
    $('inspectSpinner').style.display = 'none';
  }
  $('modalUpload').disabled = false;
}

function renderTopicList() {
  const topics = S.availTopics;
  if (topics.length <= 1) { $('topicSection').style.display = 'none'; return; }
  $('topicSection').style.display = 'block';
  $('topicList').innerHTML = topics.map((t, i) => `
    <label class="topic-item" for="topic_${i}">
      <input type="checkbox" id="topic_${i}" value="${esc(t.id)}" ${S.selectedTopics.has(t.id) ? 'checked' : ''}
        onchange="toggleTopic('${esc(t.id)}', this.checked)" />
      <svg class="topic-item-icon" width="16" height="16" viewBox="0 0 16 16" fill="none">
        <circle cx="4" cy="8" r="2" stroke="currentColor" stroke-width="1.3"/>
        <circle cx="12" cy="4" r="2" stroke="currentColor" stroke-width="1.3"/>
        <circle cx="12" cy="12" r="2" stroke="currentColor" stroke-width="1.3"/>
        <path d="M6 8h3M9.5 4.7L6 7.5M9.5 11.3L6 8.5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>
      </svg>
      <span class="topic-item-name">${esc(t.title)}</span>
      <span class="topic-item-badge">Process ${i + 1}</span>
    </label>`).join('');
}

function toggleTopic(id, checked) {
  if (checked) S.selectedTopics.add(id);
  else         S.selectedTopics.delete(id);
  $('modalUpload').disabled = S.availTopics.length > 0 && S.selectedTopics.size === 0;
}

async function doUpload() {
  if (!S.file) return;
  const name     = $('contentName').value.trim() || S.file.name.replace('.odarc', '');
  const topicIds = S.availTopics.length > 1 ? [...S.selectedTopics] : null;

  $('modalUpload').disabled = true;
  $('modalUpload').innerHTML = '<span class="spinner"></span> Processing…';

  const item = {
    id:               crypto.randomUUID(),
    name,
    originalName:     S.file.name,
    status:           'Draft',
    conversionStatus: 'converting',
    selectedTopicIds: topicIds,
    createdAt:        new Date().toISOString(),
    updatedAt:        new Date().toISOString(),
    createdBy:        'You',
  };

  S.items.unshift(item);
  S.fileStore.set(item.id, S.file);
  closeModal();
  render();

  $('modalUpload').disabled = false;
  $('modalUpload').innerHTML = 'Upload &amp; Convert';

  await startConvert(item.id);
}

// ── Convert ─────────────────────────────────────────────────────────
async function startConvert(id) {
  const item = S.items.find(i => i.id === id);
  if (!item) return;

  const file = S.fileStore.get(id);
  if (!file) {
    alert('File not found in memory. Please re-upload the .odarc file.');
    return;
  }

  item.conversionStatus = 'converting';
  item.updatedAt        = new Date().toISOString();
  render();

  // Show progress modal
  $('progressModal').classList.add('open');
  $('progressTitle').textContent  = 'Converting…';
  $('progFill').className         = 'prog-fill';
  $('progFill').style.width       = '5%';
  $('progLog').innerHTML          = '';
  $('progFooter').style.display   = 'none';

  let prog = 5;
  function advanceProgress() {
    prog = Math.min(prog + 12, 85);
    $('progFill').style.width = prog + '%';
  }

  try {
    appendLog('Loading archive…');
    advanceProgress();

    const logoB64  = await OdarcConverter.getLogoB64();
    const topicIds = item.selectedTopicIds || null;

    const topics = await OdarcConverter.extractTopics(file, topicIds, msg => {
      appendLog(msg);
      advanceProgress();
    });

    appendLog('Generating print document…');
    advanceProgress();

    const printHtml = OdarcConverter.generatePrintHtml(topics, logoB64);
    const printBlob = new Blob([printHtml], { type: 'text/html' });
    const printUrl  = URL.createObjectURL(printBlob);

    S.convertedStore.set(id, { printUrl, topics });

    item.conversionStatus = 'done';
    item.updatedAt        = new Date().toISOString();
    render();

    $('progFill').className       = 'prog-fill done';
    $('progFill').style.width     = '100%';
    $('progressTitle').textContent = 'Conversion complete!';
    appendLog('Done! Your guide is ready.', 'done');
    $('progFooter').style.display  = 'flex';
    $('progDownload').onclick       = () => openPrint(id);

  } catch (err) {
    item.conversionStatus = 'error';
    item.updatedAt        = new Date().toISOString();
    render();
    $('progFill').className        = 'prog-fill error';
    $('progressTitle').textContent = 'Conversion failed';
    appendLog('Error: ' + err.message, 'error');
    $('progFooter').style.display  = 'flex';
    $('progDownload').style.display = 'none';
    console.error('Conversion error:', err);
  }
}

async function retryConvert(id) {
  const item = S.items.find(i => i.id === id);
  if (!item) return;
  item.conversionStatus = 'converting';
  render();
  await startConvert(id);
}

function appendLog(msg, cls) {
  const el = document.createElement('div');
  if (cls) el.className = 'log-' + cls;
  el.textContent = '› ' + msg;
  $('progLog').appendChild(el);
  $('progLog').scrollTop = $('progLog').scrollHeight;
}

// ── Preview ─────────────────────────────────────────────────────────
async function openPreview(id) {
  const data = S.convertedStore.get(id);
  if (!data?.topics) {
    alert('Guide data not available. Please re-convert.');
    return;
  }

  const item     = S.items.find(i => i.id === id);
  const logoB64  = await OdarcConverter.getLogoB64();
  const html     = OdarcConverter.generatePreviewHtml(data.topics, item?.name || 'Preview', logoB64);
  const blob     = new Blob([html], { type: 'text/html' });
  const url      = URL.createObjectURL(blob);
  const win      = window.open(url, '_blank', 'width=1200,height=820,menubar=no,toolbar=no');
  // Revoke URL after window loads
  if (win) setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ── Print / PDF ──────────────────────────────────────────────────────
function openPrint(id) {
  const data = S.convertedStore.get(id);
  if (!data?.printUrl) {
    alert('Guide not converted yet.');
    return;
  }
  window.open(data.printUrl, '_blank');
}

// ── Delete ───────────────────────────────────────────────────────────
function deleteItem(id) {
  if (!confirm('Delete this guide? This cannot be undone.')) return;
  // Revoke blob URLs to free memory
  const data = S.convertedStore.get(id);
  if (data?.printUrl) URL.revokeObjectURL(data.printUrl);
  S.convertedStore.delete(id);
  S.fileStore.delete(id);
  S.items = S.items.filter(i => i.id !== id);
  render();
}

// ── Events ──────────────────────────────────────────────────────────
$('uploadBtn').onclick   = openModal;
$('navUpload').onclick   = (e) => { e.preventDefault(); openModal(); };
$('selAll').onclick      = () => { S.selectedTopics = new Set(S.availTopics.map(t => t.id)); renderTopicList(); $('modalUpload').disabled = false; };
$('selNone').onclick     = () => { S.selectedTopics = new Set(); renderTopicList(); $('modalUpload').disabled = true; };
$('modalClose').onclick  = closeModal;
$('modalCancel').onclick = closeModal;
$('modalUpload').onclick = doUpload;
$('removeFile').onclick  = () => {
  S.file = null;
  $('fileChip').style.display = 'none';
  $('fileInput').value        = '';
  $('modalUpload').disabled   = true;
};
$('fileInput').onchange = e => pickFile(e.target.files[0]);

// Drag & drop
const dz = $('dropZone');
dz.onclick     = () => $('fileInput').click();
dz.ondragover  = e => { e.preventDefault(); dz.classList.add('drag-over'); };
dz.ondragleave = () => dz.classList.remove('drag-over');
dz.ondrop      = e => { e.preventDefault(); dz.classList.remove('drag-over'); pickFile(e.dataTransfer.files[0]); };

// Progress modal
$('progClose').onclick = () => $('progressModal').classList.remove('open');
$('progressModal').onclick = e => { if (e.target === $('progressModal')) $('progressModal').classList.remove('open'); };
$('uploadModal').onclick   = e => { if (e.target === $('uploadModal')) closeModal(); };

// Tabs
document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  t.classList.add('active');
  S.tab = t.dataset.tab; S.page = 1; render();
});

// Nav sidebar
document.querySelectorAll('.nav-item').forEach(n => n.onclick = e => {
  if (n.dataset.page === 'upload') return;
  e.preventDefault();
  document.querySelectorAll('.nav-item').forEach(x => x.classList.remove('active'));
  n.classList.add('active');
});

// Search
$('searchInput').oninput = e => { S.query = e.target.value; S.page = 1; render(); };

// Sort
document.querySelectorAll('th.sortable').forEach(th => th.onclick = () => {
  const k = th.dataset.sort;
  S.sortDir = (S.sortKey === k) ? S.sortDir * -1 : -1;
  S.sortKey  = k;
  render();
});

// Pagination
$('pagePrev').onclick = () => { if (S.page > 1) { S.page--; render(); } };
$('pageNext').onclick = () => { S.page++; render(); };

// Select all
$('selectAll').onchange = e =>
  document.querySelectorAll('#tableBody input[type=checkbox]').forEach(cb => cb.checked = e.target.checked);

// ── Init ─────────────────────────────────────────────────────────────
loadContent();
