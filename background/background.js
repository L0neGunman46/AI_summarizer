// Background service worker for AI Page Summarizer
// Uses OpenRouter with OpenAI SDK format for dynamic model selection
import AIKEYS from "../keys.js";

const keys = new AIKEYS();

// Default configuration
const DEFAULT_CONFIG = {
  baseUrl: keys.getBaseUrl() || "https://openrouter.ai/api/v1",
  apiKey: keys.getOpenRouterKey() || "",
  model: keys.getDefaultModel() || "z-ai/glm-4.5-air:free",
};

// Chunked summarization settings
const CHUNK_SIZE = 5000; // Characters per chunk
const MAX_CHUNKS = 6; // Maximum chunks to process (30k chars total)

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "summarize") {
    const forceWait = request.forceWait !== false;
    handleSummarize(request.tabId, forceWait)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (request.action === "setApiConfig") {
    setApiConfig(request.config)
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (request.action === "getApiConfig") {
    getApiConfig()
      .then((config) => sendResponse(config))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (request.action === "testConnection") {
    testApiConnection(request.config)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }
});

// Get API configuration from storage
async function getApiConfig() {
  const stored = await chrome.storage.local.get(["apiKey", "baseUrl", "model"]);

  return {
    apiKey: stored.apiKey || DEFAULT_CONFIG.apiKey,
    baseUrl: stored.baseUrl || DEFAULT_CONFIG.baseUrl,
    model: stored.model || DEFAULT_CONFIG.model,
  };
}

// Set API configuration in storage
async function setApiConfig(config) {
  const updates = {};
  if (config.apiKey !== undefined) updates.apiKey = config.apiKey;
  if (config.baseUrl !== undefined) updates.baseUrl = config.baseUrl;
  if (config.model !== undefined) updates.model = config.model;

  await chrome.storage.local.set(updates);
}

// Test API connection
async function testApiConnection(config) {
  try {
    const response = await callOpenAICompatibleAPI(
      "Say 'API connection successful' in exactly 4 words.",
      config,
      50,
    );
    return { success: true, response };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Handle summarization request
async function handleSummarize(tabId, forceWait = true) {
  try {
    const contentData = await getPageContent(tabId, forceWait);
    const content = contentData.content || contentData;

    if (!content || content.trim().length < 100) {
      throw new Error("Not enough content to summarize on this page");
    }

    const summary = await generateSummary(content);

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
    const response = await chrome.tabs.sendMessage(tabId, {
      action: "getPageContent",
      forceWait,
    });
    return response;
  } catch (error) {
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

// Injected function to extract page content
function extractPageContentInjected() {
  const title = document.title || "";
  const metaDescription =
    document.querySelector('meta[name="description"]')?.content || "";

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

// Core API call function - OpenAI SDK compatible format
async function callOpenAICompatibleAPI(prompt, config, maxTokens = 500) {
  const { apiKey, baseUrl, model } = config;

  if (!apiKey) {
    throw new Error(
      "API key not configured. Please add your API key in settings.",
    );
  }

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };

  // OpenRouter-specific headers
  if (baseUrl.includes("openrouter.ai")) {
    headers["HTTP-Referer"] = chrome.runtime.getURL("");
    headers["X-OpenRouter-Title"] = "AI Page Summarizer";
  }



  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const errorMessage =
      errorData.error?.message ||
      errorData.message ||
      `API error: ${response.status}`;
    throw new Error(errorMessage);
  }

  const data = await response.json();

  if (!data.choices || !data.choices[0]?.message?.content) {
    throw new Error("Invalid API response format");
  }

  return data.choices[0].message.content.trim();
}

// Generate summary using AI API
async function generateSummary(content) {
  const config = await getApiConfig();

  // Check if API key is configured
  if (!config.apiKey) {
    return generateDemoSummary(content);
  }

  // Check if content needs chunked processing
  const needsChunking = content.length > CHUNK_SIZE;

  if (needsChunking) {
    return generateChunkedSummary(content, config);
  }

  return generateDirectSummary(content, config);
}

// Direct summary for shorter content
async function generateDirectSummary(content, config) {
  const prompt = `Please summarize the following webpage content in exactly 2 paragraphs. The first paragraph should cover the main topic and key points. The second paragraph should cover supporting details or conclusions. Keep each paragraph to 3-4 sentences.

Content:
${content}`;

  return callOpenAICompatibleAPI(prompt, config, 500);
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

    let breakPoint = CHUNK_SIZE;
    const sentenceEnders = [". ", "! ", "? ", ".\n", "!\n", "?\n"];

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
async function generateChunkedSummary(content, config) {
  const chunks = splitIntoChunks(content);

  if (chunks.length === 1) {
    return generateDirectSummary(content, config);
  }

  const chunkSummaries = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const chunkPrompt = `Summarize this section (part ${i + 1} of ${chunks.length}) in 2-3 sentences:\n\n${chunk}`;

    const summary = await callOpenAICompatibleAPI(chunkPrompt, config, 150);
    chunkSummaries.push(summary);

    if (i < chunks.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  const combinedSummaries = chunkSummaries.join("\n\n");
  const finalPrompt = `Based on these section summaries, create a cohesive 2-paragraph summary. First paragraph: main topic and key points. Second paragraph: supporting details and conclusions.

Section summaries:
${combinedSummaries}`;

  return callOpenAICompatibleAPI(finalPrompt, config, 500);
}

// Demo mode - simple extractive summary (no API needed)
function generateDemoSummary(content) {
  const titleMatch = content.match(/Title: ([^\n]+)/);
  const title = titleMatch ? titleMatch[1] : "";

  let processedContent = content
    .replace(/Title: [^\n]+\n\n/, "")
    .replace(/Description: [^\n]+\n\n/, "");

  const sentences = processedContent
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 30 && s.length < 300);

  if (sentences.length < 4) {
    return `This page${title ? ` about "${title}"` : ""} contains limited textual content that can be summarized.\n\nThe page may contain primarily media, interactive elements, or minimal text content.`;
  }

  const para1Sentences = sentences.slice(0, 3);
  const para1 = para1Sentences.join(". ") + ".";

  const midPoint = Math.floor(sentences.length / 2);
  const para2Sentences = sentences.slice(midPoint, midPoint + 3);
  const para2 = para2Sentences.join(". ") + ".";

  return `${para1}\n\n${para2}`;
}

// Clean up old summaries when tabs are closed
chrome.tabs.onRemoved.addListener(async (tabId) => {
  try {
    await chrome.storage.local.remove([`summary_${tabId}`]);
  } catch (error) {
    console.error("Error cleaning up tab summary:", error);
  }
});
