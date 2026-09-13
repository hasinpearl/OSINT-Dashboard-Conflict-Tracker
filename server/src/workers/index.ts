import { runRssWorker } from "./rss";
import { startTelegramWorker } from "./telegram";
import { runTelegramPreviewWorker } from "./telegramPreview";
import { envKey } from "../env";
import { initDb } from "../db";

async function main() {
  await initDb();
  const tgApiId = envKey('TG_API_ID');
  
  // Start workers
  const workers = [runRssWorker()];
  
  if (tgApiId) {
    // Run MTProto worker if API credentials are available
    workers.push(startTelegramWorker());
  } else {
    // Run preview worker if no API credentials
    workers.push(runTelegramPreviewWorker());
  }
  
  await Promise.all(workers);
}

main().catch(console.error);