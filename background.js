// Stable Core 1.8.0 — coordinates product tabs and records each result once.
const CART_URL = "https://www.ebgames.com.au/shopping-cart";
const PRODUCT_PREFIX = "https://www.ebgames.com.au/product/";
const MESSAGE_RETRIES = 6;
const MESSAGE_RETRY_DELAY_MS = 250;

const deliveredTabs = new Set();
let resultQueue = Promise.resolve();

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function readJob() {
  return (await chrome.storage.local.get("ebmoJob")).ebmoJob || null;
}
async function writeStatus(ebmoStatus) {
  await chrome.storage.local.set({ ebmoStatus });
}
function enqueueResult(jobId, result) {
  // Serialise storage writes so simultaneous product results cannot overwrite each other.
  resultQueue = resultQueue.then(() => recordResult(jobId, result)).catch(async error => {
    await writeStatus(`Background result error: ${error?.message || error}`);
  });
  return resultQueue;
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.url?.startsWith(PRODUCT_PREFIX)) return;

  try {
    const job = await readJob();
    if (!job?.running || !job.parallel || !Array.isArray(job.tabIds)) return;
    const index = job.tabIds.indexOf(tabId);
    if (index < 0 || !job.items?.[index] || deliveredTabs.has(tabId)) return;
    if (job.completed?.some(result => result.index === index)) return;

    deliveredTabs.add(tabId);
    const navigationToCompleteMs = Number.isFinite(job.navigationInitiatedAt)
      ? Math.max(0, Date.now() - job.navigationInitiatedAt)
      : null;
    const message = {
      type: "EBMO_ADD_PRODUCT",
      jobId: job.id,
      index,
      item: job.items[index],
      navigationToCompleteMs
    };

    let delivered = false;
    for (let attempt = 0; attempt < MESSAGE_RETRIES; attempt++) {
      try {
        await chrome.tabs.sendMessage(tabId, message);
        delivered = true;
        break;
      } catch {
        if (attempt + 1 < MESSAGE_RETRIES) await sleep(MESSAGE_RETRY_DELAY_MS);
      }
    }

    if (!delivered) {
      await enqueueResult(job.id, {
        ok: false,
        confirmed: false,
        index,
        qty: job.items[index].qty,
        url: job.items[index].url,
        message: "Could not contact product tab script"
      });
    }
  } catch (error) {
    await writeStatus(`Product-tab controller error: ${error?.message || error}`);
  }
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== "EBMO_PRODUCT_DONE" || !message.jobId || !message.result) return;

  const tabId = sender?.tab?.id;
  enqueueResult(message.jobId, message.result).then(async accepted => {
    // Close the tab only for a confirmed result belonging to the active job.
    if (accepted && message.result.confirmed && Number.isInteger(tabId)) {
      try { await chrome.tabs.remove(tabId); } catch {}
    }
  });
});

async function recordResult(jobId, result) {
  const job = await readJob();
  if (!job?.running || job.id !== jobId) return false;

  job.completed = Array.isArray(job.completed) ? job.completed : [];
  job.log = Array.isArray(job.log) ? job.log : [];
  if (job.completed.some(existing => existing.index === result.index)) return true;

  job.completed.push(result);
  job.log.push(result);
  const completedCount = job.completed.length;
  const total = job.items.length;

  if (completedCount < total) {
    await chrome.storage.local.set({
      ebmoJob: job,
      ebmoStatus: `Parallel add progress: ${completedCount}/${total} product tabs finished. Waiting for the rest…`
    });
    return true;
  }

  job.running = false;
  job.index = 0;
  const elapsedMs = Math.max(0, Date.now() - (job.startedAt || job.createdAt || Date.now()));
  const ordered = [...job.completed].sort((a, b) => a.index - b.index);
  const confirmedCount = ordered.filter(item => item.confirmed).length;
  const timingLines = ordered.map(item => {
    const timing = item.timings || {};
    const navigation = Number.isFinite(timing.navigationToCompleteMs)
      ? `navigation→page complete ${timing.navigationToCompleteMs} ms`
      : "navigation timing unavailable";
    const button = Number.isFinite(timing.buttonWaitMs)
      ? `button detection ${timing.buttonWaitMs} ms after worker start`
      : "button timing unavailable";
    const confirmation = Number.isFinite(timing.clickToSignalMs)
      ? `click→confirmation ${timing.clickToSignalMs} ms`
      : "no confirmation signal";
    return `Product ${item.index + 1}: ${item.confirmed ? "confirmed" : "UNCONFIRMED"}; ${navigation}; ${button}; ${confirmation}`;
  });

  const addSummary = `Product-tab phase: ${(elapsedMs / 1000).toFixed(1)} s total; ${confirmedCount}/${total} confirmed.\n${timingLines.join("\n")}`;
  job.addSummary = addSummary;
  await chrome.storage.local.set({
    ebmoJob: job,
    ebmoAddSummary: addSummary,
    ebmoStatus: `${addSummary}\n\nOpening cart to set requested quantities. Review all items before checkout.`
  });

  try {
    await chrome.tabs.create({ url: CART_URL, active: true });
  } catch {
    await writeStatus("All product tabs finished, but the cart tab could not open. Use the Open shopping cart button.");
  }
  return true;
}
