export async function pageToolExecutor(request = {}) {
  function readText(node) {
    return node?.innerText?.trim() || node?.textContent?.trim() || "";
  }

  function isVisible(node) {
    if (!(node instanceof Element)) {
      return false;
    }
    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    return rect.width > 0
      && rect.height > 0
      && style.visibility !== "hidden"
      && style.display !== "none";
  }

  function normalize(text) {
    return String(text || "").trim().toLowerCase();
  }

  function textIncludes(source, target) {
    return normalize(source).includes(normalize(target));
  }

  function createSelector(node) {
    if (!(node instanceof Element)) {
      return "";
    }
    if (node.id) {
      return `#${CSS.escape(node.id)}`;
    }
    for (const attribute of ["data-testid", "name", "aria-label", "placeholder"]) {
      const value = node.getAttribute(attribute);
      if (value) {
        return `${node.tagName.toLowerCase()}[${attribute}="${value.replace(/"/g, '\\"')}"]`;
      }
    }
    const classes = [...node.classList].slice(0, 2);
    if (classes.length) {
      return `${node.tagName.toLowerCase()}.${classes.map((item) => CSS.escape(item)).join(".")}`;
    }
    return node.tagName.toLowerCase();
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

  function dispatchInputEvents(node, text) {
    node.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      cancelable: true,
      inputType: "insertText",
      data: text
    }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function typeIntoNode(node, text) {
    node.focus();
    if (node.isContentEditable) {
      node.textContent = text;
      dispatchInputEvents(node, text);
      return;
    }
    setNativeValue(node, text);
    dispatchInputEvents(node, text);
  }

  function resolveByLabel(locator) {
    const labelText = normalize(locator.label);
    if (!labelText) {
      return null;
    }
    const labels = [...document.querySelectorAll("label")];
    for (const label of labels) {
      if (!textIncludes(readText(label), labelText)) {
        continue;
      }
      if (label.control) {
        return label.control;
      }
      const nested = label.querySelector("input, textarea, select, [contenteditable='true']");
      if (nested) {
        return nested;
      }
    }
    return null;
  }

  function getInteractiveCandidates(role) {
    const selectorMap = {
      button: "button, [role='button'], input[type='button'], input[type='submit'], a[role='button']",
      input: "input, textarea, [contenteditable='true'], [role='textbox']",
      select: "select"
    };
    const selector = selectorMap[role] || "button, a, input, textarea, select, [contenteditable='true'], [role='button'], [role='textbox']";
    return [...document.querySelectorAll(selector)].filter(isVisible);
  }

  function resolveElement(locator = {}) {
    if (!locator || typeof locator !== "object") {
      return null;
    }

    if (locator.selector) {
      const node = document.querySelector(locator.selector);
      if (node && isVisible(node)) {
        return node;
      }
    }

    if (locator.label) {
      const node = resolveByLabel(locator);
      if (node && isVisible(node)) {
        return node;
      }
    }

    if (locator.placeholder) {
      const node = document.querySelector(`input[placeholder*="${locator.placeholder.replace(/"/g, '\\"')}"], textarea[placeholder*="${locator.placeholder.replace(/"/g, '\\"')}"]`);
      if (node && isVisible(node)) {
        return node;
      }
    }

    if (locator.text || locator.targetText) {
      const targetText = locator.text || locator.targetText;
      const candidates = getInteractiveCandidates(locator.role);
      const node = candidates.find((candidate) => {
        const candidateText = [
          readText(candidate),
          candidate.getAttribute("aria-label"),
          candidate.getAttribute("title"),
          candidate.getAttribute("value")
        ].filter(Boolean).join(" ");
        return textIncludes(candidateText, targetText);
      });
      if (node) {
        return node;
      }
    }

    if (locator.role) {
      return getInteractiveCandidates(locator.role)[0] || null;
    }

    return null;
  }

  function describeInteractiveElements(selector) {
    return [...document.querySelectorAll(selector)]
      .filter(isVisible)
      .slice(0, 10)
      .map((node) => ({
        tag: node.tagName.toLowerCase(),
        text: readText(node).slice(0, 120),
        selector: createSelector(node)
      }));
  }

  async function waitFor(locator, timeoutMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const node = resolveElement(locator);
      if (node) {
        return node;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return null;
  }

  async function run() {
    const action = request.action;
    const payload = request.payload || {};
    const timeoutMs = Number(request.timeoutMs) || 15000;

    switch (action) {
      case "inspect_page":
        return {
          ok: true,
          output: {
            url: window.location.href,
            title: document.title,
            textSample: readText(document.body).slice(0, 3000),
            buttons: describeInteractiveElements("button, [role='button'], input[type='submit'], input[type='button']"),
            inputs: describeInteractiveElements("input, textarea, select, [contenteditable='true'], [role='textbox']"),
            links: describeInteractiveElements("a[href]")
          }
        };

      case "click": {
        const node = resolveElement(payload);
        if (!node) {
          return { ok: false, error: "Could not find a clickable element for this step." };
        }
        node.scrollIntoView({ behavior: "smooth", block: "center" });
        node.click();
        return {
          ok: true,
          output: {
            selector: payload.selector || createSelector(node),
            text: readText(node)
          }
        };
      }

      case "type": {
        const node = resolveElement(payload);
        if (!node) {
          return { ok: false, error: "Could not find a text input for this step." };
        }
        const text = String(payload.value ?? payload.text ?? "").trim();
        if (!text) {
          return { ok: false, error: "No text was provided for typing." };
        }
        node.scrollIntoView({ behavior: "smooth", block: "center" });
        typeIntoNode(node, text);
        return {
          ok: true,
          output: {
            selector: payload.selector || createSelector(node),
            text
          }
        };
      }

      case "select_option": {
        const node = resolveElement({ ...payload, role: "select" });
        if (!(node instanceof HTMLSelectElement)) {
          return { ok: false, error: "Could not find a select element for this step." };
        }
        const desiredValue = String(payload.value || payload.text || "").trim();
        const option = [...node.options].find((item) => item.value === desiredValue || textIncludes(item.textContent, desiredValue));
        if (!option) {
          return { ok: false, error: `No matching option found for "${desiredValue}".` };
        }
        node.value = option.value;
        node.dispatchEvent(new Event("input", { bubbles: true }));
        node.dispatchEvent(new Event("change", { bubbles: true }));
        return {
          ok: true,
          output: {
            value: option.value,
            text: option.textContent?.trim() || ""
          }
        };
      }

      case "wait_for": {
        const node = await waitFor(payload, timeoutMs);
        if (!node) {
          return { ok: false, error: "Timed out waiting for the requested element." };
        }
        return {
          ok: true,
          output: {
            selector: payload.selector || createSelector(node),
            text: readText(node)
          }
        };
      }

      case "extract_text": {
        const node = resolveElement(payload) || (payload.selector ? document.querySelector(payload.selector) : null);
        const text = node ? readText(node) : readText(document.body).slice(0, 3000);
        if (!text) {
          return { ok: false, error: "Could not extract text for this step." };
        }
        return {
          ok: true,
          output: text
        };
      }

      case "extract_list": {
        const itemSelector = String(payload.itemSelector || payload.selector || "").trim();
        if (!itemSelector) {
          return { ok: false, error: "extract_list requires itemSelector or selector." };
        }
        const items = [...document.querySelectorAll(itemSelector)]
          .filter(isVisible)
          .slice(0, Number(payload.limit) || 20);
        const fields = Array.isArray(payload.fields) ? payload.fields : [];
        const output = items.map((item) => {
          if (!fields.length) {
            return readText(item);
          }
          return Object.fromEntries(fields.map((field) => {
            const fieldNode = field.selector ? item.querySelector(field.selector) : item;
            return [field.name, readText(fieldNode)];
          }));
        });
        return {
          ok: true,
          output
        };
      }

      case "scroll": {
        const target = String(payload.target || "").trim();
        if (target === "bottom") {
          window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
          return { ok: true, output: "bottom" };
        }
        if (target === "top") {
          window.scrollTo({ top: 0, behavior: "smooth" });
          return { ok: true, output: "top" };
        }
        const node = resolveElement(payload);
        if (node) {
          node.scrollIntoView({ behavior: "smooth", block: "center" });
          return { ok: true, output: payload.selector || createSelector(node) };
        }
        const amount = Number(payload.amount) || Math.round(window.innerHeight * 0.75);
        window.scrollBy({ top: amount, behavior: "smooth" });
        return { ok: true, output: amount };
      }

      default:
        return {
          ok: false,
          error: `Unsupported page action "${action}".`
        };
    }
  }

  try {
    return await run();
  } catch (error) {
    return {
      ok: false,
      error: error.message || "Unknown page action error."
    };
  }
}
