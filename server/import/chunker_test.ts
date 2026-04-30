// One-shot test for chunkMarkdown. Run with:
//   deno run server/import/chunker_test.ts
// Exits 0 on pass, 1 on fail.
import { chunkMarkdown } from "./chunker.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); failures++; }
  else { console.log("PASS:", msg); }
}

// 1. empty input returns no chunks
assert(chunkMarkdown("").length === 0, "empty markdown → []");

// 2. single short paragraph → one chunk
{
  const out = chunkMarkdown("Just one paragraph.");
  assert(out.length === 1, "single paragraph → 1 chunk");
  assert(out[0].text === "Just one paragraph.", "chunk text matches");
  assert(out[0].breadcrumb === "", "no headers → empty breadcrumb");
}

// 3. H1/H2 boundaries split into separate chunks with breadcrumbs
{
  const md = "# Top\nIntro text.\n\n## Section A\nA body.\n\n## Section B\nB body.";
  const out = chunkMarkdown(md);
  assert(out.length === 3, "three sections → three chunks");
  assert(out[0].breadcrumb === "Top", "intro under H1");
  assert(out[1].breadcrumb === "Top > Section A", "section A breadcrumb");
  assert(out[2].breadcrumb === "Top > Section B", "section B breadcrumb");
}

// 4. section longer than maxChars → hard-cut with overlap carryover
{
  const long = "x".repeat(4000);
  const md = "## Long\n" + long;
  const out = chunkMarkdown(md, { maxChars: 1500, overlap: 200 });
  assert(out.length >= 2, "long section split into multiple chunks");
  // overlap: chunk N+1 starts with the last 200 chars of chunk N's body
  const lastOfFirst = out[0].text.slice(-200);
  assert(out[1].text.startsWith(lastOfFirst), "overlap preserved between chunks");
}

// 5. all chunks carry monotonic chunk_index and same chunk_total
{
  const md = "## A\n" + "x".repeat(2000) + "\n\n## B\n" + "y".repeat(2000);
  const out = chunkMarkdown(md, { maxChars: 800, overlap: 0 });
  for (let i = 0; i < out.length; i++) {
    assert(out[i].chunk_index === i, `chunk_index[${i}] === ${i}`);
    assert(out[i].chunk_total === out.length, `chunk_total === ${out.length}`);
  }
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
Deno.exit(failures === 0 ? 0 : 1);
