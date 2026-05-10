# CEWE MCFX → PDF / JPEG

Export CEWE photo books from `.mcfx` files to high-quality PDF or JPEG — entirely in your browser, no upload required.

**[▶ Try it live](https://christophe195.github.io/cewe-export)**

---

## What it does

CEWE saves photo book projects as `.mcfx` files — a SQLite database containing the layout XML and all embedded photos. This tool reads those files locally in your browser and exports them as:

- **PDF** — vector layout with rasterised text and photos at your chosen DPI
- **JPEG (ZIP)** — each page rendered as a full-resolution JPEG, packed into a ZIP file

Supported export settings:

| Setting | Options |
|---|---|
| Mode | Booklet, Spread (single pages), Single page |
| DPI | 72 – 1200 (free input + presets) |
| PDF photo quality | PNG lossless, JPEG 75% – 97% |
| JPEG export quality | 70% – 100% |

---

## Live demo

**[https://christophe195.github.io/cewe-export](https://christophe195.github.io/cewe-export)**

<!-- Screenshot placeholder — replace with an actual screenshot -->
> *Screenshot coming soon*

---

## How to use

1. Open the [live demo](https://christophe195.github.io/cewe-export) in your browser (Chrome or Edge recommended for best OffscreenCanvas support).
2. Drag and drop your `.mcfx` file onto the page, or click **Choose file**.
3. The file is parsed locally — you will see book metadata (product, page count, HPS version).
4. Optionally allow the browser to **cache** the parsed result for faster future loads.
5. Choose your export settings:
   - **Mode** — Booklet (full cover spread), Spread (split cover, single pages), Single page
   - **Format** — PDF or JPEG
   - **DPI** — higher = larger file, more detail
   - **PDF photos** — PNG for lossless, JPEG 97% is a good balance
6. Click **Export** and wait for the progress bar to complete.
7. For PDF: click **⬇ Download PDF**.  
   For JPEG: the ZIP downloads automatically.

### Finding your `.mcfx` file

CEWE photo book projects are stored in:

| OS | Default location |
|---|---|
| Windows | `C:\Users\<name>\Pictures\CEWE\` |
| macOS | `~/Pictures/CEWE/` |

The file has the same name as your project and ends in `.mcfx`.

---

## How it works

### File format

A `.mcfx` file is a **SQLite 3 database** containing:

| Table column | Content |
|---|---|
| `data.mcf` | Main project XML (layout, pages, areas) |
| `*.jpg` / `*.png` / `*.svg` | All embedded photos and assets |

The layout XML describes pages with typed areas (`imagearea`, `textarea`, `imagebackgroundarea`, etc.), each with position, rotation, and cutout/scale parameters.

### Rendering pipeline

1. **sql.js** reads the SQLite database in WebAssembly
2. The XML is parsed into a structured page/area tree
3. **pdf-lib** builds the PDF — photos are placed on the canvas using the cutout geometry from the XML
4. JPEG and PNG photos are rasterised via `OffscreenCanvas` at the chosen DPI before embedding
5. Text areas are rasterised using an HTML canvas at the same DPI
6. SVGs are rasterised to PNG via an `<img>` element
7. For JPEG export, **PDF.js** renders each PDF page to a canvas at the chosen DPI

### Libraries used

| Library | Purpose |
|---|---|
| [sql.js](https://github.com/sql-js/sql.js) | SQLite in WebAssembly |
| [pdf-lib](https://pdf-lib.js.org) | PDF generation |
| [PDF.js](https://mozilla.github.io/pdf.js/) | PDF preview + JPEG rendering |
| [JSZip](https://stuk.github.io/jszip/) | ZIP packaging for JPEG export |

All libraries are vendored locally in `libs/` (no runtime CDN dependency). No server-side code.

---

## Privacy

Your `.mcfx` file **never leaves your device**. All parsing, rendering and export happens in your browser. The only data sent externally is anonymous usage statistics (page views, export settings, book product type, page count) via [Matomo](https://matomo.org/) running on a self-hosted server.

---

## License

Copyright (C) 2026 Christophe Van Dooren

This program is free software: you can redistribute it and/or modify it under the terms of the **GNU General Public License version 3** as published by the Free Software Foundation.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the [GNU General Public License](LICENSE) for more details.
