import "../env";
import { describeError } from "./describe-error";
import http from "http";

// Proves the log line the card called empty. Each case below is an error the
// old `e instanceof Error ? e.message : String(e)` printed as "".

function oldStyle(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function report(label: string, e: unknown): void {
  console.log(`\n${label}`);
  console.log(`  old: "${oldStyle(e)}"`);
  console.log(`  new: "${describeError(e)}"`);
}

async function connectFailure(): Promise<unknown> {
  // A dual-stack connect to a closed port rejects with an AggregateError whose
  // own message is empty. This is what the collector run hit.
  try {
    await fetch("http://localhost:1/", { signal: AbortSignal.timeout(5000) });
    return new Error("unexpectedly connected");
  } catch (e) {
    return e;
  }
}

async function socketFailure(): Promise<unknown> {
  return new Promise((resolve) => {
    const req = http.request({ hostname: "127.0.0.1", port: 1, path: "/" }, () =>
      resolve(new Error("unexpectedly connected")),
    );
    req.on("error", resolve);
    req.end();
  });
}

async function main() {
  report("AggregateError from a dual-stack connect failure", await connectFailure());
  report("raw socket error", await socketFailure());
  report("AbortError from a timeout", new DOMException("", "AbortError"));
  report("Error with a blank message", new Error(""));
  report("Error with only a cause", Object.assign(new Error(""), { cause: new Error("upstream reset") }));
  report("a thrown string", "something went wrong");
  report("a thrown object", { status: 429, retry_after: 30 });
  report("a thrown undefined", undefined);
}

main().catch((e) => {
  console.error(describeError(e));
  process.exit(1);
});
