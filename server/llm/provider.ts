// Provider abstraction in front of the LLM call sites.
//
// `ChatProvider` is non-negotiable — every provider implements it.
// `ManagementProvider` is partial — methods may throw `NotImplementedInPhase1`
// or `NotSupported`, gated by `capabilities()` so the dashboard can grey out
// unsupported actions instead of hitting an endpoint that 501s.
//
// Factory functions `getProvider()` and `getClassifierProvider()` read the
// active provider from runtime config (hot-reloaded). Adapter modules
// register themselves into module-scoped slots in this file.

import { getRuntime } from "../runtime_config.ts";
import { ollamaProvider } from "./ollama_provider.ts";
import { llamacppProvider } from "./llamacpp_provider.ts";

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
  readonly id: "ollama" | "llamacpp";
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

/** Thrown by Phase 1 stubs that depend on the Phase 2 manager service. */
export class NotImplementedInPhase1 extends Error {
  constructor(method: string) {
    super(`${method} requires the llamacpp manager service (Phase 2)`);
    this.name = "NotImplementedInPhase1";
  }
}

// ─────────────────────────────────────────────────────────────
// Factory (filled in by Task 6)
// ─────────────────────────────────────────────────────────────

export function getProvider(): Provider {
  return getRuntime().llm.provider === "llamacpp" ? llamacppProvider : ollamaProvider;
}

export function getClassifierProvider(): Provider {
  const cp = getRuntime().llm.classifier_provider;
  const id = cp === "" ? getRuntime().llm.provider : cp;
  return id === "llamacpp" ? llamacppProvider : ollamaProvider;
}
