// DOM Elements
const initialState = document.getElementById("initialState");
const loadingState = document.getElementById("loadingState");
const summaryState = document.getElementById("summaryState");
const errorState = document.getElementById("errorState");
const summaryContent = document.getElementById("summaryContent");
const errorMessage = document.getElementById("errorMessage");
const paywallWarning = document.getElementById("paywallWarning");
const contentStats = document.getElementById("contentStats");
const refreshBtn = document.getElementById("refreshBtn");

const summarizeBtn = document.getElementById("summarizeBtn");
const clearBtn = document.getElementById("clearBtn");
const retryBtn = document.getElementById("retryBtn");

let currTabId = null;

// getting current tab data
document.addEventListener("DOMContentLoaded", async () => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs && tabs[0]) {
    currTabId = tabs[0].id;
    await loadExistingSummary();
  }
});

// Show summary of current tab that already exists
async function loadExistingSummary() {
  try {
    const res = await chrome.storage.local.get([`summary_${currTabId}`]);
    const summaryData = res[`summary_${currTabId}`];
    if (summaryData && summaryData.summary) {
      showSummary(summaryData.summary, {
        charCount: summaryData.charCount,
        paywallDetected: summaryData.paywallDetected,
      });
    } else {
      showState("initial");
    }
  } catch (err) {
    console.error("Error loading previous summary: ", err);
    showState("initial");
  }
}

function showState(state) {
  // Initially hide all states
  initialState.classList.add("hidden");
  loadingState.classList.add("hidden");
  summaryState.classList.add("hidden");
  errorState.classList.add("hidden");

  //Hide clear button by default
  clearBtn.classList.add("hidden");

  switch (state) {
    case "initial":
      initialState.classList.remove("hidden");
      break;
    case "loading":
      loadingState.classList.remove("hidden");
      break;
    case "summary":
      summaryState.classList.remove("hidden");
      clearBtn.classList.remove("hidden");
      break;
    case "error":
      errorState.classList.remove("hidden");
      break;
  }
}

function showSummary(summary, metaData = {}) {
  const paras = summary.split("\n\n").filter((p) => p.trim());
  summaryContent.innerHTML = paras
    .slice(0, 2)
    .map((p) => `<p>${preventXSS(p.trim())}</p>`)
    .join("");

  if (metaData.paywallDetected) {
    paywallWarning.classList.remove("hidden");
  } else {
    paywallWarning.classList.add("hidden");
  }

  // If there are large amount of chars
  if (metaData.charCount) {
    const formattedCount = metaData.charCount.toLocaleString();
    contentStats.textContent = `Extracted: ${formattedCount} chars`;
  } else {
    contentStats.textContent = "";
  }
  showState("summary");
}

// escape html to prevent xss
function preventXSS(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// error display

function showError(message) {
  errorMessage.textContent =
    message || "Something went wrong while summarizing";
  showState("error");
}

// handle summarise click
summarizeBtn.addEventListener("click", async () => {
  await summarizePage();
});

// handle retry button
retryBtn.addEventListener("click", async () => {
  await summarizePage();
});

// Refresh button click
refreshBtn.addEventListener("click", async () => {
  await summarizePage(true);
});

clearBtn.addEventListener("click", async () => {
  try {
    await chrome.storage.local.remove([`summary_${currTabId}`]);
    summaryContent.innerHTML = "";
    showState("initial");
  } catch (err) {
    console.error("Error in clearning the page: ", err);
  }
});

// main summary function
async function summarizePage(forceWait = true) {
  showState("loading");
  try {
    // get the current tab
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];

    if (!tab) {
      throw new Error("No active tabs found");
    }

    currTabId = tab.id;

    if (
      tab.url.startsWith("chrome://") ||
      tab.url.startsWith("chrome-extension://") ||
      tab.url.startsWith("about:") ||
      tab.url.startsWith("moz-extension://")
    ) {
      throw new Error("Cannot summarize internal pages");
    }

    // Send message to background script to get summary
    const response = await chrome.runtime.sendMessage({
      action: "summarize",
      tabId: tab.id,
      forceWait,
    });

    if (response.error) {
      throw new Error(response.error);
    }

    if (response.summary) {
      await chrome.storage.local.set({
        [`summary_${currTabId}`]: {
          summary: response.summary,
          url: tab.url,
          timestamp: Date.now(),
          charCount: response.charCount,
          paywallDetected: response.paywallDetected,
        },
      });
      showSummary(response.summary, {
        charCount: response.charCount,
        paywallDetected: response.paywallDetected,
      });
    } else {
      throw new Error("No summary received");
    }
  } catch (err) {
    console.error("Error in summarization: ", err);
    showError(err.message);
  }
}

// Listen for tab changes
chrome.tabs.onActivated.addListener(async (activeTabInfo) => {
  currTabId = activeTabInfo.tabId;
  await loadExistingSummary(currTabId);
});
