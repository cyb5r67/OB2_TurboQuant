// Classifier-based auto-routing.
//
// When OB2_AUTO_ROUTE=true, queries WITHOUT an explicit @domain prefix are
// classified by a small local LLM to determine if they need domain knowledge.
// If the classifier thinks a domain is relevant, retrieval fires automatically.
//
// Opt-in only. When disabled (default), queries without prefix pass through
// unchanged — preserving the explicit trigger-control behavior.
//
// The classifier uses the same Ollama instance but with a tiny model (configurable
// via OB2_CLASSIFIER_MODEL, default: same as OB2_OLLAMA_MODEL). The classification
// prompt asks the model to pick from a list of known domains or "none".

import type { Config } from "../config.ts";
import type { Sidecar } from "../sidecar.ts";
import { getRuntime } from "../runtime_config.ts";
import { getClassifierProvider } from "../llm/provider.ts";

interface SidecarDomainListResult {
  domains: string[];
}

interface SidecarKnowledgeStatsResult {
  domains?: Array<{ domain: string; doc_count: number; description?: string }>;
}

interface ClassifyResult {
  domain: string | null;
  confidence: string;  // "high" | "medium" | "low"
  reason: string;
}

/**
 * Classify whether a query needs domain knowledge and which domain.
 *
 * Returns null if auto-routing is disabled, no domains exist, or the
 * classifier decides no domain is relevant.
 *
 * `candidates`, when supplied, restricts the classifier's choice set to that
 * list. Use this to scope routing per-caller (a non-admin should never be
 * auto-routed to a domain they cannot read). When omitted, all domains
 * known to the sidecar are used.
 */
export async function classifyQuery(
  config: Config,
  sidecar: Sidecar,
  query: string,
  candidates?: string[],
): Promise<ClassifyResult | null> {
  const rt = getRuntime();
  if (!rt.ollama.auto_route) return null;

  // Fetch domains + descriptions so the classifier sees both the name and
  // a human hint of what each domain contains. Domain names alone are
  // useless for routing — "test" or "netsec" tells the LLM nothing about
  // whether the query matches. With a description like "Personal contacts
  // and relationships" the LLM can route correctly.
  let stats: SidecarKnowledgeStatsResult;
  try {
    stats = await sidecar.call<SidecarKnowledgeStatsResult>("knowledge_stats", {});
  } catch {
    return null;
  }
  const allEntries = stats.domains ?? [];
  const scopedEntries = candidates
    ? allEntries.filter((e) => candidates.includes(e.domain))
    : allEntries;
  if (scopedEntries.length === 0) return null;

  // Build an authoritative list of domains we'll accept from the classifier.
  const domains = scopedEntries.map((e) => e.domain);

  const domainList = scopedEntries.map((e) => {
    const desc = (e.description || "").trim();
    return desc ? `- @${e.domain} — ${desc}` : `- @${e.domain}`;
  }).join("\n");

  const classifierPrompt = `You are a query router. Given a user's question and a list of knowledge domains, decide if the question would benefit from domain-specific knowledge. The descriptions below tell you what each domain contains.

Available domains:
${domainList}

Respond with EXACTLY one line in this format:
DOMAIN: <domain_name> | CONFIDENCE: <high|medium|low> | REASON: <brief reason>

Or if no domain is relevant:
DOMAIN: none | CONFIDENCE: high | REASON: <brief reason>

User question: "${query}"`;

  try {
    let text: string;
    try {
      const r = await getClassifierProvider().chatNonStream(
        [{ role: "user", content: classifierPrompt }],
        { temperature: 0, max_tokens: 60 },
      );
      text = r.content.trim();
    } catch {
      return null;
    }

    // Parse: DOMAIN: xxx | CONFIDENCE: yyy | REASON: zzz
    const match = text.match(
      /DOMAIN:\s*(\S+)\s*\|\s*CONFIDENCE:\s*(high|medium|low)\s*\|\s*REASON:\s*(.+)/i,
    );
    if (!match) return null;

    const domain = match[1].replace(/^@/, "").toLowerCase();
    const confidence = match[2].toLowerCase() as "high" | "medium" | "low";
    const reason = match[3].trim();

    if (domain === "none") return { domain: null, confidence, reason };
    if (!domains.includes(domain)) return null; // hallucinated domain

    // Only auto-route on high/medium confidence
    if (confidence === "low") return { domain: null, confidence, reason };

    return { domain, confidence, reason };
  } catch {
    return null;
  }
}
