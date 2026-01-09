// Background service worker for AI Page Summarizer
import AIKEYS from "../keys";

const keys = new AIKEYS();
// Configuration - Replace with your actual API key or use environment/storage
const CONFIG = {
  apiProvider: "anthropic",
  anthropicApiKey: keys.getAnthropicKey(), // Set your Anthropic API key here or via storage
};

// Chunked summarization settings
const CHUNK_SIZE = 5000; // Characters per chunk
const MAX_CHUNKS = 6; // Maximum chunks to process (30k chars total)

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "summarize") {
    const forceWait = request.forceWait !== false; // Default to true
    handleSummarize(request.tabId, forceWait)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ error: error.message }));
    return true; // Keep message channel open for async response
  }

  if (request.action === "setApiKey") {
    setApiKey(request.provider, request.apiKey)
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }
});

// Handle summarization request
async function handleSummarize(tabId, forceWait = true) {
  try {
    // Get page content from content script (now returns metadata)
    const contentData = await getPageContent(tabId, forceWait);

    const content = contentData.content || contentData; // Handle both old and new format

    if (!content || content.trim().length < 100) {
      throw new Error("Not enough content to summarize on this page");
    }

    // Generate summary using AI (with chunking for long content)
    const summary = await generateSummary(content);

    // Return summary with metadata
    return {
      summary,
      charCount: contentData.charCount || content.length,
      paywallDetected: contentData.paywallDetected || false,
      paywallType: contentData.paywallType || null,
      wasTruncated: contentData.wasTruncated || false,
    };
  } catch (error) {
    console.error("Summarization error:", error);
    throw error;
  }
}

// Get page content from content script
async function getPageContent(tabId, forceWait = true) {
  try {
    // First, try to send message to existing content script
    const response = await chrome.tabs.sendMessage(tabId, {
      action: "getPageContent",
      forceWait,
    });
    // Response now contains metadata object or content string
    return response;
  } catch (error) {
    // Content script might not be loaded, inject it
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: extractPageContentInjected,
      });

      if (results && results[0] && results[0].result) {
        return results[0].result;
      }

      throw new Error("Could not extract page content");
    } catch (injectionError) {
      console.error("Script injection error:", injectionError);
      throw new Error("Cannot access this page. Try a different webpage.");
    }
  }
}

// Injected function to extract page content (duplicated from content script for injection)
function extractPageContentInjected() {
  const title = document.title || "";
  const metaDescription =
    document.querySelector('meta[name="description"]')?.content || "";

  // Priority selectors for main content areas
  const contentSelectors = [
    "article",
    "main",
    '[role="main"]',
    ".post-content",
    ".article-content",
    ".entry-content",
    ".content",
    "#content",
  ];

  let contentElement = null;
  for (const selector of contentSelectors) {
    contentElement = document.querySelector(selector);
    if (contentElement && contentElement.textContent.trim().length > 200) break;
  }

  if (!contentElement) contentElement = document.body;

  const clone = contentElement.cloneNode(true);

  // Remove unwanted elements
  [
    "script",
    "style",
    "noscript",
    "iframe",
    "nav",
    "header",
    "footer",
    "aside",
    ".sidebar",
    ".navigation",
    ".ad",
    ".ads",
    ".comments",
  ].forEach((sel) => {
    clone.querySelectorAll(sel).forEach((el) => el.remove());
  });

  let text = clone.textContent || "";
  text = text.replace(/\s+/g, " ").trim();

  let fullContent = "";
  if (title) fullContent += `Title: ${title}\n\n`;
  if (metaDescription) fullContent += `Description: ${metaDescription}\n\n`;
  fullContent += text;

  // Detect paywall
  const paywallSelectors = [
    ".paywall",
    '[class*="paywall"]',
    ".subscription-wall",
    ".premium-wall",
  ];
  let paywallDetected = false;
  for (const sel of paywallSelectors) {
    if (document.querySelector(sel)) {
      paywallDetected = true;
      break;
    }
  }

  // Check paywall text patterns
  const bodyText = document.body?.innerText?.toLowerCase() || "";
  const paywallPhrases = [
    "subscribe to continue",
    "subscribers only",
    "premium article",
  ];
  for (const phrase of paywallPhrases) {
    if (bodyText.includes(phrase)) {
      paywallDetected = true;
      break;
    }
  }

  const originalLength = fullContent.length;
  const maxLength = 30000;
  let wasTruncated = false;

  if (fullContent.length > maxLength) {
    fullContent = fullContent.substring(0, maxLength) + "...";
    wasTruncated = true;
  }

  return {
    content: fullContent,
    charCount: originalLength,
    paywallDetected,
    paywallType: paywallDetected ? "detected" : null,
    wasTruncated,
  };
}

// Generate summary using AI API
async function generateSummary(content) {
  // Try to get API key from storage
  const stored = await chrome.storage.local.get([
    "anthropicApiKey",
    "apiProvider",
  ]);

  const provider = stored.apiProvider || CONFIG.apiProvider;
  const anthropicKey = stored.anthropicApiKey || CONFIG.anthropicApiKey;

  // Check if content needs chunked processing
  const needsChunking = content.length > CHUNK_SIZE;

  // If no API key is set, use demo mode with a simple extractive summary
  if (provider === "demo" || !anthropicKey) {
    return generateDemoSummary(content);
  }

  // For long content, use chunked summarization
  if (needsChunking) {
    if (provider === "anthropic" && anthropicKey) {
      return generateChunkedSummary(content, "anthropic", anthropicKey);
    }
  }

  if (provider === "anthropic" && anthropicKey) {
    return generateAnthropicSummary(content, anthropicKey);
  }

  // Fallback to demo mode
  return generateDemoSummary(content);
}

// Split content into chunks at sentence boundaries
function splitIntoChunks(content) {
  const chunks = [];
  let remaining = content;

  while (remaining.length > 0 && chunks.length < MAX_CHUNKS) {
    if (remaining.length <= CHUNK_SIZE) {
      chunks.push(remaining);
      break;
    }

    // Find a good break point (end of sentence) near CHUNK_SIZE
    let breakPoint = CHUNK_SIZE;
    const sentenceEnders = [". ", "! ", "? ", ".\n", "!\n", "?\n"];

    // Look for sentence end within last 500 chars of chunk
    for (let i = CHUNK_SIZE; i > CHUNK_SIZE - 500 && i > 0; i--) {
      for (const ender of sentenceEnders) {
        if (remaining.substring(i - 1, i + ender.length - 1) === ender) {
          breakPoint = i;
          break;
        }
      }
      if (breakPoint !== CHUNK_SIZE) break;
    }

    chunks.push(remaining.substring(0, breakPoint).trim());
    remaining = remaining.substring(breakPoint).trim();
  }

  return chunks;
}

// Generate summary using chunked approach for long content
async function generateChunkedSummary(content, provider, apiKey) {
  const chunks = splitIntoChunks(content);

  if (chunks.length === 1) {
    return generateAnthropicSummary(content, apiKey);
  }

  // Summarize each chunk
  const chunkSummaries = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const chunkPrompt = `Summarize this section (part ${i + 1} of ${chunks.length}) in 2-3 sentences:\n\n${chunk}`;

    let summary;

    summary = await generateAnthropicChunkSummary(chunkPrompt, apiKey);

    chunkSummaries.push(summary);

    // Small delay to avoid rate limiting
    if (i < chunks.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  // Combine chunk summaries into final summary
  const combinedSummaries = chunkSummaries.join("\n\n");
  const finalPrompt = `Based on these section summaries, create a cohesive 2-paragraph summary. First paragraph: main topic and key points. Second paragraph: supporting details and conclusions.\n\nSection summaries:\n${combinedSummaries}`;

  return generateAnthropicFinalSummary(finalPrompt, apiKey);
}

// Anthropic chunk summary
async function generateAnthropicChunkSummary(prompt, apiKey) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-3-haiku-20240307",
      max_tokens: 150,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error?.message || "Anthropic API error");
  }

  const data = await response.json();
  return data.content[0].text.trim();
}

// Anthropic final summary from chunk summaries
async function generateAnthropicFinalSummary(prompt, apiKey) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-3-haiku-20240307",
      max_tokens: 500,
      messages: [
        {
          role: "user",
          content: `You are creating a cohesive summary from section summaries. Create exactly 2 paragraphs.\n\n${prompt}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error?.message || "Anthropic API error");
  }

  const data = await response.json();
  return data.content[0].text.trim();
}

// Anthropic API summarization
async function generateAnthropicSummary(content, apiKey) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-3-haiku-20240307",
      max_tokens: 500,
      messages: [
        {
          role: "user",
          content: `Please summarize the following webpage content in exactly 2 paragraphs. The first paragraph should cover the main topic and key points. The second paragraph should cover supporting details or conclusions. Keep each paragraph to 3-4 sentences.\n\nContent:\n${content}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error?.message || "Anthropic API error");
  }

  const data = await response.json();
  return data.content[0].text.trim();
}

// Demo mode - simple extractive summary (no API needed)
function generateDemoSummary(content) {
  // Extract title if present
  const titleMatch = content.match(/Title: ([^\n]+)/);
  const title = titleMatch ? titleMatch[1] : "";

  // Remove title and description from content for processing
  let processedContent = content
    .replace(/Title: [^\n]+\n\n/, "")
    .replace(/Description: [^\n]+\n\n/, "");

  // Split into sentences
  const sentences = processedContent
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 30 && s.length < 300);

  if (sentences.length < 4) {
    // Not enough content, return a generic message
    return `This page${title ? ` about "${title}"` : ""} contains limited textual content that can be summarized.\n\nThe page may contain primarily media, interactive elements, or minimal text content.`;
  }

  // Take first few sentences for first paragraph
  const para1Sentences = sentences.slice(0, 3);
  const para1 = para1Sentences.join(". ") + ".";

  // Take some sentences from the middle/end for second paragraph
  const midPoint = Math.floor(sentences.length / 2);
  const para2Sentences = sentences.slice(midPoint, midPoint + 3);
  const para2 = para2Sentences.join(". ") + ".";

  return `${para1}\n\n${para2}`;
}

// Set API key in storage
async function setApiKey(provider, apiKey) {
  const key = "anthropicApiKey";
  await chrome.storage.local.set({ [key]: apiKey, apiProvider: provider });
}

// Clean up old summaries when tabs are closed
chrome.tabs.onRemoved.addListener(async (tabId) => {
  try {
    await chrome.storage.local.remove([`summary_${tabId}`]);
  } catch (error) {
    console.error("Error cleaning up tab summary:", error);
  }
});
