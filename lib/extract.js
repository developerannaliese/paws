'use strict';

// Pull plain text out of documents so they can be redacted before an AI sees them.
// PDF uses pdftotext (poppler) and Word uses unzip, if they're installed.
// Returns null when the file type isn't supported or the tool is missing.

const { execFileSync } = require('child_process');

const DOC_TYPES = ['.pdf', '.docx'];

function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

function extractText(absPath) {
  const lower = absPath.toLowerCase();
  try {
    if (lower.endsWith('.pdf')) {
      return execFileSync('pdftotext', ['-layout', absPath, '-'], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 });
    }
    if (lower.endsWith('.docx')) {
      const xml = execFileSync('unzip', ['-p', absPath, 'word/document.xml'], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 });
      return decodeXml(
        xml
          .replace(/<w:tab\/>/g, '\t')
          .replace(/<w:br[^>]*\/>/g, '\n')
          .replace(/<\/w:p>/g, '\n')
          .replace(/<[^>]+>/g, '')
      );
    }
  } catch (e) {
    return null;
  }
  return null;
}

function isDocument(p) {
  const lower = String(p).toLowerCase();
  return DOC_TYPES.some((ext) => lower.endsWith(ext));
}

module.exports = { extractText, isDocument, DOC_TYPES };
