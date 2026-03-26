const fs   = require('fs');
const path = require('path');

const LOGO_PATH = path.join(__dirname, '..', 'public', 'Whatfix_logo.png');
const LOGO_B64  = fs.existsSync(LOGO_PATH)
  ? 'data:image/png;base64,' + fs.readFileSync(LOGO_PATH).toString('base64')
  : null;

function escHtml(s) {
  return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function imgBase64(p) {
  if (!p || !fs.existsSync(p)) return null;
  const ext  = path.extname(p).slice(1).toLowerCase();
  const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
  return `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`;
}

function segmentsToHtml(segments) {
  return segments.map(seg => {
    if (seg.type === 'br') return '<br>';
    return seg.segs.map(s => {
      let tag = escHtml(s.text);
      if (s.bold)      tag = `<strong>${tag}</strong>`;
      if (s.italic)    tag = `<em>${tag}</em>`;
      if (s.underline) tag = `<u>${tag}</u>`;
      if (s.color)     tag = `<span style="color:${s.color}">${tag}</span>`;
      return tag;
    }).join('');
  }).filter(Boolean).join('');
}

/**
 * Generate a self-contained, single-file interactive preview HTML.
 * All images are inlined as base64. No external dependencies.
 */
function generatePreviewHtml(topics, docTitle) {
  // Flatten all steps across topics into a single slide array
  const slides = [];

  // Intro slide
  slides.push({
    type: 'cover',
    title: docTitle || topics.map(t => t.title).join(' & '),
    topics: topics.map(t => t.title),
  });

  for (const topic of topics) {
    // Topic intro
    if (topic.intro?.segments?.length) {
      slides.push({
        type:   'intro',
        topic:  topic.title,
        intro:  topic.intro,
      });
    }

    for (const step of topic.steps) {
      const b64 = imgBase64(step.imagePath);
      slides.push({
        type:       'step',
        topic:      topic.title,
        stepNum:    step.stepNum,
        totalSteps: topic.steps.length,
        frameType:  step.frameType,
        imageB64:   b64,
        bubble:     step.bubble,
        bubblePos:  step.bubblePos,
        pointer:    step.pointer,
        hotspot:    step.hotspot,
        screenW:    step.screenW,
        screenH:    step.screenH,
      });
    }
  }

  const slidesJson = JSON.stringify(slides);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escHtml(docTitle || 'Preview')}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      width: 100%; height: 100%;
      background: #0f111a;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      overflow: hidden;
      color: #fff;
    }

    /* ── Layout ─────────────── */
    #app {
      width: 100vw; height: 100vh;
      display: flex; flex-direction: column;
    }

    /* ── Top bar ─────────────── */
    #topbar {
      height: 52px; flex-shrink: 0;
      background: #1b1f2e;
      border-bottom: 1px solid rgba(255,255,255,0.08);
      display: flex; align-items: center; justify-content: space-between;
      padding: 0 20px; gap: 16px;
    }
    .tb-brand { display: flex; align-items: center; gap: 10px; }
    .tb-logo { height: 22px; display: block; filter: brightness(0) invert(1); }
    .tb-diamond { display: none; }
    .tb-name { font-size: 14px; font-weight: 700; color: #fff; }
    .tb-sep { width: 1px; height: 20px; background: rgba(255,255,255,0.15); }
    .tb-topic { font-size: 12.5px; color: #8a92a6; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tb-progress { display: flex; align-items: center; gap: 10px; font-size: 12px; color: #8a92a6; }
    .tb-bar { width: 120px; height: 3px; background: rgba(255,255,255,0.12); border-radius: 2px; overflow: hidden; }
    .tb-bar-fill { height: 100%; background: #e87722; border-radius: 2px; transition: width 0.3s ease; }
    .tb-close {
      width: 30px; height: 30px; border-radius: 6px;
      border: 1px solid rgba(255,255,255,0.12);
      background: none; color: #8a92a6; cursor: pointer; font-size: 16px;
      display: flex; align-items: center; justify-content: center;
      transition: all 0.15s;
    }
    .tb-close:hover { background: rgba(255,255,255,0.08); color: #fff; }

    /* ── Stage (screenshot area) ─────────────── */
    #stage {
      flex: 1; display: flex; align-items: center; justify-content: center;
      position: relative; overflow: hidden;
      padding: 16px 80px;
    }
    #slide-wrap {
      position: relative;
      max-width: 100%; max-height: 100%;
      display: flex; align-items: center; justify-content: center;
    }
    #screenshot-container {
      position: relative;
      overflow: hidden;
      border-radius: 6px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.6);
      max-width: 100%; max-height: 100%;
      transition: opacity 0.25s ease;
    }
    #screenshot-img {
      display: block;
      max-width: 100%; max-height: 100%;
      height: auto;
    }

    /* ── Hotspot highlight ─────────────── */
    .hotspot-box {
      position: absolute;
      border: 2.5px solid #e87722;
      border-radius: 4px;
      box-shadow: 0 0 0 4px rgba(232,119,34,0.3), 0 0 0 8px rgba(232,119,34,0.1);
      pointer-events: none;
      animation: pulseHS 1.8s ease-in-out infinite;
    }
    @keyframes pulseHS {
      0%,100% { box-shadow: 0 0 0 2px rgba(232,119,34,.6), 0 0 0 6px rgba(232,119,34,.2); }
      50%      { box-shadow: 0 0 0 4px rgba(232,119,34,.8), 0 0 0 10px rgba(232,119,34,.1); }
    }

    /* ── Tooltip bubble ─────────────── */
    .tooltip-bubble {
      position: absolute;
      width: 280px;
      border-radius: 6px;
      padding: 10px 13px;
      font-size: 12px;
      line-height: 1.6;
      color: #111;
      box-shadow: 0 4px 20px rgba(0,0,0,0.35);
      border: 1px solid rgba(0,0,0,0.15);
      animation: bubbleIn 0.25s ease;
    }
    @keyframes bubbleIn {
      from { opacity: 0; transform: scale(0.93); }
      to   { opacity: 1; transform: scale(1); }
    }
    /* Hint bubble (auto-generated for empty-text steps) */
    .tooltip-bubble.hint-bubble {
      border: 1.5px dashed rgba(0,0,0,0.25) !important;
      font-style: italic;
    }
    .hint-icon { margin-right: 5px; font-style: normal; }

    /* Arrow variants — inherits background-color from inline style via border-color */
    .tooltip-bubble.arrow-top-right::after,
    .tooltip-bubble.arrow-top-left::after,
    .tooltip-bubble.arrow-right::after,
    .tooltip-bubble.arrow-left::after,
    .tooltip-bubble.arrow-bottom-right::after,
    .tooltip-bubble.arrow-bottom-left::after {
      content: '';
      position: absolute;
      border: 8px solid transparent;
    }
    .tooltip-bubble.arrow-top-right::after {
      top: -16px; right: 16px;
      border-bottom-width: 8px;
    }
    .tooltip-bubble.arrow-top-left::after {
      top: -16px; left: 16px;
      border-bottom-width: 8px;
    }
    .tooltip-bubble.arrow-right::after {
      right: -16px; top: 14px;
      border-left-width: 8px;
    }
    .tooltip-bubble.arrow-left::after {
      left: -16px; top: 14px;
      border-right-width: 8px;
    }

    /* ── Cover slide ─────────────── */
    .cover-slide {
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      text-align: center;
      padding: 40px;
      min-width: 500px;
    }
    .cover-logo { height: 44px; display: block; margin-bottom: 28px; filter: brightness(0) invert(1); }
    .cover-slide h1 { font-size: 26px; font-weight: 700; line-height: 1.3; max-width: 520px; margin-bottom: 16px; }
    .cover-slide .toc-list { list-style: none; margin-top: 20px; }
    .cover-slide .toc-list li {
      display: flex; align-items: center; gap: 10px;
      padding: 6px 0; font-size: 13px; color: #c8cdd9;
      border-bottom: 1px solid rgba(255,255,255,0.07);
    }
    .cover-slide .toc-num {
      width: 22px; height: 22px; background: rgba(232,119,34,.2);
      border: 1px solid #e87722; color: #e87722;
      border-radius: 50%; font-size: 10px; font-weight: 700;
      display: flex; align-items: center; justify-content: center; flex-shrink: 0;
    }
    .cover-btn {
      margin-top: 28px;
      background: #e87722; color: #fff; border: none;
      border-radius: 6px; padding: 11px 28px;
      font-size: 14px; font-weight: 600; cursor: pointer;
      transition: background 0.15s;
    }
    .cover-btn:hover { background: #d06810; }

    /* ── Intro slide ─────────────── */
    .intro-slide {
      max-width: 540px; padding: 32px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 10px;
    }
    .intro-slide .topic-pill {
      display: inline-block;
      background: rgba(232,119,34,0.15); color: #e87722;
      border: 1px solid rgba(232,119,34,0.3);
      padding: 3px 10px; border-radius: 99px;
      font-size: 11px; font-weight: 600; margin-bottom: 14px;
    }
    .intro-slide h2 { font-size: 18px; font-weight: 700; margin-bottom: 12px; }
    .intro-slide .intro-body { font-size: 13px; color: #c8cdd9; line-height: 1.7; }
    .intro-slide .intro-body strong { color: #fff; }

    /* ── Nav arrows ─────────────── */
    .nav-arrow {
      position: absolute; top: 50%; transform: translateY(-50%);
      width: 44px; height: 44px; border-radius: 50%;
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.15);
      color: #fff; cursor: pointer; font-size: 18px;
      display: flex; align-items: center; justify-content: center;
      transition: all 0.15s; z-index: 20;
      backdrop-filter: blur(4px);
    }
    .nav-arrow:hover { background: rgba(255,255,255,0.16); border-color: rgba(255,255,255,0.3); }
    .nav-arrow:disabled { opacity: 0.2; cursor: not-allowed; }
    #nav-prev { left: 16px; }
    #nav-next { right: 16px; }

    /* ── Bottom bar ─────────────── */
    #bottombar {
      height: 56px; flex-shrink: 0;
      background: #1b1f2e;
      border-top: 1px solid rgba(255,255,255,0.08);
      display: flex; align-items: center; justify-content: center;
      gap: 8px; padding: 0 20px;
    }
    .dot-nav {
      width: 7px; height: 7px; border-radius: 50%;
      background: rgba(255,255,255,0.2);
      cursor: pointer; transition: all 0.2s;
      border: none; padding: 0;
    }
    .dot-nav.active { background: #e87722; width: 22px; border-radius: 4px; }
    .dot-nav:hover:not(.active) { background: rgba(255,255,255,0.4); }

    /* Step type badge */
    .frame-badge {
      position: absolute; top: 10px; left: 10px;
      font-size: 10px; font-weight: 600; padding: 3px 8px;
      border-radius: 99px; letter-spacing: .4px;
    }
    .frame-badge.normal      { background: rgba(232,119,34,.85); color: #fff; }
    .frame-badge.explanation { background: rgba(43,123,229,.85); color: #fff; }

    /* Step counter chip */
    .step-chip {
      position: absolute; bottom: 10px; right: 10px;
      font-size: 10px; font-weight: 600; padding: 3px 9px;
      border-radius: 99px; background: rgba(0,0,0,0.55);
      color: #fff; backdrop-filter: blur(4px);
      letter-spacing: .3px;
    }

    /* Keyboard shortcut hint */
    .key-hint {
      position: absolute; bottom: 10px; left: 50%; transform: translateX(-50%);
      font-size: 10px; color: rgba(255,255,255,0.3);
    }

    /* Slide transition */
    .fade-out { opacity: 0; transform: scale(0.98); }
    .fade-in  { opacity: 1; transform: scale(1); }
    #screenshot-container { transition: opacity 0.18s ease, transform 0.18s ease; }
  </style>
</head>
<body>
<div id="app">
  <div id="topbar">
    <div class="tb-brand">
      ${LOGO_B64 ? `<img class="tb-logo" src="${LOGO_B64}" alt="Whatfix" />` : '<span class="tb-name">Whatfix</span>'}
      <div class="tb-sep"></div>
      <span class="tb-topic" id="tb-topic-name"></span>
    </div>
    <div class="tb-progress">
      <span id="tb-step-label">Step 1 of 1</span>
      <div class="tb-bar"><div class="tb-bar-fill" id="tb-bar-fill"></div></div>
    </div>
    <button class="tb-close" onclick="window.close()" title="Close">✕</button>
  </div>

  <div id="stage">
    <div id="slide-wrap">
      <div id="screenshot-container"></div>
    </div>
    <button class="nav-arrow" id="nav-prev" onclick="go(-1)">&#8592;</button>
    <button class="nav-arrow" id="nav-next" onclick="go(1)">&#8594;</button>
    <span class="key-hint">← → arrow keys to navigate</span>
  </div>

  <div id="bottombar" id="dots-row"></div>
</div>

<script>
const SLIDES = ${slidesJson};
let cur = 0;

function segToHtml(segments) {
  if (!segments) return '';
  return segments.map(seg => {
    if (seg.type === 'br') return '<br>';
    return (seg.segs || []).map(s => {
      let t = s.text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      if (s.bold)      t = '<strong>' + t + '</strong>';
      if (s.italic)    t = '<em>' + t + '</em>';
      if (s.underline) t = '<u>' + t + '</u>';
      if (s.color)     t = '<span style="color:' + s.color + '">' + t + '</span>';
      return t;
    }).join('');
  }).filter(Boolean).join('');
}

function render(idx, dir) {
  cur = Math.max(0, Math.min(SLIDES.length - 1, idx));
  const slide = SLIDES[cur];
  const container = document.getElementById('screenshot-container');

  // Fade out
  container.style.opacity = '0';
  container.style.transform = 'scale(0.98)';

  setTimeout(() => {
    container.innerHTML = buildSlideHtml(slide);
    applyOverlays(slide, container);

    // Fade in
    container.style.opacity = '1';
    container.style.transform = 'scale(1)';

    updateUI(slide);
  }, 180);
}

function buildSlideHtml(slide) {
  if (slide.type === 'cover') {
    const logoTag = ${JSON.stringify(LOGO_B64)} ? \`<img class="cover-logo" src="${LOGO_B64}" alt="Whatfix" />\` : '<div class="cover-logo" style="font-size:24px;font-weight:800;">Whatfix</div>';
    return \`<div class="cover-slide">
      \${logoTag}
      <h1>\${slide.title.replace(/</g,'&lt;')}</h1>
      \${slide.topics.length > 1 ? '<ul class="toc-list">' + slide.topics.map((t,i) =>
        \`<li><span class="toc-num">\${i+1}</span><span>\${t.replace(/</g,'&lt;')}</span></li>\`
      ).join('') + '</ul>' : ''}
      <button class="cover-btn" onclick="go(1)">Start Guide &#8594;</button>
    </div>\`;
  }

  if (slide.type === 'intro') {
    return \`<div class="intro-slide">
      <span class="topic-pill">\${slide.topic.replace(/</g,'&lt;')}</span>
      <h2>In this tutorial</h2>
      <div class="intro-body">\${segToHtml(slide.intro.segments)}</div>
    </div>\`;
  }

  // Step slide
  const imgTag = slide.imageB64
    ? \`<img id="screenshot-img" src="\${slide.imageB64}" draggable="false" />\`
    : \`<div style="width:640px;height:480px;background:#1e2235;display:flex;align-items:center;justify-content:center;color:#6b7280;font-size:13px;">No screenshot</div>\`;

  const badgeClass = (slide.frameType||'').toLowerCase();
  const badgeLabel = slide.frameType === 'Explanation' ? 'Explanation' : 'Action';

  return \`\${imgTag}
    <span class="frame-badge \${badgeClass}">\${badgeLabel}</span>
    <span class="step-chip">Step \${slide.stepNum} / \${slide.totalSteps}</span>\`;
}

function applyOverlays(slide, container) {
  if (slide.type !== 'step') return;
  if (!slide.imageB64) return;

  const img = container.querySelector('#screenshot-img');
  if (!img) return;

  // Wait for image to load to get rendered dimensions
  function doOverlay() {
    const dispW = img.offsetWidth;
    const dispH = img.offsetHeight;
    if (!dispW || !dispH) return;

    const sx = dispW / slide.screenW;
    const sy = dispH / slide.screenH;

    // ── Hotspot ──
    const hs = slide.hotspot;
    if (hs && !hs.isNextBtn) {
      const el = document.createElement('div');
      el.className = 'hotspot-box';
      el.style.cssText = \`
        left:\${Math.round(hs.left * sx)}px;
        top:\${Math.round(hs.top * sy)}px;
        width:\${Math.round((hs.right - hs.left) * sx)}px;
        height:\${Math.round((hs.bottom - hs.top) * sy)}px;
      \`;
      container.appendChild(el);
    }

    // ── Bubble ──
    const bub = slide.bubble;
    const bp  = slide.bubblePos;
    if (bub && bp && bub.segments && bub.segments.length) {
      const px  = Math.round(bp.x * sx);
      const py  = Math.round(bp.y * sy);
      const bw  = Math.min(280, dispW * 0.38);
      const bgC = bub.bgColor || '#C0FFFF';

      let left, top, arrowClass;
      const ptr = (slide.pointer || 'None').toLowerCase();

      if (ptr === 'topright') {
        left = Math.max(4, px - bw);
        top  = py;
        arrowClass = 'arrow-top-right';
      } else if (ptr === 'topleft') {
        left = px;
        top  = py;
        arrowClass = 'arrow-top-left';
      } else if (ptr === 'righttop' || ptr === 'right') {
        left = Math.max(4, px - bw - 12);
        top  = Math.max(4, py - 20);
        arrowClass = 'arrow-right';
      } else if (ptr === 'lefttop' || ptr === 'left') {
        left = px + 12;
        top  = Math.max(4, py - 20);
        arrowClass = 'arrow-left';
      } else {
        left = Math.max(4, px - bw / 2);
        top  = Math.max(4, py - 40);
        arrowClass = '';
      }

      // Clamp
      left = Math.max(4, Math.min(left, dispW - bw - 4));
      top  = Math.max(4, Math.min(top,  dispH - 60));

      const isHint = !!(bub.isAutoHint);
      const bEl = document.createElement('div');
      bEl.className = \`tooltip-bubble \${arrowClass}\${isHint ? ' hint-bubble' : ''}\`;
      bEl.style.cssText = \`left:\${left}px;top:\${top}px;width:\${bw}px;background:\${bgC};\`;

      const arrowStyle = document.createElement('style');
      const cls = 'bubble-' + Math.random().toString(36).slice(2,8);
      bEl.classList.add(cls);
      if (arrowClass === 'arrow-top-right' || arrowClass === 'arrow-top-left') {
        arrowStyle.textContent = \`.\${cls}::after { border-bottom-color: \${bgC} !important; }\`;
      } else if (arrowClass === 'arrow-right') {
        arrowStyle.textContent = \`.\${cls}::after { border-left-color: \${bgC} !important; }\`;
      } else if (arrowClass === 'arrow-left') {
        arrowStyle.textContent = \`.\${cls}::after { border-right-color: \${bgC} !important; }\`;
      }
      document.head.appendChild(arrowStyle);

      bEl.innerHTML = (isHint ? '<span class="hint-icon">👆</span>' : '') + segToHtml(bub.segments);
      container.appendChild(bEl);
    }
  }

  if (img.complete) doOverlay();
  else img.addEventListener('load', doOverlay, { once: true });
}

function updateUI(slide) {
  // Topbar
  const topicName = slide.topic || (slide.type === 'cover' ? 'Guide Overview' : '');
  document.getElementById('tb-topic-name').textContent = topicName;
  const pct = Math.round((cur / (SLIDES.length - 1)) * 100);
  document.getElementById('tb-bar-fill').style.width = pct + '%';
  const stepLabel = slide.type === 'step'
    ? \`Step \${slide.stepNum} of \${slide.totalSteps}\`
    : (slide.type === 'cover' ? 'Overview' : 'Introduction');
  document.getElementById('tb-step-label').textContent = stepLabel;

  // Nav
  document.getElementById('nav-prev').disabled = cur === 0;
  document.getElementById('nav-next').disabled = cur === SLIDES.length - 1;

  // Dots
  const bar = document.getElementById('bottombar');
  bar.innerHTML = '';
  const maxDots = Math.min(SLIDES.length, 32);
  for (let i = 0; i < maxDots; i++) {
    const d = document.createElement('button');
    d.className = 'dot-nav' + (i === cur ? ' active' : '');
    d.title = \`Slide \${i + 1}\`;
    d.onclick = () => render(i);
    bar.appendChild(d);
  }
}

function go(dir) {
  render(cur + dir);
}

// Keyboard nav
document.addEventListener('keydown', e => {
  if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); go(1); }
  if (e.key === 'ArrowLeft')  { e.preventDefault(); go(-1); }
  if (e.key === 'Escape')     window.close();
});

// Init
render(0);
</script>
</body>
</html>`;
}

module.exports = { generatePreviewHtml };
