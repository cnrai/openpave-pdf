#!/usr/bin/env node
/**
 * OpenPAVE PDF Skill
 *
 * Generate branded PDF documents from structured JSON content.
 * Two themes: Dark (PAVE Cobalt) and Light (C&R Professional).
 *
 * Uses Puppeteer via system.exec to render HTML to PDF.
 * Compatible with PAVE sandbox (__ipc__) and standalone Node.js.
 *
 * Usage:
 *   pdf dark generate -i content.json -o out.pdf
 *   pdf dark sample -o sample.json
 *   pdf light generate -i content.json -o out.pdf
 *   pdf light sample -o sample.json
 */

var fs = require('fs');
var path = require('path');

var args = process.argv.slice(2);

// ===================================================================
// System command execution (sandbox compatible)
// ===================================================================

function execCommand(cmd) {
  if (typeof __ipc__ === 'function') {
    var safeCmd = 'unset NODE_OPTIONS; ' + cmd;
    var result = __ipc__('system.exec', safeCmd);
    if (result.err) throw new Error(result.err);
    return { stdout: result.stdout || '', stderr: result.stderr || '', exitCode: result.exitCode || 0 };
  }
  // Fallback: child_process
  try {
    var cp = require('child_process');
    var out = cp.execSync(cmd, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
    return { stdout: out, stderr: '', exitCode: 0 };
  } catch (e) {
    return { stdout: e.stdout || '', stderr: e.stderr || '', exitCode: e.status || 1 };
  }
}

function exec(cmd) { return execCommand(cmd).stdout; }

function shellEscape(s) {
  if (!s) return "''";
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function resolvePath(p) {
  return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
}

function ensureDir(d) {
  try { exec('mkdir -p ' + shellEscape(d)); } catch (e) {}
}

function getFileSize(f) {
  try {
    var out = exec('stat -f "%z" ' + shellEscape(f) + ' 2>/dev/null || stat --format="%s" ' + shellEscape(f) + ' 2>/dev/null').trim();
    var n = parseInt(out, 10);
    return isNaN(n) ? 0 : n;
  } catch (e) { return 0; }
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  var k = 1024, sizes = ['B', 'KB', 'MB', 'GB'];
  var i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// ===================================================================
// Argument parser
// ===================================================================

function parseArgs() {
  var parsed = { theme: null, command: null, options: {} };
  var i = 0;

  // First arg: theme (dark/light)
  if (args[i] === 'dark' || args[i] === 'light') {
    parsed.theme = args[i]; i++;
  }
  // Second arg: command (generate/preview/sample)
  if (i < args.length && !args[i].startsWith('-')) {
    parsed.command = args[i]; i++;
  }
  // Remaining: options
  for (; i < args.length; i++) {
    var a = args[i];
    if (a.startsWith('--')) {
      var eq = a.indexOf('=');
      if (eq !== -1) {
        parsed.options[a.slice(2, eq)] = a.slice(eq + 1);
      } else if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        parsed.options[a.slice(2)] = args[i + 1]; i++;
      } else {
        parsed.options[a.slice(2)] = true;
      }
    } else if (a.startsWith('-') && a.length === 2) {
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        parsed.options[a.slice(1)] = args[i + 1]; i++;
      } else {
        parsed.options[a.slice(1)] = true;
      }
    }
  }
  return parsed;
}

// ===================================================================
// Shared helpers
// ===================================================================

function loadContent(inputPath) {
  var p = resolvePath(inputPath);
  if (!fs.existsSync(p)) throw new Error('Content file not found: ' + p);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function sanitiseFilename(s) {
  return s.replace(/[^a-zA-Z0-9_\- ]/g, '').replace(/\s+/g, '-').substring(0, 80);
}

function resolveLogoToBase64(filePath, label) {
  if (!filePath) return null;
  var abs = resolvePath(filePath);
  if (!fs.existsSync(abs)) {
    var msg = (label || 'Logo') + ' not found: ' + abs;
    if (label === 'Client logo') {
      msg += '\nPlease provide the client logo path via --client-logo <file> or in content.json logos.client';
    }
    throw new Error(msg);
  }
  var data = fs.readFileSync(abs);
  return 'data:image/png;base64,' + data.toString('base64');
}

function esc(text) {
  if (!text) return '';
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inline(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>');
}

// ===================================================================
// Content budget checker — estimates page content height to prevent overflow
// ===================================================================
// A4 page: 297mm total
// Top padding: 18mm, Bottom padding: 26mm, Header: ~14mm, Footer: ~12mm
// Available content area: 297 - 18 - 26 - 14 - 12 = 227mm

var PAGE_CONTENT_BUDGET_MM = 227;

function estimateBlockHeight(block) {
  switch (block.type) {
    case 'section': return 8;
    case 'h1': return 14;
    case 'h2': return 10;
    case 'h3': return 8;
    case 'h4': return 7;
    case 'p': return 8;
    case 'hr': return 6;
    case 'blockquote': return 14;
    case 'callout': return 10 + ((block.lines || []).length * 5);
    case 'table': {
      var rows = (block.rows || []).length;
      return 12 + (rows * 6); // header + rows
    }
    case 'ul': case 'ol': return 6 + ((block.items || []).length * 5);
    case 'kv': return (block.items || []).length * 5;
    case 'two-col': {
      var leftH = 10, rightH = 10;
      if (block.left && block.left.blocks) leftH += block.left.blocks.reduce(function(s, b) { return s + estimateBlockHeight(b); }, 0);
      if (block.right && block.right.blocks) rightH += block.right.blocks.reduce(function(s, b) { return s + estimateBlockHeight(b); }, 0);
      return Math.max(leftH, rightH) + 10;
    }
    default: return 8;
  }
}

function contentBudgetCheck(pages) {
  var warnings = [];
  pages.forEach(function(page, i) {
    var totalMm = 0;
    (page.blocks || []).forEach(function(block) {
      totalMm += estimateBlockHeight(block);
    });
    if (totalMm > PAGE_CONTENT_BUDGET_MM) {
      warnings.push('WARNING: Page ' + (i + 2) + ' estimated at ' + totalMm + 'mm (budget: ' + PAGE_CONTENT_BUDGET_MM + 'mm). Content may overflow. Consider splitting this page.');
    }
  });
  return warnings;
}

// ===================================================================
// DARK THEME — Block renderer
// ===================================================================

function darkRenderBlock(block) {
  switch (block.type) {
    case 'section': return '<div class="section-num">' + esc(block.label || '') + '</div>';
    case 'h1': return '<h1>' + esc(block.text) + '</h1>';
    case 'h2': return '<h2>' + esc(block.text) + '</h2>';
    case 'h3': return '<h3>' + esc(block.text) + '</h3>';
    case 'p': return '<p>' + inline(block.text) + '</p>';
    case 'hr': return '<hr>';
    case 'table': return darkRenderTable(block);
    case 'ul': return '<ul>' + (block.items || []).map(function(i) { return '<li>' + inline(i) + '</li>'; }).join('') + '</ul>';
    case 'ol': return '<ol>' + (block.items || []).map(function(i) { return '<li>' + inline(i) + '</li>'; }).join('') + '</ol>';
    case 'blockquote': return '<blockquote>' + inline(block.text) + '</blockquote>';
    case 'callout': return '<div class="callout' + (block.accent ? ' callout-accent' : '') + '">' + (block.lines || []).map(function(l) { return '<p style="margin-bottom:2px;">' + inline(l) + '</p>'; }).join('') + '</div>';
    case 'kv': return (block.items || []).map(function(kv) { return '<div class="kv"><span class="kv-key">' + esc(kv.key) + ':</span><span class="kv-val">' + inline(kv.value) + '</span></div>'; }).join('\n  ');
    case 'two-col': return darkRenderTwoCol(block);
    default: return '<!-- unknown: ' + (block.type || '') + ' -->';
  }
}

function darkRenderTable(block) {
  var cols = block.columns || [], rows = block.rows || [], widths = block.widths || [];
  var h = '<table>\n  <thead><tr>';
  cols.forEach(function(col, i) {
    var w = widths[i] ? ' style="width:' + widths[i] + '"' : '';
    h += '<th' + w + '>' + esc(col) + '</th>';
  });
  h += '</tr></thead>\n  <tbody>';
  rows.forEach(function(row) {
    var cls = row.highlight ? ' class="highlight-row"' : '';
    var style = row.accent ? ' style="background:var(--accent-dim);"' : '';
    h += '\n    <tr' + cls + style + '>';
    var cells = row.cells || row;
    if (Array.isArray(cells)) cells.forEach(function(cell, i) {
      var align = block.align && block.align[i] ? ' style="text-align:' + block.align[i] + '"' : '';
      h += '<td' + align + '>' + inline(String(cell)) + '</td>';
    });
    h += '</tr>';
  });
  h += '\n  </tbody>\n</table>';
  return h;
}

function darkRenderTwoCol(block) {
  var renderCol = function(col) {
    var accent = col.accent ? ' style="border-color:var(--border-accent);"' : '';
    var inner = col.title ? '<h4>' + esc(col.title) + '</h4>' : '';
    inner += (col.blocks || []).map(darkRenderBlock).join('\n');
    return '<div class="col-box"' + accent + '>' + inner + '</div>';
  };
  return '<div class="two-col">' + renderCol(block.left || {}) + renderCol(block.right || {}) + '</div>';
}

// ===================================================================
// DARK THEME — HTML builder
// ===================================================================

function darkBuildHtml(content, logos) {
  var cover = content.cover || {};
  var pages = content.pages || [];
  var entity = content.entity || 'C&R Wise AI Limited';
  var headerLabel = cover.headerLabel || (cover.clientName || '') + ' — ' + (cover.shortTitle || cover.title || '');

  var html = '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<title>' + esc(cover.title || 'Proposal') + '</title>\n' + DARK_CSS + '\n</head>\n<body>\n';

  // Cover
  var cnrImg = logos.cnr ? '<img src="' + logos.cnr + '" alt="C&amp;R" style="height:32px;">' : '';
  var paveImg = logos.pave ? '<img src="' + logos.pave + '" alt="PAVE" class="cover-pave">' : '';
  var clientImg = logos.client ? '<div class="cover-client"><img src="' + logos.client + '" alt="' + esc(cover.clientName || '') + '"></div>' : '';
  var divider = cnrImg && paveImg ? '<div class="cover-divider"></div>' : '';
  var footerPave = logos.pave ? '<img src="' + logos.pave + '" alt="PAVE" class="cover-footer-pave">' : '';

  html += '<div class="cover">\n';
  html += '  <div class="cover-logos">' + cnrImg + divider + paveImg + '</div>\n';
  html += '  <div class="cover-title">' + (cover.title || '') + '</div>\n';
  if (cover.subtitle) html += '  <div class="cover-subtitle">' + esc(cover.subtitle) + '</div>\n';
  html += '  ' + clientImg + '\n';
  html += '  <div class="cover-meta">\n';
  if (cover.preparedBy) html += '    <p>PREPARED BY: ' + esc(cover.preparedBy) + '</p>\n';
  if (cover.date) html += '    <p>DATE: ' + esc(cover.date) + (cover.version ? ' &nbsp;|&nbsp; VERSION ' + esc(cover.version) : '') + '</p>\n';
  if (cover.badge) html += '    <div class="cover-badge">' + esc(cover.badge) + '</div>\n';
  html += '  </div>\n';
  html += '  <div class="cover-footer">' + footerPave + '</div>\n';
  html += '</div>\n';

  // Content pages
  var pageNum = 2;
  pages.forEach(function(page) {
    var cnr = logos.cnr ? '<img src="' + logos.cnr + '" alt="C&amp;R" class="hdr-cnr">' : '';
    var pave = logos.pave ? '<img src="' + logos.pave + '" alt="PAVE" class="hdr-pave">' : '';
    var sep = cnr && pave ? '<div class="hdr-sep"></div>' : '';
    var header = '<div class="page-header"><div class="header-logos">' + cnr + sep + pave + '</div><span class="page-label">' + esc(headerLabel) + '</span></div>';
    var footer = '<div class="page-footer"><span>' + esc(entity) + '</span><span>Confidential</span><span>' + pageNum + '</span></div>';
    var blocks = (page.blocks || []).map(darkRenderBlock).join('\n  ');
    html += '\n<div class="page">\n  ' + header + '\n  ' + blocks + '\n  ' + footer + '\n</div>\n';
    pageNum++;
  });

  html += '\n</body>\n</html>';
  return html;
}

// ===================================================================
// LIGHT THEME — Block renderer
// ===================================================================

function lightRenderListItem(item) {
  if (typeof item === 'string') return '<li>' + inline(item) + '</li>';
  var h = '<li>' + inline(item.text || '');
  if (item.children && item.children.length) {
    h += '<ul>' + item.children.map(lightRenderListItem).join('') + '</ul>';
  }
  h += '</li>';
  return h;
}

function lightRenderBlock(block) {
  switch (block.type) {
    case 'title': return '<h1 class="doc-title">' + inline(block.text) + '</h1>';
    case 'subtitle': return '<h1 class="doc-subtitle">' + inline(block.text) + '</h1>';
    case 'h1': return '<h1>' + inline(block.text) + '</h1>';
    case 'h2': return '<h2>' + inline(block.text) + '</h2>';
    case 'h3': return '<h3>' + inline(block.text) + '</h3>';
    case 'h4': return '<h4>' + inline(block.text) + '</h4>';
    case 'p': return '<p>' + inline(block.text) + '</p>';
    case 'hr': return '<hr>';
    case 'table': return lightRenderTable(block);
    case 'ul': return '<ul>' + (block.items || []).map(lightRenderListItem).join('') + '</ul>';
    case 'ol': return '<ol>' + (block.items || []).map(lightRenderListItem).join('') + '</ol>';
    case 'blockquote': return '<blockquote>' + inline(block.text) + '</blockquote>';
    case 'callout': return '<div class="callout' + (block.variant ? ' callout-' + block.variant : '') + '">' + (block.lines || [block.text]).map(function(l) { return '<p>' + inline(l) + '</p>'; }).join('') + '</div>';
    case 'code': return '<pre><code>' + esc(block.text) + '</code></pre>';
    case 'tree': return '<pre class="tree">' + esc(block.text) + '</pre>';
    case 'kv': return (block.items || []).map(function(kv) { return '<div class="kv"><span class="kv-label">' + esc(kv.key) + ':</span> <span class="kv-value">' + inline(kv.value) + '</span></div>'; }).join('\n');
    case 'two-col': return lightRenderTwoCol(block);
    case 'page-break': return '<div class="page-break"></div>';
    default: return '<!-- unknown: ' + (block.type || '') + ' -->';
  }
}

function lightRenderTable(block) {
  var cols = block.columns || [], rows = block.rows || [], widths = block.widths || [];
  var h = '<table>\n  <thead><tr>';
  cols.forEach(function(col, i) {
    var w = widths[i] ? ' style="width:' + widths[i] + '"' : '';
    h += '<th' + w + '>' + esc(col) + '</th>';
  });
  h += '</tr></thead>\n  <tbody>';
  rows.forEach(function(row) {
    var cls = row.highlight ? ' class="highlight-row"' : '';
    h += '\n    <tr' + cls + '>';
    var cells = row.cells || row;
    if (Array.isArray(cells)) cells.forEach(function(cell) {
      h += '<td>' + inline(String(cell)) + '</td>';
    });
    h += '</tr>';
  });
  h += '\n  </tbody>\n</table>';
  return h;
}

function lightRenderTwoCol(block) {
  var renderCol = function(col) {
    var inner = col.title ? '<h4>' + esc(col.title) + '</h4>' : '';
    inner += (col.blocks || []).map(lightRenderBlock).join('\n');
    return '<div class="col-box">' + inner + '</div>';
  };
  return '<div class="two-col">' + renderCol(block.left || {}) + renderCol(block.right || {}) + '</div>';
}

// ===================================================================
// LIGHT THEME — Color helpers
// ===================================================================

function hexToRgb(hex) {
  var h = hex.replace('#', '');
  return { r: parseInt(h.substring(0, 2), 16), g: parseInt(h.substring(2, 4), 16), b: parseInt(h.substring(4, 6), 16) };
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(function(c) { return Math.max(0, Math.min(255, c)).toString(16).padStart(2, '0'); }).join('');
}

function darken(hex, amount) {
  var rgb = hexToRgb(hex);
  return rgbToHex(Math.round(rgb.r * (1 - amount)), Math.round(rgb.g * (1 - amount)), Math.round(rgb.b * (1 - amount)));
}

function lighten(hex, lightness) {
  var rgb = hexToRgb(hex);
  return rgbToHex(Math.round(rgb.r + (255 - rgb.r) * lightness), Math.round(rgb.g + (255 - rgb.g) * lightness), Math.round(rgb.b + (255 - rgb.b) * lightness));
}

// ===================================================================
// LIGHT THEME — HTML builder
// ===================================================================

function lightBuildHtml(content, accent) {
  var blocks = content.blocks || [];
  var accentDark = darken(accent, 0.3);
  var accentLight = lighten(accent, 0.92);
  var css = lightBuildCss(accent, accentDark, accentLight);

  var html = '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<title>' + esc(content.header ? content.header.title : 'Document') + '</title>\n' + css + '\n</head>\n<body>\n';
  html += blocks.map(lightRenderBlock).join('\n');
  html += '\n</body>\n</html>';
  return html;
}

// ===================================================================
// PDF RENDERER — Generates temp ESM script and runs via node
// ===================================================================

function renderPdfViaPuppeteer(htmlPath, outputPath, pdfOptions) {
  var tmpDir = '/tmp/pave_pdf_render';
  ensureDir(tmpDir);
  var tmpScript = tmpDir + '/render_' + Date.now() + '.mjs';

  var margin = pdfOptions.margin || { top: 0, right: 0, bottom: 0, left: 0 };
  var displayHeaderFooter = pdfOptions.displayHeaderFooter || false;
  var headerTemplate = pdfOptions.headerTemplate || '';
  var footerTemplate = pdfOptions.footerTemplate || '';

  var scriptContent = [
    'import puppeteer from "puppeteer";',
    '',
    'const browser = await puppeteer.launch({',
    '  headless: "new",',
    '  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-web-security", "--allow-file-access-from-files", "--font-render-hinting=none"]',
    '});',
    '',
    'const page = await browser.newPage();',
    'await page.setViewport({ width: 794, height: 1123 });',
    'await page.goto("file://' + htmlPath.replace(/"/g, '\\"') + '", { waitUntil: "networkidle0", timeout: 60000 });',
    '',
    'try { await page.evaluateHandle("document.fonts.ready"); } catch {}',
    'await new Promise(r => setTimeout(r, 5000));',
    '',
    'const len = await page.evaluate(() => document.body.innerHTML.length);',
    'if (len < 100) throw new Error("Rendered page appears blank");',
    '',
    'await page.pdf({',
    '  path: "' + outputPath.replace(/"/g, '\\"') + '",',
    '  format: "A4",',
    '  printBackground: true,',
    displayHeaderFooter ? '  displayHeaderFooter: true,' : '  preferCSSPageSize: true,',
    displayHeaderFooter ? '  headerTemplate: ' + JSON.stringify(headerTemplate) + ',' : '',
    displayHeaderFooter ? '  footerTemplate: ' + JSON.stringify(footerTemplate) + ',' : '',
    '  margin: ' + JSON.stringify(margin),
    '});',
    '',
    'await browser.close();',
    'console.log("OK");'
  ].filter(Boolean).join('\n');

  try {
    fs.writeFileSync(tmpScript, scriptContent);
  } catch (e) {
    exec("cat > " + shellEscape(tmpScript) + " << 'PAVE_PDF_EOF'\n" + scriptContent + "\nPAVE_PDF_EOF");
  }

  var result = execCommand('node ' + shellEscape(tmpScript) + ' 2>&1');

  // Clean up
  try { exec('rm -f ' + shellEscape(tmpScript)); } catch (e) {}

  if (!fs.existsSync(outputPath)) {
    throw new Error('PDF generation failed. Output: ' + (result.stdout || '') + (result.stderr || ''));
  }
}

// ===================================================================
// DARK THEME — Commands
// ===================================================================

function cmdDarkGenerate(opts) {
  var input = opts.i || opts.input;
  if (!input) throw new Error('--input / -i is required');

  var content = loadContent(input);

  // Validate client logo — prompt user if not found
  var clientLogoPath = opts['client-logo'] || (content.logos && content.logos.client) || null;
  if (clientLogoPath) {
    var absClient = resolvePath(clientLogoPath);
    if (!fs.existsSync(absClient)) {
      console.error('ERROR: Client logo not found: ' + absClient);
      console.error('Please provide the correct client logo path via --client-logo <file> or update logos.client in your content JSON.');
      process.exit(1);
    }
  }

  var logos = {
    cnr: resolveLogoToBase64(opts['cnr-logo'] || (content.logos && content.logos.cnr) || null, 'C&R logo'),
    pave: resolveLogoToBase64(opts['pave-logo'] || (content.logos && content.logos.pave) || null, 'PAVE logo'),
    client: resolveLogoToBase64(clientLogoPath, 'Client logo')
  };

  // Content budget check — warn about pages that may overflow
  var budgetWarnings = contentBudgetCheck(content.pages || []);
  if (budgetWarnings.length > 0) {
    budgetWarnings.forEach(function(w) { console.error(w); });
  }

  var html = darkBuildHtml(content, logos);
  var outputPath = opts.o || opts.output || ('tmp/' + sanitiseFilename(content.cover ? content.cover.title : 'proposal') + '.pdf');
  outputPath = resolvePath(outputPath);
  ensureDir(path.dirname(outputPath));

  // Write temp HTML
  var tmpHtml = path.join(path.dirname(outputPath), '.tmp-dark-proposal.html');
  fs.writeFileSync(tmpHtml, html, 'utf8');

  renderPdfViaPuppeteer(tmpHtml, outputPath, {
    margin: { top: 0, right: 0, bottom: 0, left: 0 }
  });

  try { exec('rm -f ' + shellEscape(tmpHtml)); } catch (e) {}

  var size = getFileSize(outputPath);
  console.log('PDF generated: ' + outputPath + '  (' + formatBytes(size) + ')');

  if (opts.open) {
    try { exec('open ' + shellEscape(outputPath)); } catch (e) {}
  }
}

function cmdDarkPreview(opts) {
  var input = opts.i || opts.input;
  if (!input) throw new Error('--input / -i is required');

  var content = loadContent(input);

  // Validate client logo
  var clientLogoPath = opts['client-logo'] || (content.logos && content.logos.client) || null;
  if (clientLogoPath) {
    var absClient = resolvePath(clientLogoPath);
    if (!fs.existsSync(absClient)) {
      console.error('ERROR: Client logo not found: ' + absClient);
      console.error('Please provide the correct client logo path via --client-logo <file> or update logos.client in your content JSON.');
      process.exit(1);
    }
  }

  var logos = {
    cnr: resolveLogoToBase64(opts['cnr-logo'] || (content.logos && content.logos.cnr) || null, 'C&R logo'),
    pave: resolveLogoToBase64(opts['pave-logo'] || (content.logos && content.logos.pave) || null, 'PAVE logo'),
    client: resolveLogoToBase64(clientLogoPath, 'Client logo')
  };

  // Content budget check
  var budgetWarnings = contentBudgetCheck(content.pages || []);
  if (budgetWarnings.length > 0) {
    budgetWarnings.forEach(function(w) { console.error(w); });
  }

  var html = darkBuildHtml(content, logos);
  var outPath = opts.o || opts.output || ('tmp/' + sanitiseFilename(content.cover ? content.cover.title : 'preview') + '.html');
  outPath = resolvePath(outPath);
  fs.writeFileSync(outPath, html, 'utf8');
  console.log('HTML preview: ' + outPath);
  try { exec('open ' + shellEscape(outPath)); } catch (e) {}
}

// ===================================================================
// LIGHT THEME — Commands
// ===================================================================

function cmdLightGenerate(opts) {
  var input = opts.i || opts.input;
  if (!input) throw new Error('--input / -i is required');

  var content = loadContent(input);
  var accent = opts.accent || content.accent || '#0066CC';
  var logos = {
    logo1: resolveLogoToBase64(opts.logo1 || (content.logos && content.logos.logo1) || null),
    logo2: resolveLogoToBase64(opts.logo2 || (content.logos && content.logos.logo2) || null)
  };

  var html = lightBuildHtml(content, accent);
  var outputPath = opts.o || opts.output || ('tmp/' + sanitiseFilename(content.header ? content.header.title : 'document') + '.pdf');
  outputPath = resolvePath(outputPath);
  ensureDir(path.dirname(outputPath));

  // Write temp HTML
  var tmpHtml = path.join(path.dirname(outputPath), '.tmp-light-doc.html');
  fs.writeFileSync(tmpHtml, html, 'utf8');

  // Build header/footer templates for displayHeaderFooter
  var hdr = content.header || {};
  var logo1Img = logos.logo1 ? '<img src="' + logos.logo1 + '" style="height:40px;" />' : '';
  var logo2Img = logos.logo2 ? '<img src="' + logos.logo2 + '" style="height:24px;" />' : '';

  var headerTemplate = '<div style="width:100%; font-size:9px; padding:10px 50px; display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #e2e8f0;"><div style="display:flex; align-items:center; gap:15px;">' + logo1Img + logo2Img + '</div><div style="text-align:right; color:#4a5568;"><div style="font-weight:600;">' + esc(hdr.title || '') + '</div>' + (hdr.subtitle ? '<div style="font-size:8px; color:#718096;">' + esc(hdr.subtitle) + '</div>' : '') + '</div></div>';

  var ftr = content.footer || {};
  var yr = new Date().getFullYear();
  var footerLeft = esc(ftr.left || '\u00A9 ' + yr + ' C&R Wise AI Limited \u2013 Commercial in Confidence');
  var footerCenter = esc(ftr.center || '');
  var footerRight = ftr.right || 'Page <span class="pageNumber"></span> of <span class="totalPages"></span>';

  var footerTemplate = '<div style="width:100%; font-size:8px; padding:10px 50px; display:flex; justify-content:space-between; align-items:center; border-top:1px solid #e2e8f0; color:#718096;"><div>' + footerLeft + '</div><div>' + footerCenter + '</div><div>' + footerRight + '</div></div>';

  renderPdfViaPuppeteer(tmpHtml, outputPath, {
    displayHeaderFooter: true,
    headerTemplate: headerTemplate,
    footerTemplate: footerTemplate,
    margin: { top: '130px', bottom: '80px', left: '50px', right: '50px' }
  });

  try { exec('rm -f ' + shellEscape(tmpHtml)); } catch (e) {}

  var size = getFileSize(outputPath);
  console.log('PDF generated: ' + outputPath + '  (' + formatBytes(size) + ')');

  if (opts.open) {
    try { exec('open ' + shellEscape(outputPath)); } catch (e) {}
  }
}

function cmdLightPreview(opts) {
  var input = opts.i || opts.input;
  if (!input) throw new Error('--input / -i is required');

  var content = loadContent(input);
  var accent = opts.accent || content.accent || '#0066CC';
  var html = lightBuildHtml(content, accent);
  var outPath = opts.o || opts.output || ('tmp/' + sanitiseFilename(content.header ? content.header.title : 'preview') + '.html');
  outPath = resolvePath(outPath);
  fs.writeFileSync(outPath, html, 'utf8');
  console.log('HTML preview: ' + outPath);
  try { exec('open ' + shellEscape(outPath)); } catch (e) {}
}

// ===================================================================
// SAMPLE CONTENT
// ===================================================================

var DARK_SAMPLE = {
  entity: "C&R Wise AI Limited",
  logos: { cnr: null, pave: null, client: null },
  cover: {
    title: "<span class='accent'>PAVE</span> AI Enablement Proposal",
    subtitle: "Prepared for",
    clientName: "Acme Corp",
    preparedBy: "C&R WISE AI LIMITED",
    date: "MARCH 2026",
    version: "1.0",
    badge: "Confidential",
    headerLabel: "Acme Corp \u2014 PAVE AI Enablement",
    shortTitle: "PAVE AI Enablement"
  },
  pages: [
    {
      blocks: [
        { type: "section", label: "Section 01" },
        { type: "h1", text: "Executive Summary" },
        { type: "p", text: "This is a sample proposal generated by the PAVE PDF skill." },
        { type: "p", text: "It demonstrates the **Cobalt design system** with lime-green accents." },
        { type: "h3", text: "Key Deliverables" },
        { type: "table", columns: ["Phase", "Activity", "Outcome"], widths: ["25%", "40%", "35%"], rows: [
          { cells: ["**Workshop**", "Hands-on build sessions", "2 functional POCs"] },
          { cells: ["**Support**", "Professional services", "Production-ready app(s)"], highlight: true }
        ]},
        { type: "h3", text: "Value Proposition" },
        { type: "ul", items: [
          "**From Outsourcing to Ownership** \u2014 Build internal capability",
          "**Cross-functional enablement** \u2014 PMs, BAs, IT specialists all participate",
          "**Low CapEx, Predictable OpEx** \u2014 Workshop + subscription model"
        ]}
      ]
    },
    {
      blocks: [
        { type: "section", label: "Section 02" },
        { type: "h1", text: "Investment Summary" },
        { type: "table", columns: ["Component", "Description", "Investment (HKD)"], widths: ["30%", "45%", "25%"], rows: [
          { cells: ["**Workshop**", "3 sessions", "48,000"] },
          { cells: ["**Support**", "4 man-days", "32,000"] },
          { cells: ["**Total**", "", "**80,000**"], highlight: true }
        ]},
        { type: "hr" },
        { type: "section", label: "Section 03" },
        { type: "h1", text: "Contact" },
        { type: "callout", accent: true, lines: [
          "**C&R Wise AI Limited**",
          "**Anne So**, Chief Strategy Officer",
          "**Email:** anne.so@candrholdings.com"
        ]},
        { type: "blockquote", text: "**Note:** This proposal is valid for 3 months from the date of issue." }
      ]
    }
  ]
};

var LIGHT_SAMPLE = {
  accent: "#0066CC",
  logos: { logo1: null, logo2: null },
  header: { title: "Project Name", subtitle: "Product Vision Document" },
  footer: { left: "\u00A9 2026 C&R Wise AI Limited \u2013 Commercial in Confidence", center: "February 2026" },
  blocks: [
    { type: "title", text: "Project Name" },
    { type: "subtitle", text: "Product Vision Document" },
    { type: "p", text: "**Intelligent Platform for Business Operations**" },
    { type: "blockquote", text: "**UPDATED Feb 2026** \u2014 Revised based on client feedback." },
    { type: "hr" },
    { type: "h1", text: "1. Executive Summary" },
    { type: "p", text: "This document outlines the product vision for an AI-powered system." },
    { type: "hr" },
    { type: "h1", text: "2. Business Objectives" },
    { type: "table", columns: ["Objective", "Description"], widths: ["30%", "70%"], rows: [
      { cells: ["**Early Visibility**", "Gain real-time insight into progress"] },
      { cells: ["**Automated Extraction**", "Use AI to extract critical data"] },
      { cells: ["**Reduced Manual Effort**", "Eliminate repetitive tasks"] }
    ]},
    { type: "hr" },
    { type: "h1", text: "3. Next Steps" },
    { type: "ol", items: [
      "**Discovery Session:** Deep-dive into current workflow",
      "**System Demo:** Show platform capabilities",
      "**Technical Assessment:** Review integration requirements",
      "**Pilot Scope:** Define MVP scope"
    ]},
    { type: "callout", variant: "info", lines: [
      "**Document Prepared By:** Anne So, C&R",
      "**Date:** February 2026"
    ]}
  ]
};

function cmdSample(theme, opts) {
  var sample = JSON.stringify(theme === 'dark' ? DARK_SAMPLE : LIGHT_SAMPLE, null, 2);
  var output = opts.o || opts.output;
  if (output) {
    var outPath = resolvePath(output);
    fs.writeFileSync(outPath, sample, 'utf8');
    console.log('Sample written to ' + outPath);
  } else {
    console.log(sample);
  }
}

// ===================================================================
// CSS — Dark Theme (Cobalt)
// ===================================================================

var DARK_CSS = '<style>\n' +
"@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap');\n" +
':root { --cobalt:#0a0f1e; --cobalt-light:#111827; --cobalt-mid:#1a2332; --accent:#c8ff00; --accent-dim:rgba(200,255,0,0.15); --accent-glow:rgba(200,255,0,0.3); --text:#e8eaed; --text-dim:#9ca3af; --text-muted:#6b7280; --border:rgba(255,255,255,0.08); --border-accent:rgba(200,255,0,0.25); }\n' +
'* { margin:0; padding:0; box-sizing:border-box; }\n' +
'@page { size:210mm 297mm; margin:0; }\n' +
'html { width:210mm; max-width:210mm; overflow:hidden; }\n' +
'body { font-family:"Inter",-apple-system,sans-serif; background:var(--cobalt); color:var(--text); font-size:9.5pt; line-height:1.55; -webkit-print-color-adjust:exact; print-color-adjust:exact; width:210mm; max-width:210mm; overflow-x:hidden; }\n' +
'.cover { width:210mm; max-width:210mm; height:297mm; background:var(--cobalt); display:flex; flex-direction:column; justify-content:center; align-items:center; position:relative; page-break-after:always; overflow:hidden; }\n' +
".cover::before { content:''; position:absolute; top:-100px; left:50%; transform:translateX(-50%); width:600px; height:400px; background:radial-gradient(ellipse,var(--accent-glow) 0%,transparent 70%); filter:blur(80px); opacity:0.2; }\n" +
'.cover-logos { display:flex; align-items:center; gap:24px; margin-bottom:60px; z-index:1; }\n' +
'.cover-logos img { height:32px; }\n' +
'.cover-logos img.cover-pave { height:50px; }\n' +
'.cover-client img { height:60px; }\n' +
'.cover-footer-pave { height:20px; opacity:0.4; }\n' +
'.cover-divider { width:1px; height:36px; background:rgba(255,255,255,0.2); }\n' +
'.cover-client { margin-top:30px; z-index:1; }\n' +
'.cover-client img { height:60px; }\n' +
'.cover-title { font-size:32pt; font-weight:800; letter-spacing:-1.5px; text-align:center; z-index:1; max-width:500px; line-height:1.15; }\n' +
'.cover-title .accent { color:var(--accent); }\n' +
'.cover-subtitle { font-size:13pt; color:var(--text-dim); margin-top:20px; text-align:center; z-index:1; }\n' +
'.cover-meta { margin-top:60px; text-align:center; z-index:1; }\n' +
".cover-meta p { font-family:'JetBrains Mono',monospace; font-size:9pt; color:var(--text-muted); letter-spacing:0.05em; margin-bottom:4px; }\n" +
".cover-badge { display:inline-block; margin-top:20px; padding:6px 16px; background:var(--accent-dim); border:1px solid var(--border-accent); border-radius:4px; font-family:'JetBrains Mono',monospace; font-size:8pt; color:var(--accent); letter-spacing:0.1em; text-transform:uppercase; }\n" +
'.cover-footer { position:absolute; bottom:30px; left:0; right:0; text-align:center; }\n' +
'.cover-footer img { height:20px; opacity:0.4; }\n' +
'.invert { filter:brightness(0) invert(1); }\n' +
'.page { width:210mm; max-width:210mm; height:297mm; padding:18mm 22mm 26mm 22mm; background:var(--cobalt); page-break-after:always; position:relative; overflow:hidden; }\n' +
".page::before { content:''; position:absolute; top:0; left:0; right:0; height:3px; background:linear-gradient(90deg,var(--accent),transparent); }\n" +
'.page-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; padding-bottom:6px; border-bottom:1px solid var(--border); max-width:100%; }\n' +
'.header-logos { display:flex; align-items:center; gap:10px; flex-shrink:0; }\n' +
'.header-logos img { opacity:0.7; }\n' +
'.header-logos img.hdr-cnr { height:16px; }\n' +
'.header-logos img.hdr-pave { height:28px; }\n' +
'.header-logos .hdr-sep { width:1px; height:20px; background:rgba(255,255,255,0.15); }\n' +
".page-header .page-label { font-family:'JetBrains Mono',monospace; font-size:7pt; color:var(--text-muted); letter-spacing:0.1em; text-transform:uppercase; white-space:nowrap; }\n" +
'.page-footer { position:absolute; bottom:8mm; left:22mm; right:22mm; display:flex; justify-content:space-between; align-items:center; padding-top:6px; border-top:1px solid var(--border); }\n' +
".page-footer span { font-family:'JetBrains Mono',monospace; font-size:7pt; color:var(--text-muted); letter-spacing:0.05em; }\n" +
".section-num { font-family:'JetBrains Mono',monospace; font-size:8pt; color:var(--accent); letter-spacing:0.15em; text-transform:uppercase; display:flex; align-items:center; gap:8px; margin-bottom:4px; }\n" +
".section-num::before { content:''; width:20px; height:1px; background:var(--accent); }\n" +
'h1 { font-size:18pt; font-weight:700; letter-spacing:-0.5px; margin-bottom:10px; color:#fff; }\n' +
'h2 { font-size:12pt; font-weight:700; letter-spacing:-0.3px; margin-top:12px; margin-bottom:6px; color:#fff; }\n' +
'h3 { font-size:10pt; font-weight:600; margin-top:10px; margin-bottom:4px; color:var(--text); }\n' +
'p { margin-bottom:5px; color:var(--text-dim); }\n' +
'strong { color:var(--text); font-weight:600; }\n' +
'table { width:100%; max-width:100%; border-collapse:collapse; margin:6px 0 10px; font-size:8pt; table-layout:fixed; }\n' +
"th { background:var(--cobalt-mid); font-family:'JetBrains Mono',monospace; font-size:7pt; font-weight:500; text-transform:uppercase; letter-spacing:0.08em; color:var(--text-muted); text-align:left; padding:5px 6px; border-bottom:1px solid var(--border-accent); word-wrap:break-word; overflow:hidden; }\n" +
'td { padding:4px 6px; border-bottom:1px solid var(--border); color:var(--text-dim); vertical-align:top; word-wrap:break-word; overflow-wrap:break-word; overflow:hidden; }\n' +
'td strong { color:var(--text); }\n' +
'.highlight-row td { background:var(--accent-dim); color:var(--text); font-weight:600; }\n' +
'.highlight-row td strong { color:var(--accent); }\n' +
'ul, ol { margin:3px 0 6px 16px; color:var(--text-dim); }\n' +
'li { margin-bottom:2px; padding-left:3px; font-size:8.5pt; }\n' +
'li::marker { color:var(--accent); }\n' +
'blockquote { margin:6px 0; padding:6px 10px; background:var(--accent-dim); border-left:3px solid var(--accent); border-radius:0 6px 6px 0; font-size:8pt; color:var(--text-dim); }\n' +
'blockquote strong { color:var(--accent); }\n' +
'hr { border:none; border-top:1px solid var(--border); margin:10px 0; }\n' +
'.callout { background:var(--cobalt-light); border:1px solid var(--border); border-radius:8px; padding:10px 12px; margin:6px 0; }\n' +
'.callout-accent { border-color:var(--border-accent); background:var(--accent-dim); }\n' +
'.kv { display:flex; gap:8px; margin-bottom:2px; font-size:8.5pt; }\n' +
'.kv-key { font-weight:600; color:var(--text); min-width:100px; flex-shrink:0; }\n' +
'.kv-val { color:var(--text-dim); }\n' +
'.two-col { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin:6px 0; max-width:100%; }\n' +
'.col-box { background:var(--cobalt-light); border:1px solid var(--border); border-radius:8px; padding:8px 10px; overflow:hidden; min-width:0; }\n' +
'.col-box h4 { font-size:8.5pt; font-weight:600; margin-bottom:4px; color:var(--accent); }\n' +
'.col-box table { margin:3px 0 4px; }\n' +
'.col-box table th, .col-box table td { padding:3px 5px; font-size:7pt; }\n' +
'.col-box p { font-size:8pt; }\n' +
'.col-box li { font-size:7.5pt; }\n' +
'.accent { color:var(--accent); }\n' +
'.small { font-size:7.5pt; color:var(--text-muted); }\n' +
'.italic { font-style:italic; }\n' +
'</style>';

// ===================================================================
// CSS — Light Theme (C&R Professional)
// ===================================================================

function lightBuildCss(accent, accentDark, accentLight) {
  return '<style>\n' +
  "@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap');\n" +
  '@page { margin:130px 50px 80px 50px; }\n' +
  '* { margin:0; padding:0; box-sizing:border-box; }\n' +
  "body { font-family:'Inter','Segoe UI',Tahoma,Geneva,Verdana,sans-serif; font-size:11px; line-height:1.6; color:#333; max-width:100%; -webkit-print-color-adjust:exact; print-color-adjust:exact; }\n" +
  '.doc-title { font-size:28px; font-weight:800; color:#1a365d; border-bottom:none; margin-top:40px; margin-bottom:4px; padding-bottom:0; text-align:center; }\n' +
  '.doc-subtitle { font-size:18px; font-weight:400; color:#4a5568; border-bottom:none; margin-top:0; margin-bottom:8px; text-align:center; }\n' +
  'h1 { color:#1a365d; font-size:20px; font-weight:700; border-bottom:3px solid ' + accent + '; padding-bottom:8px; margin-top:28px; margin-bottom:12px; page-break-after:avoid; }\n' +
  'h2 { color:#2c5282; font-size:15px; font-weight:600; margin-top:22px; margin-bottom:8px; border-left:4px solid ' + accent + '; padding-left:10px; page-break-after:avoid; }\n' +
  'h3 { color:#2d3748; font-size:13px; font-weight:600; margin-top:18px; margin-bottom:6px; page-break-after:avoid; }\n' +
  'h4 { color:#4a5568; font-size:12px; font-weight:600; margin-top:14px; margin-bottom:4px; page-break-after:avoid; }\n' +
  'p { margin:8px 0; line-height:1.6; }\n' +
  'strong { color:#1a202c; font-weight:600; }\n' +
  'table { width:100%; border-collapse:collapse; margin:12px 0; font-size:10px; page-break-inside:avoid; }\n' +
  'th { background-color:' + accentDark + '; color:#ffffff !important; padding:8px 8px; text-align:left; font-weight:600; font-size:10px; }\n' +
  'th, th * { color:#ffffff !important; }\n' +
  'td { padding:7px 8px; border:1px solid #e2e8f0; vertical-align:top; line-height:1.5; }\n' +
  'tr:nth-child(even) { background-color:#f7fafc; }\n' +
  '.highlight-row td { background-color:' + accentLight + '; font-weight:600; }\n' +
  'ul, ol { margin:8px 0; padding-left:24px; }\n' +
  'li { margin:6px 0; line-height:1.6; }\n' +
  'li ul, li ol { margin:4px 0; }\n' +
  'blockquote { border-left:4px solid ' + accent + '; margin:14px 0; padding:10px 18px; background-color:' + accentLight + '; font-style:italic; color:#1a365d; }\n' +
  'blockquote strong { color:#1a365d; font-style:normal; }\n' +
  'code { background-color:#edf2f7; padding:2px 5px; border-radius:3px; font-family:"JetBrains Mono","Consolas",monospace; font-size:10px; }\n' +
  'pre { background-color:#1a202c; color:#e2e8f0; padding:14px; border-radius:5px; overflow-x:auto; font-size:10px; margin:12px 0; page-break-inside:avoid; }\n' +
  'pre.tree { background-color:#f7fafc; color:#2d3748; border:1px solid #e2e8f0; font-size:10px; line-height:1.5; }\n' +
  'pre code { background-color:transparent; color:inherit; padding:0; }\n' +
  'hr { border:none; border-top:2px solid #e2e8f0; margin:24px 0; }\n' +
  '.callout { margin:14px 0; padding:12px 16px; border-radius:6px; border:1px solid #e2e8f0; background-color:#f7fafc; page-break-inside:avoid; }\n' +
  '.callout p { margin:4px 0; }\n' +
  '.callout-info { border-left:4px solid ' + accent + '; background-color:' + accentLight + '; }\n' +
  '.callout-warning { border-left:4px solid #dd6b20; background-color:#fffaf0; }\n' +
  '.callout-success { border-left:4px solid #38a169; background-color:#f0fff4; }\n' +
  '.kv { margin:4px 0; font-size:11px; }\n' +
  '.kv-label { font-weight:600; color:#1a365d; display:inline-block; min-width:140px; }\n' +
  '.kv-value { color:#4a5568; }\n' +
  '.two-col { display:grid; grid-template-columns:1fr 1fr; gap:16px; margin:12px 0; page-break-inside:avoid; }\n' +
  '.col-box { border:1px solid #e2e8f0; border-radius:6px; padding:12px; background-color:#f7fafc; overflow:hidden; min-width:0; }\n' +
  '.col-box h4 { margin-top:0; color:' + accentDark + '; }\n' +
  '.page-break { page-break-after:always; height:0; margin:0; padding:0; }\n' +
  '</style>';
}

// ===================================================================
// HELP
// ===================================================================

function printHelp() {
  console.log('');
  console.log('PDF Skill - Generate branded PDF documents from JSON content');
  console.log('');
  console.log('USAGE:');
  console.log('  pdf <theme> <command> [options]');
  console.log('');
  console.log('THEMES:');
  console.log('  dark     PAVE Dark Theme (cobalt bg, lime-green accents)');
  console.log('           Best for: PAVE proposals, client-facing sales documents');
  console.log('');
  console.log('  light    C&R Light Theme (white bg, configurable accent color)');
  console.log('           Best for: Product vision docs, requirements, specifications');
  console.log('');
  console.log('COMMANDS:');
  console.log('  generate   Generate PDF from content JSON');
  console.log('  preview    Generate HTML preview');
  console.log('  sample     Output sample content JSON');
  console.log('');
  console.log('DARK THEME OPTIONS:');
  console.log('  -i, --input <file>       Content JSON file (required for generate/preview)');
  console.log('  -o, --output <file>      Output file path');
  console.log('  --cnr-logo <file>        C&R logo (white, for dark bg)');
  console.log('  --pave-logo <file>       PAVE logo (BLK variant, auto-inverted)');
  console.log('  --client-logo <file>     Client logo (shown on cover)');
  console.log('  --open                   Open PDF after generation');
  console.log('');
  console.log('LIGHT THEME OPTIONS:');
  console.log('  -i, --input <file>       Content JSON file (required for generate/preview)');
  console.log('  -o, --output <file>      Output file path');
  console.log('  --logo1 <file>           Left header logo (client)');
  console.log('  --logo2 <file>           Right header logo (C&R)');
  console.log('  --accent <color>         Accent color hex (default: #0066CC)');
  console.log('  --open                   Open PDF after generation');
  console.log('');
  console.log('EXAMPLES:');
  console.log('  pdf dark sample -o proposal.json');
  console.log('  pdf dark generate -i proposal.json -o proposal.pdf --client-logo logo.png --open');
  console.log('  pdf light sample -o vision.json');
  console.log('  pdf light generate -i vision.json -o vision.pdf --logo1 client.png --accent "#0066CC" --open');
  console.log('');
}

// ===================================================================
// MAIN
// ===================================================================

function main() {
  var parsed = parseArgs();

  if (!parsed.theme || parsed.options.help || parsed.options.h) {
    printHelp();
    return;
  }

  if (!parsed.command) {
    console.error('Error: command required (generate, preview, or sample)');
    console.error('Run "pdf --help" for usage.');
    process.exit(1);
  }

  if (parsed.theme === 'dark') {
    switch (parsed.command) {
      case 'generate': cmdDarkGenerate(parsed.options); break;
      case 'preview': cmdDarkPreview(parsed.options); break;
      case 'sample': cmdSample('dark', parsed.options); break;
      default:
        console.error('Unknown command: ' + parsed.command);
        process.exit(1);
    }
  } else if (parsed.theme === 'light') {
    switch (parsed.command) {
      case 'generate': cmdLightGenerate(parsed.options); break;
      case 'preview': cmdLightPreview(parsed.options); break;
      case 'sample': cmdSample('light', parsed.options); break;
      default:
        console.error('Unknown command: ' + parsed.command);
        process.exit(1);
    }
  }
}

try {
  main();
} catch (err) {
  console.error('Error: ' + err.message);
  if (process.env.DEBUG) console.error('Stack:', err.stack);
  process.exit(1);
}
