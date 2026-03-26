const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const { v4: uuidv4 }         = require('uuid');
const { convertOdarcToPdf, extractTopics, inspectOdarc } = require('./src/converter');
const { generatePreviewHtml }              = require('./src/previewGen');

const app  = express();
const PORT = process.env.PORT || 3000;

const UPLOADS_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR  = path.join(__dirname, 'output');
const PUBLIC_DIR  = path.join(__dirname, 'public');
const DB_PATH     = path.join(__dirname, 'db.json');

[UPLOADS_DIR, OUTPUT_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ── DB ─────────────────────────────────────────────────────────────
function readDb()        { return fs.existsSync(DB_PATH) ? JSON.parse(fs.readFileSync(DB_PATH,'utf8')) : { items:[] }; }
function writeDb(data)   { fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2)); }

// ── Multer ─────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (_, file, cb) => cb(null, uuidv4() + '.odarc'),
});
const upload = multer({
  storage,
  fileFilter: (_, file, cb) => {
    if (file.originalname.endsWith('.odarc') || file.mimetype === 'application/octet-stream')
      cb(null, true);
    else cb(new Error('Only .odarc files are accepted'));
  },
  limits: { fileSize: 300 * 1024 * 1024 },
});

app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// ── REST API ───────────────────────────────────────────────────────

// List content
app.get('/api/content', (_, res) => res.json(readDb().items));

// Inspect – returns topic list without saving the file
app.post('/api/inspect', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  try {
    const topics = await inspectOdarc(req.file.path);
    res.json({ topics });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    try { require('fs').unlinkSync(req.file.path); } catch (_) {}
  }
});

// Upload
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const db   = readDb();
  const item = {
    id:               uuidv4(),
    name:             req.body.name || req.file.originalname.replace('.odarc',''),
    originalName:     req.file.originalname,
    filePath:         req.file.path,
    type:             'Flow',
    status:           'Draft',
    version:          1,
    createdAt:        new Date().toISOString(),
    updatedAt:        new Date().toISOString(),
    createdBy:        'You',
    updatedBy:        'You',
    pdfPath:          null,
    conversionStatus: 'pending',
    conversionLog:    [],
    availableTopics:  [],   // filled by inspect on first convert
  };
  db.items.unshift(item);
  writeDb(db);
  res.json(item);
});

// Convert to PDF (non-blocking); body may contain { topicIds: ['id1','id2'] }
app.post('/api/convert/:id', async (req, res) => {
  const db        = readDb();
  const item      = db.items.find(i => i.id === req.params.id);
  if (!item)                         return res.status(404).json({ error: 'Not found' });
  if (!fs.existsSync(item.filePath)) return res.status(400).json({ error: 'Source file missing' });

  const topicIds = Array.isArray(req.body.topicIds) && req.body.topicIds.length ? req.body.topicIds : null;
  if (topicIds) item.selectedTopicIds = topicIds;

  item.conversionStatus = 'converting';
  item.conversionLog    = ['Starting…'];
  item.updatedAt        = new Date().toISOString();
  writeDb(db);
  res.json({ status: 'converting', id: item.id });

  const out = path.join(OUTPUT_DIR, item.id + '.pdf');
  try {
    await convertOdarcToPdf(item.filePath, out, msg => {
      const d = readDb(), it = d.items.find(i => i.id === item.id);
      if (it) { it.conversionLog.push(msg); writeDb(d); }
    }, topicIds);
    const d = readDb(), it = d.items.find(i => i.id === item.id);
    if (it) { it.conversionStatus = 'done'; it.pdfPath = out; it.updatedAt = new Date().toISOString(); writeDb(d); }
  } catch (err) {
    const d = readDb(), it = d.items.find(i => i.id === item.id);
    if (it) { it.conversionStatus = 'error'; it.conversionLog.push('Error: ' + err.message); writeDb(d); }
  }
});

// Poll status
app.get('/api/status/:id', (req, res) => {
  const db   = readDb();
  const item = db.items.find(i => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  res.json({ id: item.id, conversionStatus: item.conversionStatus, conversionLog: item.conversionLog });
});

// Download PDF
app.get('/api/download/:id', (req, res) => {
  const db   = readDb();
  const item = db.items.find(i => i.id === req.params.id);
  if (!item?.pdfPath || !fs.existsSync(item.pdfPath)) return res.status(404).json({ error: 'PDF not found' });
  const name = (item.name || 'export').replace(/[^a-z0-9_\- ]/gi,'_') + '.pdf';
  res.download(item.pdfPath, name);
});

// Interactive preview (serves self-contained HTML)
app.get('/api/preview/:id', async (req, res) => {
  const db   = readDb();
  const item = db.items.find(i => i.id === req.params.id);
  if (!item)                        return res.status(404).send('Not found');
  if (!fs.existsSync(item.filePath)) return res.status(400).send('Source file missing');

  try {
    const ids = item.selectedTopicIds || null;
    const { topics } = await extractTopics(item.filePath, ids);
    const html = generatePreviewHtml(topics, item.name);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    res.status(500).send('Preview generation failed: ' + err.message);
  }
});

// Delete
app.delete('/api/content/:id', (req, res) => {
  const db  = readDb();
  const idx = db.items.findIndex(i => i.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const [item] = db.items.splice(idx, 1);
  try { if (item.filePath) fs.unlinkSync(item.filePath); } catch (_) {}
  try { if (item.pdfPath)  fs.unlinkSync(item.pdfPath);  } catch (_) {}
  writeDb(db);
  res.json({ ok: true });
});

app.get('*', (_, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.listen(PORT, () => console.log(`\n  WhatfxConvert → http://localhost:${PORT}\n`));
