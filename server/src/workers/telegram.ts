import { envKey } from '../env';
import { pool } from '../db';
import { sourceStatusUpdate } from './source-status';
import { classify } from '../enrich';
import https from 'https';
import { JSDOM } from 'jsdom';

//TUNE: Control the (telegram channels). TG_CHANNELS=comma separated public channel usernames.
const TG_CHANNELS = envKey('TG_CHANNELS')?.split(',').map(c => c.trim()).filter(c => c) || [];
//TUNE: Control the (channel cap). TG_MAX_CHANNELS=hard limit on watched channels.
const TG_MAX_CHANNELS = parseInt(envKey('TG_MAX_CHANNELS') || '40');
//TUNE: Control the (resolve pacing). TG_RESOLVE_DELAY_SECONDS=pause between channel lookups at startup.
const TG_RESOLVE_DELAY_SECONDS = parseInt(envKey('TG_RESOLVE_DELAY_SECONDS') || '5');
//TUNE: Control the (heartbeat). TG_HEARTBEAT_SECONDS=how often the worker reports it is alive.
const TG_HEARTBEAT_SECONDS = parseInt(envKey('TG_HEARTBEAT_SECONDS') || '120');

// Circuit breaker settings
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_MULTIPLIER = 2;
const INITIAL_BACKOFF = 60; // seconds

// Channel health tracking
const channelFailures: Record<string, number> = {};
const channelBackoffs: Record<string, number> = {};
const channelLastOk: Record<string, number> = {};

// Function to generate external ID for Telegram messages
function generateExternalId(channel: string, messageId: string): string {
  return `${channel}:${messageId}`;
}

// Function to insert Telegram message into database
async function insertTelegramMessage(message: {
  channel: string;
  messageId: string;
  url: string;
  content: string;
  author: string | null;
  eventTs: Date;
  hasMedia: boolean;
  raw: any;
}): Promise<boolean> {
  try {
    // Generate external ID
    const externalId = generateExternalId(message.channel, message.messageId);
    
    const enriched = classify({
      content: message.content,
      publishedAt: message.eventTs,
    });

    // Insert into database
    const result = await pool.query(
      `INSERT INTO items (
        source, 
        external_id, 
        url, 
        content, 
        author, 
        published_at, 
        source_uid, 
        has_media, 
        raw,
        event_type,
        severity,
        is_breaking,
        lang,
        enrichment
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (source, external_id) DO NOTHING
      RETURNING id`,
      [
        'telegram',
        externalId,
        message.url,
        message.content,
        message.author,
        message.eventTs,
        message.channel,
        message.hasMedia,
        message.raw,
        enriched.event_type,
        enriched.severity,
        enriched.is_breaking,
        enriched.lang,
        JSON.stringify(enriched.enrichment)
      ]
    );
    
    return result?.rowCount !== null && result?.rowCount > 0;
  } catch (e) {
    console.error("Error inserting Telegram message:", e);
    return false;
  }
}

// Function to parse Telegram message from HTML
function parseTelegramMessage(element: Element, channel: string): {
  messageId: string;
  url: string;
  content: string;
  author: string | null;
  eventTs: Date;
  hasMedia: boolean;
} | null {
  try {
    // Get message ID
    const messageIdAttr = element.getAttribute('data-post');
    if (!messageIdAttr) return null;
    
    const messageId = messageIdAttr.split('/').pop() || '';
    if (!messageId) return null;
    
    // Get URL
    const url = `https://t.me/${channel}/${messageId}`;
    
    // Get timestamp
    const timeElement = element.querySelector('time.time');
    const timestamp = timeElement?.getAttribute('datetime');
    if (!timestamp) return null;
    
    const eventTs = new Date(timestamp);
    
    // Get author
    const authorElement = element.querySelector('.tgme_widget_message_from_name');
    const author = authorElement?.textContent?.trim() || null;
    
    // Get content
    const contentElement = element.querySelector('.tgme_widget_message_text');
    const content = contentElement?.textContent?.trim() || '';
    
    // Check for media
    const hasMedia = !!element.querySelector('.tgme_widget_message_photo_wrap, .tgme_widget_message_video_thumb');
    
    return {
      messageId,
      url,
      content,
      author,
      eventTs,
      hasMedia
    };
  } catch (e) {
    console.error("Error parsing Telegram message:", e);
    return null;
  }
}

// Function to fetch and parse Telegram channel preview
async function fetchChannelPreview(channel: string, beforeMsgId?: string): Promise<{
  messages: Array<{
    messageId: string;
    url: string;
    content: string;
    author: string | null;
    eventTs: Date;
    hasMedia: boolean;
  }>;
  hasMore: boolean;
}> {
  const url = beforeMsgId 
    ? `https://t.me/s/${channel}?before=${beforeMsgId}`
    : `https://t.me/s/${channel}`;
  
  // Custom https agent to handle self-signed certificates
  const agent = new https.Agent({  
    rejectUnauthorized: false
  });
  
  // Fetch HTML content
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    }
  });
  
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  
  const html = await response.text();
  
  // Parse HTML
  const dom = new JSDOM(html);
  const document = dom.window.document;
  
  // Extract messages
  const messageElements = document.querySelectorAll('.tgme_widget_message');
  const messages = [];
  
  for (const element of Array.from(messageElements)) {
    const message = parseTelegramMessage(element, channel);
    if (message) {
      messages.push(message);
    }
  }
  
  // Check if there are more messages
  const hasMore = messages.length > 0 && messages.length === 20; // 20 is the page size
  
  return { messages, hasMore };
}

// Function to process a single channel
async function processChannel(channel: string): Promise<void> {
  // Check if channel is under backoff
  if (channelBackoffs[channel]) {
    const backoffUntil = channelBackoffs[channel];
    if (Date.now() < backoffUntil) {
      console.log(`Skipping ${channel} due to backoff until ${new Date(backoffUntil).toISOString()}`);
      return;
    }
  }
  
  try {
    console.log(`Processing channel: ${channel}`);
    
    // Fetch initial page
    let result = await fetchChannelPreview(channel);
    let messages = result.messages;
    let hasMore = result.hasMore;
    let processedCount = 0;
    let lastMsgId: string | undefined;
    
    // Process messages
    for (const message of messages) {
      const inserted = await insertTelegramMessage({
        channel,
        messageId: message.messageId,
        url: message.url,
        content: message.content,
        author: message.author,
        eventTs: message.eventTs,
        hasMedia: message.hasMedia,
        raw: message
      });
      
      if (inserted) {
        console.log(`Inserted Telegram message from ${channel}: ${message.content.substring(0, 50)}...`);
      }
      
      processedCount++;
      lastMsgId = message.messageId;
    }
    
    // If we have more messages and haven't reached the limit, fetch more
    const maxEntries = 50; // Limit per channel cycle
    while (hasMore && processedCount < maxEntries) {
      if (!lastMsgId) break;
      
      result = await fetchChannelPreview(channel, lastMsgId);
      messages = result.messages;
      hasMore = result.hasMore;
      
      // Process messages
      for (const message of messages) {
        const inserted = await insertTelegramMessage({
          channel,
          messageId: message.messageId,
          url: message.url,
          content: message.content,
          author: message.author,
          eventTs: message.eventTs,
          hasMedia: message.hasMedia,
          raw: message
        });
        
        if (inserted) {
          console.log(`Inserted Telegram message from ${channel}: ${message.content.substring(0, 50)}...`);
        }
        
        processedCount++;
        lastMsgId = message.messageId;
      }
    }
    
    // Reset failure tracking
    channelFailures[channel] = 0;
    channelLastOk[channel] = Date.now();
    if (channelBackoffs[channel]) {
      delete channelBackoffs[channel];
    }
    
    console.log(`Channel ${channel} processed successfully with ${processedCount} messages`);
    
    // Update source status
    await sourceStatusUpdate({
      id: channel,
      source: 'telegram',
      label: channel,
      ok: true,
      detail: `Processed ${processedCount} messages`,
      failures: 0,
      last_ok: new Date(),
      updated_at: new Date()
    });
    
  } catch (e) {
    // Handle failure
    channelFailures[channel] = (channelFailures[channel] || 0) + 1;
    const errorMessage = e instanceof Error ? e.message : String(e);
    console.error(`Error processing channel ${channel}:`, errorMessage);
    
    // Update source status with failure
    await sourceStatusUpdate({
      id: channel,
      source: 'telegram',
      label: channel,
      ok: false,
      detail: errorMessage,
      failures: channelFailures[channel],
      last_ok: channelLastOk[channel] ? new Date(channelLastOk[channel]) : undefined,
      updated_at: new Date()
    });
    
    if (channelFailures[channel] >= MAX_CONSECUTIVE_FAILURES) {
      // Apply backoff
      const backoffRounds = Math.min(channelFailures[channel] - MAX_CONSECUTIVE_FAILURES, 10); // Cap at 10
      const backoffTime = INITIAL_BACKOFF * Math.pow(BACKOFF_MULTIPLIER, backoffRounds) * 1000;
      channelBackoffs[channel] = Date.now() + backoffTime;
      console.warn(`Backing off channel ${channel} for ${backoffTime/1000} seconds`);
    }
  }
}

// Function to send heartbeat
async function sendHeartbeat(): Promise<void> {
  console.log("Sending Telegram worker heartbeat...");
  
  for (const channel of TG_CHANNELS) {
    try {
      await sourceStatusUpdate({
        id: channel,
        source: 'telegram',
        label: channel,
        ok: true,
        detail: 'Heartbeat',
        failures: 0,
        last_ok: channelLastOk[channel] ? new Date(channelLastOk[channel]) : undefined,
        updated_at: new Date()
      });
    } catch (e) {
      console.error(`Error sending heartbeat for channel ${channel}:`, e);
    }
  }
}

// Start the Telegram worker
export async function startTelegramWorker(): Promise<void> {
  if (TG_CHANNELS.length === 0) {
    console.error("No Telegram channels configured");
    return;
  }
  
  if (TG_CHANNELS.length > TG_MAX_CHANNELS) {
    throw new Error(`Too many channels configured (${TG_CHANNELS.length} > ${TG_MAX_CHANNELS})`);
  }
  
  console.log(`Starting Telegram worker with ${TG_CHANNELS.length} channels`);
  
  // Send initial heartbeat
  await sendHeartbeat();
  
  // Start heartbeat interval
  const heartbeatInterval = setInterval(sendHeartbeat, TG_HEARTBEAT_SECONDS * 1000);
  
  while (true) {
    try {
      console.log("Polling Telegram channels...");
      
      // Process all channels
      for (const channel of TG_CHANNELS) {
        await processChannel(channel);
        
        // Add delay between channels
        await new Promise(resolve => setTimeout(resolve, TG_RESOLVE_DELAY_SECONDS * 1000));
      }
      
      console.log("Finished polling all Telegram channels");
      
      // Wait before next poll
      await new Promise(resolve => setTimeout(resolve, 60 * 1000)); // 1 minute
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      console.error("Unexpected error in Telegram worker loop:", errorMessage);
      await new Promise(resolve => setTimeout(resolve, 60 * 1000)); // Wait 1 minute before retrying
    }
  }
}