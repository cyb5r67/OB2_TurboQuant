// One-shot test for sniffMagicBytes. Run with:
//   deno run server/import/sniffer_test.ts
import { sniffMagicBytes } from "./sniffer.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); failures++; }
  else { console.log("PASS:", msg); }
}

const enc = new TextEncoder();

// PDF
{
  const bytes = enc.encode("%PDF-1.7\n...");
  assert(sniffMagicBytes(bytes)?.format === "pdf", "PDF magic");
}
// PNG
{
  const bytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  assert(sniffMagicBytes(bytes)?.format === "png", "PNG magic");
}
// ZIP (also covers DOCX/PPTX/XLSX which are zip-wrapped — sniffer returns "zip"; the runner uses extension to disambiguate)
{
  const bytes = new Uint8Array([0x50, 0x4B, 0x03, 0x04]);
  assert(sniffMagicBytes(bytes)?.format === "zip", "ZIP magic");
}
// Plain text fallback
{
  const bytes = enc.encode("hello world");
  const r = sniffMagicBytes(bytes);
  assert(r?.format === "text", "ASCII → text");
}
// Empty / unknown returns null
{
  assert(sniffMagicBytes(new Uint8Array(0)) === null, "empty → null");
  assert(sniffMagicBytes(new Uint8Array([0xff, 0xfe, 0x00])) === null, "unknown → null");
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
Deno.exit(failures === 0 ? 0 : 1);
