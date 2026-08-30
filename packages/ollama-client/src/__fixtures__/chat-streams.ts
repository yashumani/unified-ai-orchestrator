export const STREAM_WITHOUT_TRAILING_NEWLINE = [
  JSON.stringify({
    model: "qwen3:4b",
    created_at: "2026-08-28T10:00:00.000Z",
    message: {
      role: "assistant",
      content: "Hello ",
      thinking: "checking"
    },
    done: false
  }),
  JSON.stringify({
    model: "qwen3:4b",
    created_at: "2026-08-28T10:00:00.100Z",
    message: {
      role: "assistant",
      content: "world 🌍",
      tool_calls: [
        {
          function: {
            name: "repository.read_file",
            arguments: { path: "README.md" }
          }
        },
        {
          function: {
            name: "repository.search",
            arguments: { query: "orchestrator" }
          }
        }
      ]
    },
    done: false
  }),
  JSON.stringify({
    model: "qwen3:4b",
    created_at: "2026-08-28T10:00:00.200Z",
    message: { role: "assistant", content: "" },
    done: true,
    done_reason: "stop",
    total_duration: 1200,
    load_duration: 100,
    prompt_eval_count: 11,
    prompt_eval_duration: 200,
    eval_count: 7,
    eval_duration: 900
  })
].join("\n");

export function byteChunks(
  value: string,
  boundaries: readonly number[]
): Uint8Array[] {
  const bytes = new TextEncoder().encode(value);
  const chunks: Uint8Array[] = [];
  let previous = 0;

  for (const boundary of boundaries) {
    chunks.push(bytes.slice(previous, boundary));
    previous = boundary;
  }

  chunks.push(bytes.slice(previous));
  return chunks.filter((chunk) => chunk.byteLength > 0);
}

export function streamFromChunks(
  chunks: readonly Uint8Array[]
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    }
  });
}
