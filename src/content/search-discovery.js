(function bootstrapSearchDiscovery() {
  if (window.__engageAiFlowSearchDiscoveryLoaded) {
    return;
  }
  window.__engageAiFlowSearchDiscoveryLoaded = true;

  function dispatchInputLikeHuman(field, value) {
    const prototype = Object.getPrototypeOf(field);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    if (descriptor?.set) {
      descriptor.set.call(field, value);
    } else {
      field.value = value;
    }
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function getGoogleSearchField() {
    return document.querySelector('textarea[name="q"], input[name="q"], textarea[title="Search"], input[title="Search"]');
  }

  async function typeIntoGoogleSearch(payload) {
    const searchText = String(payload?.searchText || "").trim();
    const searchUrl = String(payload?.searchUrl || "").trim();
    if (!searchText) {
      throw new Error("No Google search text was provided.");
    }

    const field = getGoogleSearchField();
    if (!field) {
      throw new Error("Could not find the Google search field.");
    }

    field.focus();
    dispatchInputLikeHuman(field, "");

    const minDelay = Number(payload?.typingDelayRangeMs?.min) || 45;
    const maxDelay = Number(payload?.typingDelayRangeMs?.max) || 95;
    for (const character of searchText) {
      dispatchInputLikeHuman(field, `${field.value}${character}`);
      await new Promise((resolve) => {
        setTimeout(resolve, Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay);
      });
    }

    field.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true
    }));
    field.dispatchEvent(new KeyboardEvent("keyup", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true
    }));

    const form = field.closest("form");
    setTimeout(() => {
      if (form?.requestSubmit) {
        form.requestSubmit();
        return;
      }
      if (searchUrl) {
        window.location.href = searchUrl;
      }
    }, 140);
  }

  function isVisibleNode(node) {
    if (!(node instanceof Element)) {
      return false;
    }

    const style = window.getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.visibility !== "hidden"
      && style.display !== "none"
      && rect.width > 0
      && rect.height > 0;
  }

  function getVisiblePrimaryGoogleResultAnchors() {
    const candidates = [
      ...document.querySelectorAll('#search a[href] h3'),
      ...document.querySelectorAll('#search a[href] [role="heading"]')
    ];
    const anchors = [];
    const seen = new Set();

    for (const heading of candidates) {
      const anchor = heading.closest("a[href]");
      if (!anchor || seen.has(anchor)) {
        continue;
      }
      if (!isVisibleNode(anchor) || !isVisibleNode(heading)) {
        continue;
      }
      seen.add(anchor);
      anchors.push(anchor);
    }

    return anchors;
  }

  function discoverPostUrls(payload) {
    const limit = Number(payload?.limit) || 20;
    const urls = new Set();
    const onGoogleResultsPage = /(^|\.)google\.com$/i.test(window.location.hostname);

    function normalizeSearchResultUrl(rawHref) {
      const absoluteUrl = new URL(rawHref, window.location.href);
      if (onGoogleResultsPage && absoluteUrl.pathname === "/url") {
        const targetUrl = absoluteUrl.searchParams.get("q") || absoluteUrl.searchParams.get("url");
        if (targetUrl) {
          return targetUrl;
        }
      }
      return absoluteUrl.toString();
    }

    for (const node of getVisiblePrimaryGoogleResultAnchors()) {
      const href = node.href || node.getAttribute("href");
      if (!href) {
        continue;
      }
      const absoluteUrl = normalizeSearchResultUrl(href);
      if (!onGoogleResultsPage) {
        continue;
      }
      const parsed = new URL(absoluteUrl);
      if (parsed.protocol.startsWith("http") && !/(^|\.)google\.com$/i.test(parsed.hostname)) {
        urls.add(absoluteUrl);
      }
      if (urls.size >= limit) {
        return [...urls];
      }
    }

    for (const node of document.querySelectorAll('#search a[href]')) {
      if (!isVisibleNode(node)) {
        continue;
      }
      const href = node.href || node.getAttribute("href");
      if (!href) {
        continue;
      }
      const absoluteUrl = normalizeSearchResultUrl(href);
      if (!onGoogleResultsPage) {
        continue;
      }
      const parsed = new URL(absoluteUrl);
      if (parsed.protocol.startsWith("http") && !/(^|\.)google\.com$/i.test(parsed.hostname)) {
        urls.add(absoluteUrl);
      }
      if (urls.size >= limit) {
        return [...urls];
      }
    }

    return [...urls];
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "RUN_GOOGLE_SEARCH_INTERNAL") {
      void typeIntoGoogleSearch(message.payload)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message?.type !== "DISCOVER_POSTS_INTERNAL") {
      return undefined;
    }

    try {
      const urls = discoverPostUrls(message.payload);
      sendResponse({
        ok: true,
        pageUrl: window.location.href,
        urls
      });
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
    return true;
  });
})();
