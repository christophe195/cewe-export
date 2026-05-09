/**
 * CEWE MCFX → PDF  |  app.js
 * All processing happens entirely locally in the browser.
 * No files or data are sent to a server.
 *
 * External libraries are loaded via CDN (read-only, no upload):
 *   sql.js, pdf-lib, PDF.js, JSZip
 */

// ─── Constanten ──────────────────────────────────────────────────────────────
// Eenheden in data.mcf zijn tienden van mm (1/10 mm)
// 1 PDF punt = 25.4/72 mm → 1/10 mm = 72/254 pt
const PT_PER_UNIT = 72 / 254;

// Canvas pixels per PDF punt (bepaalt rasterisatie-kwaliteit van tekst en SVG).
// Wordt voor elke export opnieuw ingesteld o.b.v. de gekozen DPI: dpi / 72.
let CANVAS_PX_PER_PT = 4; // default ~288 DPI

// ─── UI-elementen ─────────────────────────────────────────────────────────────
const sectionDrop   = document.getElementById('section-drop');
const sectionLoaded = document.getElementById('section-loaded');
const dropZone      = document.getElementById('drop-zone');
const fileInput     = document.getElementById('file-input');
const uploadBtn     = document.getElementById('upload-btn');
const dropStatus    = document.getElementById('drop-status');
const infoTable     = document.getElementById('info-table');
const btnNew        = document.getElementById('btn-new');
const btnDownload   = document.getElementById('btn-download');
const btnClearCache = document.getElementById('btn-clear-cache');
const btnExport     = document.getElementById('btn-export');
const selDpi           = document.getElementById('sel-dpi');
const selJpegQuality   = document.getElementById('sel-jpeg-quality');
const selPdfImgQuality = document.getElementById('sel-pdf-img-quality');
const jpegQualityWrap  = document.getElementById('jpeg-quality-wrap');
const progressWrap      = document.getElementById('progress-wrap');
const progressLabelPage = document.getElementById('progress-label-page');
const progressFillPage  = document.getElementById('progress-fill-page');
const progressLabelElem = document.getElementById('progress-label-elem');
const progressFillElem  = document.getElementById('progress-fill-elem');
const sectionViewer = document.getElementById('section-viewer');

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// ─── State ───────────────────────────────────────────────────────────────────
let parsedMcfx  = null;
let pdfBlobUrl  = null;
let currentFile = null;

// ─── Events ──────────────────────────────────────────────────────────────────
uploadBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { if (fileInput.files[0]) handleFile(fileInput.files[0]); });

dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', ()  => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});

// Toon/verberg JPEG-kwaliteitsoptie op basis van formaatkeuze
document.querySelectorAll('input[name="export-format"]').forEach(r =>
  r.addEventListener('change', () => {
    const isJpeg = document.querySelector('input[name="export-format"]:checked')?.value === 'jpeg';
    jpegQualityWrap.style.display = isJpeg ? 'flex' : 'none';
  })
);

btnNew.addEventListener('click', resetToUpload);

btnExport.addEventListener('click', async () => {
  if (!parsedMcfx) return;
  btnExport.disabled = true;
  try {
    const mode     = document.querySelector('input[name="render-mode"]:checked')?.value ?? 'booklet';
    const format   = document.querySelector('input[name="export-format"]:checked')?.value ?? 'pdf';
    const dpi      = parseInt(selDpi.value) || 300;
    const quality  = parseFloat(selJpegQuality.value) || 0.92;
    const baseName = (currentFile?.name ?? 'photobook').replace('.mcfx', '');

    // DPI instellen voor rasterisatie van tekst en SVG binnen de PDF
    CANVAS_PX_PER_PT = dpi / 72;

    // PDF foto-kwaliteit: 'png' = lossless, getal = JPEG quality
    const pdfImgQuality = selPdfImgQuality.value === 'png' ? 'png' : parseFloat(selPdfImgQuality.value);

    const pdfBytes = await buildPdf(parsedMcfx, mode, pdfImgQuality, updateProgress, updateElemProgress);

    if (format === 'jpeg') {
      setProgress('Rendering JPEG…', 100, null, 0);
      const zipUrl = await exportAsJpeg(pdfBytes, dpi, quality, baseName);
      const a = document.createElement('a');
      a.href = zipUrl;
      a.download = baseName + '_jpeg.zip';
      a.click();
      setTimeout(() => URL.revokeObjectURL(zipUrl), 10000);
    } else {
      // Maak blob VÓÓR renderPreview: PDF.js transfert de ArrayBuffer
      // van pdfBytes intern waarna de buffer geleegd wordt (0 bytes).
      if (pdfBlobUrl) URL.revokeObjectURL(pdfBlobUrl);
      pdfBlobUrl = URL.createObjectURL(new Blob([pdfBytes], { type: 'application/pdf' }));
      btnDownload.style.display = '';
      btnDownload.onclick = () => {
        const a = document.createElement('a');
        a.href = pdfBlobUrl;
        a.download = baseName + '.pdf';
        a.click();
      };
      setProgress('Loading preview…', 100, null, 0);
      await renderPreview(pdfBytes);
    }
  } catch (err) {
    setProgress(`Error: ${err.message}`, 0, null, 0);
    console.error(err);
  } finally {
    btnExport.disabled = false;
    setTimeout(() => { progressWrap.style.display = 'none'; }, 2000);
  }
});

// ─── IndexedDB cache ────────────────────────────────────────────────────
const DB_NAME    = 'cewe-export-cache';
const DB_VERSION = 1;
const STORE_NAME = 'parsed-mcfx';

function openCacheDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => e.target.result.createObjectStore(STORE_NAME, { keyPath: 'cacheKey' });
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

function cacheKey(file) {
  return `${file.name}__${file.size}`;
}

async function cacheGet(key) {
  const db = await openCacheDb();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = e => resolve(e.target.result ?? null);
    req.onerror   = e => reject(e.target.error);
  });
}

async function cachePut(key, data) {
  const db = await openCacheDb();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).put({ cacheKey: key, data, cachedAt: Date.now() });
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  });
}

async function cacheClearAll() {
  const db = await openCacheDb();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).clear();
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  });
}

async function cacheCountAndSize() {
  const db = await openCacheDb();
  return new Promise((resolve, reject) => {
    const tx      = db.transaction(STORE_NAME, 'readonly');
    const store   = tx.objectStore(STORE_NAME);
    const countReq = store.count();
    countReq.onsuccess = () => {
      const count = countReq.result;
      // Schat grootte door alle records te lezen
      const items = []; const cursor = store.openCursor();
      let bytes = 0;
      cursor.onsuccess = e => {
        const c = e.target.result;
        if (c) { try { bytes += JSON.stringify(c.value).length; } catch(_) {} c.continue(); }
        else resolve({ count, bytes });
      };
      cursor.onerror = e => reject(e.target.error);
    };
    countReq.onerror = e => reject(e.target.error);
  });
}

function askToCache() {
  return new Promise(resolve => {
    // ── Ask-to-cache dialog ─────────────────────────────────────────────────────
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.65);display:flex;align-items:center;justify-content:center;z-index:9999';
    const box = document.createElement('div');
    box.style.cssText = 'background:#16213e;border:1px solid #0f3460;border-radius:10px;padding:1.5rem 2rem;max-width:400px;text-align:center;color:#e0e0e0';
    box.innerHTML = `
      <div style="font-size:1.5rem;margin-bottom:0.75rem">💾</div>
      <p style="font-weight:600;margin-bottom:0.5rem">Bestand cachen?</p>
      <p style="font-size:0.82rem;color:#aaa;margin-bottom:1.2rem">
        Het verwerken van dit bestand duurt even. Wil je het resultaat opslaan in de browsercache zodat het volgende keer direct beschikbaar is?
      </p>
      <div style="display:flex;gap:0.75rem;justify-content:center">
        <button id="cache-no"  class="btn btn-secondary">Nee, niet cachen</button>
        <button id="cache-yes" class="btn btn-primary">Ja, cachen</button>
      </div>`;
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    box.querySelector('#cache-yes').onclick = () => { document.body.removeChild(overlay); resolve(true); };
    box.querySelector('#cache-no').onclick  = () => { document.body.removeChild(overlay); resolve(false); };
  });
}

// Toon/verberg de cache-knop op basis van cache-inhoud
async function updateCacheButton() {
  try {
    const { count } = await cacheCountAndSize();
    btnClearCache.style.display = count > 0 ? '' : 'none';
  } catch (_) { btnClearCache.style.display = 'none'; }
}

btnClearCache.addEventListener('click', async () => {
  if (!confirm('Delete all cached files?')) return;
  await cacheClearAll();
  btnClearCache.style.display = 'none';
  dropStatus.textContent = 'Cache cleared.';
  setTimeout(() => { dropStatus.textContent = ''; }, 2500);
});

// Controleer bij opstarten of er iets in de cache zit
updateCacheButton();

// ─── Bestand laden ───────────────────────────────────────────────────────────
async function handleFile(file) {
  if (!file.name.endsWith('.mcfx')) {
    dropStatus.textContent = 'Only .mcfx files are supported.';
    return;
  }
  currentFile = file;
dropStatus.textContent = `Loading: ${file.name} …`;

  try {
    const key    = cacheKey(file);
    const cached = await cacheGet(key);

    if (cached) {
      // Cache-hit: direct gebruiken
      dropStatus.textContent = 'Loaded from cache.';
      parsedMcfx = cached.data;
      showLoaded(parsedMcfx, file.name, '✅ from cache');
    } else {
      // Cache-miss: verwerken en eventueel opslaan
      const buffer = await file.arrayBuffer();
      dropStatus.textContent = 'Reading SQLite + XML…';
      parsedMcfx = await parseMcfx(buffer);

      // Vraag of we mogen cachen
      const doCache = await askToCache();
      if (doCache) {
        dropStatus.textContent = 'Saving to cache…';
        try {
          await cachePut(key, parsedMcfx);
          await updateCacheButton();
          showLoaded(parsedMcfx, file.name, '💾 cached');
        } catch (cacheErr) {
          console.warn('Cache save failed:', cacheErr);
          showLoaded(parsedMcfx, file.name, '⚠️ cache failed');
        }
      } else {
        showLoaded(parsedMcfx, file.name, '— not cached');
      }
    }
  } catch (err) {
    dropStatus.textContent = `Error: ${err.message}`;
    console.error(err);
  }
}

function resetToUpload() {
  parsedMcfx = null;
  currentFile = null;
  if (pdfBlobUrl) { URL.revokeObjectURL(pdfBlobUrl); pdfBlobUrl = null; }
  sectionLoaded.style.display = 'none';
  sectionDrop.style.display = '';
  fileInput.value = '';
  dropStatus.textContent = '';
  btnNew.style.display = 'none';
  btnDownload.style.display = 'none';
  sectionViewer.innerHTML = '<p id="viewer-placeholder">Click "Export" to generate a preview.</p>';
  progressWrap.style.display = 'none';
}

function showLoaded(parsed, filename, cacheStatus) {
  sectionDrop.style.display = 'none';
  sectionLoaded.style.display = 'flex';
  btnNew.style.display = '';

  const { projectInfo, pages, files } = parsed;
  const imgCount = [...files.keys()].filter(k => /\.(jpg|jpeg|png|svg)$/i.test(k)).length;

  infoTable.innerHTML = '';
  const rows = [
    ['File',           filename],
    ['Cache',          cacheStatus ?? '—'],
    ['Product',        projectInfo.articleName],
    ['Version',        projectInfo.version],
    ['Pages',          `${pages.length} (${projectInfo.normalpages} normal)`],
    ['Photos in DB',   imgCount],
    ['HPS version',    projectInfo.hpsVersion],
    ['Saved',          projectInfo.saveTime],
  ];
  for (const [label, value] of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${label}</td><td>${value ?? '—'}</td>`;
    infoTable.appendChild(tr);
  }
}

// ─── Voortgang ───────────────────────────────────────────────────────────────
function updateProgress(current, total) {
  const pct = Math.round((current / total) * 100);
  setProgress(`Page ${current} of ${total}`, pct, null, 0);
}

function updateElemProgress(current, total, label) {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  setProgress(null, null, label ? `  ↳ ${label} (${current}/${total})` : null, pct);
}

function setProgress(pageLabel, pagePct, elemLabel, elemPct) {
  progressWrap.style.display = 'block';
  if (pageLabel !== null && pageLabel !== undefined) progressLabelPage.textContent = pageLabel;
  if (pagePct  !== null && pagePct  !== undefined) progressFillPage.style.width = pagePct + '%';
  if (elemLabel !== null && elemLabel !== undefined) progressLabelElem.textContent = elemLabel || ' ';
  if (elemPct  !== null && elemPct  !== undefined) progressFillElem.style.width = elemPct + '%';
}

// ─── SQLite + XML inlezen ────────────────────────────────────────────────────
async function parseMcfx(buffer) {
  // Laad sql.js WASM
  const SQL = await initSqlJs({
    locateFile: f => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/${f}`,
  });

  const db = new SQL.Database(new Uint8Array(buffer));

  // Lees alle bestanden uit de Files-tabel
  const files = new Map();
  const stmt = db.prepare('SELECT Filename, Data FROM Files');
  while (stmt.step()) {
    const row = stmt.getAsObject();
    files.set(row.Filename, row.Data); // Data is Uint8Array voor BLOB
  }
  stmt.free();
  db.close();

  // Haal data.mcf op en verwijder null-byte padding (bestand is 4 MB groot)
  const mcfRaw = files.get('data.mcf');
  if (!mcfRaw) throw new Error('data.mcf not found in the mcfx file.');
  let xmlText = new TextDecoder('utf-8').decode(mcfRaw);
  const lastClose = xmlText.lastIndexOf('>');
  if (lastClose >= 0) xmlText = xmlText.substring(0, lastClose + 1);

  // XML parsen
  const dom = new DOMParser().parseFromString(xmlText, 'text/xml');
  if (dom.querySelector('parsererror')) throw new Error('XML parse error in data.mcf.');

  const fotobook     = dom.documentElement;
  const project      = fotobook.querySelector('project');
  const savingVer    = fotobook.querySelector('savingVersion');
  const articleConf  = fotobook.querySelector('articleConfig');

  const projectInfo = {
    articleName:  decodeURIComponent(fotobook.getAttribute('article_name') ?? ''),
    version:      fotobook.getAttribute('version'),
    productname:  fotobook.getAttribute('productname'),
    folderID:     fotobook.getAttribute('folderID'),
    hpsVersion:   project?.getAttribute('createdWithHPSVersion'),
    saveTime:     savingVer?.getAttribute('savetime'),
    normalpages:  parseInt(articleConf?.getAttribute('normalpages') ?? '0'),
    totalpages:   parseInt(articleConf?.getAttribute('totalpages') ?? '0'),
  };

  // Pagina's inlezen
  const pages = [];
  for (const pageEl of fotobook.querySelectorAll('page')) {
    const bsEl = pageEl.querySelector('bundlesize');
    const bundlesize = bsEl
      ? { width: parseInt(bsEl.getAttribute('width')), height: parseInt(bsEl.getAttribute('height')) }
      : { width: 5800, height: 2900 }; // default normaal formaat

    const areas = [];
    for (const areaEl of pageEl.querySelectorAll('area')) {
      const areatype = areaEl.getAttribute('areatype');
      const posEl    = areaEl.querySelector('position');
      if (!posEl) continue;

      const pos = {
        left:      parseFloat(posEl.getAttribute('left')      ?? '0'),
        top:       parseFloat(posEl.getAttribute('top')       ?? '0'),
        width:     parseFloat(posEl.getAttribute('width')     ?? '0'),
        height:    parseFloat(posEl.getAttribute('height')    ?? '0'),
        rotation:  parseFloat(posEl.getAttribute('rotation')  ?? '0'),
        zposition: parseInt (posEl.getAttribute('zposition')  ?? '0'),
      };

      const area = { type: areatype, pos };

      if (areatype === 'clipartarea') {
        // CEWE cliparts zijn interne design-elementen zonder file in de DB.
        // target-formaat: "#RRGGBB,opacity" waarbij opacity 0-255 is.
        const colorEl = areaEl.querySelector('color');
        if (colorEl) {
          const target = colorEl.getAttribute('target') ?? '';
          const parts  = target.split(',');
          area.fillColor   = parts[0] ?? '#000000';
          area.fillOpacity = parts[1] ? parseInt(parts[1]) / 255 : 1;
        } else {
          // Geen kleurconfig = CEWE intern decoratie-element (lint, banner, …).
          // Render als CEWE-rood rechthoek — de positie/grootte/rotatie zitten
          // wel in de XML en zijn alles wat we nodig hebben.
          area.fillColor   = '#cc0000';
          area.fillOpacity = 1;
        }
      }

      if (areatype === 'imagearea' || areatype === 'imagebackgroundarea') {
        // imagebackgroundarea gebruikt <imagebackground>, imagearea gebruikt <image>
        const imgEl = areaEl.querySelector('imagebackground') ?? areaEl.querySelector('image');
        if (imgEl) {
          const raw = imgEl.getAttribute('filename') ?? '';
          area.dbKey = decodeURIComponent(raw.replace('safecontainer:/', ''));
          area.useABK = imgEl.getAttribute('useABK') === '1';
          // backgroundPosition="RIGHT_OR_BOTTOM" = coördinaten zijn relatief aan de rechterhelft
          area.bgPosition = imgEl.getAttribute('backgroundPosition') ?? null;
          const cutEl = imgEl.querySelector('cutout');
          if (cutEl) {
            area.cutout = {
              left:  parseFloat(cutEl.getAttribute('left')  ?? '0'),
              top:   parseFloat(cutEl.getAttribute('top')   ?? '0'),
              scale: parseFloat(cutEl.getAttribute('scale') ?? '1'),
            };
          }
        }
      }

      if (areatype === 'textarea' || areatype === 'spinetextarea') {
        const textEl = areaEl.querySelector('text');
        if (textEl) {
          // CDATA-sectie = nodeType 4 in XML-modus
          const cdata = Array.from(textEl.childNodes).find(n => n.nodeType === 4);
          area.htmlContent = cdata?.nodeValue ?? null;
          const tfEl = textEl.querySelector('textFormat');
          if (tfEl) {
            area.textFormat = {
              alignment:            tfEl.getAttribute('Alignment')            ?? 'ALIGNLEADING',
              verticalIndentMargin: parseFloat(tfEl.getAttribute('VerticalIndentMargin') ?? '0'),
              foregroundColor:      tfEl.getAttribute('foregroundColor')      ?? '#ff000000',
              lineHeight:           parseInt(tfEl.getAttribute('lineHeight')  ?? '100'),
            };
          }
        }
      }

      // Slagschaduw parsen (voor tekst- en SVG-canvas rendering)
      const shadowEl = areaEl.querySelector('decoration > shadow');
      if (shadowEl && shadowEl.getAttribute('shadowEnabled') === '1') {
        area.shadow = {
          angle:    parseFloat(shadowEl.getAttribute('shadowAngle')    ?? '135'),
          distance: parseFloat(shadowEl.getAttribute('shadowDistance') ?? '0'),
          blur:     parseFloat(shadowEl.getAttribute('shadowBlurNew')  ?? '0'),
          opacity:  parseInt (shadowEl.getAttribute('shadowIntensity') ?? '128') / 255,
        };
      }

      areas.push(area);
    }
    areas.sort((a, b) => a.pos.zposition - b.pos.zposition);

    pages.push({
      pagenr:     parseInt(pageEl.getAttribute('pagenr') ?? '0'),
      type:       pageEl.getAttribute('type'),
      rotation:   parseFloat(pageEl.getAttribute('rotation') ?? '0'),
      bundlesize,
      areas,
    });
  }

  return { projectInfo, pages, files };
}

// ─── Hulpfuncties: tekst en SVG ──────────────────────────────────────────────
const CANVAS_PX_PER_PT_DEFAULT = 4; // bewaard als referentie (wordt overschreven door DPI-keuze)

/** Qt ARGB kleur (#aarrggbb) naar CSS rgba() */
function qtColorToCss(qt) {
  if (!qt || qt.length < 9) return '#000000';
  const a  = parseInt(qt.slice(1, 3), 16) / 255;
  const r  = parseInt(qt.slice(3, 5), 16);
  const g  = parseInt(qt.slice(5, 7), 16);
  const b  = parseInt(qt.slice(7, 9), 16);
  return `rgba(${r},${g},${b},${a.toFixed(3)})`;
}

/** CSS-eigenschap uit inline style string lezen */
function cssProp(style, prop) {
  const m = new RegExp(prop + '\\s*:\\s*([^;]+)', 'i').exec(style);
  return m ? m[1].trim() : null;
}

/** font-size naar pt: ondersteunt pt en px */
function parseFontSizePt(style) {
  const m = /font-size\s*:\s*([\d.]+)(pt|px)/i.exec(style);
  if (!m) return null;
  return m[2].toLowerCase() === 'px' ? parseFloat(m[1]) * 0.75 : parseFloat(m[1]);
}

/**
 * Parse Qt rich text HTML naar [ { align, runs: [{ text, fontFamily, fontSizePt, color, bold, italic }] } ]
 */
function parseQtHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const body = doc.body;
  const bodyStyle = body.getAttribute('style') || '';
  const defaults = {
    fontFamily: (cssProp(bodyStyle, 'font-family') || 'sans-serif').replace(/'/g, ''),
    fontSizePt: parseFontSizePt(bodyStyle) || 12,
    color:      '#000000',
    bold:       /font-weight\s*:\s*(700|bold)/i.test(bodyStyle),
    italic:     /font-style\s*:\s*italic/i.test(bodyStyle),
  };

  const paragraphs = [];
  for (const pEl of body.querySelectorAll('p')) {
    const align = pEl.getAttribute('align') ||
                  cssProp(pEl.getAttribute('style') || '', 'text-align') || 'left';
    const runs = [];

    const walk = (node, inh) => {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.textContent) runs.push({ ...inh, text: node.textContent });
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const s = node.getAttribute('style') || '';
        const next = {
          fontFamily: (cssProp(s, 'font-family') || inh.fontFamily).replace(/'/g, '').split(',')[0].trim(),
          fontSizePt: parseFontSizePt(s) || inh.fontSizePt,
          color:      cssProp(s, 'color') || inh.color,
          bold:       /font-weight\s*:\s*(700|bold)/i.test(s) ? true : inh.bold,
          italic:     /font-style\s*:\s*italic/i.test(s) ? true : inh.italic,
        };
        for (const c of node.childNodes) walk(c, next);
      }
    };
    for (const c of pEl.childNodes) walk(c, defaults);

    if (runs.length) paragraphs.push({ align, runs });
  }
  return paragraphs;
}

/** Tekst woordafbreking voor canvas */
function wrapWords(ctx, text, maxWidth) {
  const lines = [];
  let current = '';
  for (const word of text.split(' ')) {
    const test = current ? current + ' ' + word : word;
    if (ctx.measureText(test).width <= maxWidth || !current) {
      current = test;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Pas een canvas drop-shadow toe op basis van MCFX shadow-data.
 * Formule: angle 0° = omhoog, CW. Typisch angle=135 = schaduw rechtsonder.
 * shadowDistance in MCFX-eenheden (1/10 mm), shadowBlur idem.
 */
function applyCanvasShadow(ctx, shadow) {
  if (!shadow) return;
  const PX_PER_UNIT = CANVAS_PX_PER_PT * PT_PER_UNIT;
  const dist = shadow.distance * PX_PER_UNIT;
  const blur = shadow.blur * PX_PER_UNIT * 3; // zichtbaar blur-effect
  const rad  = shadow.angle * Math.PI / 180;
  ctx.shadowColor   = `rgba(0,0,0,${shadow.opacity.toFixed(3)})`;
  ctx.shadowOffsetX = Math.sin(rad) * dist;
  ctx.shadowOffsetY = -Math.cos(rad) * dist; // canvas Y gaat omlaag
  ctx.shadowBlur    = blur;
}

function clearCanvasShadow(ctx) {
  ctx.shadowColor   = 'transparent';
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.shadowBlur    = 0;
}

/**
 * Rasteriseer tekst naar PNG bytes.
 * aW_pt / aH_pt = area breedte/hoogte in PDF punten
 * vertIndent_pt = VerticalIndentMargin in pt (beginoffset bovenaan)
 * shadow = MCFX shadow-object (optioneel)
 */
async function rasterizeTextArea(htmlContent, aW_pt, aH_pt, vertIndent_pt, shadow) {
  const paragraphs = parseQtHtml(htmlContent);
  if (!paragraphs.length) return null;

  const cW = Math.max(1, Math.round(aW_pt * CANVAS_PX_PER_PT));
  const cH = Math.max(1, Math.round(aH_pt * CANVAS_PX_PER_PT));
  const canvas = new OffscreenCanvas(cW, cH);
  const ctx    = canvas.getContext('2d');
  ctx.clearRect(0, 0, cW, cH);

  let y = Math.round(vertIndent_pt * CANVAS_PX_PER_PT);

  for (const para of paragraphs) {
    // Hoogte van de hoogste run bepaalt de regelafstand
    const maxPt = Math.max(...para.runs.map(r => r.fontSizePt));
    const lineH = Math.round(maxPt * CANVAS_PX_PER_PT * 1.2);

    // Stel uitlijning in voor ctx
    const alignMap = { left: ['left', 0], center: ['center', cW / 2], right: ['right', cW] };
    const [ta, tx] = alignMap[para.align] ?? alignMap['left'];
    ctx.textAlign    = ta;
    ctx.textBaseline = 'top';

    // Veronderstel één run per paragraaf (meest voorkomend in CEWE fotoboeken).
    // Bij meerdere runs: teken opeenvolgend (imperfect maar werkbaar).
    for (const run of para.runs) {
      const sizePx   = run.fontSizePt * CANVAS_PX_PER_PT;
      const fontStr  = `${run.italic ? 'italic ' : ''}${run.bold ? 'bold ' : ''}${sizePx}px "${run.fontFamily}", Georgia, serif`;
      ctx.font       = fontStr;
      ctx.fillStyle  = run.color;
      applyCanvasShadow(ctx, shadow);

      for (const line of wrapWords(ctx, run.text, cW)) {
        if (y + sizePx > cH) break;
        ctx.fillText(line, tx, y);
        clearCanvasShadow(ctx); // schaduw alleen op eerste lijn (anders stapelt het)
        y += lineH;
      }
    }
  }

  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Rasteriseer SVG bytes naar PNG.
 *
 * Schaal-semantiek (geverifieerd op echte data):
 *   - mm-SVG:  svgImgW_pt = svgWidth_mm × cutoutScale       (scale is pt/mm)
 *   - px-SVG:  svgImgW_pt = svgWidth_px × cutoutScale × PT_PER_UNIT  (zelfde als JPEG)
 *
 * Geeft { pngBytes, svgImgW, svgImgH } terug in pt.
 */
function rasterizeSvg(svgBytes, shadow, cutoutScale) {
  return new Promise((resolve, reject) => {
    let svgText = new TextDecoder().decode(svgBytes);

    // Parse width/height inclusief eenheid (mm of px of geen)
    const wMatch  = /\bwidth=["']([0-9.]+)(mm|px)?["']/i.exec(svgText);
    const hMatch  = /\bheight=["']([0-9.]+)(mm|px)?["']/i.exec(svgText);
    const vbMatch = /viewBox=["']\s*[\d.]+ [\d.]+ ([\d.]+) ([\d.]+)["']/i.exec(svgText);

    const svgW = wMatch ? parseFloat(wMatch[1]) : (vbMatch ? parseFloat(vbMatch[1]) : 256);
    const svgH = hMatch ? parseFloat(hMatch[1]) : (vbMatch ? parseFloat(vbMatch[2]) : 256);
    const unit  = (wMatch?.[2] || '').toLowerCase();
    const scale = cutoutScale ?? 1;

    // Berekening van de gerenderde afmetingen in pt
    let svgImgW, svgImgH;
    if (unit === 'mm') {
      // Formule: rendered_pt = mm × scale  (geverifieerd: 732mm × 0.177 = 129.6pt ≈ frame 130.1pt)
      svgImgW = svgW * scale;
      svgImgH = svgH * scale;
    } else {
      // px: zelfde formule als JPEG (scale in MCFX-units/px)
      svgImgW = svgW * scale * PT_PER_UNIT;
      svgImgH = svgH * scale * PT_PER_UNIT;
    }

    // Rasteriseer op de gerenderde outputgrootte × CANVAS_PX_PER_PT
    // (proportioneel afkappen als te groot voor OffscreenCanvas)
    const rasterW_raw = Math.round(svgImgW * CANVAS_PX_PER_PT);
    const rasterH_raw = Math.round(svgImgH * CANVAS_PX_PER_PT);
    const maxDim = Math.max(rasterW_raw, rasterH_raw);
    const cap    = maxDim > 8192 ? 8192 / maxDim : 1;
    const rasterW = Math.max(1, Math.round(rasterW_raw * cap));
    const rasterH = Math.max(1, Math.round(rasterH_raw * cap));

    // Vervang width/height door expliciete px-waarden zodat de browser correct rendert.
    // Voeg viewBox toe als die ontbreekt — zonder viewBox schaalt de SVG-inhoud niet mee.
    let svgForRender = svgText.replace(/<svg(\b[^>]*)>/i, (_, attrs) => {
      const hasViewBox = /\bviewBox\s*=/i.test(attrs);
      let newAttrs = attrs
        .replace(/\s*\bwidth=["'][^"']*["']/gi, '')
        .replace(/\s*\bheight=["'][^"']*["']/gi, '');
      if (!hasViewBox) newAttrs += ` viewBox="0 0 ${svgW} ${svgH}"`;
      return `<svg${newAttrs} width="${rasterW}" height="${rasterH}">`;
    });

    const b64     = btoa(unescape(encodeURIComponent(svgForRender)));
    const dataUrl = 'data:image/svg+xml;base64,' + b64;

    const img = new Image();
    img.onload = async () => {
      try {
        const canvas = new OffscreenCanvas(rasterW, rasterH);
        const ctx    = canvas.getContext('2d');
        if (shadow) applyCanvasShadow(ctx, shadow);
        ctx.drawImage(img, 0, 0, rasterW, rasterH);
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        resolve({ pngBytes: new Uint8Array(await blob.arrayBuffer()), svgImgW, svgImgH });
      } catch (e) { reject(e); }
    };
    img.onerror = (e) => reject(new Error(`SVG render error: ${e?.message ?? e}`));
    img.src = dataUrl;
  });
}

/**
 * Rasteriseer een JPEG/PNG foto naar de exacte framegrootte op het gekozen DPI.
 * - Verwerkt de cutout (crop + schaal) op de canvas.
 * - Uitvoer is een PNG Uint8Array (pre-gecropped, klaar voor inbedden).
 * - pxPerPt = dpi / 72
 */
async function rasterizeImageToFrame(rawData, ext, aW_pt, aH_pt, cutout, pxPerPt) {
  const mimeType = (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg' : 'image/png';
  const blob     = new Blob([rawData], { type: mimeType });
  const url      = URL.createObjectURL(blob);

  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload  = () => { URL.revokeObjectURL(url); res(i); };
    i.onerror = ()  => { URL.revokeObjectURL(url); rej(new Error('img load')); };
    i.src = url;
  });

  const canvasW = Math.max(1, Math.round(aW_pt * pxPerPt));
  const canvasH = Math.max(1, Math.round(aH_pt * pxPerPt));

  // Beeldgrootte na cutout-schaal
  let imgW_px, imgH_px;
  if (cutout && cutout.scale > 0) {
    imgW_px = img.naturalWidth  * cutout.scale * PT_PER_UNIT * pxPerPt;
    imgH_px = img.naturalHeight * cutout.scale * PT_PER_UNIT * pxPerPt;
  } else {
    const coverScale = Math.max(canvasW / img.naturalWidth, canvasH / img.naturalHeight);
    imgW_px = img.naturalWidth  * coverScale;
    imgH_px = img.naturalHeight * coverScale;
  }

  // Cutout-offset (in canvas-pixels, Y naar beneden)
  const drawX = (cutout?.left ?? 0) * PT_PER_UNIT * pxPerPt;
  const drawY = (cutout?.top  ?? 0) * PT_PER_UNIT * pxPerPt;

  const canvas = new OffscreenCanvas(canvasW, canvasH);
  canvas.getContext('2d').drawImage(img, drawX, drawY, imgW_px, imgH_px);

  // JPEG source → JPEG uitvoer (vermijdt PNG-overhead voor foto's)
  // PNG source → PNG uitvoer (behoudt transparantie)
  const outType = mimeType;
  const outBlob = await canvas.convertToBlob({ type: outType, quality: 0.97 });
  return new Uint8Array(await outBlob.arrayBuffer());
}

/**
 * Rasteriseer een JPEG/PNG foto naar de exacte framegrootte op het gekozen DPI.
 * - Respecteert de cutout (crop + schaal).
 * - Samplet nooit hoger dan de native pixelresolutie van de bronafbeelding.
 * - pdfImgQuality: 'png' = lossless PNG, getal = JPEG quality (0-1)
 * - Cache: dezelfde combinatie van (dbKey, canvasW, canvasH, cutout, quality) wordt één keer berekend.
 */
const _rasterFrameCache = new Map();

async function rasterizeImageToFrame(rawData, ext, dbKey, aW_pt, aH_pt, cutout, pxPerPt, pdfImgQuality) {
  // Canvas-afmetingen in pixels op het gewenste DPI
  const targetW = Math.max(1, Math.round(aW_pt * pxPerPt));
  const targetH = Math.max(1, Math.round(aH_pt * pxPerPt));

  // Cache-sleutel inclusief cutout-params
  const cKey = `${dbKey}|${targetW}|${targetH}|${cutout?.left??0}|${cutout?.top??0}|${cutout?.scale??0}|${pdfImgQuality}`;
  if (_rasterFrameCache.has(cKey)) return _rasterFrameCache.get(cKey);

  const mimeType = (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg' : 'image/png';
  const blob     = new Blob([rawData], { type: mimeType });
  const url      = URL.createObjectURL(blob);

  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload  = () => { URL.revokeObjectURL(url); res(i); };
    i.onerror = ()  => { URL.revokeObjectURL(url); rej(new Error('img load')); };
    i.src = url;
  });

  // Schaalafmetingen van het beeld op het canvas
  let imgW_px, imgH_px;
  if (cutout && cutout.scale > 0) {
    imgW_px = img.naturalWidth  * cutout.scale * PT_PER_UNIT * pxPerPt;
    imgH_px = img.naturalHeight * cutout.scale * PT_PER_UNIT * pxPerPt;
  } else {
    const coverScale = Math.max(targetW / img.naturalWidth, targetH / img.naturalHeight);
    imgW_px = img.naturalWidth  * coverScale;
    imgH_px = img.naturalHeight * coverScale;
  }

  // Cap: nooit hoger rasteriseren dan de native pixelresolutie van de bron.
  // Dit voorkomt reusachtige canvassen voor kleine foto's op hoog DPI.
  const overScale = Math.max(imgW_px / img.naturalWidth, imgH_px / img.naturalHeight);
  let canvasW = targetW, canvasH = targetH;
  if (overScale > 1) {
    // Schaal alles naar beneden zodat de bron niet wordt vergroot
    canvasW = Math.max(1, Math.round(targetW / overScale));
    canvasH = Math.max(1, Math.round(targetH / overScale));
    imgW_px /= overScale;
    imgH_px /= overScale;
  }

  // Veiligheidsgrens: OffscreenCanvas crasht boven ~16 384px
  const MAX_DIM  = 8192;
  const bigSide  = Math.max(canvasW, canvasH);
  if (bigSide > MAX_DIM) {
    const shrink = MAX_DIM / bigSide;
    canvasW  = Math.max(1, Math.round(canvasW  * shrink));
    canvasH  = Math.max(1, Math.round(canvasH  * shrink));
    imgW_px *= shrink;
    imgH_px *= shrink;
  }

  const drawX = (cutout?.left ?? 0) * PT_PER_UNIT * (canvasW / targetW) * (targetW / (targetW / pxPerPt)) / (1 / pxPerPt * (canvasW / targetW));
  // Vereenvoudigd: cutout offset schalen naar de effectieve canvas schaal
  const effScale = canvasW / targetW; // verhouding effectief canvas tov gewenst
  const drawXpx  = (cutout?.left ?? 0) * PT_PER_UNIT * pxPerPt * effScale;
  const drawYpx  = (cutout?.top  ?? 0) * PT_PER_UNIT * pxPerPt * effScale;

  const canvas = new OffscreenCanvas(canvasW, canvasH);
  canvas.getContext('2d').drawImage(img, drawXpx, drawYpx, imgW_px, imgH_px);

  const outType    = (pdfImgQuality !== 'png') ? 'image/jpeg' : 'image/png';
  const outOptions  = outType === 'image/jpeg' ? { type: outType, quality: pdfImgQuality } : { type: outType };
  const outBlob = await canvas.convertToBlob(outOptions);
  const result  = new Uint8Array(await outBlob.arrayBuffer());
  _rasterFrameCache.set(cKey, result);
  return result;
}

// ─── PDF genereren ───────────────────────────────────────────────────────────
// Strategie voor hoge kwaliteit: JPEG/PNG bytes worden 1-op-1 ingebed in de PDF.
// Geen canvas-rendering, geen re-encoding → originele beeldkwaliteit behouden.
// Clipping van afbeeldingen binnen hun frame via PDF clip paths (pdf-lib operators).

async function buildPdf(parsed, mode, pdfImgQuality, onProgress, onElemProgress) {
  const { pages, files } = parsed;
  const {
    PDFDocument,
    pushGraphicsState, popGraphicsState,
    moveTo, lineTo, closePath, clip, endPath,
    concatTransformationMatrix,
  } = PDFLib;

  const pdfDoc = await PDFDocument.create();

  // Cache: voorkom dat dezelfde afbeelding meerdere keren wordt ingebed
  const embedCache = new Map();

  async function embedImage(dbKey) {
    if (embedCache.has(dbKey)) return embedCache.get(dbKey);
    const data = files.get(dbKey);
    if (!data) return null;
    const ext = dbKey.split('.').pop().toLowerCase();
    try {
      let img;
      if (ext === 'jpg' || ext === 'jpeg') img = await pdfDoc.embedJpg(data);
      else if (ext === 'png')              img = await pdfDoc.embedPng(data);
      else return null;
      embedCache.set(dbKey, img);
      return img;
    } catch (e) {
      console.warn(`Afbeelding overgeslagen (${dbKey}):`, e.message);
      return null;
    }
  }

  const skipEmpty    = document.getElementById('chk-skip-empty')?.checked ?? true;
  const hasUserContent = (page) => page.areas.some(a =>
    (a.type === 'clipartarea' && a.fillColor) ||
    ((a.type === 'imagearea' || a.type === 'imagebackgroundarea') && a.dbKey) ||
    ((a.type === 'textarea'  || a.type === 'spinetextarea') && a.htmlContent)
  );

  // ── Render-queue opbouwen ──────────────────────────────────────────────────
  // Elk queue-item beschrijft één PDF-pagina en bestaat uit één of twee layers.
  // Een layer is één MCFX-pagina met optionele x-verschuiving en clipping.
  //
  //   fullPW_pt  = volledige MCFX-paginabreedte in pt (voor bgOffset-berekening)
  //   xShift_pt  = verschuiving die op elke cx wordt opgeteld (negatief voor rechter cover-helft)
  //   clipX_pt   = linkergrens van het zichtbare venster op de PDF-pagina
  //   clipW_pt   = breedte van het zichtbare venster

  const renderQueue = [];

  if (mode === 'booklet') {
    const pagesToRender = skipEmpty
      ? pages.filter(p => p.type !== 'emptypage' && hasUserContent(p))
      : pages;
    for (const page of pagesToRender) {
      const pW = page.bundlesize.width  * PT_PER_UNIT;
      const pH = page.bundlesize.height * PT_PER_UNIT;
      renderQueue.push({ pdfW: pW, pdfH: pH, layers: [
        { page, fullPW_pt: pW, xShift_pt: 0, clipX_pt: 0, clipW_pt: pW }
      ]});
    }
  } else {
    // Boek-volgorde: voorkant → inhoud → achterkant
    // Eerste fullcover: links = achtercover, rechts = voorcover.
    const mainCover  = pages.find(p => p.type === 'fullcover');
    const normalPages = pages.filter(p =>
      p.type === 'normalpage' && (!skipEmpty || hasUserContent(p))
    );

    if (mainCover) {
      const fullW_pt = mainCover.bundlesize.width  * PT_PER_UNIT;
      const halfW_pt = fullW_pt / 2;
      const H_pt     = mainCover.bundlesize.height * PT_PER_UNIT;
      // Voorcover (rechter helft): xShift = -halfW zodat RIGHT_OR_BOTTOM areas op x=0 beginnen
      renderQueue.push({ pdfW: halfW_pt, pdfH: H_pt, layers: [
        { page: mainCover, fullPW_pt: fullW_pt, xShift_pt: -halfW_pt, clipX_pt: 0, clipW_pt: halfW_pt }
      ]});
    }

    if (mode === 'paged') {
      // Normal pages 2-up on one PDF page
      for (let i = 0; i < normalPages.length; i += 2) {
        const left  = normalPages[i];
        const right = normalPages[i + 1];
        if (right) {
          const lW = left.bundlesize.width   * PT_PER_UNIT;
          const rW = right.bundlesize.width  * PT_PER_UNIT;
          const pH = Math.max(left.bundlesize.height, right.bundlesize.height) * PT_PER_UNIT;
          renderQueue.push({ pdfW: lW + rW, pdfH: pH, layers: [
            { page: left,  fullPW_pt: lW, xShift_pt: 0,  clipX_pt: 0,  clipW_pt: lW },
            { page: right, fullPW_pt: rW, xShift_pt: lW, clipX_pt: lW, clipW_pt: rW },
          ]});
        } else {
          const pW = left.bundlesize.width  * PT_PER_UNIT;
          const pH = left.bundlesize.height * PT_PER_UNIT;
          renderQueue.push({ pdfW: pW, pdfH: pH, layers: [
            { page: left, fullPW_pt: pW, xShift_pt: 0, clipX_pt: 0, clipW_pt: pW }
          ]});
        }
      }
    } else { // 'page' mode: each MCFX page → one PDF page
      for (const p of normalPages) {
        const pW = p.bundlesize.width  * PT_PER_UNIT;
        const pH = p.bundlesize.height * PT_PER_UNIT;
        renderQueue.push({ pdfW: pW, pdfH: pH, layers: [
          { page: p, fullPW_pt: pW, xShift_pt: 0, clipX_pt: 0, clipW_pt: pW }
        ]});
      }
    }

    if (mainCover) {
      const fullW_pt = mainCover.bundlesize.width  * PT_PER_UNIT;
      const halfW_pt = fullW_pt / 2;
      const H_pt     = mainCover.bundlesize.height * PT_PER_UNIT;
      // Achtercover (linker helft): geen xShift, clip tot halfW
      renderQueue.push({ pdfW: halfW_pt, pdfH: H_pt, layers: [
        { page: mainCover, fullPW_pt: fullW_pt, xShift_pt: 0, clipX_pt: 0, clipW_pt: halfW_pt }
      ]});
    }
  }

  // ── Hulpfunctie: render alle areas van één layer op een pdfPage ───────────
  async function doRenderAreas(pdfPage, layer, pH_pt, totalElems, tickElem, pdfImgQuality) {
    const { page, fullPW_pt, xShift_pt, clipX_pt, clipW_pt } = layer;

    // Outer clip zodat content van deze layer niet in de andere layer loopt
    pdfPage.pushOperators(
      pushGraphicsState(),
      moveTo(clipX_pt,           0),
      lineTo(clipX_pt + clipW_pt, 0),
      lineTo(clipX_pt + clipW_pt, pH_pt),
      lineTo(clipX_pt,           pH_pt),
      closePath(), clip(), endPath(),
    );

    for (const area of page.areas) {
      // ── Clipart-overlays ────────────────────────────────────────────────
      if (area.type === 'clipartarea') {
        if (!area.fillColor) continue;
        const aW = area.pos.width  * PT_PER_UNIT;
        const aH = area.pos.height * PT_PER_UNIT;
        if (aW <= 0 || aH <= 0) continue;

        const r = parseInt(area.fillColor.slice(1, 3), 16) / 255;
        const g = parseInt(area.fillColor.slice(3, 5), 16) / 255;
        const b = parseInt(area.fillColor.slice(5, 7), 16) / 255;
        const cx  = (area.pos.left + area.pos.width  / 2) * PT_PER_UNIT + xShift_pt;
        const cy  = pH_pt - (area.pos.top + area.pos.height / 2) * PT_PER_UNIT;
        const θ   = area.pos.rotation * Math.PI / 180;
        pdfPage.pushOperators(
          pushGraphicsState(),
          concatTransformationMatrix(Math.cos(θ), -Math.sin(θ), Math.sin(θ), Math.cos(θ), cx, cy),
        );
        pdfPage.drawRectangle({
          x: -aW / 2, y: -aH / 2, width: aW, height: aH,
          color: PDFLib.rgb(r, g, b), borderWidth: 0, opacity: area.fillOpacity,
        });
        pdfPage.pushOperators(popGraphicsState());
        continue;
      }

      // ── Tekstvakken ────────────────────────────────────────────────────
      if (area.type === 'textarea' || area.type === 'spinetextarea') {
        if (!area.htmlContent) continue;
        const aW = area.pos.width  * PT_PER_UNIT;
        const aH = area.pos.height * PT_PER_UNIT;
        if (aW <= 0 || aH <= 0) continue;

        const vertIndent = (area.textFormat?.verticalIndentMargin ?? 0) * PT_PER_UNIT;
        const pngBytes = await rasterizeTextArea(area.htmlContent, aW, aH, vertIndent, area.shadow).catch(() => null);
        if (!pngBytes) continue;

        const pdfImg = await pdfDoc.embedPng(pngBytes);
        const cx = (area.pos.left + area.pos.width  / 2) * PT_PER_UNIT + xShift_pt;
        const cy = pH_pt - (area.pos.top + area.pos.height / 2) * PT_PER_UNIT;
        const θ  = area.pos.rotation * Math.PI / 180;
        pdfPage.pushOperators(
          pushGraphicsState(),
          concatTransformationMatrix(Math.cos(θ), -Math.sin(θ), Math.sin(θ), Math.cos(θ), cx, cy),
        );
        pdfPage.drawImage(pdfImg, { x: -aW / 2, y: -aH / 2, width: aW, height: aH });
        pdfPage.pushOperators(popGraphicsState());
        tickElem('text');
        continue;
      }

      if (area.type !== 'imagearea' && area.type !== 'imagebackgroundarea') continue;
      if (!area.dbKey) continue;

      // ── SVG-afbeeldingen ───────────────────────────────────────────────
      const isSvg = area.dbKey.toLowerCase().endsWith('.svg');
      if (isSvg) {
        const svgData = files.get(area.dbKey);
        const svgName = area.dbKey.split('_').pop() ?? area.dbKey;
        const aW = area.pos.width  * PT_PER_UNIT;
        const aH = area.pos.height * PT_PER_UNIT;
        if (aW <= 0 || aH <= 0) continue;

        onElemProgress?.(0, totalElems, `SVG: ${svgName}`);
        if (!svgData) { tickElem(`SVG (niet gevonden)`); continue; }

        const cutout = area.cutout ?? null;
        const result = await rasterizeSvg(svgData, area.shadow, cutout?.scale ?? null)
          .catch(e => { console.warn('SVG:', area.dbKey, e.message); return null; });
        if (!result) { tickElem(`SVG (overgeslagen)`); continue; }

        const pdfImg    = await pdfDoc.embedPng(result.pngBytes);
        const svgImgW   = result.svgImgW;
        const svgImgH   = result.svgImgH;
        const cutoutLeft = cutout?.left ?? 0;
        const cutoutTop  = cutout?.top  ?? 0;
        const imgLocalX  = cutoutLeft * PT_PER_UNIT - aW / 2;
        const imgLocalY  = aH / 2 - cutoutTop * PT_PER_UNIT - svgImgH;

        const bgOffsetX = (area.bgPosition === 'RIGHT_OR_BOTTOM') ? fullPW_pt / 2 : 0;
        const cx   = bgOffsetX + (area.pos.left + area.pos.width  / 2) * PT_PER_UNIT + xShift_pt;
        const cy   = pH_pt - (area.pos.top + area.pos.height / 2) * PT_PER_UNIT;
        const θ    = area.pos.rotation * Math.PI / 180;
        const cosθ = Math.cos(θ), sinθ = Math.sin(θ);

        pdfPage.pushOperators(
          pushGraphicsState(),
          concatTransformationMatrix(cosθ, -sinθ, sinθ, cosθ, cx, cy),
          moveTo(-aW / 2, -aH / 2), lineTo(aW / 2, -aH / 2),
          lineTo(aW / 2, aH / 2),  lineTo(-aW / 2, aH / 2),
          closePath(), clip(), endPath(),
        );
        pdfPage.drawImage(pdfImg, { x: imgLocalX, y: imgLocalY, width: svgImgW, height: svgImgH });
        pdfPage.pushOperators(popGraphicsState());
        tickElem(`SVG: ${svgName}`);
        continue;
      }

      // ── JPEG / PNG afbeeldingen ──────────────────────────────────────
      const rawData = files.get(area.dbKey);
      if (!rawData) { tickElem(area.dbKey.split('_').pop() ?? area.dbKey); continue; }

      const aW = area.pos.width  * PT_PER_UNIT;
      const aH = area.pos.height * PT_PER_UNIT;
      if (aW <= 0 || aH <= 0) continue;

      const ext      = area.dbKey.split('.').pop().toLowerCase();
      const cutout   = area.cutout ?? null;
      const framePng = await rasterizeImageToFrame(rawData, ext, area.dbKey, aW, aH, cutout, CANVAS_PX_PER_PT, pdfImgQuality)
        .catch(e => { console.warn('Photo raster:', area.dbKey, e.message); return null; });
      if (!framePng) { tickElem(area.dbKey.split('_').pop() ?? area.dbKey); continue; }

      // JPEG output → embedJpg (kleinere PDF), anders embedPng
      let pdfImg;
      try {
        pdfImg = (pdfImgQuality !== 'png')
          ? await pdfDoc.embedJpg(framePng)
          : await pdfDoc.embedPng(framePng);
      } catch (_) {
        try { pdfImg = await pdfDoc.embedPng(framePng); } catch (e2) {
          console.warn('Embed failed:', area.dbKey, e2.message);
          tickElem(area.dbKey.split('_').pop() ?? area.dbKey); continue;
        }
      }

      // Beeld is pre-gecropped naar framegrootte → geen clip path nodig.
      const bgOffsetX = (area.bgPosition === 'RIGHT_OR_BOTTOM') ? fullPW_pt / 2 : 0;
      const cx  = bgOffsetX + (area.pos.left + area.pos.width  / 2) * PT_PER_UNIT + xShift_pt;
      const cy  = pH_pt - (area.pos.top + area.pos.height / 2) * PT_PER_UNIT;
      const θ   = area.pos.rotation * Math.PI / 180;
      const cosθ = Math.cos(θ), sinθ = Math.sin(θ);

      pdfPage.pushOperators(
        pushGraphicsState(),
        concatTransformationMatrix(cosθ, -sinθ, sinθ, cosθ, cx, cy),
      );
      pdfPage.drawImage(pdfImg, { x: -aW / 2, y: -aH / 2, width: aW, height: aH });
      pdfPage.pushOperators(popGraphicsState());
      tickElem(area.dbKey.split('_').pop() ?? area.dbKey);
    }

    pdfPage.pushOperators(popGraphicsState()); // sluit outer clip
  }

  // ── Render queue uitvoeren ─────────────────────────────────────────────────
  for (let qi = 0; qi < renderQueue.length; qi++) {
    const qItem  = renderQueue[qi];
    const pdfPage = pdfDoc.addPage([qItem.pdfW, qItem.pdfH]);

    for (const layer of qItem.layers) {
      const renderableAreas = layer.page.areas.filter(a =>
        (a.type === 'clipartarea' && a.fillColor) ||
        ((a.type === 'imagearea' || a.type === 'imagebackgroundarea') && a.dbKey) ||
        ((a.type === 'textarea'  || a.type === 'spinetextarea') && a.htmlContent)
      );
      let elemDone = 0;
      const totalElems = renderableAreas.length;
      const tickElem = (label) => { elemDone++; onElemProgress?.(elemDone, totalElems, label); };
      await doRenderAreas(pdfPage, layer, qItem.pdfH, totalElems, tickElem, pdfImgQuality);
    }

    onProgress?.(qi + 1, renderQueue.length);
    setProgress(null, null, '\u00a0', 0);
    await new Promise(r => setTimeout(r, 0));
  }

  return pdfDoc.save();
}

// ─── JPEG export via PDF.js ──────────────────────────────────────────────────
// Rasterises each PDF page via PDF.js at the chosen DPI and
// packs all JPEG files into a single ZIP. Each page gets its own
// canvas of the correct size → fully scalable regardless of page format.
async function exportAsJpeg(pdfBytes, dpi, quality, baseName) {
  const scale       = dpi / 72; // 1 PDF point = 1/72 inch
  const loadingTask = pdfjsLib.getDocument({ data: pdfBytes });
  const pdf         = await loadingTask.promise;
  const zip         = new JSZip();
  const folder      = zip.folder(baseName);
  const digits      = String(pdf.numPages).length;

  for (let i = 1; i <= pdf.numPages; i++) {
setProgress(`JPEG page ${i} of ${pdf.numPages}`, Math.round((i - 1) / pdf.numPages * 100),
                `↳ rendering at ${dpi} DPI`, Math.round((i - 1) / pdf.numPages * 100));

    const pdfPage  = await pdf.getPage(i);
    const viewport = pdfPage.getViewport({ scale });
    const canvas   = document.createElement('canvas');
    canvas.width   = Math.round(viewport.width);
    canvas.height  = Math.round(viewport.height);

    // White background (JPEG does not support transparency)
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await pdfPage.render({ canvasContext: ctx, viewport }).promise;

    const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
    const arr  = new Uint8Array(await blob.arrayBuffer());
    const num  = String(i).padStart(digits, '0');
    folder.file(`page_${num}.jpg`, arr);

    await new Promise(r => setTimeout(r, 0)); // free UI thread
  }

  setProgress(`Packing ZIP…`, 99, null, 0);
  const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 3 } });
  return URL.createObjectURL(zipBlob);
}

// ─── PDF.js preview ──────────────────────────────────────────────────────────
async function renderPreview(pdfBytes) {
  sectionViewer.innerHTML = '';

  const loadingTask = pdfjsLib.getDocument({ data: pdfBytes });
  const pdf = await loadingTask.promise;

  for (let i = 1; i <= pdf.numPages; i++) {
    const pdfPage = await pdf.getPage(i);

    // Scale so that the width fits in the viewer (max 1200px)
    const vp0 = pdfPage.getViewport({ scale: 1 });
    const scale = Math.min(1200 / vp0.width, 1.5);
    const viewport = pdfPage.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width  = viewport.width;
    canvas.height = viewport.height;

    await pdfPage.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

    // Page number label
    const label = document.createElement('div');
    label.textContent = `Page ${i} / ${pdf.numPages}`;
    label.style.cssText = 'font-size:0.75rem;color:#555;margin-top:0.25rem;margin-bottom:-0.5rem';

    sectionViewer.appendChild(label);
    sectionViewer.appendChild(canvas);

    // Update progress per render step
    setProgress(`Preview: page ${i} of ${pdf.numPages}`, Math.round((i / pdf.numPages) * 100), '\u00a0', 0);
    await new Promise(r => setTimeout(r, 0));
  }
}
