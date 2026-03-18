export function createChromeStub(initialStorage = {}) {
  const storageData = { ...initialStorage };
  const tabs = new Map();
  let nextTabId = 1;

  function hydrateTab(tabId, patch = {}) {
    const current = tabs.get(tabId) || {
      id: tabId,
      url: "https://example.com",
      title: "Example",
      status: "complete",
      active: true,
      windowId: 1
    };
    const next = { ...current, ...patch };
    tabs.set(tabId, next);
    return next;
  }

  const chrome = {
    runtime: {
      sendMessage: async () => undefined,
      onMessage: {
        addListener() {}
      },
      onInstalled: {
        addListener() {}
      },
      onStartup: {
        addListener() {}
      }
    },
    storage: {
      local: {
        async get(keys) {
          if (Array.isArray(keys)) {
            return Object.fromEntries(keys.map((key) => [key, storageData[key]]));
          }
          if (typeof keys === "string") {
            return { [keys]: storageData[keys] };
          }
          return { ...storageData };
        },
        async set(value) {
          Object.assign(storageData, value);
        }
      }
    },
    tabs: {
      async get(tabId) {
        return hydrateTab(tabId);
      },
      async create(createProperties) {
        const tab = hydrateTab(nextTabId, {
          id: nextTabId,
          url: createProperties.url,
          active: Boolean(createProperties.active),
          status: "complete"
        });
        nextTabId += 1;
        return tab;
      },
      async update(tabId, patch) {
        return hydrateTab(tabId, patch);
      },
      async remove(tabId) {
        tabs.delete(tabId);
      },
      async query() {
        return [...tabs.values()];
      }
    },
    scripting: {
      async executeScript({ func, args = [] }) {
        return [{ result: await func(...args) }];
      }
    },
    sidePanel: {
      async setOptions() {},
      async open() {}
    },
    permissions: {
      async contains() {
        return true;
      },
      async request() {
        return true;
      }
    }
  };

  return {
    chrome,
    storageData,
    tabs
  };
}
