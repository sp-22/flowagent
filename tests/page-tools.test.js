import test from "node:test";
import assert from "node:assert/strict";

import { pageToolExecutor } from "../src/content/page-tools.js";

class FakeEvent {
  constructor(type) {
    this.type = type;
  }
}

class FakeElement {
  constructor({ tagName = "div", text = "", attributes = {}, queryMap = {}, classList = [] } = {}) {
    this.tagName = tagName.toUpperCase();
    this.innerText = text;
    this.textContent = text;
    this.attributes = new Map(Object.entries(attributes));
    this.queryMap = queryMap;
    this.classList = classList;
    this.isContentEditable = false;
    this.events = [];
    this.clicked = false;
    this.focused = false;
  }

  getAttribute(name) {
    return this.attributes.get(name) || null;
  }

  dispatchEvent(event) {
    this.events.push(event.type);
    return true;
  }

  getBoundingClientRect() {
    return {
      width: 120,
      height: 24
    };
  }

  scrollIntoView() {}

  click() {
    this.clicked = true;
  }

  focus() {
    this.focused = true;
  }

  querySelector(selector) {
    const value = this.queryMap[selector];
    return Array.isArray(value) ? value[0] : (value || null);
  }

  querySelectorAll(selector) {
    const value = this.queryMap[selector];
    return Array.isArray(value) ? value : (value ? [value] : []);
  }
}

class FakeInputElement extends FakeElement {
  constructor(options = {}) {
    super(options);
    this._value = options.value || "";
  }

  get value() {
    return this._value;
  }

  set value(nextValue) {
    this._value = nextValue;
  }
}

class FakeSelectElement extends FakeInputElement {}

function installDomFixture() {
  const submitButton = new FakeElement({
    tagName: "button",
    text: "Continue",
    attributes: {
      type: "submit"
    }
  });
  const nameInput = new FakeInputElement({
    tagName: "input",
    attributes: {
      placeholder: "Name"
    }
  });
  const select = new FakeSelectElement({
    tagName: "select"
  });
  select.options = [
    { value: "basic", textContent: "Basic" },
    { value: "pro", textContent: "Pro" }
  ];
  const excerpt = new FakeElement({
    tagName: "p",
    text: "This is extracted text."
  });
  const item1 = new FakeElement({
    tagName: "li",
    queryMap: {
      ".title": new FakeElement({ tagName: "span", text: "First" }),
      ".price": new FakeElement({ tagName: "span", text: "$10" })
    }
  });
  const item2 = new FakeElement({
    tagName: "li",
    queryMap: {
      ".title": new FakeElement({ tagName: "span", text: "Second" }),
      ".price": new FakeElement({ tagName: "span", text: "$20" })
    }
  });

  const selectorMap = {
    "#submit": submitButton,
    "#name": nameInput,
    "#plan": select,
    "#excerpt": excerpt,
    ".item": [item1, item2],
    "button, [role='button'], input[type='submit'], input[type='button']": [submitButton],
    "input, textarea, select, [contenteditable='true'], [role='textbox']": [nameInput, select],
    "a[href]": [],
    "label": []
  };

  global.Element = FakeElement;
  global.HTMLSelectElement = FakeSelectElement;
  global.InputEvent = FakeEvent;
  global.Event = FakeEvent;
  global.CSS = { escape: (value) => value };
  global.document = {
    title: "Fixture",
    body: new FakeElement({ tagName: "body", text: "Fixture body text" }),
    documentElement: {
      scrollHeight: 2000
    },
    querySelector(selector) {
      const value = selectorMap[selector];
      return Array.isArray(value) ? value[0] : (value || null);
    },
    querySelectorAll(selector) {
      const value = selectorMap[selector];
      return Array.isArray(value) ? value : (value ? [value] : []);
    }
  };
  global.window = {
    location: {
      href: "https://example.com/dashboard"
    },
    getComputedStyle() {
      return {
        visibility: "visible",
        display: "block"
      };
    },
    scrollTo() {},
    scrollBy() {},
    innerHeight: 900
  };

  return {
    submitButton,
    nameInput,
    select
  };
}

test.beforeEach(() => {
  installDomFixture();
});

test("pageToolExecutor clicks and types using selector-based fixtures", async () => {
  const { submitButton, nameInput } = installDomFixture();

  const clickResult = await pageToolExecutor({
    action: "click",
    payload: {
      selector: "#submit"
    }
  });
  const typeResult = await pageToolExecutor({
    action: "type",
    payload: {
      selector: "#name",
      text: "Alice"
    }
  });

  assert.equal(clickResult.ok, true);
  assert.equal(submitButton.clicked, true);
  assert.equal(typeResult.ok, true);
  assert.equal(nameInput.value, "Alice");
});

test("pageToolExecutor selects options and extracts text and lists", async () => {
  const { select } = installDomFixture();

  const selectResult = await pageToolExecutor({
    action: "select_option",
    payload: {
      selector: "#plan",
      text: "Pro"
    }
  });
  const textResult = await pageToolExecutor({
    action: "extract_text",
    payload: {
      selector: "#excerpt"
    }
  });
  const listResult = await pageToolExecutor({
    action: "extract_list",
    payload: {
      itemSelector: ".item",
      fields: [
        { name: "title", selector: ".title" },
        { name: "price", selector: ".price" }
      ]
    }
  });

  assert.equal(selectResult.ok, true);
  assert.equal(select.value, "pro");
  assert.equal(textResult.output, "This is extracted text.");
  assert.deepEqual(listResult.output, [
    { title: "First", price: "$10" },
    { title: "Second", price: "$20" }
  ]);
});
