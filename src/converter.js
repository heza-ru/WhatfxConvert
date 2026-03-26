const AdmZip    = require('adm-zip');
const xml2js    = require('xml2js');
const path      = require('path');
const fs        = require('fs');
const puppeteer = require('puppeteer');

const parser = new xml2js.Parser({ explicitArray: true, ignoreAttrs: false });

// ── Logo (embedded once at load time) ─────────────────────────────
const LOGO_PATH = path.join(__dirname, '..', 'public', 'Whatfix_logo.png');
const LOGO_B64  = fs.existsSync(LOGO_PATH)
  ? 'data:image/png;base64,' + fs.readFileSync(LOGO_PATH).toString('base64')
  : null;

// ── XML helpers ────────────────────────────────────────────────────
async function parseXml(xmlString) {
  return parser.parseStringPromise(xmlString.replace(/^\uFEFF/, ''));
}

function extractSegments(bubbleTextEl) {
  const segments = [];
  for (const p of (bubbleTextEl.p || [])) {
    const fmts = Array.isArray(p.fmt) ? p.fmt : [];
    const segs = [];
    for (const fmt of fmts) {
      const text = typeof fmt === 'string' ? fmt : (fmt._ || '');
      if (!text.trim()) continue;
      const attrs = fmt.$ || {};
      const sty   = attrs.sty || '';
      segs.push({ text, bold: sty.includes('b'), italic: sty.includes('i'), underline: sty.includes('u'), color: attrs.clr || null });
    }
    if (segs.length) segments.push({ type: 'line', segs });
    else if (segments.length) segments.push({ type: 'br' });
  }
  return segments;
}

function extractBubbleData(bubble) {
  if (!bubble) return null;
  const bt = (bubble.BubbleText || [])[0];
  if (!bt) return null;
  return { bgColor: bt.$ ? (bt.$.BgColor || '#C0FFFF') : '#C0FFFF', segments: extractSegments(bt) };
}

// ── Interaction hint for empty-text action steps ───────────────────
const EVENT_VERB = {
  LClick1: 'Click',  LClick2: 'Click',
  RClick1: 'Right-click',
  DClick1: 'Double-click',
  Type:    'Type in',
  Drag:    'Drag',
};
const ROLE_SUFFIX = {
  ROLE_SYSTEM_BUTTONMENU: 'menu',
  ROLE_SYSTEM_PUSHBUTTON: 'button',
  ROLE_SYSTEM_LINK:       'link',
  ROLE_SYSTEM_TEXT:       'field',
  ROLE_SYSTEM_LISTITEM:   'option',
  ROLE_SYSTEM_COMBOBOX:   'dropdown',
  ROLE_SYSTEM_MENUITEM:   'menu item',
  ROLE_SYSTEM_CHECKBOX:   'checkbox',
  ROLE_SYSTEM_RADIOBUTTON:'radio button',
};

function buildInteractionHint(eventType, objName, objType) {
  const verb   = EVENT_VERB[eventType] || 'Interact with';
  const suffix = ROLE_SUFFIX[objType]  || '';
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
    const actions = frame.raw.Actions?.[0]?.Action || [];
    cur = (actions[0]?.$.TargetFrame || '').replace(/^\//, '') || null;
  }
  return ordered;
}

// ── Topic parser ───────────────────────────────────────────────────
async function parseTopic(topicXml, topicDir) {
  const parsed = await parseXml(topicXml);
  const topic  = parsed.Topic;

  const screenW = parseInt(topic.ScreenResolution?.[0]?.$?.Width  || '1280', 10);
  const screenH = parseInt(topic.ScreenResolution?.[0]?.$?.Height || '1024', 10);

  // Intro
  let intro = null;
  const introEl = topic.IntroFrame?.[0];
  if (introEl?.Bubble?.[0]) {
    const d = extractBubbleData(introEl.Bubble[0]);
    if (d?.segments?.length) intro = d;
  }

  // Build frame map
  const rawFrames = topic.Frames?.[0]?.Frame || [];
  const frameMap  = {};
  for (const f of rawFrames) {
    const id   = f.$.ID;
    const ssEl = f.Screenshot?.[0];
    const img  = ssEl?.$?.['xlink:href'] || null;
    const imgPath = img ? path.join(topicDir, img) : null;

    const actions = f.Actions?.[0]?.Action || [];
    const act     = actions[0];
    let bubble = null, hotspot = null, bubblePos = null, pointer = null;
    let actionEventType = null, actionObjectName = null, actionObjectType = null;

    if (act) {
      const hs = act.Hotspots?.[0]?.Hotspot?.[0];
      if (hs) {
        hotspot = {
          top:    parseInt(hs.$.Top,    10),
          left:   parseInt(hs.$.Left,   10),
          bottom: parseInt(hs.$.Bottom, 10),
          right:  parseInt(hs.$.Right,  10),
          isNextBtn: (parseInt(hs.$.Top, 10) === 492 && parseInt(hs.$.Left, 10) === 620),
        };
      }
      const ab = act.ActionBubble?.[0];
      if (ab) {
        bubblePos = { x: parseInt(ab.$.PosX, 10), y: parseInt(ab.$.PosY, 10) };
        pointer   = ab.$.Pointer || 'None';
        bubble    = extractBubbleData(ab.Bubble?.[0]);
      }
      // Action metadata for hint generation
      const evt = act.Event?.[0];
      const obj = act.Object?.[0];
      actionEventType   = evt?.$?.Type || null;
      const rawName     = obj?.Name?.[0];
      actionObjectName  = typeof rawName === 'object' ? (rawName._ || '') : (rawName || '');
      actionObjectType  = obj?.Type?.[0] || null;
    }

    // If bubble has no visible text but we have action metadata, synthesise a hint
    const hasText = bubble?.segments?.some(s => s.type === 'line');
    if (!hasText && (actionEventType || actionObjectName)) {
      const hint = buildInteractionHint(actionEventType, actionObjectName, actionObjectType);
      if (hint) {
        bubble = {
          bgColor:    '#FFF3CD',           // warm amber — visually distinct from info bubbles
          segments:   [{ type: 'line', segs: [{ text: hint, bold: false, italic: false, underline: false, color: null }] }],
          isAutoHint: true,
        };
      }
    }

    frameMap[id] = { id, type: f.$.Type, imgPath, bubble, hotspot, bubblePos, pointer, raw: f };
  }

  // Order and build steps
  const ordered = orderFrames(frameMap, rawFrames[0]?.$.ID);
  const steps   = [];
  let stepNum   = 0;
  for (const frame of ordered) {
    if (frame.type === 'End') continue;
    if (!frame.bubble?.segments?.length && !frame.imgPath) continue;
    stepNum++;
    steps.push({
      stepNum,
      frameType: frame.type,
      imagePath: frame.imgPath && fs.existsSync(frame.imgPath) ? frame.imgPath : null,
      hotspot:   frame.hotspot,
      bubble:    frame.bubble,
      bubblePos: frame.bubblePos,
      pointer:   frame.pointer,
      screenW,
      screenH,
    });
  }

  return { intro, steps, screenW, screenH };
}

// ── Manifest parser ────────────────────────────────────────────────
async function parseManifest(manifestXml) {
  const parsed = await parseXml(manifestXml);
  const il     = parsed['import:ImportList'];
  const docs   = [];
  for (const ii of il['import:ImportInto'] || []) {
    for (const doc of ii['import:Document'] || []) {
      docs.push({
        folder: doc['import:ImportFolder']?.[0],
        id:     doc['import:ID']?.[0],
        title:  doc['import:Title']?.[0],
        type:   doc['import:Type']?.[0],
        schema: doc['import:SchemaNamespace']?.[0],
      });
    }
  }
  return docs;
}

// ── Fast manifest inspection (no image extraction) ─────────────────
async function inspectOdarc(odarcPath) {
  const zip      = new AdmZip(odarcPath);
  const mEntry   = zip.getEntry('manifest.xml');
  if (!mEntry) throw new Error('No manifest.xml found');
  const docs     = await parseManifest(mEntry.getData().toString('utf8'));
  return docs
    .filter(d => d.schema === 'urn:topic-v1')
    .map(d => ({ id: d.id, title: d.title }));
}

// ── Full extraction ────────────────────────────────────────────────
async function extractTopics(odarcPath, allowedIds = null) {
  const tmpDir = path.join(require('os').tmpdir(), 'odarc_' + Date.now() + '_' + Math.random().toString(36).slice(2));
  fs.mkdirSync(tmpDir, { recursive: true });

  const zip = new AdmZip(odarcPath);
  zip.extractAllTo(tmpDir, true);

  const manifestXml = fs.readFileSync(path.join(tmpDir, 'manifest.xml'), 'utf8');
  const docs        = await parseManifest(manifestXml);
  let topicDocs     = docs.filter(d => d.schema === 'urn:topic-v1');
  if (allowedIds?.length) topicDocs = topicDocs.filter(d => allowedIds.includes(d.id));

  const topics = [];
  for (const doc of topicDocs) {
    const topicDir  = path.join(tmpDir, doc.folder);
    const topicFile = path.join(topicDir, 'topic.xml');
    if (!fs.existsSync(topicFile)) continue;
    const data = await parseTopic(fs.readFileSync(topicFile, 'utf8'), topicDir);
    topics.push({ title: doc.title, ...data, _tmpDir: tmpDir });
  }

  return { topics, tmpDir };
}

// ── PDF conversion ─────────────────────────────────────────────────
async function convertOdarcToPdf(odarcPath, outputPath, progressCallback, allowedIds = null) {
  const log    = msg => progressCallback?.(msg);
  const tmpDir = path.join(require('os').tmpdir(), 'odarc_pdf_' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    log('Extracting archive…');
    new AdmZip(odarcPath).extractAllTo(tmpDir, true);

    log('Parsing manifest…');
    const docs      = await parseManifest(fs.readFileSync(path.join(tmpDir, 'manifest.xml'), 'utf8'));
    let topicDocs   = docs.filter(d => d.schema === 'urn:topic-v1');
    if (allowedIds?.length) topicDocs = topicDocs.filter(d => allowedIds.includes(d.id));
    if (!topicDocs.length) throw new Error('No matching topics found');

    const allTopics = [];
    for (const doc of topicDocs) {
      log(`Parsing: ${doc.title}…`);
      const topicDir  = path.join(tmpDir, doc.folder);
      const topicFile = path.join(topicDir, 'topic.xml');
      if (!fs.existsSync(topicFile)) continue;
      const data = await parseTopic(fs.readFileSync(topicFile, 'utf8'), topicDir);
      allTopics.push({ title: doc.title, ...data });
    }

    log('Generating annotated HTML…');
    const html     = generatePdfHtml(allTopics);
    const htmlPath = path.join(tmpDir, 'out.html');
    fs.writeFileSync(htmlPath, html);

    log('Rendering PDF…');
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page    = await browser.newPage();
    await page.goto('file://' + htmlPath, { waitUntil: 'networkidle0', timeout: 90000 });
    await page.pdf({ path: outputPath, format: 'A4', printBackground: true, margin: { top: '15mm', bottom: '15mm', left: '12mm', right: '12mm' } });
    await browser.close();
    log('Done!');
    return outputPath;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

// ── HTML / PDF generators ──────────────────────────────────────────
function imgBase64(p) {
  if (!p || !fs.existsSync(p)) return null;
  const ext  = path.extname(p).slice(1).toLowerCase();
  const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
  return `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`;
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

function bubbleCss(step, dispW, dispH) {
  if (!step.bubblePos) return null;
  const sx = dispW / step.screenW, sy = dispH / step.screenH;
  const px = Math.round(step.bubblePos.x * sx);
  const py = Math.round(step.bubblePos.y * sy);
  const bw = 280;
  const ptr = (step.pointer || 'None').toLowerCase();
  let left, top, arrowClass;

  if (ptr === 'topright')                    { left = Math.max(4, px - bw); top = py;              arrowClass = 'arrow-top-right'; }
  else if (ptr === 'topleft')                { left = px;                   top = py;              arrowClass = 'arrow-top-left';  }
  else if (ptr === 'righttop' || ptr === 'right') { left = Math.max(4, px - bw - 12); top = Math.max(4, py - 20); arrowClass = 'arrow-right'; }
  else if (ptr === 'lefttop'  || ptr === 'left')  { left = px + 12;               top = Math.max(4, py - 20); arrowClass = 'arrow-left';  }
  else                                       { left = Math.max(4, px - bw / 2); top = Math.max(4, py - 40); arrowClass = ''; }

  left = Math.min(Math.max(4, left), dispW - bw - 8);
  top  = Math.max(4, top);
  return { left, top, arrowClass, bw };
}

function hotspotCss(step, dispW, dispH) {
  if (!step.hotspot || step.hotspot.isNextBtn) return null;
  const sx = dispW / step.screenW, sy = dispH / step.screenH;
  return { left: Math.round(step.hotspot.left * sx), top: Math.round(step.hotspot.top * sy), width: Math.round((step.hotspot.right - step.hotspot.left) * sx), height: Math.round((step.hotspot.bottom - step.hotspot.top) * sy) };
}

function generatePdfHtml(allTopics) {
  const DISP_W = 600;

  const logoHtml = LOGO_B64
    ? `<img src="${LOGO_B64}" alt="Whatfix" style="height:28px;display:block;margin-bottom:20px;" />`
    : `<div style="font-size:22px;font-weight:800;color:#fff;margin-bottom:20px;">Whatfix</div>`;

  const sections = allTopics.map((topic, ti) => {
    const DISP_H = Math.round(DISP_W * topic.screenH / topic.screenW);

    const introHtml = topic.intro ? `
      <div class="intro-block">
        <div class="intro-icon">ℹ</div>
        <div class="intro-body">${segmentsToHtml(topic.intro.segments)}</div>
      </div>` : '';

    const stepsHtml = topic.steps.map(step => {
      const b64  = imgBase64(step.imagePath);
      const bPos = step.bubble ? bubbleCss(step, DISP_W, DISP_H) : null;
      const hPos = hotspotCss(step, DISP_W, DISP_H);
      const bgC  = step.bubble?.bgColor || '#C0FFFF';
      const isHint = step.bubble?.isAutoHint;

      const hotspotEl = hPos ? `<div class="hs-box" style="left:${hPos.left}px;top:${hPos.top}px;width:${hPos.width}px;height:${hPos.height}px;"></div>` : '';

      let bubbleEl = '';
      if (bPos && step.bubble?.segments?.length) {
        // Arrow colour
        const arrowColour = isHint ? '#FFF3CD' : bgC;
        bubbleEl = `<div class="bubble ${bPos.arrowClass}${isHint ? ' hint' : ''}" style="left:${bPos.left}px;top:${bPos.top}px;width:${bPos.bw}px;background:${bgC};--arrow-color:${arrowColour};">
          ${isHint ? '<span class="hint-icon">👆</span>' : ''}${segmentsToHtml(step.bubble.segments)}
        </div>`;
      }

      const imgEl = b64
        ? `<img src="${b64}" width="${DISP_W}" height="${DISP_H}" />`
        : `<div style="width:${DISP_W}px;height:${DISP_H}px;background:#f3f4f6;display:flex;align-items:center;justify-content:center;color:#9ca3af;">No screenshot</div>`;

      const captionHtml = step.bubble?.segments?.length
        ? `<div class="step-caption${isHint ? ' caption-hint' : ''}">${isHint ? '👆 ' : ''}${segmentsToHtml(step.bubble.segments)}</div>`
        : '';

      return `<div class="step-wrap">
        <div class="step-label">Step ${step.stepNum}</div>
        <div class="sc" style="width:${DISP_W}px;height:${DISP_H}px;">${imgEl}${hotspotEl}${bubbleEl}</div>
        ${captionHtml}
      </div>`;
    }).join('');

    return `<div class="topic-section${ti > 0 ? ' page-break' : ''}">
      <div class="topic-header">
        <div class="topic-num">${ti + 1}</div>
        <h1>${escHtml(topic.title)}</h1>
      </div>
      ${introHtml}${stepsHtml}
    </div>`;
  }).join('');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Segoe UI',Arial,sans-serif;font-size:12px;color:#111;background:#fff;line-height:1.5}
  .cover{background:linear-gradient(135deg,#1e2235,#2d3355);color:#fff;padding:50px 40px;margin-bottom:30px;}
  .cover h1{font-size:26px;font-weight:700;margin-bottom:8px;}
  .cover-date{font-size:11px;opacity:.6;margin-top:6px;}
  .toc{padding:18px 40px 26px;border-bottom:1px solid #e5e7eb;margin-bottom:20px;}
  .toc-title{font-size:13px;font-weight:700;color:#1e2235;border-bottom:2px solid #e87722;display:inline-block;padding-bottom:3px;margin-bottom:10px;}
  .toc-item{display:flex;align-items:center;gap:10px;padding:4px 0;font-size:11.5px;color:#374151;}
  .toc-dot{width:18px;height:18px;background:#e87722;color:#fff;border-radius:50%;font-size:9px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
  .topic-section{padding:0 30px 20px;}
  .topic-header{display:flex;align-items:center;gap:12px;background:linear-gradient(90deg,#1e2235,#2d3355);padding:12px 18px;border-radius:6px;margin-bottom:16px;color:#fff;}
  .topic-num{width:26px;height:26px;border:2px solid rgba(255,255,255,.35);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;}
  .topic-header h1{font-size:15px;font-weight:700;}
  .intro-block{display:flex;gap:10px;background:#f0f7ff;border-left:3px solid #2b7be5;border-radius:4px;padding:10px 12px;margin-bottom:14px;font-size:11px;color:#1a3a5c;line-height:1.6;}
  .intro-icon{font-size:14px;color:#2b7be5;flex-shrink:0;}
  .step-wrap{margin-bottom:22px;break-inside:avoid;}
  .step-label{font-size:10px;font-weight:700;color:#e87722;text-transform:uppercase;letter-spacing:.5px;margin-bottom:5px;}
  .sc{position:relative;overflow:hidden;border:1px solid #e5e7eb;border-radius:4px;}
  .sc img{display:block;width:100%;height:100%;object-fit:cover;}
  .hs-box{position:absolute;border:2.5px solid #e87722;border-radius:3px;box-shadow:0 0 0 3px rgba(232,119,34,.25);}
  .bubble{position:absolute;border-radius:5px;padding:7px 10px;font-size:10px;line-height:1.55;color:#111;box-shadow:0 2px 10px rgba(0,0,0,.22);border:1px solid rgba(0,0,0,.12);}
  .bubble.hint{border:1.5px dashed rgba(0,0,0,.2);}
  .hint-icon{margin-right:4px;}
  .bubble::after{content:'';position:absolute;border:7px solid transparent;}
  .arrow-top-right::after{top:-14px;right:12px;border-bottom-color:var(--arrow-color,inherit);}
  .arrow-top-left::after{top:-14px;left:12px;border-bottom-color:var(--arrow-color,inherit);}
  .arrow-right::after{right:-14px;top:10px;border-left-color:var(--arrow-color,inherit);}
  .arrow-left::after{left:-14px;top:10px;border-right-color:var(--arrow-color,inherit);}
  .step-caption{margin-top:6px;font-size:11px;color:#374151;line-height:1.6;padding:6px 10px;background:#fafafa;border-left:3px solid #e87722;border-radius:0 3px 3px 0;}
  .step-caption.caption-hint{background:#fffbf0;border-left-color:#f59e0b;}
  .page-break{page-break-before:always;}
</style></head><body>

<div class="cover">
  ${logoHtml}
  <h1>${escHtml(allTopics.map(t => t.title).join(' · '))}</h1>
  <div class="cover-date">Generated ${new Date().toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})}</div>
</div>

${allTopics.length > 1 ? `<div class="toc">
  <div class="toc-title">Contents</div>
  ${allTopics.map((t,i)=>`<div class="toc-item"><span class="toc-dot">${i+1}</span><span>${escHtml(t.title)}</span></div>`).join('')}
</div>` : ''}

${sections}
</body></html>`;
}

function escHtml(s) {
  return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

module.exports = { convertOdarcToPdf, extractTopics, inspectOdarc };
