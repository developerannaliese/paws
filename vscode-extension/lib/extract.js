'use strict';

// Pull plain text out of documents so they can be redacted before an AI sees them.
// PDF uses pdftotext (poppler) and Word uses unzip, if they're installed.
// Returns null when the file type isn't supported or the tool is missing.

const { execFileSync } = require('child_process');

const DOC_TYPES = ['.pdf', '.docx'];
const IMAGE_TYPES = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tiff', '.tif', '.webp', '.heic', '.heif'];

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

function isImage(p) {
  const lower = String(p).toLowerCase();
  return IMAGE_TYPES.some((ext) => lower.endsWith(ext));
}

// macOS Vision OCR: extract text from an image using the system's built-in OCR.
// Returns null if not on macOS or if recognition fails.
function ocrImage(absPath) {
  if (process.platform !== 'darwin') return null;
  try {
    // Use macOS Vision framework via a Swift one-liner through osascript
    const script = `
      import Vision
      import Foundation
      let url = URL(fileURLWithPath: ${JSON.stringify(absPath)})
      guard let img = CGImageSourceCreateWithURL(url as CFURL, nil),
            let cgImg = CGImageSourceCreateImageAtIndex(img, 0, nil) else { exit(1) }
      let req = VNRecognizeTextRequest()
      req.recognitionLevel = .accurate
      try VNImageRequestHandler(cgImage: cgImg).perform([req])
      let text = (req.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\\n")
      print(text)
    `;
    return execFileSync('swift', ['-e', script], {
      encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 * 1024 * 1024,
    }).trim() || null;
  } catch (e) {
    return null;
  }
}

module.exports = { extractText, isDocument, isImage, ocrImage, DOC_TYPES, IMAGE_TYPES };
