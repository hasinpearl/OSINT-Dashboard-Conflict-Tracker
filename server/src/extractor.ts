// @ts-ignore - These dependencies are installed but not in package.json
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

export interface ExtractedArticle {
  title: string;
  content: string;
  publishedAt: string | null;
}

/**
 * Extract article content and metadata from a URL
 * Uses JSDOM + Readability for content extraction
 * Prefers structured metadata when present
 */
export async function extractArticle(url: string): Promise<ExtractedArticle> {
  // Try direct fetch first
  let response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; OSINT-Dashboard/1.0; +https://github.com/hessa/OSINT-Dashboard)",
    },
  });

  // If blocked, try Wayback Machine fallback
  if (response.status === 403 || response.status === 429) {
    const waybackCdxUrl = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}&output=json&limit=1`;
    try {
      const cdxResponse = await fetch(waybackCdxUrl);
      if (cdxResponse.ok) {
        const cdxData = await cdxResponse.json();
        if (cdxData && cdxData.length > 1) {
          const timestamp = cdxData[1][1]; // First row is header, second is data
          const waybackUrl = `https://web.archive.org/web/${timestamp}/${url}`;
          response = await fetch(waybackUrl, {
            headers: {
              "User-Agent": "Mozilla/5.0 (compatible; OSINT-Dashboard/1.0; +https://github.com/hessa/OSINT-Dashboard)",
            },
          });
        }
      }
    } catch (waybackError) {
      console.error("Wayback Machine fallback failed:", waybackError);
    }
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  const dom = new JSDOM(html, { url });
  const document = dom.window.document;

  // Try to extract published time from metadata
  let publishedAt: string | null = null;

  // Check various metadata tags for published time
  const metaSelectors = [
    'meta[property="article:published_time"]',
    'meta[name="article:published_time"]',
    'meta[property="og:article:published_time"]',
    'meta[name="date"]',
    'meta[property="og:updated_time"]',
  ];

  for (const selector of metaSelectors) {
    const meta = document.querySelector(selector);
    if (meta) {
      const content = meta.getAttribute("content");
      if (content) {
        publishedAt = content;
        break;
      }
    }
  }

  // Check for JSON-LD structured data
  if (!publishedAt) {
    const jsonLdScripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of jsonLdScripts) {
      try {
        const json = JSON.parse(script.textContent || "{}");
        if (json.datePublished) {
          publishedAt = json.datePublished;
          break;
        }
        if (json.dateCreated) {
          publishedAt = json.dateCreated;
          break;
        }
      } catch (e) {
        // Ignore invalid JSON
      }
    }
  }

  // Check for time elements with datetime attribute
  if (!publishedAt) {
    const timeElement = document.querySelector("time[datetime]");
    if (timeElement) {
      publishedAt = timeElement.getAttribute("datetime");
    }
  }

  // Use Readability for content extraction
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  if (!article) {
    throw new Error("Failed to parse article content with Readability");
  }

  return {
    title: article.title || "",
    content: article.textContent || "",
    publishedAt,
  };
}