// Provider abstraction in front of the LLM call sites.
//
// `ChatProvider` is non-negotiable — every provider implements it.
// `ManagementProvider` is partial — methods may throw `NotSupported` (e.g. an
// Ollama provider asked to load explicitly, or a llamacpp provider asked to
// warm), gated by `capabilities()` so the dashboard can grey out unsupported
// actions instead of hitting an endpoint that 501s.
//
// Factory functions `getProvider()` and `getClassifierProvider()` read the
// active provider from runtime config (hot-reloaded). Adapter modules
// register themselves into module-scoped slots in this file.

import { getRuntime, type ProviderId } from "../runtime_config.ts";
import { ollamaProvider } from "./ollama_provider.ts";
import { llamacppProvider } from "./llamacpp_provider.ts";
import { openaiProvider } from "./openai_provider.ts";
import { anthropicProvider } from "./anthropic_provider.ts";
import { geminiProvider } from "./gemini_provider.ts";

// ─────────────────────────────────────────────────────────────
// Shared types
// ─────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface ChatOpts {
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  /**
   * Ollama-only override: pick a different model than `runtime.ollama.model`
   * for this single call. Used by the classifier to honor the `classifier_model`
   * config knob. Llamacpp ignores it (llama-server has exactly one model loaded
   * at any time; switching is a manager operation, not a per-request option).
   */
  model?: string;
}

/** Normalized streaming chunk. Both providers parse their wire format into this. */
export interface ChatChunk {
  /** Incremental text. Empty string allowed (e.g. on the terminal frame). */
  content: string;
  done: boolean;
  finish_reason?: "stop" | "length";
}

export interface NonStreamResult {
  content: string;
  prompt_tokens: number;
  completion_tokens: number;
}

export interface ModelEntry {
  /** For Ollama: the model name (e.g. "gemma3:4b"). For llamacpp: the GGUF filename. */
  name: string;
  size_bytes: number;
  modified_at: string;
  /** Provider-specific extras the dashboard may surface. */
  details?: Record<string, unknown>;
}

export interface LoadedEntry {
  name: string;
  /** Provider-specific extras (Ollama: VRAM bytes; llamacpp: ctx_size, port). */
  details?: Record<string, unknown>;
}

export interface PullSpec {
  source: "url" | "hf" | "ollama";
  /** When source=url. */
  url?: string;
  /** When source=hf. */
  repo?: string;
  file?: string;
  /** When source=ollama. */
  name?: string;
}

export interface PullProgress {
  status: string;
  total?: number;
  completed?: number;
}

export interface LoadOpts {
  ctx_size?: number;
  gpu_layers?: number;
  parallel_slots?: number;
}

export interface Capabilities {
  canList: boolean;
  canPull: boolean;
  canDelete: boolean;
  canLoad: boolean;
  canUnload: boolean;
  canWarm: boolean;
}

// ─────────────────────────────────────────────────────────────
// Provider interface
// ─────────────────────────────────────────────────────────────

export interface ChatProvider {
  readonly id: ProviderId;
  /** Free-form label for telemetry / status header. */
  activeModelLabel(): Promise<string>;
  chatStream(messages: ChatMessage[], opts: ChatOpts): Promise<ReadableStream<ChatChunk>>;
  chatNonStream(messages: ChatMessage[], opts: ChatOpts): Promise<NonStreamResult>;
}

export interface ManagementProvider {
  capabilities(): Capabilities;
  listInstalled(): Promise<ModelEntry[]>;
  listLoaded(): Promise<LoadedEntry[]>;
  pullModel(
    spec: PullSpec,
    onProgress: (p: PullProgress) => void,
    signal?: AbortSignal,
  ): Promise<void>;
  /** llamacpp only — Ollama implementations should throw `NotSupported`. */
  loadModel(name: string, opts?: LoadOpts): Promise<void>;
  /** Ollama: by-name unload. llamacpp: ignores `name`, unloads the running model. */
  unloadModel(name?: string): Promise<void>;
  /** Ollama only — llamacpp throws `NotSupported`. */
  warmModel(name: string): Promise<void>;
  deleteModel(name: string): Promise<void>;
}

export type Provider = ChatProvider & Partial<ManagementProvider>;

// ─────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────

/** Thrown by providers for capability methods their backend doesn't support. */
export class NotSupported extends Error {
  constructor(method: string, providerId: string) {
    super(`${providerId} does not support ${method}`);
    this.name = "NotSupported";
  }
}

// ─────────────────────────────────────────────────────────────
// Factory (filled in by Task 6)
// ─────────────────────────────────────────────────────────────

function providerById(id: ProviderId): Provider {
  switch (id) {
    case "llamacpp":  return llamacppProvider;
    case "openai":    return openaiProvider;
    case "anthropic": return anthropicProvider;
    case "gemini":    return geminiProvider;
    case "ollama":    return ollamaProvider;
  }
}

export function getProvider(): Provider {
  return providerById(getRuntime().llm.provider);
}

export function getClassifierProvider(): Provider {
  const cp = getRuntime().llm.classifier_provider;
  const id: ProviderId = cp === "" ? getRuntime().llm.provider : cp;
  return providerById(id);
}
