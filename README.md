# OpenPAVE PDF Skill

Generate branded PDF proposals and documents from structured JSON content. Includes two professional themes powered by Puppeteer.

## Themes

### Dark Theme (PAVE Cobalt)
- Cobalt dark background (`#0a0f1e`), lime-green accents (`#c8ff00`)
- Fixed-page layout with explicit page divs (A4, 297mm)
- Embedded C&R + PAVE logos on cover and page headers
- Optional client logo on cover
- Best for: PAVE proposals, client-facing sales documents

### Light Theme (C&R Professional)
- White background, configurable accent color (default `#0066CC`)
- Flowing layout with Puppeteer's native `@page` margins
- Repeating header/footer via `displayHeaderFooter`
- Best for: Product vision docs, requirements, specifications

## What's New in v1.1.0

- **Client Logo Validation** — `generate` and `preview` commands now verify the client logo path exists before rendering. If not found, prints a clear error with instructions instead of silently skipping.
- **Content Budget / Overflow Prevention** — New `contentBudgetCheck()` runs before HTML generation, estimating each page's content height using weighted block scoring. Pages exceeding the 227mm available area print a WARNING with the estimated height and a suggestion to split.
- **Standardized Logo Sizing** — Cover: C&R 32px, PAVE 50px, Client 60px. Headers: C&R 16px, PAVE 28px. No `.invert` CSS filter — provide logos in the correct color variant for the theme.
- **Footer Protection** — 26mm bottom padding on pages to prevent content overlapping the footer area.
- **Page Guideline** — Max ~10 blocks per page; tables count as 2-3 blocks depending on row count.

## Requirements

- Node.js >= 16
- Puppeteer (`npm install -g puppeteer` or available via npx)

## Installation

```bash
pave install pdf
```

## Usage

```bash
# Dark theme
pave run pdf dark sample -o content.json          # Generate sample JSON
pave run pdf dark generate -i content.json -o proposal.pdf
pave run pdf dark generate -i content.json -o proposal.pdf --client-logo logo.png --open
pave run pdf dark preview -i content.json          # HTML preview

# Light theme
pave run pdf light sample -o content.json          # Generate sample JSON
pave run pdf light generate -i content.json -o doc.pdf
pave run pdf light generate -i content.json -o doc.pdf --logo1 client.png --logo2 cnr.png --accent "#0066CC" --open
pave run pdf light preview -i content.json         # HTML preview
```

## Content JSON Schema

### Dark Theme

```json
{
  "entity": "C&R Wise AI Limited",
  "logos": {
    "cnr": "/path/to/cnr-logo-white.png",
    "pave": "/path/to/pave-logo.png",
    "client": "/path/to/client-logo.png"
  },
  "cover": {
    "title": "<span class='accent'>PAVE</span> AI Enablement Proposal",
    "subtitle": "Prepared for Acme Corp",
    "clientName": "Acme Corp",
    "preparedBy": "C&R WISE AI LIMITED",
    "date": "MARCH 2026",
    "version": "1.0",
    "badge": "Confidential",
    "headerLabel": "Acme Corp — PAVE AI Enablement"
  },
  "pages": [
    {
      "blocks": [
        { "type": "section", "label": "Section 01" },
        { "type": "h1", "text": "Executive Summary" },
        { "type": "p", "text": "Supports **bold**, *italic*, and `code`." },
        { "type": "table", "columns": ["Col1", "Col2"], "rows": [{ "cells": ["A", "B"] }] },
        { "type": "ul", "items": ["Item 1", "Item 2"] },
        { "type": "callout", "accent": true, "lines": ["Line 1", "Line 2"] },
        { "type": "blockquote", "text": "A quote" },
        { "type": "kv", "items": [{ "key": "Key", "value": "Value" }] },
        { "type": "two-col", "left": { "title": "Left", "blocks": [] }, "right": { "title": "Right", "blocks": [] } }
      ]
    }
  ]
}
```

### Light Theme

```json
{
  "accent": "#0066CC",
  "logos": {
    "logo1": "/path/to/client-logo.png",
    "logo2": "/path/to/cnr-logo-black.png"
  },
  "header": {
    "title": "Project Name",
    "subtitle": "Product Vision Document"
  },
  "footer": {
    "left": "© 2026 C&R Wise AI Limited",
    "center": "February 2026"
  },
  "blocks": [
    { "type": "title", "text": "Project Name" },
    { "type": "subtitle", "text": "Vision Document" },
    { "type": "h1", "text": "Section Title" },
    { "type": "p", "text": "Body text with **bold** and *italic*." },
    { "type": "table", "columns": ["A", "B"], "rows": [{ "cells": ["1", "2"] }] },
    { "type": "code", "text": "console.log('hello')" },
    { "type": "tree", "text": "src/\n  index.js\n  utils.js" },
    { "type": "callout", "variant": "info", "lines": ["Note text"] },
    { "type": "page-break" }
  ]
}
```

## Block Types

| Type | Dark | Light | Description |
|------|------|-------|-------------|
| `section` | Yes | - | Section label with accent line |
| `title` | - | Yes | Document title (centered) |
| `subtitle` | - | Yes | Document subtitle (centered) |
| `h1`-`h4` | Yes | Yes | Headings |
| `p` | Yes | Yes | Paragraph (inline markdown) |
| `hr` | Yes | Yes | Horizontal rule |
| `table` | Yes | Yes | Table with columns, rows, widths |
| `ul` / `ol` | Yes | Yes | Lists (light supports nesting) |
| `blockquote` | Yes | Yes | Styled quote block |
| `callout` | Yes | Yes | Callout box (dark: accent; light: info/warning/success) |
| `kv` | Yes | Yes | Key-value pairs |
| `two-col` | Yes | Yes | Two-column layout with sub-blocks |
| `code` | - | Yes | Code block |
| `tree` | - | Yes | File tree (preformatted) |
| `page-break` | - | Yes | Force page break |

## License

MIT - C&R Wise AI Limited
