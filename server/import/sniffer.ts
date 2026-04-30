// Magic-byte sniffer. We only inspect the first 16 bytes — enough for every
// format we accept. Returns null for empty / unrecognised inputs; the caller
// then decides whether to refuse the upload outright.

export interface SniffResult {
  format: "pdf" | "png" | "jpeg" | "gif" | "tiff" | "zip" | "ogg" | "wav"
        | "mp3" | "flac" | "m4a" | "html" | "xml" | "text";
  contentType: string;
}

const enc = new TextDecoder();

export function sniffMagicBytes(bytes: Uint8Array): SniffResult | null {
  if (bytes.length === 0) return null;
  const head = bytes.subarray(0, Math.min(16, bytes.length));
  const h = (n: number) => head[n] ?? 0;

  // PDF: "%PDF-"
  if (h(0) === 0x25 && h(1) === 0x50 && h(2) === 0x44 && h(3) === 0x46) {
    return { format: "pdf", contentType: "application/pdf" };
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (h(0) === 0x89 && h(1) === 0x50 && h(2) === 0x4E && h(3) === 0x47) {
    return { format: "png", contentType: "image/png" };
  }
  // JPEG: FF D8 FF
  if (h(0) === 0xFF && h(1) === 0xD8 && h(2) === 0xFF) {
    return { format: "jpeg", contentType: "image/jpeg" };
  }
  // GIF: "GIF87a" or "GIF89a"
  if (h(0) === 0x47 && h(1) === 0x49 && h(2) === 0x46) {
    return { format: "gif", contentType: "image/gif" };
  }
  // TIFF: "II*\0" or "MM\0*"
  if ((h(0) === 0x49 && h(1) === 0x49 && h(2) === 0x2A) || (h(0) === 0x4D && h(1) === 0x4D && h(3) === 0x2A)) {
    return { format: "tiff", contentType: "image/tiff" };
  }
  // ZIP / DOCX / PPTX / XLSX: "PK\x03\x04"
  if (h(0) === 0x50 && h(1) === 0x4B && h(2) === 0x03 && h(3) === 0x04) {
    return { format: "zip", contentType: "application/zip" };
  }
  // OGG: "OggS"
  if (h(0) === 0x4F && h(1) === 0x67 && h(2) === 0x67 && h(3) === 0x53) {
    return { format: "ogg", contentType: "audio/ogg" };
  }
  // WAV: "RIFF....WAVE"
  if (h(0) === 0x52 && h(1) === 0x49 && h(2) === 0x46 && h(3) === 0x46
      && h(8) === 0x57 && h(9) === 0x41 && h(10) === 0x56 && h(11) === 0x45) {
    return { format: "wav", contentType: "audio/wav" };
  }
  // FLAC: "fLaC"
  if (h(0) === 0x66 && h(1) === 0x4C && h(2) === 0x61 && h(3) === 0x43) {
    return { format: "flac", contentType: "audio/flac" };
  }
  // MP3: "ID3" or 0xFF 0xFB / 0xFF 0xF3 / 0xFF 0xF2 (sync word)
  if ((h(0) === 0x49 && h(1) === 0x44 && h(2) === 0x33)
      || (h(0) === 0xFF && (h(1) === 0xFB || h(1) === 0xF3 || h(1) === 0xF2))) {
    return { format: "mp3", contentType: "audio/mpeg" };
  }
  // M4A: "....ftypM4A " — bytes 4..7 = "ftyp", 8..11 = "M4A "
  if (h(4) === 0x66 && h(5) === 0x74 && h(6) === 0x79 && h(7) === 0x70
      && h(8) === 0x4D && h(9) === 0x34 && h(10) === 0x41) {
    return { format: "m4a", contentType: "audio/mp4" };
  }

  // Text fallback: if every byte in the first 256 is printable ASCII or common whitespace, treat as text.
  const probeLen = Math.min(256, bytes.length);
  let printable = 0;
  for (let i = 0; i < probeLen; i++) {
    const b = bytes[i];
    if (b === 0x09 || b === 0x0A || b === 0x0D || (b >= 0x20 && b <= 0x7E)) printable++;
  }
  if (printable === probeLen) {
    const sample = enc.decode(bytes.subarray(0, Math.min(64, bytes.length))).trimStart().toLowerCase();
    if (sample.startsWith("<!doctype html") || sample.startsWith("<html")) {
      return { format: "html", contentType: "text/html" };
    }
    if (sample.startsWith("<?xml")) {
      return { format: "xml", contentType: "application/xml" };
    }
    return { format: "text", contentType: "text/plain" };
  }

  return null;
}
