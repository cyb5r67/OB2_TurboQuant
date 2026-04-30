// Tiny stand-in for llama-server's /v1/chat/completions used by tests/e2e.sh.
// Speaks just enough OpenAI to validate the chat path.
//
// Usage:
//   deno run --allow-net tests/fixtures/fake-llama-server.ts --port 18080

const port = (() => {
  const i = Deno.args.indexOf("--port");
  return i >= 0 ? Number(Deno.args[i + 1]) : 18080;
})();

const enc = new TextEncoder();

Deno.serve({ port }, (req) => {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/health") {
    return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
  }
  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    const stream = new ReadableStream({
      async start(controller) {
        const frames = [
          { choices: [{ delta: { role: "assistant" }, finish_reason: null }] },
          { choices: [{ delta: { content: "Hello" }, finish_reason: null }] },
          { choices: [{ delta: { content: " from fake llama" }, finish_reason: null }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ];
        for (const f of frames) {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
          await new Promise((r) => setTimeout(r, 5));
        }
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      },
    });
  }
  return new Response("not found", { status: 404 });
});
