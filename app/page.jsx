'use client';

import { useState, useRef, useCallback, useEffect } from 'react';

// Converter is loaded dynamically so browser APIs (DOMParser, Blob, etc.)
// are never evaluated during server-side rendering.
async function getConverter() {
  return import('../lib/converter');
}

export default function Page() {
  const [items, setItems]               = useState([]);
  const [file, setFile]                 = useState(null);
  const [inspecting, setInspecting]     = useState(false);
  const [availTopics, setAvailTopics]   = useState([]);
  const [selected, setSelected]         = useState(new Set());
  const [dragging, setDragging]         = useState(false);
  const [loading, setLoading]           = useState(true);
  const [fading, setFading]             = useState(false);
  const fileInputRef                    = useRef(null);

  useEffect(() => {
    const fadeTimer  = setTimeout(() => setFading(true),  4500);
    const hideTimer  = setTimeout(() => setLoading(false), 5000);
    return () => { clearTimeout(fadeTimer); clearTimeout(hideTimer); };
  }, []);

  // ── Update a single item by id ──────────────────────────────────
  const patchItem = useCallback((id, patch) =>
    setItems(prev => prev.map(it => it.id === id ? { ...it, ...patch } : it)),
  []);

  // ── Handle file selection ───────────────────────────────────────
  const handleFile = async (f) => {
    if (!f) return;
    if (!f.name.endsWith('.odarc')) { alert('Please choose an .odarc file.'); return; }
    setFile(f);
    setAvailTopics([]);
    setSelected(new Set());
    setInspecting(true);
    try {
      const { inspectOdarc } = await getConverter();
      const topics = await inspectOdarc(f);
      setAvailTopics(topics);
      setSelected(new Set(topics.map(t => t.id)));
    } catch {
      // proceed without topic selector
    } finally {
      setInspecting(false);
    }
  };

  const clearFile = (e) => {
    e?.stopPropagation();
    setFile(null);
    setAvailTopics([]);
    setSelected(new Set());
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // ── Run conversion for a given item id ─────────────────────────
  const runConversion = useCallback(async (id, fileObj, topicIds) => {
    try {
      const { extractTopics, generatePrintHtml, getLogoB64 } = await getConverter();
      const logoB64 = await getLogoB64();

      let prog = 8;
      const log = [];
      const onProgress = (msg) => {
        log.push(msg);
        prog = Math.min(prog + 18, 85);
        patchItem(id, { log: [...log], progress: prog });
      };

      const topics = await extractTopics(fileObj, topicIds, onProgress);

      patchItem(id, { log: [...log, 'Generating document…'], progress: 93 });

      const html      = generatePrintHtml(topics, logoB64, true);
      const htmlClean = generatePrintHtml(topics, logoB64, false);
      const printUrl      = URL.createObjectURL(new Blob([html],      { type: 'text/html' }));
      const printUrlClean = URL.createObjectURL(new Blob([htmlClean], { type: 'text/html' }));

      patchItem(id, { status: 'done', progress: 100, printUrl, printUrlClean, topics, log: [...log, 'Done!'] });
    } catch (err) {
      patchItem(id, { status: 'error', error: err.message });
    }
  }, [patchItem]);

  // ── Submit conversion ───────────────────────────────────────────
  const handleConvert = async () => {
    if (!file) return;
    const topicIds = availTopics.length > 1 ? [...selected] : null;
    const name = (() => {
      if (!availTopics.length) return file.name.replace(/\.odarc$/i, '');
      const pool = topicIds ? availTopics.filter(t => topicIds.includes(t.id)) : availTopics;
      return pool.map(t => t.title).join(' · ') || file.name.replace(/\.odarc$/i, '');
    })();

    const id = crypto.randomUUID();
    setItems(prev => [
      { id, name, status: 'converting', log: [], progress: 8,
        printUrl: null, topics: null, error: null,
        _file: file, _topicIds: topicIds },
      ...prev,
    ]);
    clearFile();
    runConversion(id, file, topicIds);
  };

  // ── Retry ───────────────────────────────────────────────────────
  const handleRetry = (item) => {
    patchItem(item.id, { status: 'converting', log: [], progress: 8, error: null });
    runConversion(item.id, item._file, item._topicIds);
  };

  // ── Preview ─────────────────────────────────────────────────────
  const handlePreview = async (item) => {
    if (!item.topics) return;
    const { generatePreviewHtml, getLogoB64 } = await getConverter();
    const logoB64 = await getLogoB64();
    const html = generatePreviewHtml(item.topics, item.name, logoB64);
    const url  = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    const win  = window.open(url, '_blank', 'width=1200,height=820,menubar=no,toolbar=no');
    if (win) setTimeout(() => URL.revokeObjectURL(url), 15000);
  };

  // ── Download helpers ─────────────────────────────────────────────
  const downloadBlob = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const handleDocx = async (item, withTooltips) => {
    if (!item.topics) return;
    const { generateDocx, getLogoB64 } = await getConverter();
    const logoB64 = await getLogoB64();
    patchItem(item.id, { exportingDocx: true });
    try {
      const blob = await generateDocx(item.topics, item.name, logoB64, withTooltips);
      downloadBlob(blob, `${item.name}${withTooltips ? '' : '-clean'}.docx`);
    } finally {
      patchItem(item.id, { exportingDocx: false });
    }
  };

  const handlePptx = async (item, withTooltips) => {
    if (!item.topics) return;
    const { generatePptx, getLogoB64 } = await getConverter();
    const logoB64 = await getLogoB64();
    patchItem(item.id, { exportingPptx: true });
    try {
      const blob = await generatePptx(item.topics, item.name, logoB64, withTooltips);
      downloadBlob(blob, `${item.name}${withTooltips ? '' : '-clean'}.pptx`);
    } finally {
      patchItem(item.id, { exportingPptx: false });
    }
  };

  // ── Delete ──────────────────────────────────────────────────────
  const handleDelete = (id) => {
    setItems(prev => {
      const it = prev.find(x => x.id === id);
      if (it?.printUrl)      URL.revokeObjectURL(it.printUrl);
      if (it?.printUrlClean) URL.revokeObjectURL(it.printUrlClean);
      return prev.filter(x => x.id !== id);
    });
  };

  // ── Drag & drop ─────────────────────────────────────────────────
  const onDragOver  = (e) => { e.preventDefault(); setDragging(true); };
  const onDragLeave = () => setDragging(false);
  const onDrop      = (e) => { e.preventDefault(); setDragging(false); handleFile(e.dataTransfer.files[0]); };

  const canConvert = !!file && !inspecting && (availTopics.length === 0 || selected.size > 0);

  return (
    <>
      {/* Loading screen */}
      {loading && (
        <div className={`loading-screen${fading ? ' fading' : ''}`}>
          <img src="/whatfix-loader.gif" alt="Loading" className="loading-gif" />
          <p className="loading-text">Software Clicks Smarter with Whatfix</p>
        </div>
      )}

      {/* Header */}
      <header className="header">
        <img src="/Whatfix_logo.png" alt="Whatfix" className="header-logo" />
        <div className="header-divider" />
        <span className="header-title">OdArc Converter</span>
      </header>

      <div className="page">

        {/* Upload zone */}
        <div
          className={`upload-zone${dragging ? ' drag-over' : ''}${file ? ' has-file' : ''}`}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onClick={() => !file && fileInputRef.current?.click()}
        >
          {file ? (
            <div className="file-chip">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M8 1.5H4a1 1 0 00-1 1v9a1 1 0 001 1h6a1 1 0 001-1V5L8 1.5z" stroke="#e87722" strokeWidth="1.2"/>
                <path d="M8 1.5V5h3.5" stroke="#e87722" strokeWidth="1.2" strokeLinecap="round"/>
              </svg>
              {file.name}
              <button className="file-chip-remove" onClick={clearFile} title="Remove">×</button>
            </div>
          ) : (
            <>
              <div className="upload-icon">
                <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
                  <path d="M11 15V7M11 7l-4 4M11 7l4 4" stroke="#e87722" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M4 17h14" stroke="#e87722" strokeWidth="1.7" strokeLinecap="round"/>
                </svg>
              </div>
              <p className="upload-text">
                Drop an <strong>.odarc</strong> file here, or{' '}
                <strong onClick={() => fileInputRef.current?.click()}>browse</strong>
              </p>
              <p className="upload-hint">Converts to an annotated PDF with screenshots and step tooltips</p>
            </>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept=".odarc"
            style={{ display: 'none' }}
            onChange={e => handleFile(e.target.files[0])}
          />
        </div>

        {/* Inspect spinner */}
        {inspecting && (
          <div className="inspect-row">
            <span className="spinner" />
            Detecting processes…
          </div>
        )}

        {/* Topic picker */}
        {!inspecting && availTopics.length > 1 && (
          <div className="topic-picker">
            <div className="topic-picker-header">
              <span className="topic-picker-label">Processes to include</span>
              <div className="topic-picker-actions">
                <button className="topic-link" onClick={() => setSelected(new Set(availTopics.map(t => t.id)))}>All</button>
                <button className="topic-link" style={{ color: '#6b7280' }} onClick={() => setSelected(new Set())}>None</button>
              </div>
            </div>
            <div className="topic-list">
              {availTopics.map((t, i) => (
                <label key={t.id} className="topic-item">
                  <input
                    type="checkbox"
                    checked={selected.has(t.id)}
                    onChange={e => setSelected(prev => {
                      const next = new Set(prev);
                      e.target.checked ? next.add(t.id) : next.delete(t.id);
                      return next;
                    })}
                  />
                  <span className="topic-item-title">{t.title}</span>
                  <span className="topic-item-num">Process {i + 1}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        {/* Convert button */}
        {file && (
          <button
            className="btn-convert"
            disabled={!canConvert}
            onClick={handleConvert}
          >
            Convert to PDF
          </button>
        )}

        {/* Guide list */}
        {items.length > 0 && (
          <section className="guide-list">
            <div className="guide-list-title">Your guides</div>
            {items.map(item => (
              <GuideCard
                key={item.id}
                item={item}
                onPreview={() => handlePreview(item)}
                onPrint={(wt) => window.open(wt ? item.printUrl : item.printUrlClean, '_blank')}
                onDocx={(wt) => handleDocx(item, wt)}
                onPptx={(wt) => handlePptx(item, wt)}
                onRetry={() => handleRetry(item)}
                onDelete={() => handleDelete(item.id)}
              />
            ))}
          </section>
        )}
      </div>
    </>
  );
}

function GuideCard({ item, onPreview, onPrint, onDocx, onPptx, onRetry, onDelete }) {
  const { status, name, log, progress, error, exportingDocx, exportingPptx } = item;
  const lastLog = log?.[log.length - 1];
  const [withTooltips, setWithTooltips] = useState(true);

  return (
    <div className="guide-card">
      <div className="guide-card-top">
        {/* Flow icon */}
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, color: '#9ca3af' }}>
          <circle cx="3.5" cy="8" r="2" stroke="currentColor" strokeWidth="1.3"/>
          <circle cx="12.5" cy="3.5" r="2" stroke="currentColor" strokeWidth="1.3"/>
          <circle cx="12.5" cy="12.5" r="2" stroke="currentColor" strokeWidth="1.3"/>
          <path d="M5.5 8h4M10 4.5L5.5 7.5M10 11.5L5.5 8.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
        </svg>

        <span className="guide-name" title={name}>{name}</span>

        {status === 'done' && <span className="badge badge-done">&#10003; Ready</span>}
        {status === 'error' && <span className="badge badge-error">&#10005; Failed</span>}
        {status === 'converting' && (
          <span className="badge badge-converting">
            <span className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} />
            Converting
          </span>
        )}

        <div className="guide-actions">
          {status === 'done' && (
            <>
              <button className="btn-action" onClick={onPreview} title="Interactive slideshow preview">
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none" style={{ verticalAlign: 'middle', marginRight: 4 }}>
                  <rect x="1" y="1" width="11" height="9" rx="1" stroke="currentColor" strokeWidth="1.2"/>
                  <path d="M1 11.5h11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                  <path d="M5.5 4.5L8 6.5l-2.5 2V4.5z" fill="currentColor"/>
                </svg>
                Preview
              </button>

              <label className="tooltip-toggle" title="Toggle tooltip overlays on exported screenshots">
                <input type="checkbox" checked={withTooltips} onChange={e => setWithTooltips(e.target.checked)} />
                <span className="toggle-track"><span className="toggle-thumb" /></span>
                <span className="tooltip-toggle-label-on">Tooltips on</span>
                <span className="tooltip-toggle-label-off">Tooltips off</span>
              </label>

              <button className="btn-action" onClick={() => onPrint(withTooltips)} title="Open print view to save as PDF">
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none" style={{ verticalAlign: 'middle', marginRight: 4 }}>
                  <path d="M3 5V2h7v3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                  <rect x="1" y="5" width="11" height="5" rx="1" stroke="currentColor" strokeWidth="1.2"/>
                  <path d="M3 8h7v4H3z" stroke="currentColor" strokeWidth="1.2"/>
                </svg>
                PDF
              </button>
              <button className="btn-action" onClick={() => onDocx(withTooltips)} disabled={exportingDocx} title="Download Word document">
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none" style={{ verticalAlign: 'middle', marginRight: 4 }}>
                  <path d="M2 1h6.5L11 3.5V12H2V1z" stroke="currentColor" strokeWidth="1.2"/>
                  <path d="M8.5 1v3H11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                  <path d="M4 5.5h5M4 7.5h5M4 9.5h3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
                </svg>
                {exportingDocx ? 'Exporting…' : 'DOCX'}
              </button>
              <button className="btn-action primary" onClick={() => onPptx(withTooltips)} disabled={exportingPptx} title="Download PowerPoint presentation">
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none" style={{ verticalAlign: 'middle', marginRight: 4 }}>
                  <rect x="1" y="1" width="11" height="9" rx="1" stroke="currentColor" strokeWidth="1.2"/>
                  <path d="M1 10.5h11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                  <circle cx="6.5" cy="5.5" r="1.5" stroke="currentColor" strokeWidth="1.1"/>
                  <path d="M4.5 8.5c0-1.1.9-2 2-2s2 .9 2 2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
                </svg>
                {exportingPptx ? 'Exporting…' : 'PPTX'}
              </button>
            </>
          )}
          {status === 'error' && (
            <button className="btn-action" onClick={onRetry}>Retry</button>
          )}
          <button className="btn-action danger" onClick={onDelete} title="Remove">&#215;</button>
        </div>
      </div>

      {status === 'converting' && (
        <>
          <div className="prog-track">
            <div className="prog-fill" style={{ width: `${progress}%` }} />
          </div>
          {lastLog && <div className="prog-log">{lastLog}</div>}
        </>
      )}

      {status === 'error' && error && (
        <div className="error-msg">{error}</div>
      )}
    </div>
  );
}
