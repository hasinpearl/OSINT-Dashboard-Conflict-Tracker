import { pool } from "../db";
import { envKey } from "../env";
import { sourceStatusUpdate } from "./source-status";
import { Item, SourceStatus } from "../types";
import https from "https";
import http from "http";
import { JSDOM } from "jsdom";

//TUNE: Control the (telegram channels). TG_PREVIEW_CHANNELS=comma separated public channel usernames.
const TG_PREVIEW_CHANNELS = envKey("TG_PREVIEW_CHANNELS")?.split(",").map(c => c.trim()).filter(c => c) || 
  ["monitor_the_situation", "intelslava", "GeoPWatch", "rnintel", "CIG_telegram", "idkunim_il", "OSINTdefender", "BellumActaNews", "RocketAlert"];
//TUNE: Control the (preview poll rate). TG_PREVIEW_POLL_SECONDS=seconds between polling rounds.
const TG_PREVIEW_POLL_SECONDS = parseInt(envKey("TG_PREVIEW_POLL_SECONDS") || "120");
//TUNE: Control the (backfill depth). TG_PREVIEW_MAX_PAGES=history pages walked per channel per run, 20 posts each.
const TG_PREVIEW_MAX_PAGES = parseInt(envKey("TG_PREVIEW_MAX_PAGES") || "25");
//TUNE: Control the (request pacing). TG_PREVIEW_DELAY_SECONDS=seconds between channel requests.
const TG_PREVIEW_DELAY_SECONDS = parseInt(envKey("TG_PREVIEW_DELAY_SECONDS") || "2");

// Utility function to sleep
function sleep(seconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

// Utility function to clamp future timestamps
function clampFutureTimestamp(date: Date | null): Date | null {
  if (!date) return null;
  const now = new Date();
  return date > now ? now : date;
}

//TUNE: Control the (redirect depth). TG_PREVIEW_MAX_REDIRECTS=hops followed before a request is abandoned.
const TG_PREVIEW_MAX_REDIRECTS = parseInt(envKey("TG_PREVIEW_MAX_REDIRECTS") || "5");

// Function to make HTTP request, following redirects (t.me/s/ answers 301)
function httpRequest(
  options: any,
  postData?: string,
  redirectsLeft: number = TG_PREVIEW_MAX_REDIRECTS,
): Promise<{statusCode: number, headers: any, data: string}> {
  return new Promise((resolve, reject) => {
    const lib = options.protocol === 'https:' ? https : http;
    const req = lib.request(options, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        const next = new URL(
          res.headers.location,
          `${options.protocol || 'https:'}//${options.hostname || options.host}${options.path}`,
        );
        resolve(httpRequest({
          protocol: next.protocol,
          host: next.host,
          path: next.pathname + next.search,
          method: options.method || 'GET',
          headers: options.headers,
        }, postData, redirectsLeft - 1));
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({statusCode: status, headers: res.headers, data}));
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

// Function to insert item into database
async function insertItem(item: {
  source: string;
  externalId: string;
  url: string;
  content: string;
  eventTs: Date;
  hasMedia: boolean;
  channelId: string;
  raw: any;
}): Promise<boolean> {
  try {
    const result = await pool.query(
      `INSERT INTO items (
        source, 
        external_id, 
        url, 
        content, 
        published_at, 
        has_media,
        source_uid,
        raw
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (source, external_id) DO NOTHING
      RETURNING id`,
      [
        item.source,
        item.externalId,
        item.url,
        item.content,
        item.eventTs,
        item.hasMedia,
        item.channelId,
        item.raw
      ]
    );
    
    return result && result.rowCount !== null && result.rowCount > 0;
  } catch (e) {
    console.error("Error inserting item:", e);
    return false;
  }
}

// Function to extract message data from HTML
function extractMessagesFromHtml(html: string, channelId: string): Array<{
  messageId: number;
  eventTs: Date;
  url: string;
  content: string;
  hasMedia: boolean;
  raw: string;
}> {
  const dom = new JSDOM(html);
  const document = dom.window.document;
  const messages: Array<{
    messageId: number;
    eventTs: Date;
    url: string;
    content: string;
    hasMedia: boolean;
    raw: string;
  }> = [];
  
  const messageElements = document.querySelectorAll(".tgme_widget_message");
  
  messageElements.forEach((element: Element) => {
    const dataPost = element.getAttribute("data-post");
    const timeElement = element.querySelector("time.time");
    const datetime = timeElement ? timeElement.getAttribute("datetime") : null;
    
    // Skip if not a valid message element or missing timestamp
    if (!dataPost || !datetime) {
      return;
    }
    
    // Extract message ID from data-post attribute
    const postIdMatch = dataPost.match(new RegExp(`${channelId}/(\\d+)`));
    if (!postIdMatch) {
      return;
    }
    
    const messageId = parseInt(postIdMatch[1]);
    const eventTs = new Date(datetime);
    const url = `https://t.me/${dataPost}`;
    const contentElement = element.querySelector(".tgme_widget_message_text");
    const content = contentElement ? contentElement.textContent || "" : "";
    const hasMedia = element.querySelectorAll(".tgme_widget_message_photo, .tgme_widget_message_video, .tgme_widget_message_document").length > 0;
    
    messages.push({
      messageId,
      eventTs,
      url,
      content,
      hasMedia,
      raw: element.outerHTML || ""
    });
  });
  
  return messages;
}

// Function to fetch and process a single channel
async function processChannel(channelId: string): Promise<void> {
  let lowestMessageId = Infinity;
  let totalPages = 0;
  let totalInserted = 0;
  
  try {
    console.log(`Processing channel: ${channelId}`);
    
    while (totalPages < TG_PREVIEW_MAX_PAGES) {
      // Construct URL with pagination if needed
      let urlString = `https://t.me/s/${channelId}`;
      if (lowestMessageId !== Infinity) {
        urlString += `?before=${lowestMessageId}`;
      }
      
      // Parse URL
      const parsedUrl = new URL(urlString);
      
      // Fetch page with browser User-Agent
      const options = {
        protocol: parsedUrl.protocol,
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
        }
      };
      
      const response = await httpRequest(options);
      
      if (response.statusCode !== 200) {
        throw new Error(`HTTP ${response.statusCode}: ${response.data}`);
      }
      
      const html = response.data;
      const messages = extractMessagesFromHtml(html, channelId);
      
      // If no messages found, we've reached the end
      if (messages.length === 0) {
        console.log(`No more messages found for channel ${channelId}`);
        break;
      }
      
      // Check if we have new messages compared to previous page
      const newMessages = messages.filter(msg => msg.messageId < lowestMessageId);
      if (newMessages.length === 0) {
        console.log(`No new messages found for channel ${channelId}, stopping pagination`);
        break;
      }
      
      // Update lowest message ID for next pagination
      const currentLowest = Math.min(...messages.map(m => m.messageId));
      if (currentLowest < lowestMessageId) {
        lowestMessageId = currentLowest;
      }
      
      // Process each message
      let insertedCount = 0;
      for (const message of messages) {
        const eventTs = clampFutureTimestamp(message.eventTs);
        if (!eventTs) {
          console.warn(`Skipping message with invalid timestamp: ${message.messageId}`);
          continue;
        }
        
        const inserted = await insertItem({
          source: "telegram",
          externalId: `${channelId}:${message.messageId}`,
          url: message.url,
          content: message.content,
          eventTs,
          hasMedia: message.hasMedia,
          channelId,
          raw: {
            html: message.raw,
            source: "telegram_preview"
          }
        });
        
        if (inserted) {
          insertedCount++;
          totalInserted++;
        }
      }
      
      console.log(`Inserted ${insertedCount} messages from page ${totalPages + 1} of channel ${channelId}`);
      totalPages++;
      
      // If we're not at the last page, wait before next request
      if (totalPages < TG_PREVIEW_MAX_PAGES) {
        await sleep(TG_PREVIEW_DELAY_SECONDS);
      }
    }
    
    // Update source status
    await sourceStatusUpdate({
      id: channelId,
      source: "telegram",
      label: channelId,
      ok: true,
      detail: `Processed ${totalPages} pages, inserted ${totalInserted} items`,
      failures: 0,
      last_ok: undefined,
      updated_at: new Date()
    });
    
    console.log(`Successfully processed channel ${channelId}: ${totalInserted} items inserted`);
  } catch (e: any) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    console.error(`Error processing channel ${channelId}:`, errorMessage);
    
    // Update source status with failure
    await sourceStatusUpdate({
      id: channelId,
      source: "telegram",
      label: channelId,
      ok: false,
      detail: errorMessage,
      failures: 1,
      updated_at: new Date()
    });
  }
}

// Main worker function
export async function runTelegramPreviewWorker(): Promise<void> {
  if (TG_PREVIEW_CHANNELS.length === 0) {
    console.error("No Telegram channels configured");
    return;
  }
  
  console.log(`Starting Telegram Preview worker with ${TG_PREVIEW_CHANNELS.length} channels`);
  
  while (true) {
    try {
      console.log("Polling Telegram channels...");
      
      // Process all channels sequentially to respect rate limits
      for (const channel of TG_PREVIEW_CHANNELS) {
        await processChannel(channel);
        // Delay between channels
        await sleep(TG_PREVIEW_DELAY_SECONDS);
      }
      
      console.log(`Sleeping for ${TG_PREVIEW_POLL_SECONDS} seconds`);
      await new Promise(resolve => setTimeout(resolve, TG_PREVIEW_POLL_SECONDS * 1000));
    } catch (e: any) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      console.error("Unexpected error in Telegram Preview worker loop:", errorMessage);
      await new Promise(resolve => setTimeout(resolve, 60 * 1000)); // Wait 1 minute before retrying
    }
  }
}