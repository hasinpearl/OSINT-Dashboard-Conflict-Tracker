import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition, openBrowser } from "@remotion/renderer";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bundled = await bundle({ entryPoint: path.resolve(__dirname, "../src/index.ts"), webpackOverride: c => c });
const browser = await openBrowser("chrome", { browserExecutable: "/bin/chromium", chromiumOptions: { args: ["--no-sandbox","--disable-gpu","--disable-dev-shm-usage"] }, chromeMode: "chrome-for-testing" });
const comp = await selectComposition({ serveUrl: bundled, id: "main", puppeteerInstance: browser });
for (const f of [0, 50, 120, 250]) {
  await renderStill({ composition: comp, serveUrl: bundled, output: `/tmp/frame-${f}.png`, frame: f, puppeteerInstance: browser });
  console.log("Rendered frame", f);
}
await browser.close({ silent: false });
