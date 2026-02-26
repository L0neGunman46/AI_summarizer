// DOM Elements
const initialState = document.getElementById("initialState");
const loadingState = document.getElementById("loadingState");
const summaryState = document.getElementById("summaryState");
const errorState = document.getElementById("errorState");
const settingsState = document.getElementById("settingsState");
const summaryContent = document.getElementById("summaryContent");
const errorMessage = document.getElementById("errorMessage");
const paywallWarning = document.getElementById("paywallWarning");
const contentStats = document.getElementById("contentStats");
const refreshBtn = document.getElementById("refreshBtn");
const modelIndicator = document.getElementById("modelIndicator");

const summarizeBtn = document.getElementById("summarizeBtn");
const clearBtn = document.getElementById("clearBtn");
const retryBtn = document.getElementById("retryBtn");
const settingsBtn = document.getElementById("settingsBtn");
const backToMainBtn = document.getElementById("backToMainBtn");

// Settings elements
const apiKeyInput = document.getElementById("apiKey");
const baseUrlInput = document.getElementById("baseUrl");
const modelSelect = document.getElementById("model");
const customModelInput = document.getElementById("customModel");
const testConnectionBtn = document.getElementById("testConnectionBtn");
const saveSettingsBtn = document.getElementById("saveSettingsBtn");
const settingsStatus = document.getElementById("settingsStatus");
const paidModelWarning = document.getElementById("paidModelWarning");

let currTabId = null;
let previousState = "initial";

// Free models on OpenRouter always have the ':free' suffix
function isPaidModel(modelId) {
  return modelId && !modelId.trim().endsWith(":free");
}

function updatePaidModelWarning() {
  const model = customModelInput.value.trim() || modelSelect.value;
  paidModelWarning.classList.toggle("hidden", !isPaidModel(model));
}

// Initialize on DOM load
document.addEventListener("DOMContentLoaded", async () => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs && tabs[0]) {
    currTabId = tabs[0].id;
    await loadExistingSummary();
  }
  await updateModelIndicator();
});

// Update model indicator on initial state
async function updateModelIndicator() {
  try {
    const config = await chrome.runtime.sendMessage({ action: "getApiConfig" });
    if (config && config.model) {
      const modelName = config.model.split("/").pop();
      const paidBadge = isPaidModel(config.model)
        ? ' <span class="paid-badge">PAID</span>'
        : "";
      modelIndicator.innerHTML = `Using: ${modelName}${paidBadge}`;
    } else {
      modelIndicator.textContent = "Demo mode (no API key)";
    }
  } catch (err) {
    modelIndicator.textContent = "";
  }
}

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
  // Store previous state for back navigation
  if (state !== "settings" && state !== previousState) {
    previousState = state;
  }

  // Hide all states
  initialState.classList.add("hidden");
  loadingState.classList.add("hidden");
  summaryState.classList.add("hidden");
  errorState.classList.add("hidden");
  settingsState.classList.add("hidden");

  // Hide clear button by default
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
    case "settings":
      settingsState.classList.remove("hidden");
      loadSettings();
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

  if (metaData.charCount) {
    const formattedCount = metaData.charCount.toLocaleString();
    contentStats.textContent = `Extracted: ${formattedCount} chars`;
  } else {
    contentStats.textContent = "";
  }
  showState("summary");
}

// Escape HTML to prevent XSS
function preventXSS(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// Error display
function showError(message) {
  errorMessage.textContent =
    message || "Something went wrong while summarizing";
  showState("error");
}

// Load settings from storage
async function loadSettings() {
  try {
    const config = await chrome.runtime.sendMessage({ action: "getApiConfig" });
    if (config) {
      apiKeyInput.value = config.apiKey || "";
      baseUrlInput.value = config.baseUrl || "https://openrouter.ai/api/v1";

      // Check if model is in select options
      const modelExists = Array.from(modelSelect.options).some(
        (opt) => opt.value === config.model
      );
      if (modelExists) {
        modelSelect.value = config.model;
        customModelInput.value = "";
      } else {
        modelSelect.value = "anthropic/claude-haiku-4.5";
        customModelInput.value = config.model || "";
      }
    }
    updatePaidModelWarning();
  } catch (err) {
    console.error("Error loading settings:", err);
  }
}

// Save settings
async function saveSettings() {
  const apiKey = apiKeyInput.value.trim();
  const baseUrl = baseUrlInput.value.trim() || "https://openrouter.ai/api/v1";
  const model = customModelInput.value.trim() || modelSelect.value;

  try {
    await chrome.runtime.sendMessage({
      action: "setApiConfig",
      config: { apiKey, baseUrl, model },
    });

    showSettingsStatus("Settings saved successfully!", "success");
    await updateModelIndicator();
  } catch (err) {
    showSettingsStatus(`Error saving settings: ${err.message}`, "error");
  }
}

// Test API connection
async function testConnection() {
  const apiKey = apiKeyInput.value.trim();
  const baseUrl = baseUrlInput.value.trim() || "https://openrouter.ai/api/v1";
  const model = customModelInput.value.trim() || modelSelect.value;

  if (!apiKey) {
    showSettingsStatus("Please enter an API key first", "error");
    return;
  }

  testConnectionBtn.disabled = true;
  testConnectionBtn.textContent = "Testing...";

  try {
    const result = await chrome.runtime.sendMessage({
      action: "testConnection",
      config: { apiKey, baseUrl, model },
    });

    if (result.success) {
      showSettingsStatus(`Connection successful! Response: "${result.response}"`, "success");
    } else {
      showSettingsStatus(`Connection failed: ${result.error}`, "error");
    }
  } catch (err) {
    showSettingsStatus(`Error: ${err.message}`, "error");
  } finally {
    testConnectionBtn.disabled = false;
    testConnectionBtn.textContent = "Test Connection";
  }
}

// Show settings status message
function showSettingsStatus(message, type) {
  settingsStatus.textContent = message;
  settingsStatus.className = `settings-status ${type}`;
  settingsStatus.classList.remove("hidden");

  setTimeout(() => {
    settingsStatus.classList.add("hidden");
  }, 5000);
}

// Event listeners
summarizeBtn.addEventListener("click", async () => {
  await summarizePage();
});

retryBtn.addEventListener("click", async () => {
  await summarizePage();
});

refreshBtn.addEventListener("click", async () => {
  await summarizePage(true);
});

clearBtn.addEventListener("click", async () => {
  try {
    await chrome.storage.local.remove([`summary_${currTabId}`]);
    summaryContent.innerHTML = "";
    showState("initial");
  } catch (err) {
    console.error("Error in clearing the page: ", err);
  }
});

settingsBtn.addEventListener("click", () => {
  showState("settings");
});

backToMainBtn.addEventListener("click", async () => {
  await loadExistingSummary();
  await updateModelIndicator();
});

saveSettingsBtn.addEventListener("click", saveSettings);
testConnectionBtn.addEventListener("click", testConnection);

// Clear custom model when select changes, update paid warning
modelSelect.addEventListener("change", () => {
  customModelInput.value = "";
  updatePaidModelWarning();
});

customModelInput.addEventListener("input", () => {
  updatePaidModelWarning();
});

// Main summary function
async function summarizePage(forceWait = true) {
  showState("loading");
  try {
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
