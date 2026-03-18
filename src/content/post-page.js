(function bootstrapPostPage() {
  if (window.__engageAiFlowPostPageLoaded) {
    return;
  }
  window.__engageAiFlowPostPageLoaded = true;

  function readFirstText(selectors) {
    for (const selector of selectors || []) {
      const node = document.querySelector(selector);
      const text = node?.innerText?.trim() || node?.textContent?.trim();
      if (text) {
        return text;
      }
    }
    return "";
  }

  function findComposer(selectors) {
    for (const selector of selectors || []) {
      const node = document.querySelector(selector);
      if (node) {
        return node;
      }
    }
    return null;
  }

  function highlightNode(node) {
    if (!node) {
      return;
    }
    node.scrollIntoView({ behavior: "smooth", block: "center" });
    node.style.outline = "3px solid rgba(255, 166, 0, 0.9)";
    node.style.outlineOffset = "4px";
    setTimeout(() => {
      node.style.outline = "";
      node.style.outlineOffset = "";
    }, 4000);
  }

  function extractPostContent(adapter) {
    const composer = findComposer(adapter.composerSelectors);
    highlightNode(composer);

    return {
      text: readFirstText(adapter.postTextSelectors),
      author: readFirstText(adapter.authorSelectors),
      metadata: readFirstText(adapter.metadataSelectors),
      url: window.location.href
    };
  }

  function dispatchTextInputEvents(node, text) {
    const inputEvent = new InputEvent("input", {
      bubbles: true,
      cancelable: true,
      inputType: "insertText",
      data: text
    });
    node.dispatchEvent(inputEvent);
    node.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setNativeValue(element, value) {
    const prototype = Object.getPrototypeOf(element);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    if (descriptor?.set) {
      descriptor.set.call(element, value);
      return;
    }
    element.value = value;
  }

  function insertIntoTextField(node, text) {
    node.focus();
    setNativeValue(node, text);
    dispatchTextInputEvents(node, text);
  }

  function insertIntoContentEditable(node, text) {
    node.focus();
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(node);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }

    const inserted = document.execCommand("insertText", false, text);
    if (!inserted) {
      node.textContent = text;
    }
    dispatchTextInputEvents(node, text);
  }

  async function simulateTyping(node, text, delayRangeMs) {
    const min = Number(delayRangeMs?.min) || 50;
    const max = Number(delayRangeMs?.max) || 120;
    if (node.isContentEditable) {
      node.textContent = "";
    } else if ("value" in node) {
      setNativeValue(node, "");
      dispatchTextInputEvents(node, "");
    }

    for (const character of text) {
      if (node.isContentEditable) {
        node.textContent += character;
      } else {
        setNativeValue(node, `${node.value}${character}`);
      }
      dispatchTextInputEvents(node, character);
      await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min));
    }
  }

  async function insertComment(payload) {
    const adapter = payload?.adapter || {};
    const composer = findComposer(adapter.composerSelectors);
    if (!composer) {
      throw new Error("Could not find the comment composer on this page.");
    }

    highlightNode(composer);
    const text = String(payload?.text || "").trim();
    if (!text) {
      throw new Error("No comment text was provided.");
    }

    if (payload?.mode === "typing") {
      await simulateTyping(composer, text, payload?.typingDelayRangeMs);
      return;
    }

    if (composer.isContentEditable) {
      insertIntoContentEditable(composer, text);
      return;
    }

    if ("value" in composer) {
      insertIntoTextField(composer, text);
      return;
    }

    throw new Error("Unsupported composer type for insertion.");
  }

  function checkConfirmation(adapter) {
    const textPatterns = Array.isArray(adapter.confirmationTextPatterns)
      ? adapter.confirmationTextPatterns
      : [];
    const ariaLiveNodes = document.querySelectorAll('[aria-live], [role="alert"], [data-test-live-announcer]');
    const combinedText = [
      ...Array.from(ariaLiveNodes).map((node) => node.innerText || node.textContent || ""),
      document.body?.innerText?.slice(0, 5000) || ""
    ].join(" ");
    return textPatterns.some((pattern) => combinedText.includes(pattern));
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const payload = message?.payload || {};
    const adapter = payload.adapter || {};

    if (message?.type === "EXTRACT_POST_CONTENT_INTERNAL") {
      try {
        const content = extractPostContent(adapter);
        sendResponse({ ok: true, content });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
      return true;
    }

    if (message?.type === "INSERT_COMMENT_TEXT_INTERNAL") {
      void insertComment(payload)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message?.type === "CHECK_POST_CONFIRMATION_INTERNAL") {
      try {
        sendResponse({ ok: true, confirmed: checkConfirmation(adapter) });
      } catch (error) {
        sendResponse({ ok: false, error: error.message, confirmed: false });
      }
      return true;
    }

    if (message?.type === "ENSURE_COMMENT_CONTEXT_INTERNAL") {
      try {
        const composer = findComposer(adapter.composerSelectors);
        if (composer) {
          highlightNode(composer);
        }
        sendResponse({ ok: Boolean(composer) });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
      return true;
    }

    return undefined;
  });
})();
