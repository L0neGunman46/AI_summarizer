// Content script to extract page content

// Listen for messages from background script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "getPageContent") {
    const shouldWait = request.forceWait !== false; // Default to waiting

    if (shouldWait) {
      waitForContent().then(() => {
        const result = extractPageContent();
        sendResponse(result);
      });
    } else {
      const result = extractPageContent();
      sendResponse(result);
    }
    return true; // Keep the message channel open for async response
  }
  return true;
});

// Wait for dynamic content to load (for SPAs)
function waitForContent(timeout = 3000) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    let lastContentLength = 0;
    let stableCount = 0;

    // Check if we already have substantial content
    const initialContent = document.body?.textContent?.length || 0;
    if (initialContent > 1000) {
      // Already have content, wait briefly for any final updates
      setTimeout(resolve, 300);
      return;
    }

    const observer = new MutationObserver(() => {
      const currentLength = document.body?.textContent?.length || 0;

      if (currentLength === lastContentLength) {
        stableCount++;
        // Content has stabilized for 3 checks
        if (stableCount >= 3) {
          observer.disconnect();
          resolve();
        }
      } else {
        stableCount = 0;
        lastContentLength = currentLength;
      }

      // Timeout check
      if (Date.now() - startTime > timeout) {
        observer.disconnect();
        resolve();
      }
    });

    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    // Also check periodically in case no mutations occur
    const interval = setInterval(() => {
      if (Date.now() - startTime > timeout) {
        clearInterval(interval);
        observer.disconnect();
        resolve();
      }
    }, 500);

    // Cleanup on resolve
    const originalResolve = resolve;
    resolve = () => {
      clearInterval(interval);
      observer.disconnect();
      originalResolve();
    };
  });
}

// Detect if page has a paywall
function detectPaywall() {
  // Common paywall CSS selectors
  const paywallSelectors = [
    ".paywall",
    ".subscription-wall",
    ".premium-wall",
    ".meter-wall",
    '[class*="paywall"]',
    '[class*="Paywall"]',
    '[id*="paywall"]',
    ".piano-offer",
    ".tp-modal",
    ".tp-backdrop",
    ".subscribe-wall",
    ".registration-wall",
    '[data-testid*="paywall"]',
    ".article-locked",
    ".content-locked",
    ".premium-content-gate",
    ".subscriber-only",
  ];

  // Check for paywall elements
  for (const selector of paywallSelectors) {
    const element = document.querySelector(selector);
    if (element && isVisible(element)) {
      return { detected: true, type: "paywall-element" };
    }
  }

  // Check for common paywall text patterns
  const bodyText = document.body?.innerText?.toLowerCase() || "";
  const paywallPhrases = [
    "subscribe to continue reading",
    "subscribe to read the full",
    "subscribers only",
    "member-only content",
    "premium article",
    "to continue reading, subscribe",
    "you have reached your limit",
    "free articles remaining",
    "sign in to read",
    "create an account to continue",
  ];

  for (const phrase of paywallPhrases) {
    if (bodyText.includes(phrase)) {
      return { detected: true, type: "paywall-text" };
    }
  }

  // Check for gradient/fade overlays that often indicate truncated content
  const fadeSelectors = [
    ".fade-out",
    ".content-fade",
    ".article-fade",
    '[class*="gradient-overlay"]',
    '[class*="read-more-fade"]',
  ];

  for (const selector of fadeSelectors) {
    const element = document.querySelector(selector);
    if (element && isVisible(element)) {
      return { detected: true, type: "content-truncated" };
    }
  }

  return { detected: false, type: null };
}

// Check if element is visible
function isVisible(element) {
  if (!element) return false;
  const style = window.getComputedStyle(element);
  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    style.opacity !== "0" &&
    element.offsetParent !== null
  );
}

// Extract meaningful content from the page
function extractPageContent() {
  // Get the page title
  const title = document.title || "";

  // Get meta description
  const metaDescription =
    document.querySelector('meta[name="description"]')?.content || "";

  // Get the main content
  const mainContent = extractMainContent();

  // Detect paywall
  const paywall = detectPaywall();

  // Combine all content
  let fullContent = "";

  if (title) {
    fullContent += `Title: ${title}\n\n`;
  }

  if (metaDescription) {
    fullContent += `Description: ${metaDescription}\n\n`;
  }

  fullContent += mainContent;

  // Store original length before truncation
  const originalLength = fullContent.length;

  // Limit content to avoid token limits (now 30000 for chunked processing)
  const maxLength = 30000;
  let wasTruncated = false;
  if (fullContent.length > maxLength) {
    fullContent = fullContent.substring(0, maxLength) + "...";
    wasTruncated = true;
  }

  // Return content with metadata
  return {
    content: fullContent,
    charCount: originalLength,
    wasTruncated,
    paywallDetected: paywall.detected,
    paywallType: paywall.type,
  };
}

// Extract main content from the page
function extractMainContent() {
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
    ".post",
    ".article",
  ];

  // Try to find main content area
  let contentElement = null;

  for (const selector of contentSelectors) {
    contentElement = document.querySelector(selector);
    if (contentElement && contentElement.textContent.trim().length > 200) {
      break;
    }
  }

  // If no specific content area found, use body
  if (!contentElement) {
    contentElement = document.body;
  }

  // Clone the element to avoid modifying the actual page
  const clone = contentElement.cloneNode(true);

  // Remove unwanted elements
  const unwantedSelectors = [
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
    ".nav",
    ".menu",
    ".advertisement",
    ".ad",
    ".ads",
    ".social-share",
    ".comments",
    ".comment",
    ".related-posts",
    '[role="navigation"]',
    '[role="banner"]',
    '[role="complementary"]',
    '[aria-hidden="true"]',
  ];

  unwantedSelectors.forEach((selector) => {
    clone.querySelectorAll(selector).forEach((el) => el.remove());
  });

  // Get text content and clean it up
  let text = clone.textContent || "";

  // Clean up whitespace
  text = text
    .replace(/\s+/g, " ") // Replace multiple whitespace with single space
    .replace(/\n\s*\n/g, "\n\n") // Normalize paragraph breaks
    .trim();

  return text;
}

// Also expose a function that can be called via executeScript
window.getPageContentForSummarizer = extractPageContent;

// Expose waitForContent for injection use
window.waitForContentForSummarizer = waitForContent;
