// lib/converter.js — Browser-only ODARC converter (ESM, dynamic-import only)
// Depends on: jszip (npm), browser APIs (DOMParser, Blob, FileReader, fetch)

import JSZip from 'jszip';

// ── Logo cache ─────────────────────────────────────────────────────
let _logoPromise = null;
export function getLogoB64() {
  if (!_logoPromise) {
    _logoPromise = fetch('/Whatfix_logo.png')
      .then(r => r.ok ? r.blob() : null)
      .then(blob => blob ? new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.onerror = rej;
        fr.readAsDataURL(blob);
      }) : null)
      .catch(() => null);
  }
  return _logoPromise;
}

// ── XML helpers ────────────────────────────────────────────────────
function normalizeXml(str) {
  return str
    .replace(/^\uFEFF/, '')
    .replace(/\s+xmlns(?::\w+)?="[^"]*"/g, '')
    .replace(/(<\/?\s*)\w+:/g, '$1')
    .replace(/\b\w+:(\w+)=/g, '$1=');
}

function parseXml(xmlString) {
  const doc = new DOMParser().parseFromString(normalizeXml(xmlString), 'application/xml');
  const err = doc.querySelector('parsererror');
  if (err) throw new Error('XML parse error: ' + err.textContent.slice(0, 120));
  return doc;
}

// ── Text helpers ───────────────────────────────────────────────────
function escHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function extractSegments(btEl) {
  const segments = [];
  for (const p of btEl.querySelectorAll('p')) {
    const segs = [];
    for (const fmt of p.querySelectorAll('fmt')) {
      const text = fmt.textContent || '';
      if (!text.trim()) continue;
      const sty = fmt.getAttribute('sty') || '';
      segs.push({ text, bold: sty.includes('b'), italic: sty.includes('i'), underline: sty.includes('u'), color: fmt.getAttribute('clr') || null });
    }
    if (segs.length) segments.push({ type: 'line', segs });
    else if (segments.length) segments.push({ type: 'br' });
  }
  return segments;
}

function extractBubbleData(bubbleEl) {
  if (!bubbleEl) return null;
  const bt = bubbleEl.querySelector('BubbleText');
  if (!bt) return null;
  return { bgColor: bt.getAttribute('BgColor') || '#C0FFFF', segments: extractSegments(bt) };
}

function segmentsToHtml(segments) {
  return (segments || []).map(seg => {
    if (seg.type === 'br') return '<br>';
    return seg.segs.map(s => {
      let t = escHtml(s.text);
      if (s.bold)      t = `<strong>${t}</strong>`;
      if (s.italic)    t = `<em>${t}</em>`;
      if (s.underline) t = `<u>${t}</u>`;
      if (s.color)     t = `<span style="color:${s.color}">${t}</span>`;
      return t;
    }).join('');
  }).filter(Boolean).join('');
}

// ── Interaction hints ──────────────────────────────────────────────
const EVENT_VERB  = { LClick1:'Click', LClick2:'Click', RClick1:'Right-click', DClick1:'Double-click', Type:'Type in', Drag:'Drag' };
const ROLE_SUFFIX = { ROLE_SYSTEM_BUTTONMENU:'menu', ROLE_SYSTEM_PUSHBUTTON:'button', ROLE_SYSTEM_LINK:'link', ROLE_SYSTEM_TEXT:'field', ROLE_SYSTEM_LISTITEM:'option', ROLE_SYSTEM_COMBOBOX:'dropdown', ROLE_SYSTEM_MENUITEM:'menu item', ROLE_SYSTEM_CHECKBOX:'checkbox', ROLE_SYSTEM_RADIOBUTTON:'radio button' };

function buildInteractionHint(eventType, objName, objType) {
  const verb   = EVENT_VERB[eventType]  || 'Interact with';
  const suffix = ROLE_SUFFIX[objType]   || '';
  const name   = objName ? `"${objName}"` : 'the highlighted area';
  if (!objName && !eventType) return null;
  return suffix ? `${verb} the ${name} ${suffix}` : `${verb} ${name}`;
}

// ── Frame ordering ─────────────────────────────────────────────────
function orderFrames(frameMap, firstId) {
  const ordered = [], visited = new Set();
  let cur = firstId;
  while (cur && !visited.has(cur)) {
    visited.add(cur);
    const frame = frameMap[cur];
    if (!frame) break;
    ordered.push(frame);
    cur = frame.nextId;
  }
  return ordered;
}

// ── Image to base64 ────────────────────────────────────────────────
async function zipEntryToB64(zip, path) {
  const entry = zip.file(path);
  if (!entry) return null;
  try {
    const ab = await entry.async('arraybuffer');
    const bytes = new Uint8Array(ab);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 8192)
      bin += String.fromCharCode(...bytes.subarray(i, Math.min(i + 8192, bytes.length)));
    const ext  = path.split('.').pop().toLowerCase();
    const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    return `data:${mime};base64,${btoa(bin)}`;
  } catch { return null; }
}

// ── Manifest parser ────────────────────────────────────────────────
function parseManifest(xmlString) {
  const doc = parseXml(xmlString);
  return [...doc.querySelectorAll('Document')].map(d => ({
    folder: d.querySelector('ImportFolder')?.textContent?.trim() || '',
    id:     d.querySelector('ID')?.textContent?.trim()           || '',
    title:  d.querySelector('Title')?.textContent?.trim()        || '',
    schema: d.querySelector('SchemaNamespace')?.textContent?.trim() || '',
  }));
}

// ── Topic parser ───────────────────────────────────────────────────
async function parseTopic(xmlString, folder, zip) {
  const doc     = parseXml(xmlString);
  const topicEl = doc.querySelector('Topic');
  const srEl    = topicEl?.querySelector('ScreenResolution');
  const screenW = parseInt(srEl?.getAttribute('Width')  || '1280', 10);
  const screenH = parseInt(srEl?.getAttribute('Height') || '1024', 10);

  let intro = null;
  const introEl = topicEl?.querySelector('IntroFrame > Bubble');
  if (introEl) { const d = extractBubbleData(introEl); if (d?.segments?.length) intro = d; }

  const frameEls = [...(topicEl?.querySelectorAll('Frames > Frame') || [])];
  const frameMap = {};

  for (const f of frameEls) {
    const id = f.getAttribute('ID'), type = f.getAttribute('Type');
    const imgName = f.querySelector('Screenshot')?.getAttribute('href') || null;
    const act = f.querySelector('Actions > Action');
    let bubble = null, hotspot = null, bubblePos = null, pointer = null;
    let evtType = null, objName = '', objType = null;

    if (act) {
      const hs = act.querySelector('Hotspots > Hotspot');
      if (hs) {
        const top = parseInt(hs.getAttribute('Top'), 10), left = parseInt(hs.getAttribute('Left'), 10);
        hotspot = { top, left, bottom: parseInt(hs.getAttribute('Bottom'), 10), right: parseInt(hs.getAttribute('Right'), 10), isNextBtn: top === 492 && left === 620 };
      }
      const ab = act.querySelector('ActionBubble');
      if (ab) {
        bubblePos = { x: parseInt(ab.getAttribute('PosX'), 10), y: parseInt(ab.getAttribute('PosY'), 10) };
        pointer   = ab.getAttribute('Pointer') || 'None';
        bubble    = extractBubbleData(ab.querySelector('Bubble'));
      }
      evtType = act.querySelector('Event')?.getAttribute('Type') || null;
      objName = act.querySelector('Object > Name')?.textContent?.trim() || '';
      objType = act.querySelector('Object > Type')?.textContent?.trim() || null;
    }

    const nextId = (act?.getAttribute('TargetFrame') || '').replace(/^\//, '') || null;

    if (!bubble?.segments?.some(s => s.type === 'line') && (evtType || objName)) {
      const hint = buildInteractionHint(evtType, objName, objType);
      if (hint) bubble = { bgColor: '#FFF3CD', segments: [{ type: 'line', segs: [{ text: hint, bold: false, italic: false, underline: false, color: null }] }], isAutoHint: true };
    }

    frameMap[id] = { id, type, imgName, bubble, hotspot, bubblePos, pointer, nextId };
  }

  const ordered = orderFrames(frameMap, frameEls[0]?.getAttribute('ID'));
  const steps = [];
  let stepNum = 0;
  for (const frame of ordered) {
    if (frame.type === 'End') continue;
    if (!frame.bubble?.segments?.length && !frame.imgName) continue;
    stepNum++;
    const imageB64 = frame.imgName ? await zipEntryToB64(zip, `${folder}/${frame.imgName}`) : null;
    steps.push({ stepNum, frameType: frame.type, imageB64, hotspot: frame.hotspot, bubble: frame.bubble, bubblePos: frame.bubblePos, pointer: frame.pointer, screenW, screenH });
  }
  return { intro, steps, screenW, screenH };
}

// ── Public: inspect (manifest only) ───────────────────────────────
export async function inspectOdarc(file) {
  const zip = await JSZip.loadAsync(file);
  const mEntry = zip.file('manifest.xml');
  if (!mEntry) throw new Error('No manifest.xml found in archive');
  const docs = parseManifest(await mEntry.async('string'));
  return docs.filter(d => d.schema === 'urn:topic-v1').map(d => ({ id: d.id, title: d.title }));
}

// ── Public: full extraction ────────────────────────────────────────
export async function extractTopics(file, allowedIds = null, onProgress = null) {
  const zip = await JSZip.loadAsync(file);
  const mEntry = zip.file('manifest.xml');
  if (!mEntry) throw new Error('No manifest.xml found');
  let docs = parseManifest(await mEntry.async('string')).filter(d => d.schema === 'urn:topic-v1');
  if (allowedIds?.length) docs = docs.filter(d => allowedIds.includes(d.id));
  if (!docs.length) throw new Error('No matching topics found');

  const topics = [];
  for (const doc of docs) {
    onProgress?.(`Parsing: ${doc.title}…`);
    const tEntry = zip.file(`${doc.folder}/topic.xml`);
    if (!tEntry) continue;
    topics.push({ title: doc.title, ...await parseTopic(await tEntry.async('string'), doc.folder, zip) });
  }
  return topics;
}

// ── CSS helpers ────────────────────────────────────────────────────
function bubbleCss(step, dispW, dispH) {
  if (!step.bubblePos) return null;
  const sx = dispW / step.screenW, sy = dispH / step.screenH;
  const px = Math.round(step.bubblePos.x * sx), py = Math.round(step.bubblePos.y * sy);
  const bw = 280, ptr = (step.pointer || 'None').toLowerCase();
  let left, top, arrowClass;
  if      (ptr === 'topright')                       { left = Math.max(4, px - bw);      top = py;                   arrowClass = 'arrow-top-right'; }
  else if (ptr === 'topleft')                        { left = px;                         top = py;                   arrowClass = 'arrow-top-left';  }
  else if (ptr === 'righttop' || ptr === 'right')    { left = Math.max(4, px - bw - 12); top = Math.max(4, py - 20); arrowClass = 'arrow-right'; }
  else if (ptr === 'lefttop'  || ptr === 'left')     { left = px + 12;                   top = Math.max(4, py - 20); arrowClass = 'arrow-left';  }
  else                                               { left = Math.max(4, px - bw / 2);  top = Math.max(4, py - 40); arrowClass = ''; }
  return { left: Math.min(Math.max(4, left), dispW - bw - 8), top: Math.max(4, top), arrowClass, bw };
}

function hotspotCss(step, dispW, dispH) {
  if (!step.hotspot || step.hotspot.isNextBtn) return null;
  const sx = dispW / step.screenW, sy = dispH / step.screenH;
  return { left: Math.round(step.hotspot.left * sx), top: Math.round(step.hotspot.top * sy), width: Math.round((step.hotspot.right - step.hotspot.left) * sx), height: Math.round((step.hotspot.bottom - step.hotspot.top) * sy) };
}

// ── Public: print HTML ─────────────────────────────────────────────
export function generatePrintHtml(allTopics, logoB64 = null, includeTooltips = true) {
  const DISP_W = 600;
  const logoHtml = logoB64
    ? `<img src="${logoB64}" alt="Whatfix" style="height:28px;display:block;margin-bottom:20px;" />`
    : `<div style="font-size:22px;font-weight:800;color:#fff;margin-bottom:20px;">Whatfix</div>`;

  const sections = allTopics.map((topic, ti) => {
    const DISP_H = Math.round(DISP_W * topic.screenH / topic.screenW);
    const introHtml = topic.intro ? `<div class="intro-block"><span class="intro-icon"><svg width="13" height="13" viewBox="0 0 13 13" fill="none"><circle cx="6.5" cy="6.5" r="6" stroke="#2b7be5" stroke-width="1.2"/><path d="M6.5 5.5v4" stroke="#2b7be5" stroke-width="1.4" stroke-linecap="round"/><circle cx="6.5" cy="3.8" r=".75" fill="#2b7be5"/></svg></span><div class="intro-body">${segmentsToHtml(topic.intro.segments)}</div></div>` : '';
    const stepsHtml = topic.steps.map(step => {
      const bPos = (includeTooltips && step.bubble) ? bubbleCss(step, DISP_W, DISP_H) : null;
      const hPos = includeTooltips ? hotspotCss(step, DISP_W, DISP_H) : null;
      const bgC  = step.bubble?.bgColor || '#C0FFFF';
      const isHint = step.bubble?.isAutoHint;
      const hotspotEl = hPos ? `<div class="hs-box" style="left:${hPos.left}px;top:${hPos.top}px;width:${hPos.width}px;height:${hPos.height}px;"></div>` : '';
      let bubbleEl = '';
      if (bPos && step.bubble?.segments?.length) {
        const bCls = `b${ti}s${step.stepNum}`;
        const ac = bPos.arrowClass;
        const arrowCssProp = (ac === 'arrow-top-right' || ac === 'arrow-top-left') ? `border-bottom-color:${bgC}` : ac === 'arrow-right' ? `border-left-color:${bgC}` : ac === 'arrow-left' ? `border-right-color:${bgC}` : '';
        const arrowSt = arrowCssProp ? `<style>.${bCls}::after{${arrowCssProp}!important}</style>` : '';
        const hintIconHtml = isHint ? '<span class="hint-icon"><svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M1.5 1L9 4.5 5 5.2 4.3 9z" fill="#777" stroke="#555" stroke-width=".4" stroke-linejoin="round"/></svg></span>' : '';
        bubbleEl = `${arrowSt}<div class="bubble ${bCls} ${ac}${isHint ? ' hint' : ''}" style="left:${bPos.left}px;top:${bPos.top}px;width:${bPos.bw}px;background:${bgC};">${hintIconHtml}${segmentsToHtml(step.bubble.segments)}</div>`;
      }
      const imgEl = step.imageB64 ? `<img src="${step.imageB64}" width="${DISP_W}" height="${DISP_H}" />` : `<div style="width:${DISP_W}px;height:${DISP_H}px;background:#f3f4f6;display:flex;align-items:center;justify-content:center;color:#9ca3af;">No screenshot</div>`;
      const captionHtml = (includeTooltips && step.bubble?.segments?.length) ? `<div class="step-caption${isHint ? ' caption-hint' : ''}">${isHint ? '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" style="vertical-align:middle;margin-right:3px;"><path d="M1.5 1L9 4.5 5 5.2 4.3 9z" fill="#f59e0b" stroke="#e08a00" stroke-width=".4" stroke-linejoin="round"/></svg>' : ''}${segmentsToHtml(step.bubble.segments)}</div>` : '';
      return `<div class="step-wrap"><div class="step-label">Step ${step.stepNum}</div><div class="sc" style="width:${DISP_W}px;height:${DISP_H}px;">${imgEl}${hotspotEl}${bubbleEl}</div>${captionHtml}</div>`;
    }).join('');
    return `<div class="topic-section${ti > 0 ? ' page-break' : ''}"><div class="topic-header"><div class="topic-num">${ti + 1}</div><h1>${escHtml(topic.title)}</h1></div>${introHtml}${stepsHtml}</div>`;
  }).join('');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;}
  body{font-family:'Segoe UI',Arial,sans-serif;font-size:12px;color:#111;background:#fff;line-height:1.5;padding-bottom:72px;}
  .print-bar{position:fixed;bottom:0;left:0;right:0;padding:12px 20px;background:#25223B;display:flex;align-items:center;justify-content:space-between;gap:12px;z-index:9999;border-top:2px solid #FF6B18;}
  .print-bar span{color:#c8cdd9;font-size:12px;}.print-btn{background:#FF6B18;color:#fff;border:none;border-radius:5px;padding:8px 22px;font-size:13px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:6px;}
  .print-btn:hover{background:#e05a0d;}@media print{.print-bar{display:none!important;}body{padding-bottom:0!important;}}
  .cover{background:linear-gradient(135deg,#25223B,#3a3660);color:#fff;padding:50px 40px;margin-bottom:30px;}.cover h1{font-size:26px;font-weight:700;margin-bottom:8px;}.cover-date{font-size:11px;opacity:.6;margin-top:6px;}
  .toc{padding:18px 40px 26px;border-bottom:1px solid #e5e7eb;margin-bottom:20px;}.toc-title{font-size:13px;font-weight:700;color:#25223B;border-bottom:2px solid #FF6B18;display:inline-block;padding-bottom:3px;margin-bottom:10px;}
  .toc-item{display:flex;align-items:center;gap:10px;padding:4px 0;font-size:11.5px;color:#374151;}.toc-dot{width:18px;height:18px;background:#FF6B18;color:#fff;border-radius:50%;font-size:9px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
  .topic-section{padding:0 30px 20px;}.topic-header{display:flex;align-items:center;gap:12px;background:linear-gradient(90deg,#25223B,#3a3660);padding:12px 18px;border-radius:6px;margin-bottom:16px;color:#fff;}
  .topic-num{width:26px;height:26px;border:2px solid rgba(255,255,255,.35);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;}.topic-header h1{font-size:15px;font-weight:700;}
  .intro-block{display:flex;gap:10px;align-items:flex-start;background:#f0f7ff;border-left:3px solid #2b7be5;border-radius:4px;padding:10px 12px;margin-bottom:14px;font-size:11px;color:#1a3a5c;line-height:1.6;}.intro-icon{flex-shrink:0;margin-top:1px;}
  .step-wrap{margin-bottom:22px;break-inside:avoid;}.step-label{font-size:10px;font-weight:700;color:#FF6B18;text-transform:uppercase;letter-spacing:.5px;margin-bottom:5px;}
  .sc{position:relative;overflow:hidden;border:1px solid #e5e7eb;border-radius:4px;}.sc img{display:block;width:100%;height:100%;object-fit:cover;}
  .hs-box{position:absolute;border:2.5px solid #FF6B18;border-radius:3px;box-shadow:0 0 0 3px rgba(255,107,24,.25);}
  .bubble{position:absolute;border-radius:5px;padding:7px 10px;font-size:10px;line-height:1.55;color:#111;box-shadow:0 2px 10px rgba(0,0,0,.22);border:1px solid rgba(0,0,0,.12);}.bubble.hint{border:1.5px dashed rgba(0,0,0,.2);}.hint-icon{margin-right:4px;vertical-align:middle;}
  .bubble::after{content:'';position:absolute;border:7px solid transparent;}
  .arrow-top-right::after{top:-14px;right:12px;}.arrow-top-left::after{top:-14px;left:12px;}.arrow-right::after{right:-14px;top:10px;}.arrow-left::after{left:-14px;top:10px;}
  .step-caption{margin-top:6px;font-size:11px;color:#374151;line-height:1.6;padding:6px 10px;background:#fafafa;border-left:3px solid #FF6B18;border-radius:0 3px 3px 0;}.step-caption.caption-hint{background:#fffbf0;border-left-color:#f59e0b;}
  .page-break{page-break-before:always;}
</style></head><body>
<div class="print-bar"><span>Open your browser's <strong>Print</strong> dialog and choose <strong>Save as PDF</strong>.</span><button class="print-btn" onclick="window.print()"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 5V2h8v3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><rect x="1" y="5" width="12" height="6" rx="1" stroke="currentColor" stroke-width="1.2"/><path d="M3 9h8v4H3z" stroke="currentColor" stroke-width="1.2"/><circle cx="11.5" cy="7.5" r=".6" fill="currentColor"/></svg>Print / Save PDF</button></div>
<div class="cover">${logoHtml}<h1>${escHtml(allTopics.map(t => t.title).join(' · '))}</h1><div class="cover-date">Generated ${new Date().toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})}</div></div>
${allTopics.length > 1 ? `<div class="toc"><div class="toc-title">Contents</div>${allTopics.map((t,i)=>`<div class="toc-item"><span class="toc-dot">${i+1}</span><span>${escHtml(t.title)}</span></div>`).join('')}</div>` : ''}
${sections}</body></html>`;
}

// ── Public: preview HTML ───────────────────────────────────────────
export function generatePreviewHtml(topics, docTitle, logoB64 = null) {
  const slides = [{ type: 'cover', title: docTitle || topics.map(t => t.title).join(' & '), topics: topics.map(t => t.title) }];
  for (const topic of topics) {
    if (topic.intro?.segments?.length) slides.push({ type: 'intro', topic: topic.title, intro: topic.intro });
    for (const step of topic.steps) {
      slides.push({ type: 'step', topic: topic.title, stepNum: step.stepNum, totalSteps: topic.steps.length, frameType: step.frameType, imageB64: step.imageB64, bubble: step.bubble, bubblePos: step.bubblePos, pointer: step.pointer, hotspot: step.hotspot, screenW: step.screenW, screenH: step.screenH });
    }
  }

  const coverLogo = logoB64
    ? `<img class="cover-logo" src="${logoB64}" alt="Whatfix" />`
    : '<div style="font-size:24px;font-weight:800;margin-bottom:28px;">Whatfix</div>';
  const tbLogo = logoB64
    ? `<img class="tb-logo" src="${logoB64}" alt="Whatfix" />`
    : '<span class="tb-name">Whatfix</span>';

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>${escHtml(docTitle || 'Preview')}</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  html,body{width:100%;height:100%;background:#0f111a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;overflow:hidden;color:#fff;}
  #app{width:100vw;height:100vh;display:flex;flex-direction:column;}
  #topbar{height:52px;flex-shrink:0;background:#1b1f2e;border-bottom:1px solid rgba(255,255,255,.08);display:flex;align-items:center;justify-content:space-between;padding:0 20px;gap:16px;}
  .tb-brand{display:flex;align-items:center;gap:10px;}.tb-logo{height:22px;display:block;filter:brightness(0) invert(1);}.tb-name{font-size:14px;font-weight:700;}
  .tb-sep{width:1px;height:20px;background:rgba(255,255,255,.15);}.tb-topic{font-size:12.5px;color:#8a92a6;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .tb-progress{display:flex;align-items:center;gap:10px;font-size:12px;color:#8a92a6;}.tb-bar{width:120px;height:3px;background:rgba(255,255,255,.12);border-radius:2px;overflow:hidden;}.tb-bar-fill{height:100%;background:#FF6B18;border-radius:2px;transition:width .3s ease;}
  .tb-close{width:30px;height:30px;border-radius:6px;border:1px solid rgba(255,255,255,.12);background:none;color:#8a92a6;cursor:pointer;font-size:16px;display:flex;align-items:center;justify-content:center;transition:all .15s;}.tb-close:hover{background:rgba(255,255,255,.08);color:#fff;}
  #stage{flex:1;display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden;padding:16px 80px;}
  #screenshot-container{position:relative;overflow:hidden;border-radius:6px;box-shadow:0 20px 60px rgba(0,0,0,.6);max-width:100%;max-height:100%;transition:opacity .18s ease,transform .18s ease;}
  #screenshot-img{display:block;max-width:100%;max-height:100%;height:auto;}
  .hotspot-box{position:absolute;border:2.5px solid #FF6B18;border-radius:4px;pointer-events:none;animation:pulseHS 1.8s ease-in-out infinite;}
  @keyframes pulseHS{0%,100%{box-shadow:0 0 0 2px rgba(255,107,24,.6),0 0 0 6px rgba(255,107,24,.2);}50%{box-shadow:0 0 0 4px rgba(255,107,24,.8),0 0 0 10px rgba(255,107,24,.1);}}
  .tooltip-bubble{position:absolute;width:280px;border-radius:6px;padding:10px 13px;font-size:12px;line-height:1.6;color:#111;box-shadow:0 4px 20px rgba(0,0,0,.35);border:1px solid rgba(0,0,0,.15);animation:bubbleIn .25s ease;}
  @keyframes bubbleIn{from{opacity:0;transform:scale(.93);}to{opacity:1;transform:scale(1);}}
  .tooltip-bubble.hint-bubble{border:1.5px dashed rgba(0,0,0,.25)!important;font-style:italic;}.hint-icon{margin-right:5px;font-style:normal;}
  .tooltip-bubble::after{content:'';position:absolute;border:8px solid transparent;}
  .tooltip-bubble.arrow-top-right::after{top:-16px;right:16px;border-bottom-width:8px;}.tooltip-bubble.arrow-top-left::after{top:-16px;left:16px;border-bottom-width:8px;}
  .tooltip-bubble.arrow-right::after{right:-16px;top:14px;border-left-width:8px;}.tooltip-bubble.arrow-left::after{left:-16px;top:14px;border-right-width:8px;}
  .cover-slide{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:40px;min-width:500px;}
  .cover-logo{height:44px;display:block;margin-bottom:28px;filter:brightness(0) invert(1);}
  .cover-slide h1{font-size:26px;font-weight:700;line-height:1.3;max-width:520px;margin-bottom:16px;}
  .cover-slide .toc-list{list-style:none;margin-top:20px;}.cover-slide .toc-list li{display:flex;align-items:center;gap:10px;padding:6px 0;font-size:13px;color:#c8cdd9;border-bottom:1px solid rgba(255,255,255,.07);}
  .cover-slide .toc-num{width:22px;height:22px;background:rgba(255,107,24,.2);border:1px solid #FF6B18;color:#FF6B18;border-radius:50%;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
  .cover-btn{margin-top:28px;background:#FF6B18;color:#fff;border:none;border-radius:6px;padding:11px 28px;font-size:14px;font-weight:600;cursor:pointer;}.cover-btn:hover{background:#e05a0d;}
  .intro-slide{max-width:540px;padding:32px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:10px;}
  .intro-slide .topic-pill{display:inline-block;background:rgba(255,107,24,.15);color:#FF6B18;border:1px solid rgba(255,107,24,.3);padding:3px 10px;border-radius:99px;font-size:11px;font-weight:600;margin-bottom:14px;}
  .intro-slide h2{font-size:18px;font-weight:700;margin-bottom:12px;}.intro-slide .intro-body{font-size:13px;color:#c8cdd9;line-height:1.7;}.intro-slide .intro-body strong{color:#fff;}
  .nav-arrow{position:absolute;top:50%;transform:translateY(-50%);width:44px;height:44px;border-radius:50%;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);color:#fff;cursor:pointer;font-size:18px;display:flex;align-items:center;justify-content:center;transition:all .15s;z-index:20;}
  .nav-arrow:hover{background:rgba(255,255,255,.16);}.nav-arrow:disabled{opacity:.2;cursor:not-allowed;}#nav-prev{left:16px;}#nav-next{right:16px;}
  #bottombar{height:56px;flex-shrink:0;background:#1b1f2e;border-top:1px solid rgba(255,255,255,.08);display:flex;align-items:center;justify-content:center;gap:8px;padding:0 20px;}
  .dot-nav{width:7px;height:7px;border-radius:50%;background:rgba(255,255,255,.2);cursor:pointer;transition:all .2s;border:none;padding:0;}.dot-nav.active{background:#FF6B18;width:22px;border-radius:4px;}.dot-nav:hover:not(.active){background:rgba(255,255,255,.4);}
  .frame-badge{position:absolute;top:10px;left:10px;font-size:10px;font-weight:600;padding:3px 8px;border-radius:99px;letter-spacing:.4px;}.frame-badge.normal{background:rgba(255,107,24,.85);color:#fff;}.frame-badge.explanation{background:rgba(43,123,229,.85);color:#fff;}
  .step-chip{position:absolute;bottom:10px;right:10px;font-size:10px;font-weight:600;padding:3px 9px;border-radius:99px;background:rgba(0,0,0,.55);color:#fff;}
  .key-hint{position:absolute;bottom:10px;left:50%;transform:translateX(-50%);font-size:10px;color:rgba(255,255,255,.3);}
</style></head><body>
<div id="app">
  <div id="topbar">
    <div class="tb-brand">${tbLogo}<div class="tb-sep"></div><span class="tb-topic" id="tb-topic"></span></div>
    <div class="tb-progress"><span id="tb-label"></span><div class="tb-bar"><div class="tb-bar-fill" id="tb-fill"></div></div></div>
    <button class="tb-close" onclick="window.close()">✕</button>
  </div>
  <div id="stage" style="position:relative;">
    <div id="screenshot-container"></div>
    <button class="nav-arrow" id="nav-prev" onclick="go(-1)">&#8592;</button>
    <button class="nav-arrow" id="nav-next" onclick="go(1)">&#8594;</button>
    <span class="key-hint">← → to navigate</span>
  </div>
  <div id="bottombar"></div>
</div>
<script>
const SLIDES=${JSON.stringify(slides)};
const COVER=${JSON.stringify(coverLogo)};
let cur=0;
function h(s){if(!s)return'';return s.map(seg=>{if(seg.type==='br')return'<br>';return(seg.segs||[]).map(s=>{let t=s.text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');if(s.bold)t='<strong>'+t+'</strong>';if(s.italic)t='<em>'+t+'</em>';if(s.underline)t='<u>'+t+'</u>';if(s.color)t='<span style="color:'+s.color+'">'+t+'</span>';return t;}).join('');}).filter(Boolean).join('');}
function render(i){cur=Math.max(0,Math.min(SLIDES.length-1,i));const slide=SLIDES[cur];const c=document.getElementById('screenshot-container');c.style.opacity='0';c.style.transform='scale(0.98)';setTimeout(()=>{c.innerHTML=buildHtml(slide);applyOverlays(slide,c);c.style.opacity='1';c.style.transform='scale(1)';updateUI(slide);},180);}
function buildHtml(s){
  if(s.type==='cover')return'<div class="cover-slide">'+COVER+'<h1>'+s.title.replace(/</g,'&lt;')+'</h1>'+(s.topics.length>1?'<ul class="toc-list">'+s.topics.map((t,i)=>'<li><span class="toc-num">'+(i+1)+'</span><span>'+t.replace(/</g,'&lt;')+'</span></li>').join('')+'</ul>':'')+'<button class="cover-btn" onclick="go(1)">Start &#8594;</button></div>';
  if(s.type==='intro')return'<div class="intro-slide"><span class="topic-pill">'+s.topic.replace(/</g,'&lt;')+'</span><h2>In this tutorial</h2><div class="intro-body">'+h(s.intro.segments)+'</div></div>';
  const img=s.imageB64?'<img id="screenshot-img" src="'+s.imageB64+'" draggable="false" />':'<div style="width:640px;height:480px;background:#25223B;display:flex;align-items:center;justify-content:center;color:#6b7280;">No screenshot</div>';
  return img+'<span class="frame-badge '+((s.frameType||'').toLowerCase())+'">'+( s.frameType==='Explanation'?'Explanation':'Action')+'</span><span class="step-chip">Step '+s.stepNum+' / '+s.totalSteps+'</span>';
}
function applyOverlays(s,c){
  if(s.type!=='step'||!s.imageB64)return;
  const img=c.querySelector('#screenshot-img');if(!img)return;
  function go(){
    const dW=img.offsetWidth,dH=img.offsetHeight;if(!dW||!dH)return;
    const sx=dW/s.screenW,sy=dH/s.screenH;
    const hs=s.hotspot;
    if(hs&&!hs.isNextBtn){const el=document.createElement('div');el.className='hotspot-box';el.style.cssText='left:'+Math.round(hs.left*sx)+'px;top:'+Math.round(hs.top*sy)+'px;width:'+Math.round((hs.right-hs.left)*sx)+'px;height:'+Math.round((hs.bottom-hs.top)*sy)+'px;';c.appendChild(el);}
    const bub=s.bubble,bp=s.bubblePos;
    if(bub&&bp&&bub.segments&&bub.segments.length){
      const px=Math.round(bp.x*sx),py=Math.round(bp.y*sy),bw=Math.min(280,dW*0.38),bgC=bub.bgColor||'#C0FFFF';
      let left,top,ac;const ptr=(s.pointer||'None').toLowerCase();
      if(ptr==='topright'){left=Math.max(4,px-bw);top=py;ac='arrow-top-right';}
      else if(ptr==='topleft'){left=px;top=py;ac='arrow-top-left';}
      else if(ptr==='righttop'||ptr==='right'){left=Math.max(4,px-bw-12);top=Math.max(4,py-20);ac='arrow-right';}
      else if(ptr==='lefttop'||ptr==='left'){left=px+12;top=Math.max(4,py-20);ac='arrow-left';}
      else{left=Math.max(4,px-bw/2);top=Math.max(4,py-40);ac='';}
      left=Math.max(4,Math.min(left,dW-bw-4));top=Math.max(4,Math.min(top,dH-60));
      const isHint=!!(bub.isAutoHint);
      const bEl=document.createElement('div');bEl.className='tooltip-bubble '+ac+(isHint?' hint-bubble':'');bEl.style.cssText='left:'+left+'px;top:'+top+'px;width:'+bw+'px;background:'+bgC+';';
      const cls='b'+Math.random().toString(36).slice(2,8);bEl.classList.add(cls);
      const st=document.createElement('style');
      if(ac==='arrow-top-right'||ac==='arrow-top-left')st.textContent='.'+cls+'::after{border-bottom-color:'+bgC+'!important;}';
      else if(ac==='arrow-right')st.textContent='.'+cls+'::after{border-left-color:'+bgC+'!important;}';
      else if(ac==='arrow-left')st.textContent='.'+cls+'::after{border-right-color:'+bgC+'!important;}';
      document.head.appendChild(st);
      bEl.innerHTML=(isHint?'<span class="hint-icon"><svg width="10" height="10" viewBox="0 0 10 10" fill="none" style="vertical-align:middle;"><path d="M1.5 1L9 4.5 5 5.2 4.3 9z" fill="#777" stroke="#555" stroke-width=".4" stroke-linejoin="round"/></svg></span>':'')+h(bub.segments);
      c.appendChild(bEl);
    }
  }
  if(img.complete)go();else img.addEventListener('load',go,{once:true});
}
function updateUI(s){
  document.getElementById('tb-topic').textContent=s.topic||(s.type==='cover'?'Overview':'');
  document.getElementById('tb-fill').style.width=(SLIDES.length>1?Math.round(cur/(SLIDES.length-1)*100):100)+'%';
  document.getElementById('tb-label').textContent=s.type==='step'?'Step '+s.stepNum+' of '+s.totalSteps:(s.type==='cover'?'Overview':'Introduction');
  document.getElementById('nav-prev').disabled=cur===0;document.getElementById('nav-next').disabled=cur===SLIDES.length-1;
  const bar=document.getElementById('bottombar');bar.innerHTML='';
  for(let i=0;i<Math.min(SLIDES.length,32);i++){const d=document.createElement('button');d.className='dot-nav'+(i===cur?' active':'');d.onclick=()=>render(i);bar.appendChild(d);}
}
function go(d){render(cur+d);}
document.addEventListener('keydown',e=>{if(e.key==='ArrowRight'||e.key===' '){e.preventDefault();go(1);}if(e.key==='ArrowLeft'){e.preventDefault();go(-1);}if(e.key==='Escape')window.close();});
render(0);
</script></body></html>`;
}

// ── Helper: base64 data-URI → Uint8Array ───────────────────────────
function dataUriToUint8Array(dataUri) {
  const base64 = dataUri.split(',')[1];
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

// ── Public: generate DOCX ─────────────────────────────────────────
export async function generateDocx(topics, docName, logoB64 = null, includeTooltips = true) {
  const { Document, Paragraph, TextRun, ImageRun, HeadingLevel, AlignmentType, Packer, BorderStyle, ShadingType } = await import('docx');

  const ORANGE = 'FF6B18', NAVY = '25223B';
  const children = [];

  // Cover heading
  children.push(new Paragraph({
    children: [new TextRun({ text: docName || topics.map(t => t.title).join(' · '), bold: true, size: 48, color: NAVY })],
    heading: HeadingLevel.TITLE,
    spacing: { after: 240 },
  }));
  children.push(new Paragraph({
    children: [new TextRun({ text: `Generated ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`, size: 20, color: '6b7280' })],
    spacing: { after: 600 },
  }));

  for (const topic of topics) {
    // Topic heading
    children.push(new Paragraph({
      children: [new TextRun({ text: topic.title, bold: true, size: 32, color: NAVY })],
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 480, after: 200 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: ORANGE } },
    }));

    if (topic.intro?.segments?.length) {
      const introText = topic.intro.segments.filter(s => s.type === 'line').flatMap(s => s.segs).map(s => s.text).join('');
      children.push(new Paragraph({
        children: [new TextRun({ text: introText, italics: true, size: 20, color: '374151' })],
        spacing: { after: 200 },
        shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'EFF6FF' },
      }));
    }

    for (const step of topic.steps) {
      // Step label
      children.push(new Paragraph({
        children: [new TextRun({ text: `Step ${step.stepNum}`, bold: true, size: 18, color: ORANGE, allCaps: true })],
        spacing: { before: 240, after: 80 },
      }));

      // Screenshot image
      if (step.imageB64) {
        try {
          const imgData = dataUriToUint8Array(step.imageB64);
          const ext = step.imageB64.split(';')[0].split('/')[1];
          const imgType = ext === 'jpeg' || ext === 'jpg' ? 'jpg' : 'png';
          children.push(new Paragraph({
            children: [new ImageRun({ data: imgData, transformation: { width: 580, height: Math.round(580 * step.screenH / step.screenW) }, type: imgType })],
            spacing: { after: 120 },
          }));
        } catch { /* skip if image fails */ }
      }

      // Bubble text caption
      if (includeTooltips && step.bubble?.segments?.length) {
        const bubbleText = step.bubble.segments.filter(s => s.type === 'line').flatMap(s => s.segs).map(s => s.text).join(' ');
        if (bubbleText.trim()) {
          children.push(new Paragraph({
            children: [new TextRun({ text: bubbleText, size: 19, color: '1f2937' })],
            spacing: { after: 200 },
            shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'F9F9F2' },
            border: { left: { style: BorderStyle.SINGLE, size: 12, color: ORANGE } },
            indent: { left: 180 },
          }));
        }
      }
    }
  }

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBlob(doc);
}

// ── Public: generate PPTX ─────────────────────────────────────────
export async function generatePptx(topics, docName, logoB64 = null, includeTooltips = true) {
  const PptxGenJS = (await import('pptxgenjs')).default;
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE'; // 13.33" x 7.5"

  // Cover slide
  const cover = pptx.addSlide();
  cover.background = { color: '25223B' };
  cover.addShape(pptx.ShapeType.rect, { x: 0, y: 6.8, w: 13.33, h: 0.06, fill: { color: 'FF6B18' } });
  if (logoB64) {
    cover.addImage({ data: logoB64, x: 0.6, y: 0.6, w: 2.2, h: 0.62 });
  }
  cover.addText(docName || topics.map(t => t.title).join(' · '), { x: 0.6, y: 2.2, w: 12, h: 1.6, fontSize: 32, bold: true, color: 'FFFFFF', fontFace: 'Segoe UI', wrap: true });
  cover.addText(new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }), { x: 0.6, y: 4.0, w: 8, h: 0.4, fontSize: 13, color: '9ca3af', fontFace: 'Segoe UI' });

  for (const topic of topics) {
    // Section title slide
    const titleSlide = pptx.addSlide();
    titleSlide.background = { color: 'F9F9F2' };
    titleSlide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.07, h: 7.5, fill: { color: 'FF6B18' } });
    titleSlide.addText(topic.title, { x: 0.4, y: 2.8, w: 12.5, h: 1.2, fontSize: 28, bold: true, color: '25223B', fontFace: 'Segoe UI', wrap: true });
    if (topic.intro?.segments?.length) {
      const introText = topic.intro.segments.filter(s => s.type === 'line').flatMap(s => s.segs).map(s => s.text).join(' ');
      titleSlide.addText(introText, { x: 0.4, y: 4.2, w: 12.5, h: 1.4, fontSize: 14, color: '374151', fontFace: 'Segoe UI', wrap: true });
    }

    for (const step of topic.steps) {
      const slide = pptx.addSlide();
      slide.background = { color: 'FFFFFF' };

      // Header bar
      slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.33, h: 0.55, fill: { color: '25223B' } });
      slide.addText(`${topic.title}  ·  Step ${step.stepNum} of ${topic.steps.length}`, { x: 0.2, y: 0, w: 10, h: 0.55, fontSize: 11, color: 'FFFFFF', fontFace: 'Segoe UI', valign: 'middle' });
      slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0.55, w: 13.33, h: 0.04, fill: { color: 'FF6B18' } });

      // Screenshot
      if (step.imageB64) {
        try {
          const imgH = Math.min(5.6, 5.6 * step.screenH / step.screenW * (13.33 / step.screenW) * step.screenW);
          const scaledH = Math.round(5.6 * step.screenH / step.screenW);
          const dispH = Math.min(5.6, scaledH > 5.6 ? 5.6 : scaledH);
          slide.addImage({ data: logoB64 ? step.imageB64 : step.imageB64, x: 0.2, y: 0.7, w: 12.93, h: dispH });
        } catch { /* skip */ }
      }

      // Bubble text
      if (includeTooltips && step.bubble?.segments?.length) {
        const bubbleText = step.bubble.segments.filter(s => s.type === 'line').flatMap(s => s.segs).map(s => s.text).join(' ');
        if (bubbleText.trim()) {
          const bgColor = (step.bubble.bgColor || '#C0FFFF').replace('#', '');
          slide.addText(bubbleText, {
            x: 0.2, y: 6.6, w: 12.93, h: 0.8,
            fontSize: 11, color: '111827', fontFace: 'Segoe UI', wrap: true,
            fill: { color: bgColor },
            line: { color: 'e5e7eb', width: 0.5 },
            inset: 0.08,
          });
        }
      }
    }
  }

  const ab = await pptx.write({ outputType: 'arraybuffer' });
  return new Blob([ab], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
}
