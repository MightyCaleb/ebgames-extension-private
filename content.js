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
      try {
        const canonical = u => { try { const x = new URL(u); return x.origin + x.pathname.replace(/\/+$/,''); } catch { return u; } };
        if (canonical(location.href) !== canonical(item.url)) throw new Error("Tab URL did not match assigned product");

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
        const timings = {
          navigationToCompleteMs: Number.isFinite(navigationToCompleteMs) ? navigationToCompleteMs : null,
          buttonWaitMs,
          clickToSignalMs: confirmed ? Math.round(finishedAt - clickAt) : null,
          tabTaskMs: Math.round(finishedAt - taskStarted)
        };
        result = {
          ok: !!confirmed, index, qty:item.qty, url:item.url, confirmed:!!confirmed,
          closeTabOnSuccess:!!confirmed, timings,
          message: confirmed ? "Add signal detected" : "Clicked once; no confirmation detected, verify cart"
        };
      } catch (e) {
        result = {ok:false,index,qty:item.qty,url:item.url,confirmed:false,closeTabOnSuccess:false,
          timings:{tabTaskMs:Math.round(performance.now()-taskStarted)},message:e?.message||"Unknown error"};
      }
      try { chrome.runtime.sendMessage({type:"EBMO_PRODUCT_DONE",jobId,result}); } catch {}
      sendResponse?.({accepted:true});
    })();
    return true;
  });
})();
