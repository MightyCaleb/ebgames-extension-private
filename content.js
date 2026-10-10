(() => {
  if (location.hostname !== "www.ebgames.com.au" || !location.pathname.startsWith("/product/")) return;

  const norm = s => (s || "").trim().toLowerCase().replace(/\s+/g, " ");
  const visible = el => {
    if (!el) return false;
    const s = getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden" && el.getClientRects().length > 0;
  };

  function actionButton() {
    return [...document.querySelectorAll("button,a,[role='button'],input[type='submit']")]
      .filter(el => visible(el) && !el.disabled && el.getAttribute("aria-disabled") !== "true")
      .find(el => /^(preorder now|add to cart|add to bag)$/i.test(norm(el.innerText || el.value || el.getAttribute("aria-label"))));
  }

  function cartCountSnapshot() {
    const candidates = [...document.querySelectorAll('a,button,[aria-label],[title]')].filter(visible);
    const el = candidates.find(node => {
      const label = `${node.getAttribute('aria-label') || ''} ${node.getAttribute('title') || ''} ${node.innerText || ''}`;
      const countText = `${node.getAttribute('aria-label') || ''} ${node.innerText || ''}`;
      return /cart/i.test(label) && /\d+/.test(countText);
    });
    return el ? norm(el.getAttribute('aria-label') || el.innerText) : '';
  }

  function productTitleTokens(url) {
    try {
      const parts = new URL(url).pathname.split('/').filter(Boolean);
      let slug = parts[parts.length - 1] || '';
      slug = slug.replace(/^\d+-/, '').replace(/-\d+$/, '').replace(/-/g, ' ');
      return norm(slug).split(' ').filter(t => t.length > 2 && !['the','and','for','with','edition','standard','deluxe'].includes(t));
    } catch { return []; }
  }

  function metaContent(selectorList) {
    for (const selector of selectorList) {
      const el = document.querySelector(selector);
      const value = el?.getAttribute("content") || el?.getAttribute("href") || "";
      if (value.trim()) return value.trim();
    }
    return "";
  }

  function safeImageUrl(raw) {
    if (!raw) return "";
    try {
      const url = new URL(String(raw).trim(), location.href);
      return url.protocol === "https:" ? url.href : "";
    } catch { return ""; }
  }

  function collectProductStructuredData() {
    const found = [];
    const visit = value => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { for (const item of value) visit(item); return; }
      const type = value["@type"];
      const types = Array.isArray(type) ? type : [type];
      if (types.some(x => String(x || "").toLowerCase() === "product") && (value.name || value.image || value.offers)) {
        found.push(value);
      }
      for (const [key, child] of Object.entries(value)) {
        if (key !== "offers" || !types.some(x => String(x || "").toLowerCase() === "product")) visit(child);
        else if (Array.isArray(child)) visit(child);
        else if (child && typeof child === "object" && !child.price && child.offers) visit(child.offers);
      }
    };
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try { visit(JSON.parse(script.textContent || "")); } catch {}
    }
    return found[0] || null;
  }

  function offerFromStructuredData(product) {
    const offers = product?.offers;
    if (Array.isArray(offers)) return offers.find(item => item && (item.price != null || item.lowPrice != null)) || offers[0] || null;
    if (offers && typeof offers === "object") return offers;
    return null;
  }

  function parsePrice(raw, numericOnly = false) {
    if (raw == null) return null;
    const text = String(raw).replace(/\u00a0/g, " ").trim();
    let match;
    if (!numericOnly) {
      match = text.match(/(?:AUD\s*)?\$\s*([0-9][0-9,]*(?:\.\d{1,2})?)/i);
      if (!match) match = text.match(/\bAUD\s*([0-9][0-9,]*(?:\.\d{1,2})?)\b/i);
    }
    if (!match && numericOnly) match = text.match(/^\s*([0-9][0-9,]*(?:\.\d{1,2})?)\s*$/);
    if (!match) return null;
    const amount = Number(match[1].replace(/,/g, ""));
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) return null;
    return { value: Math.round(amount * 100) / 100, display: `AUD $${amount.toFixed(2)}` };
  }

  function domPriceFallback() {
    const selectors = [
      '[itemprop="price"]', '[data-testid*="price" i]', '[class*="price" i]', '[id*="price" i]'
    ];
    const candidates = [];
    for (const el of document.querySelectorAll(selectors.join(","))) {
      if (!visible(el) || el.closest("del,s,strike")) continue;
      const identity = `${el.className || ""} ${el.id || ""} ${el.getAttribute("data-testid") || ""}`.toLowerCase();
      if (/rrp|was-price|old-price|saving|save-amount|compare-at/.test(identity)) continue;
      const text = (el.getAttribute("content") || el.innerText || el.textContent || "").trim();
      if (!text || text.length > 100) continue;
      const price = parsePrice(text, false);
      if (price) candidates.push({ price, length: text.length, depth: (() => { let d=0; for(let n=el;n&&n!==document.body;n=n.parentElement)d++; return d; })() });
    }
    candidates.sort((a,b) => a.length-b.length || a.depth-b.depth);
    return candidates[0]?.price || null;
  }

  function extractProductInfo(productUrl) {
    const structured = collectProductStructuredData();
    const offer = offerFromStructuredData(structured);
    const h1 = [...document.querySelectorAll("h1")].find(visible)?.innerText?.trim() || "";
    const ogTitle = metaContent(['meta[property="og:title"]', 'meta[name="twitter:title"]']);
    let title = h1 || structured?.name || ogTitle || document.title || "";
    title = String(title).replace(/\s*[|–-]\s*(EB Games Australia|EB Games)\s*$/i, "").replace(/\s+/g, " ").trim().slice(0, 240);
    if (!title) title = productUrl;

    let parsedPrice = null;
    const metaPrice = metaContent([
      'meta[property="product:price:amount"]', 'meta[property="og:price:amount"]',
      'meta[property="product:price"]', 'meta[itemprop="price"]'
    ]);
    if (metaPrice) parsedPrice = parsePrice(metaPrice, true) || parsePrice(metaPrice, false);
    if (!parsedPrice && offer) parsedPrice = parsePrice(offer.price ?? offer.lowPrice ?? offer.highPrice, true);
    if (!parsedPrice) {
      const itempropEl = document.querySelector('[itemprop="price"][content]');
      if (itempropEl) parsedPrice = parsePrice(itempropEl.getAttribute("content"), true) || parsePrice(itempropEl.getAttribute("content"), false);
    }
    if (!parsedPrice) parsedPrice = domPriceFallback();

    let imageRaw = metaContent(['meta[property="og:image"]', 'meta[name="twitter:image"]', 'meta[property="twitter:image"]']);
    if (!imageRaw && structured?.image) {
      const image = Array.isArray(structured.image) ? structured.image[0] : structured.image;
      imageRaw = typeof image === "string" ? image : (image?.url || image?.contentUrl || "");
    }
    if (!imageRaw) {
      const titleTokens = norm(title).split(" ").filter(t => t.length > 3);
      const imgs = [...document.images].filter(img => visible(img));
      const ranked = imgs.map(img => {
        const raw = img.currentSrc || img.src || img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || "";
        const alt = norm(img.alt || "");
        const hits = titleTokens.filter(token => alt.includes(token)).length;
        const dimensions = (img.naturalWidth || img.width || 0) * (img.naturalHeight || img.height || 0);
        return { raw, hits, dimensions };
      }).filter(x => x.raw && x.dimensions > 10000).sort((a,b) => b.hits-a.hits || b.dimensions-a.dimensions);
      imageRaw = ranked[0]?.raw || "";
    }
    return {
      title,
      priceValue: parsedPrice?.value ?? null,
      priceDisplay: parsedPrice?.display || "Price not detected",
      currency: "AUD",
      imageUrl: safeImageUrl(imageRaw),
      productUrl: productUrl
    };
  }

  function miniCartConfirmsProduct(url) {
    const body = norm(document.body?.innerText || '');
    if (!body.includes('checkout now') || !body.includes('keep shopping') || !body.includes('total amount')) return false;
    const tokens = productTitleTokens(url);
    const hits = tokens.filter(t => body.includes(t)).length;
    return tokens.length > 0 && hits >= Math.min(2, tokens.length);
  }

  // Event-driven wait: react immediately to DOM changes, with a lightweight
  // polling fallback for sites that update text/properties without useful mutations.
  function waitForCondition(check, timeoutMs, pollMs = 150) {
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
      const test = () => {
        try { const value = check(); if (value) finish(value); } catch {}
      };
      const observer = document.documentElement ? new MutationObserver(test) : null;
      observer?.observe(document.documentElement, {subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['disabled','aria-disabled','class','style','aria-label']});
      const pollId = setInterval(test, pollMs);
      const timeoutId = setTimeout(() => finish(null), timeoutMs);
      test();
    });
  }

  let running = false;
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "EBMO_ADD_PRODUCT" || running) return;
    running = true;
    (async () => {
      const taskStarted = performance.now();
      const {item,index,jobId,navigationToCompleteMs} = message;
      let result;
      let productInfo = null;
      try {
        const canonical = u => { try { const x = new URL(u); return x.origin + x.pathname.replace(/\/+$/,''); } catch { return u; } };
        if (canonical(location.href) !== canonical(item.url)) throw new Error("Tab URL did not match assigned product");
        // Capture product metadata before clicking; the confirmation modal may change the DOM.
        productInfo = extractProductInfo(item.url);

        const before = cartCountSnapshot();
        const buttonWaitStart = performance.now();
        const button = await waitForCondition(actionButton, 8000, 120);
        const buttonWaitMs = Math.round(performance.now() - buttonWaitStart);
        if (!button) throw new Error("Couldn't find an enabled PREORDER NOW / ADD TO CART button within 8 seconds");

        const clickAt = performance.now();
        button.click(); // The site adds one unit; target quantity is handled in the cart.
        const confirmed = await waitForCondition(() => {
          const after = cartCountSnapshot();
          return miniCartConfirmsProduct(item.url) || (after && after !== before) || /added to (your )?cart|added to bag|successfully added/i.test(norm(document.body?.innerText || ''));
        }, 6500, 150);
        const finishedAt = performance.now();
        // Wall-clock timestamp when the add-to-cart confirmation signal was detected.
        // This is a local-browser event timestamp, not proof of completed checkout.
        const addToCartAt = confirmed ? new Date().toISOString() : null;
        const timings = {
          navigationToCompleteMs: Number.isFinite(navigationToCompleteMs) ? navigationToCompleteMs : null,
          buttonWaitMs,
          clickToSignalMs: confirmed ? Math.round(finishedAt - clickAt) : null,
          tabTaskMs: Math.round(finishedAt - taskStarted)
        };
        result = {
          ok: !!confirmed, index, qty:item.qty, url:item.url, confirmed:!!confirmed,
          productInfo, closeTabOnSuccess:!!confirmed, timings, addToCartAt,
          message: confirmed ? "Add signal detected" : "Clicked once; no confirmation detected, verify cart"
        };
      } catch (e) {
        result = {ok:false,index,qty:item.qty,url:item.url,confirmed:false,productInfo,closeTabOnSuccess:false,addToCartAt:null,
          timings:{tabTaskMs:Math.round(performance.now()-taskStarted)},message:e?.message||"Unknown error"};
      }
      try { chrome.runtime.sendMessage({type:"EBMO_PRODUCT_DONE",jobId,result}); } catch {}
      sendResponse?.({accepted:true});
    })();
    return true;
  });
})();
