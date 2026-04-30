// Stub llama-server for manager tests. Mimics --port, /health, /v1/chat/completions.
//
// CLI: --port <n>  -m <path>  --ctx-size <n>  --n-gpu-layers <n>  --parallel <n>
// Other unknown flags are ignored.

const args = Deno.args;
function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const port = Number(flag("--port") || "8080");
const modelPath = flag("-m") || "(unset)";

console.error(`stub-llama-server: model=${modelPath} port=${port}`);

Deno.serve({ port }, (req) => {
  const u = new URL(req.url);
  if (req.method === "GET" && u.pathname === "/health") {
    return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
  }
  if (req.method === "POST" && u.pathname === "/v1/chat/completions") {
    return new Response(JSON.stringify({
      choices: [{ message: { content: "stub" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return new Response("not found", { status: 404 });
});
