// 1 MiB cap; legitimate hook payloads are tiny. Beyond this we bail rather
// than buffer unbounded input. Mirrors agent-memory/memory-router's helper.

const MAX_STDIN_BYTES = 1 << 20;

export function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    let data = "";
    let bytes = 0;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk, "utf8");
      if (bytes > MAX_STDIN_BYTES) {
        process.stdin.destroy();
        reject(new Error(`stdin payload exceeded ${MAX_STDIN_BYTES} bytes`));
        return;
      }
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}
