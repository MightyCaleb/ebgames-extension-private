const itemsEl = document.getElementById("items");
const statusEl = document.getElementById("status");
const startButton = document.getElementById("start");
let rows = [];
let saveTimer = null;
let startInProgress = false;

const DEFAULT_CART = "https://www.ebgames.com.au/shopping-cart";
const TEST_TEMPLATE = [
  { url: "https://www.ebgames.com.au/product/toys-and-collectibles/383499-pokemon-tcg-mega-evolution-delta-reign-booster", qty: 36 },
  { url: "https://www.ebgames.com.au/product/ps5/287986-playstation-5-dualsense-wireless-controller-gray-camouflage", qty: 1 },
  { url: "https://www.ebgames.com.au/product/ps5/330056-grand-theft-auto-vi", qty: 5 }
];

function newRow(url = "", qty = 1, id = crypto.randomUUID()) {
  return { id, url, qty };
}
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveRows, 180);
}
async function saveRows() {
  rows = [...itemsEl.querySelectorAll(".item")].map(element => ({
    id: element.dataset.id,
    url: element.querySelector(".url").value.trim(),
    qty: Number(element.querySelector(".qty").value) || 1
  }));
  await chrome.storage.local.set({ ebmoRows: rows });
}
function renderRows() {
  itemsEl.replaceChildren();
  rows.forEach((row, index) => {
    const card = document.createElement("div");
    card.className = "item";
    card.dataset.id = row.id;
    card.innerHTML = `<div><strong>Product ${index + 1}</strong></div><textarea class="url" placeholder="Paste EB Games product URL here"></textarea><div class="row"><label>Quantity <input class="qty" type="number" min="1" step="1" value="${row.qty}"></label><button class="remove">Remove</button></div>`;
    card.querySelector(".url").value = row.url;
    card.querySelector(".url").addEventListener("input", scheduleSave);
    card.querySelector(".qty").addEventListener("input", scheduleSave);
    card.querySelector(".remove").addEventListener("click", async () => {
      rows = rows.filter(item => item.id !== row.id);
      renderRows();
      await saveRows();
    });
    itemsEl.appendChild(card);
  });
}
async function updateStartAvailability() {
  const stored = await chrome.storage.local.get("ebmoJob");
  const running = !!stored.ebmoJob?.running;
  startButton.disabled = startInProgress || running;
  startButton.textContent = startInProgress ? "Preparing run…" : (running ? "Run in progress…" : "Start adding to cart");
}
async function loadPopup() {
  const stored = await chrome.storage.local.get(["ebmoRows", "ebmoStatus"]);
  rows = Array.isArray(stored.ebmoRows) ? stored.ebmoRows : [];
  if (!rows.length) rows = [newRow()];
  renderRows();
  if (stored.ebmoStatus) statusEl.textContent = stored.ebmoStatus;
  await updateStartAvailability();
}

 document.getElementById("template").addEventListener("click", async () => {
  if (!confirm("Load the 3-product test template? This replaces the current product list with Pokémon ×36, DualSense controller ×1, and GTA VI ×5.")) return;
  rows = TEST_TEMPLATE.map(item => newRow(item.url, item.qty));
  renderRows();
  await saveRows();
  statusEl.textContent = "3-product test template loaded and saved. Quantities: Pokémon 36, DualSense controller 1, GTA VI 5.";
});

document.getElementById("add").addEventListener("click", async () => {
  await saveRows();
  rows.push(newRow());
  renderRows();
  await saveRows();
});
document.getElementById("clear").addEventListener("click", async () => {
  if (!confirm("Clear all saved product links and quantities?")) return;
  rows = [newRow()];
  renderRows();
  await saveRows();
  statusEl.textContent = "List cleared.";
});
document.getElementById("cart").addEventListener("click", () => chrome.tabs.create({ url: DEFAULT_CART }));
document.getElementById("retry").addEventListener("click", async () => {
  const tabs = await chrome.tabs.query({ url: ["https://www.ebgames.com.au/shopping-cart*", "https://www.ebgames.com.au/cart*"] });
  if (!tabs.length) {
    statusEl.textContent = "Open the EB Games shopping cart first, then click Retry cart quantities.";
    return;
  }
  const tab = tabs.find(candidate => candidate.active) || tabs[0];
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "EBMO_RUN_CART_QUANTITIES" });
    statusEl.textContent = "Retrying quantity updates once in the open cart…";
  } catch {
    statusEl.textContent = "Could not contact the cart script. Reload the cart tab once, wait for it to finish loading, then retry.";
  }
});

startButton.addEventListener("click", async () => {
  if (startInProgress) return;
  startInProgress = true;
  await updateStartAvailability();
  try {
    await saveRows();
    const products = rows.filter(item => item.url);
    if (!products.length) {
      statusEl.textContent = "Paste at least one product URL.";
      return;
    }
    for (const item of products) {
      let url;
      try { url = new URL(item.url); }
      catch { statusEl.textContent = "One URL is invalid."; return; }
      if (url.hostname !== "www.ebgames.com.au" || !url.pathname.startsWith("/product/")) {
        statusEl.textContent = "Use EB Games Australia product links with /product/ in the URL.";
        return;
      }
      if (!Number.isSafeInteger(item.qty) || item.qty < 1) {
        statusEl.textContent = "Each quantity must be a positive whole number.";
        return;
      }
    }

    // Recheck persistent state at the last responsible moment to prevent overlapping jobs.
    const existing = (await chrome.storage.local.get("ebmoJob")).ebmoJob;
    if (existing?.running) {
      statusEl.textContent = "A product-tab run is already in progress. Wait for it to finish before starting another.";
      return;
    }

    const job = {
      id: crypto.randomUUID(),
      items: products.map(item => ({ url: item.url, qty: item.qty })),
      index: 0,
      running: true,
      parallel: true,
      tabIds: [],
      completed: [],
      log: [],
      startedAt: Date.now()
    };
    await chrome.storage.local.set({
      ebmoJob: job,
      ebmoAddSummary: "",
      ebmoCartRunState: null,
      ebmoCartAutoRunJobId: null,
      ebmoStatus: "Preparing parallel product tabs…"
    });

    const createdTabs = await Promise.all(job.items.map((_, index) => chrome.tabs.create({ url: "about:blank", active: index === 0 })));
    job.tabIds = createdTabs.map(tab => tab.id);
    await chrome.storage.local.set({ ebmoJob: job, ebmoStatus: `Opening ${job.items.length} product tabs in parallel…` });
    job.navigationInitiatedAt = Date.now();
    await chrome.storage.local.set({ ebmoJob: job });
    await Promise.all(createdTabs.map((tab, index) => chrome.tabs.update(tab.id, { url: job.items[index].url })));
    statusEl.textContent = `Opened ${job.items.length} product tabs in parallel. Timing will be shown after the add attempts finish.`;
  } catch (error) {
    const stored = (await chrome.storage.local.get("ebmoJob")).ebmoJob;
    if (stored) {
      stored.running = false;
      await chrome.storage.local.set({ ebmoJob: stored });
    }
    statusEl.textContent = `Could not open all tabs: ${error?.message || error}`;
  } finally {
    startInProgress = false;
    await updateStartAvailability();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.ebmoStatus) statusEl.textContent = changes.ebmoStatus.newValue || "";
  if (changes.ebmoJob) updateStartAvailability();
});

loadPopup();
