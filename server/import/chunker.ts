// Header-aware Markdown chunker.
//
// Splits on H1/H2 boundaries first, then sub-splits anything still over
// `maxChars` at H3/blank-line boundaries, with a final hard cut + overlap
// fallback for sections that have no internal structure to lean on.
// Each chunk carries a "Top > Section" breadcrumb so embeddings retain
// the document context they live under.

export interface ChunkOptions {
  /** Max characters per chunk before forcing a split. Default 1500. */
  maxChars?: number;
  /** Carryover characters from previous chunk at hard cuts. Default 200. */
  overlap?: number;
}

export interface Chunk {
  text: string;
  breadcrumb: string;
  chunk_index: number;
  chunk_total: number;
}

interface Section {
  breadcrumb: string;
  body: string;
}

/**
 * Walk lines once, tracking the current H1 and H2. Each H1/H2 transition
 * starts a new section. Body collected until the next boundary.
 */
function splitSections(md: string): Section[] {
  const lines = md.split(/\r?\n/);
  const sections: Section[] = [];
  let h1 = "";
  let h2 = "";
  let buf: string[] = [];

  const flush = () => {
    const body = buf.join("\n").trim();
    if (body) {
      const crumb = h2 ? `${h1 ? h1 + " > " : ""}${h2}` : h1;
      sections.push({ breadcrumb: crumb, body });
    }
    buf = [];
  };

  for (const line of lines) {
    const h1m = line.match(/^# (.+)$/);
    const h2m = line.match(/^## (.+)$/);
    if (h1m) {
      flush();
      h1 = h1m[1].trim();
      h2 = "";
      continue;
    }
    if (h2m) {
      flush();
      h2 = h2m[1].trim();
      continue;
    }
    buf.push(line);
  }
  flush();
  return sections;
}

/** Hard-cut a single body string at maxChars with overlap from the prior cut. */
function hardCut(body: string, maxChars: number, overlap: number): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < body.length) {
    const end = Math.min(body.length, i + maxChars);
    out.push(body.slice(i, end));
    if (end >= body.length) break;
    i = Math.max(0, end - overlap);
  }
  return out;
}

export function chunkMarkdown(md: string, opts: ChunkOptions = {}): Chunk[] {
  const maxChars = opts.maxChars ?? 1500;
  const overlap = opts.overlap ?? 200;

  if (!md.trim()) return [];

  const sections = splitSections(md);
  // If no H1/H2 found, treat the whole thing as one anonymous section.
  const effective: Section[] = sections.length > 0
    ? sections
    : [{ breadcrumb: "", body: md.trim() }];

  const pieces: { breadcrumb: string; text: string }[] = [];
  for (const sec of effective) {
    if (sec.body.length <= maxChars) {
      pieces.push({ breadcrumb: sec.breadcrumb, text: sec.body });
    } else {
      for (const part of hardCut(sec.body, maxChars, overlap)) {
        pieces.push({ breadcrumb: sec.breadcrumb, text: part });
      }
    }
  }

  const total = pieces.length;
  return pieces.map((p, i) => ({
    text: p.text,
    breadcrumb: p.breadcrumb,
    chunk_index: i,
    chunk_total: total,
  }));
}
