(() => {
  if (location.hostname !== "www.ebgames.com.au") return;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const norm = s => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
  const STATE_KEY = "ebmoCartRunState";
  const documentStartedAt = Date.now();
  let pageControlsReadyAt = null;
  let running = false;

  const log = async text => { try { await chrome.storage.local.set({ebmoStatus:text}); } catch {} };
  async function getState() { return (await chrome.storage.local.get(STATE_KEY))[STATE_KEY] || null; }
  async function putState(state) { await chrome.storage.local.set({[STATE_KEY]:state}); }

  function extractVisibleAccountEmail() {
    const text = document.body?.innerText || "";
    const emails = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
    return emails.length ? emails[0].trim() : null;
  }

  function profileToggleCandidates() {
    const clickables = [...document.querySelectorAll('button,a,[role="button"],[aria-haspopup]')].filter(visible);
    return clickables.filter(el => {
      const text = `${el.innerText || ""} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""}`.replace(/\s+/g, " ").trim();
      if (!text || /log ?out|sign ?out|checkout|cart/i.test(text)) return false;
      return /\blevel\s*(?:i{1,3}|iv|v|[0-9]+)\b/i.test(text) || /\b(my account|account profile|member profile|profile menu)\b/i.test(text);
    });
  }

  async function detectCartAccountEmail() {
    const direct = extractVisibleAccountEmail();
    if (direct) return direct;

    // The EB Games profile email is shown in its account panel. Open only the
    // profile/member toggle (never logout or checkout), read the visible email,
    // then dismiss the panel before modifying quantities.
    const toggle = profileToggleCandidates()[0];
    if (toggle) {
      try {
        toggle.click();
        await sleep(350);
        const email = extractVisibleAccountEmail();
        const closers = [...document.querySelectorAll('[role="dialog"] button,[aria-modal="true"] button,button[aria-label*="close" i],button[title*="close" i]')]
          .filter(visible)
          .filter(el => /close|dismiss|×|✕/i.test(`${el.innerText || ""} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""}`));
        if (closers.length) closers[0].click();
        else document.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape", bubbles:true}));
        return email || null;
      } catch {
        try { document.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape", bubbles:true})); } catch {}
      }
    }
    return extractVisibleAccountEmail();
  }

  function titleFromUrl(url) {
    try {
      const parts = new URL(url).pathname.split("/").filter(Boolean);
      let slug = parts[parts.length - 1] || "";
      slug = slug.replace(/^\d+-/, "").replace(/-\d+$/, "");
      return norm(decodeURIComponent(slug.replace(/-/g, " ")));
    } catch { return "product"; }
  }
  function titleTokens(title) {
    const stop = new Set(["the", "and", "for", "with", "edition", "standard", "deluxe"]);
    return title.split(" ").filter(t => t.length > 1 && !stop.has(t));
  }
  function visible(el) {
    if (!el) return false;
    const s = getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden" && el.getClientRects().length > 0;
  }
  function canonicalPath(url) {
    try { return new URL(url, location.href).pathname.replace(/\/+$/, "").toLowerCase(); }
    catch { return ""; }
  }
  function numericOptionValue(option) {
    const text = String(option.textContent || "").trim();
    const exact = text.match(/^(?:(?:qty|quantity)\s*:?\s*)?(\d+)(?:\s*(?:items?|units?))?$/i);
    if (exact) return Number(exact[1]);
    const val = String(option.value || "").trim();
    if (/^\d+$/.test(val) && Number(val) > 0) return Number(val);
    const match = text.match(/(?:^|\D)(\d+)(?:\D|$)/);
    return match ? Number(match[1]) : NaN;
  }
  function quantitySelects() {
    return [...document.querySelectorAll("select")].filter(visible).filter(sel => {
      const vals = [...sel.options].map(numericOptionValue).filter(n => Number.isFinite(n) && n >= 1);
      const label = norm(sel.getAttribute("aria-label") || sel.name || sel.id || "");
      return vals.length >= 2 || (vals.length >= 1 && /qty|quantity/.test(label));
    });
  }
  function selectForItem(item, excluded = new Set()) {
    const wantedPath = canonicalPath(item.url);
    const tokens = titleTokens(titleFromUrl(item.url));
    const selects = quantitySelects().filter(sel => !excluded.has(sel));
    const anchors = [...document.querySelectorAll("a[href]")].filter(a => visible(a) && canonicalPath(a.href) === wantedPath);
    let best = null;
    for (const anchor of anchors) {
      let node = anchor;
      for (let depth = 0; depth < 14 && node && node !== document.body; depth++, node = node.parentElement) {
        const contained = selects.filter(sel => node.contains(sel));
        if (contained.length === 1) {
          const text = norm(node.innerText || node.textContent);
          const candidate = {sel:contained[0], score:10000 - Math.min(text.length, 9999), method:"product-link"};
          if (!best || candidate.score > best.score) best = candidate;
          break;
        }
        if (contained.length > 1) break;
      }
    }
    if (best) return best;

    // Fallback: choose the smallest ancestor containing a strong title match and one control.
    for (const sel of selects) {
      let node = sel;
      for (let depth = 0; depth < 14 && node && node !== document.body; depth++, node = node.parentElement) {
        const text = norm(node.innerText || node.textContent);
        if (!text || text.length > 1600) continue;
        const hits = tokens.filter(t => text.includes(t)).length;
        const contained = selects.filter(other => node.contains(other));
        if (hits >= Math.min(2, tokens.length) && contained.length === 1) {
          const candidate = {sel, score:hits * 1000 - text.length, method:"title-match"};
          if (!best || candidate.score > best.score) best = candidate;
          break;
        }
      }
    }
    return best;
  }
  function readSelected(sel) {
    const opt = sel?.selectedOptions?.[0];
    return opt ? numericOptionValue(opt) : NaN;
  }
  function optionSummary(sel) {
    return [...sel.options].map(o => `${(o.textContent || "").trim()} [value=${o.value}]`).join(", ");
  }
  function applyOptionOnce(sel, option) {
    try { sel.focus(); } catch {}
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    if (setter) setter.call(sel, option.value); else sel.value = option.value;
    sel.dispatchEvent(new Event("input", {bubbles:true}));
    sel.dispatchEvent(new Event("change", {bubbles:true}));
  }
  async function waitForControls() {
    let controls = quantitySelects();
    if (controls.length) return controls;
    return new Promise(resolve => {
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        observer?.disconnect();
        clearInterval(pollId);
        clearTimeout(timeoutId);
        resolve(value);
      };
      const check = () => {
        const found = quantitySelects();
        if (found.length) finish(found);
      };
      const observer = document.documentElement ? new MutationObserver(check) : null;
      observer?.observe(document.documentElement, {subtree:true,childList:true,attributes:true,attributeFilter:['class','style','disabled','aria-label']});
      const pollId = setInterval(check, 180);
      const timeoutId = setTimeout(() => finish([]), 10000);
      check();
    });
  }
  function desiredFor(item, sel) {
    const options = [...sel.options].map(option => ({option, value:numericOptionValue(option), label:(option.textContent || "").trim(), rawValue:option.value}))
      .filter(x => Number.isFinite(x.value) && x.value >= 1);
    if (!options.length) return {error:"matched a select but found no numeric quantity options", optionList:optionSummary(sel)};
    const desired = Number(item.qty);
    const eligible = options.filter(x => x.value <= desired).sort((a,b) => b.value-a.value);
    const chosen = eligible[0] || options.slice().sort((a,b) => a.value-b.value)[0];
    return {options, desired, expected:chosen.value, option:chosen.option, capped:chosen.value < desired, optionList:optionSummary(sel)};
  }
  async function saveResult(state, line) {
    state.results.push(line);
    state.pending = null;
    await putState(state);
  }
  async function verifyPending(state) {
    if (!state.pending) return;
    const pending = state.pending;
    const item = state.items[pending.index];
    const verifyStartedAt = Date.now();
    const changeToDocumentMs = Number.isFinite(pending.dispatchedAt) ? Math.max(0, documentStartedAt - pending.dispatchedAt) : null;
    const changeToControlsMs = Number.isFinite(pending.dispatchedAt) && Number.isFinite(pageControlsReadyAt) ? Math.max(0, pageControlsReadyAt - pending.dispatchedAt) : null;
    const deadline = Date.now() + 3200;
    let actual = NaN, match = null;
    while (Date.now() < deadline) {
      match = selectForItem(item, new Set());
      actual = match?.sel ? readSelected(match.sel) : NaN;
      if (actual === pending.expected) break;
      await sleep(250);
    }
    const title = pending.target;
    if (actual === pending.expected) {
      const status = pending.capped
        ? `${title}: requested ${pending.desired}; set to available maximum ${actual}`
        : `${title}: quantity set to ${actual}`;
      const reloadTiming = Number.isFinite(changeToDocumentMs)
        ? `change→new document=${(changeToDocumentMs/1000).toFixed(2)}s; change→controls=${Number.isFinite(changeToControlsMs) ? (changeToControlsMs/1000).toFixed(2)+'s' : 'n/a'}; verify=${Date.now()-verifyStartedAt}ms`
        : `verification=${Date.now()-verifyStartedAt}ms`;
      await saveResult(state, `${status} — matched by ${match?.method || pending.method}; ${reloadTiming}; match=${Number.isFinite(pending.matchMs) ? pending.matchMs+'ms' : 'n/a'}; previous=${pending.before}; options=${pending.optionList}`);
    } else {
      const reloadTiming = Number.isFinite(changeToDocumentMs)
        ? `change→new document=${(changeToDocumentMs/1000).toFixed(2)}s; change→controls=${Number.isFinite(changeToControlsMs) ? (changeToControlsMs/1000).toFixed(2)+'s' : 'n/a'}; verify=${Date.now()-verifyStartedAt}ms`
        : `verification=${Date.now()-verifyStartedAt}ms`;
      await saveResult(state, `${title}: FAILED — attempted ${pending.expected}, observed ${Number.isFinite(actual) ? actual : "no selected value"} after update/reload; matched by ${match?.method || pending.method}; ${reloadTiming}; options=${pending.optionList}. Check site quantity limits or update behavior.`);
    }
    await log(`Cart quantity progress ${state.nextIndex}/${state.items.length}\n${state.results.join("\n")}`);
  }
  async function begin() {
    if (running) return;
    running = true;
    try {
      const stored = await chrome.storage.local.get(["ebmoJob", "ebmoCartAutoRunJobId", STATE_KEY]);
      const job = stored.ebmoJob && Array.isArray(stored.ebmoJob.items) && stored.ebmoJob.items.length ? stored.ebmoJob : null;
      const active = stored[STATE_KEY];
      let state = active;

      if (!job) {
        await log("Cart updater: no active product run found. Start a product run first.");
        return;
      }
      if (state && !state.done && state.jobId === job.id) {
        // Resume the interrupted sequential quantity flow after a cart refresh.
      } else if (state && state.done && state.jobId === job.id) {
        if (stored.ebmoCartAutoRunJobId === job.id) return;
        state = null;
      }
      if (!state || state.jobId !== job.id || state.done) {
        if (stored.ebmoCartAutoRunJobId === job.id) {
          await log("Cart quantity routine already ran for this product job. Start a new product run to run it again.");
          return;
        }
        state = {runId:job.id, jobId:job.id, items:job.items.map(x => ({url:x.url, qty:Number(x.qty)})), nextIndex:0, results:[], pending:null, done:false, createdAt:Date.now(), metrics:{pageVisits:0,totalControlsWaitMs:0,totalMatchMs:0,quantityChanges:0}};
        await chrome.storage.local.set({ebmoCartAutoRunJobId:job.id});
        await putState(state);
      }

      state.metrics = state.metrics || {pageVisits:0,totalControlsWaitMs:0,totalMatchMs:0,quantityChanges:0};
      if (!state.accountCapturedAt) {
        const accountEmail = await detectCartAccountEmail();
        state.accountEmail = accountEmail;
        state.accountCapturedAt = Date.now();
        await putState(state);
        // Queue the webhook notification without delaying cart quantity updates.
        // Account detection is local; Discord delivery is handled by the service worker.
        try {
          chrome.runtime.sendMessage({
            type:"EBMO_CART_ACCOUNT_READY",
            jobId:state.jobId,
            accountEmail:accountEmail || ""
          }).catch(() => {});
        } catch {}
        await log(accountEmail ? `Active EB Games cart account detected: ${accountEmail}. Preparing quantities…` : "Could not read the active account email from the EB Games cart profile panel. Discord will flag the account for manual verification.");
      }
      state.metrics.pageVisits = (state.metrics.pageVisits || 0) + 1;
      state.metrics.lastDocumentStartedAt = documentStartedAt;
      await putState(state);
      await log(`Cart updater active. Waiting for quantity controls… (${state.nextIndex}/${state.items.length} completed; cart page visit ${state.metrics.pageVisits})`);
      const controlsWaitStartedAt = Date.now();
      const controls = await waitForControls();
      pageControlsReadyAt = Date.now();
      state = (await getState()) || state;
      state.metrics = state.metrics || {pageVisits:1,totalControlsWaitMs:0,totalMatchMs:0,quantityChanges:0};
      state.metrics.totalControlsWaitMs = (state.metrics.totalControlsWaitMs || 0) + (pageControlsReadyAt - controlsWaitStartedAt);
      await putState(state);
      if (!controls.length) {
        const message = `Cart updater: no quantity dropdowns found. Found ${document.querySelectorAll("select").length} select elements on ${location.pathname}.`;
        await log(message);
        try { chrome.runtime.sendMessage({ type:"EBMO_CART_FINISHED", payload:{ failed:true, productCount:state.items.length, pageVisits:state.metrics.pageVisits || 1, quantityChanges:state.metrics.quantityChanges || 0, results:[message] } }).catch(() => {}); } catch {}
        return;
      }

      // If an update triggered a navigation, verify the item that was already attempted.
      if (state.pending) await verifyPending(state);

      const excluded = new Set();
      while (state.nextIndex < state.items.length) {
        const index = state.nextIndex;
        const item = state.items[index];
        const title = titleFromUrl(item.url);
        const matchStartedAt = Date.now();
        const match = selectForItem(item, excluded);
        const matchMs = Date.now() - matchStartedAt;
        state.metrics.totalMatchMs = (state.metrics.totalMatchMs || 0) + matchMs;
        await log(`Cart quantity update ${index+1}/${state.items.length}: matching ${title}… (${quantitySelects().length} quantity controls; match=${matchMs}ms)`);
        if (!match?.sel) {
          state.results.push(`${title}: FAILED — no matching quantity dropdown; match=${matchMs}ms. Product row may not expose a native select.`);
          state.nextIndex++;
          await putState(state);
          continue;
        }
        const sel = match.sel;
        const choice = desiredFor(item, sel);
        if (choice.error) {
          state.results.push(`${title}: FAILED — ${choice.error}; method=${match.method}; match=${matchMs}ms; options=${choice.optionList}`);
          state.nextIndex++;
          await putState(state);
          continue;
        }
        const before = readSelected(sel);
        excluded.add(sel);
        if (before === choice.expected) {
          // Crucial: do not fire a change event for a row already at its target.
          state.results.push(`${title}: already at ${before}; no event fired — matched by ${match.method}; match=${matchMs}ms; available options=${choice.optionList}`);
          state.nextIndex++;
          await putState(state);
          await log(`Cart quantity progress ${state.nextIndex}/${state.items.length}\n${state.results.join("\n")}`);
          continue;
        }

        // Persist the pending item and advance the cursor BEFORE dispatch. If EB Games reloads
        // the cart in response to the quantity change, the next document resumes at the next row.
        state.pending = {
          index, target:title, expected:choice.expected, desired:choice.desired, before,
          capped:choice.capped, method:match.method, optionList:choice.optionList, matchMs, dispatchedAt:Date.now()
        };
        state.metrics.quantityChanges = (state.metrics.quantityChanges || 0) + 1;
        state.nextIndex = index + 1;
        await putState(state);
        await log(`Updating ${title}: ${Number.isFinite(before) ? before : "unknown"} → ${choice.expected}. If the cart reloads, the updater will resume with the next product.`);
        applyOptionOnce(sel, choice.option);
        // EB Games may reload the entire cart after a quantity change. Let its update
        // request settle; if this document is still alive, force one reload so the next
        // item is handled only on the refreshed cart. The pending result and cursor were
        // saved before dispatch, so the new document verifies this item and continues.
        await sleep(2800);
        const latestState = await getState();
        if (latestState?.pending?.index === index && latestState.runId === state.runId) {
          latestState.pending.reloadRequested = true;
          await putState(latestState);
          await log(`Waiting for cart refresh after updating ${title}; next product will run after the page reloads.`);
          location.reload();
          return;
        }
        // In case another execution already resolved the pending state, continue using
        // the latest persisted state rather than dispatching another quantity event.
        state = (await getState()) || state;
        await sleep(150);
      }

      state.done = true;
      state.finishedAt = Date.now();
      await putState(state);
      const addInfo = (await chrome.storage.local.get("ebmoAddSummary")).ebmoAddSummary || "Product-tab timing summary unavailable for this run.";
      const cartElapsedMs = Math.max(0, (state.finishedAt || Date.now()) - (state.createdAt || state.finishedAt || Date.now()));
      const metrics = state.metrics || {};
      const cartTiming = `Cart timing: ${(cartElapsedMs/1000).toFixed(1)}s total; ${metrics.pageVisits || 1} cart page visit(s); controls wait ${metrics.totalControlsWaitMs || 0}ms; product matching ${metrics.totalMatchMs || 0}ms; ${metrics.quantityChanges || 0} quantity change(s).`;
      await log(`${addInfo}\n${cartTiming}\n\nCart quantity check finished.\n${state.results.join("\n")}\nVerify the visible quantities and totals manually. No checkout was performed.`);
      try {
        chrome.runtime.sendMessage({
          type: "EBMO_CART_FINISHED",
          payload: {
            jobId: state.jobId,
            productCount: state.items.length,
            pageVisits: metrics.pageVisits || 1,
            quantityChanges: metrics.quantityChanges || 0,
            durationMs: cartElapsedMs,
            results: state.results,
            failed: state.results.some(line => /FAILED|couldn.t confidently|could not/i.test(String(line)))
          }
        }).catch(() => {});
      } catch {}
    } catch (e) {
      const message = `Cart updater error: ${e?.message || e}`;
      await log(`Cart updater error: ${e?.stack || e}`);
      try { chrome.runtime.sendMessage({ type:"EBMO_CART_FINISHED", payload:{ failed:true, results:[message] } }).catch(() => {}); } catch {}
    } finally {
      running = false;
    }
  }

  setTimeout(() => { begin(); }, 700);
})();
