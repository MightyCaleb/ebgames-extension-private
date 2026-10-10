// Stable Core 1.8.0 — coordinates product tabs and records each result once.
const CART_URL = "https://www.ebgames.com.au/shopping-cart";
const PRODUCT_PREFIX = "https://www.ebgames.com.au/product/";
const MESSAGE_RETRIES = 6;
const MESSAGE_RETRY_DELAY_MS = 250;

const deliveredTabs = new Set();
const pendingDiscordNotifications = new Set();
let resultQueue = Promise.resolve();

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function readJob() {
  return (await chrome.storage.local.get("ebmoJob")).ebmoJob || null;
}
async function writeStatus(ebmoStatus) {
  await chrome.storage.local.set({ ebmoStatus });
}

function productTitleFromUrl(url) {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    let slug = parts.at(-1) || "EB Games product";
    slug = slug.replace(/^\d+-/, "").replace(/-\d+$/, "").replace(/-/g, " ");
    return decodeURIComponent(slug).replace(/\s+/g, " ").trim().slice(0, 180) || "EB Games product";
  } catch { return "EB Games product"; }
}
function isDiscordWebhookUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ["discord.com", "discordapp.com"].includes(url.hostname) && /^\/api\/webhooks\/\d+\/[^/]+$/.test(url.pathname);
  } catch { return false; }
}
async function postDiscordEmbed({ title, description, color = 0x5865F2, fields = [], url = "", imageUrl = "" }) {
  const { ebmoDiscordWebhook } = await chrome.storage.local.get("ebmoDiscordWebhook");
  if (!ebmoDiscordWebhook) return { ok:false, error:"No Discord webhook is saved." };
  if (!isDiscordWebhookUrl(ebmoDiscordWebhook)) return { ok:false, error:"Saved Discord webhook URL is invalid." };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(ebmoDiscordWebhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "EB Games Helper",
        embeds: [(() => {
          const embed = {
            title: String(title || "EB Games Helper").slice(0, 256),
            description: String(description || "").slice(0, 3800),
            color,
            fields: fields.slice(0, 10).map(field => ({
              name: String(field.name || "Details").slice(0, 256),
              value: String(field.value || "—").slice(0, 1000),
              inline: !!field.inline
            })),
          };
          try { const u = new URL(url); if (u.protocol === "https:") embed.url = u.href; } catch {}
          try { const u = new URL(imageUrl); if (u.protocol === "https:") embed.image = { url: u.href }; } catch {}
          return embed;
        })()]
      }),
      signal: controller.signal,
      cache: "no-store",
      credentials: "omit"
    });
    if (!response.ok) return { ok:false, error:`Discord returned HTTP ${response.status}. Check the webhook URL and channel.` };
    return { ok:true };
  } catch (error) {
    return { ok:false, error:error?.name === "AbortError" ? "Discord request timed out." : "Could not reach Discord. Check your connection and webhook URL." };
  } finally { clearTimeout(timeout); }
}
function notifyDiscordInBackground(payload) {
  // Start notifications immediately without blocking cart navigation. The product-message
  // event waits for these tracked requests before its response closes, keeping the MV3
  // service worker alive long enough to finish short webhook requests.
  const task = postDiscordEmbed(payload).catch(() => ({ ok:false }));
  pendingDiscordNotifications.add(task);
  task.finally(() => pendingDiscordNotifications.delete(task));
  return task;
}
function formatLocalDateTime(isoTimestamp) {
  if (!isoTimestamp) return "Not confirmed";
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return "Not recorded";
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric", month: "short", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: true
    }).format(date);
  } catch {
    return date.toLocaleString();
  }
}

function productResultNotification(job, result, checkoutAccountEmail) {
  const fallbackTitle = productTitleFromUrl(result.url || job.items?.[result.index]?.url || "");
  const info = result.productInfo && typeof result.productInfo === "object" ? result.productInfo : {};
  const productTitle = String(info.title || fallbackTitle).slice(0, 240);
  const productUrl = String(info.productUrl || result.url || job.items?.[result.index]?.url || "");
  const imageUrl = String(info.imageUrl || "");
  const confirmed = !!result.confirmed;
  const timing = result.timings?.clickToSignalMs;
  const targetQty = Number(result.qty);
  const quantityLabel = Number.isSafeInteger(targetQty) && targetQty > 0 ? `×${targetQty}` : "Not recorded";
  const priceValue = Number(info.priceValue);
  const hasPrice = Number.isFinite(priceValue) && priceValue > 0;
  const priceLabel = String(info.priceDisplay || "Price not detected on product page").slice(0, 100);
  const totalLabel = hasPrice && Number.isSafeInteger(targetQty) && targetQty > 0
    ? `AUD $${(priceValue * targetQty).toFixed(2)} (estimate)`
    : "Unavailable";
  const description = confirmed
    ? "✅ CHECKOUT **SUCCESS — CHECKOUT DONE**\nProduct checkouted successfully. The requested quantity is handled during cart preparation."
    : `⚠️ **Add-to-cart not confirmed**\n${String(result.message || "Please inspect the product page and cart.").slice(0, 500)}`;
  const fields = [
    { name: "Unit price", value: priceLabel, inline: true },
    { name: "Target cart quantity", value: quantityLabel, inline: true },
    { name: "Estimated target total", value: totalLabel, inline: true },
    { name: "Time", value: confirmed ? formatLocalDateTime(result.addToCartAt) : "Not confirmed", inline: false },
    { name: "Account", value: checkoutAccountEmail || "Not detected — check the active EB Games account before checkout", inline: false },
    { name: "Add result", value: confirmed ? "Confirmation detected" : "Needs manual check", inline: true },
    { name: "Run progress", value: `Product ${Number(result.index) + 1} of ${job.items?.length || "?"}`, inline: true }
  ];
  if (Number.isFinite(timing)) fields.push({ name: "Click → confirmation", value: `${timing} ms`, inline: true });
  if (!imageUrl) fields.push({ name: "Product image", value: "Image could not be detected on the product page", inline: false });
  notifyDiscordInBackground({
    title: `${confirmed ? "✅" : "⚠️"} ${productTitle}`,
    description,
    color: confirmed ? 0x2ECC71 : 0xE74C3C,
    fields,
    url: productUrl,
    imageUrl
  });
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "EBMO_TEST_DISCORD") {
    postDiscordEmbed({
      title: "✅ EB Games Helper — Test notification",
      description: "Your Discord webhook is configured correctly. You will receive rich product-add notifications here.",
      color: 0x5865F2
    }).then(sendResponse).catch(error => sendResponse({ ok:false, error:error?.message || "Test failed." }));
    return true;
  }

  if (message?.type === "EBMO_CART_ACCOUNT_READY" && message.jobId) {
    (async () => {
      const job = await readJob();
      if (!job || job.id !== message.jobId) return { ok:false, error:"No matching product run was found." };
      if (job.discordNotificationsSentAt) return { ok:true, alreadySent:true };
      const account = typeof message.accountEmail === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(message.accountEmail.trim())
        ? message.accountEmail.trim()
        : "Not detected — check the active EB Games account before checkout";
      job.checkoutAccountEmail = account;
      job.discordNotificationsSentAt = Date.now();
      await chrome.storage.local.set({ ebmoJob:job, ebmoCheckoutAccount:account });
      for (const result of [...(job.completed || [])].sort((a,b) => a.index-b.index)) {
        productResultNotification(job, result, account);
      }
      const outcomes = await Promise.all([...pendingDiscordNotifications]);
      const failed = outcomes.some(outcome => !outcome?.ok);
      return { ok:!failed, account, sent:outcomes.length, error:failed ? "Some Discord product notifications failed." : undefined };
    })().then(sendResponse).catch(error => sendResponse({ ok:false, error:error?.message || "Account verification notification failed." }));
    return true;
  }

  if (message?.type === "EBMO_PRODUCT_DONE" && message.jobId && message.result) {
    const tabId = sender?.tab?.id;
    enqueueResult(message.jobId, message.result).then(async accepted => {
      // Close the tab only for a confirmed result belonging to the active job.
      if (accepted && message.result.confirmed && Number.isInteger(tabId)) {
        try { await chrome.tabs.remove(tabId); } catch {}
      }
      // Wait briefly for any product notification without slowing the cart opening itself;
      // recordResult has already moved the workflow forward.
      await Promise.all([...pendingDiscordNotifications]);
      sendResponse?.({ accepted: !!accepted });
    }).catch(error => sendResponse?.({ accepted:false, error:error?.message || "Failed to record product result." }));
    return true;
  }
});

async function recordResult(jobId, result) {
  const job = await readJob();
  if (!job?.running || job.id !== jobId) return false;

  job.completed = Array.isArray(job.completed) ? job.completed : [];
  job.log = Array.isArray(job.log) ? job.log : [];
  if (job.completed.some(existing => existing.index === result.index)) return true;

  job.completed.push(result);
  job.log.push(result);
  // Product webhooks are sent after the cart page reports its active account, so
  // the Account field reflects the cart session rather than a hard-coded email.
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
