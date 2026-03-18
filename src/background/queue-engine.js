import {
  INTERNAL_ACTIONS,
  ITEM_STATUS,
  MAX_DISCOVERED_POSTS_PER_QUERY,
  RUN_STATUS
} from "../shared/constants.js";
import { MESSAGE_TYPES } from "../shared/messages.js";
import {
  createId,
  getLocalDateKey,
  normalizeSettings,
  pickDailyTarget,
  randomInt,
  shouldSkipWithChance,
  sleep
} from "../shared/utils.js";
import { getAdapterForUrl, getAllPlatformAdapters, getPlatformAdapter } from "../platforms/index.js";
import { getGoogleSearchText } from "../shared/google-search.js";
import {
  appendActivityLog,
  appendQueueItems,
  bumpDailyStats,
  clearActivityLog,
  getSettings,
  getSnapshot,
  getRunState,
  initializeStorage,
  replaceRunState,
  resetQueueItems,
  saveSettings,
  setRunState,
  updateQueueItem
} from "./storage.js";
import { generateCommentSuggestions } from "./llm-client.js";

const WAKE_ALARM = "flowagent-wake";

class RunSupersededError extends Error {
  constructor() {
    super("Run was superseded by a newer session.");
    this.name = "RunSupersededError";
  }
}

async function safeSendMessage(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function getTabDomReadiness(tabId) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        readyState: document.readyState,
        hasBody: Boolean(document.body),
        href: window.location.href
      })
    });
    return result?.result || null;
  } catch {
    return null;
  }
}

async function broadcastSnapshot() {
  const snapshot = await getSnapshot();
  try {
    await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.STATUS_UPDATE,
      payload: snapshot
    });
  } catch {
    // Popup or sidepanel may not be open.
  }
  return snapshot;
}

async function waitForTabComplete(tabId, timeoutMs = 20000) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") {
      return { timedOut: false, usedFallback: false };
    }

    const readiness = await getTabDomReadiness(tabId);
    if (readiness?.hasBody && ["interactive", "complete"].includes(readiness.readyState)) {
      return { timedOut: false, usedFallback: true };
    }

    await sleep(350);
  }

  const finalReadiness = await getTabDomReadiness(tabId);
  if (finalReadiness?.hasBody && ["interactive", "complete"].includes(finalReadiness.readyState)) {
    return { timedOut: true, usedFallback: true };
  }

  throw new Error(`Timed out waiting for tab ${tabId} to finish loading.`);
}

async function logTabReadinessFallback(result, message) {
  if (!result?.usedFallback) {
    return;
  }

  await appendActivityLog({
    message,
    level: result.timedOut ? "warning" : "info"
  });
}

function isGoogleSearchUrlMatch(currentUrl, expectedUrl) {
  try {
    const current = new URL(currentUrl);
    const expected = new URL(expectedUrl);
    if (!/(^|\.)google\.com$/i.test(current.hostname) || current.pathname !== "/search") {
      return false;
    }

    for (const key of ["q", "tbs", "tbm", "num"]) {
      const expectedValue = expected.searchParams.get(key);
      if (expectedValue && current.searchParams.get(key) !== expectedValue) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

async function waitForTabUrlMatch(tabId, matcher, timeoutMs = 25000) {
  const tab = await chrome.tabs.get(tabId);
  if (matcher.test(tab.url || "")) {
    return tab;
  }

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error(`Timed out waiting for tab ${tabId} URL to match ${matcher}.`));
    }, timeoutMs);

    async function onUpdated(updatedTabId, changeInfo) {
      if (updatedTabId !== tabId) {
        return;
      }

      const nextUrl = changeInfo.url || (await chrome.tabs.get(tabId)).url || "";
      if (matcher.test(nextUrl)) {
        clearTimeout(timeoutId);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve(chrome.tabs.get(tabId));
      }
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function waitForTabUrlPredicate(tabId, predicate, timeoutMs = 25000, description = "requested state") {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (predicate(tab.url || "")) {
      return tab;
    }
    await sleep(250);
  }

  throw new Error(`Timed out waiting for tab ${tabId} URL to reach ${description}.`);
}

async function readGoogleResultsSnapshot(tabId, limit = 8) {
  const response = await safeSendMessage(tabId, {
    type: INTERNAL_ACTIONS.DISCOVER_POSTS,
    payload: { limit }
  });

  if (!response?.ok) {
    return {
      pageUrl: "",
      urls: []
    };
  }

  return {
    pageUrl: response.pageUrl || "",
    urls: Array.isArray(response.urls) ? response.urls : []
  };
}

async function waitForGoogleResultsToSettle(tabId, expectedUrl, timeoutMs = 15000) {
  const startTime = Date.now();
  let previousSignature = "";
  let stableCount = 0;

  while (Date.now() - startTime < timeoutMs) {
    const snapshot = await readGoogleResultsSnapshot(tabId, 8);
    const urlMatches = isGoogleSearchUrlMatch(snapshot.pageUrl, expectedUrl);
    const signature = snapshot.urls.slice(0, 5).join("|");
    const hasEnoughResults = snapshot.urls.length > 0;

    if (urlMatches && hasEnoughResults) {
      if (signature && signature === previousSignature) {
        stableCount += 1;
      } else {
        stableCount = 1;
        previousSignature = signature;
      }

      if (stableCount >= 2) {
        return snapshot;
      }
    } else {
      stableCount = 0;
      previousSignature = signature;
    }

    await sleep(700);
  }

  return readGoogleResultsSnapshot(tabId, 8);
}

async function ensureWindowFocused(windowId) {
  if (!windowId) {
    return;
  }
  try {
    await chrome.windows.update(windowId, { focused: true });
  } catch {
    // Chrome may reject focus updates in some environments.
  }
}

async function ensureTabActive(tabId) {
  const tab = await chrome.tabs.get(tabId);
  await chrome.tabs.update(tabId, { active: true });
  await ensureWindowFocused(tab.windowId);
}

async function checkVisibleContext(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      visibilityState: document.visibilityState,
      hasFocus: document.hasFocus()
    })
  });
  return result?.result || { visibilityState: "hidden", hasFocus: false };
}

async function humanScroll(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      window.scrollBy({
        top: Math.round(window.innerHeight * 0.18),
        behavior: "smooth"
      });
    }
  });
}

async function openSidePanel(windowId) {
  if (!windowId) {
    return;
  }
  try {
    await chrome.sidePanel.setOptions({
      enabled: true,
      path: "sidepanel.html"
    });
    await chrome.sidePanel.open({ windowId });
  } catch {
    // Side panel support can vary by Chrome version.
  }
}

function getCurrentRunPreparedCount(queueItems = []) {
  return queueItems.filter((item) => [
    ITEM_STATUS.READY,
    ITEM_STATUS.INSERTED,
    ITEM_STATUS.POSTED
  ].includes(item.status)).length;
}

export class QueueEngine {
  constructor() {
    this.processing = false;
  }

  scheduleProcess(reason = "scheduled") {
    queueMicrotask(() => {
      void this.process(reason);
    });
  }

  async init() {
    await initializeStorage();
  }

  async throwIfRunSuperseded(expectedRunId) {
    const currentRunState = await getRunState();
    if (!expectedRunId || currentRunState.runId !== expectedRunId) {
      throw new RunSupersededError();
    }
  }

  async pauseForExternalError(message) {
    await setRunState({
      status: RUN_STATUS.PAUSED,
      errorMessage: message,
      waitingReason: "external_error",
      wakeAt: null,
      remainingDelayMs: 0
    });
    await chrome.alarms.clear(WAKE_ALARM);
    await appendActivityLog({
      message,
      level: "error"
    });
    await broadcastSnapshot();
  }

  async syncActiveTaskForTab(tabId, windowId) {
    const snapshot = await getSnapshot();
    const matchingTask = snapshot.queueItems.find((item) => item.preparedTabId === tabId) || null;
    if (!matchingTask) {
      await setRunState({
        activeTaskId: null,
        activePostTabId: null,
        activeWindowId: windowId || snapshot.runState.activeWindowId || null
      });
      await broadcastSnapshot();
      return;
    }

    await setRunState({
      activeTaskId: matchingTask.id,
      activePostTabId: tabId,
      activeWindowId: windowId || snapshot.runState.activeWindowId || null
    });
    await broadcastSnapshot();
  }

  async handleTabActivated(activeInfo) {
    try {
      const tab = await chrome.tabs.get(activeInfo.tabId);
      await this.syncActiveTaskForTab(activeInfo.tabId, tab.windowId);
    } catch {
      // Ignore transient tab activation races.
    }
  }

  async handleTabRemoved(tabId) {
    const snapshot = await getSnapshot();
    if (snapshot.runState.activePostTabId === tabId) {
      await setRunState({
        activeTaskId: null,
        activePostTabId: null
      });
      await broadcastSnapshot();
    }
  }

  async startRun({ settings, windowId }) {
    await this.init();
    const mergedSettings = await saveSettings(normalizeSettings({
      ...(await getSettings()),
      ...settings
    }));

    if (!mergedSettings.queries.length) {
      throw new Error("Add at least one search query before starting a run.");
    }

    await resetQueueItems();
    await clearActivityLog();
    const pickedDailyTarget = pickDailyTarget(mergedSettings.dailyTargetRange);
    const runState = await replaceRunState({
      runId: createId("run"),
      status: RUN_STATUS.RUNNING,
      pickedDailyTarget,
      dailyTargetDate: getLocalDateKey(),
      activeTaskId: null,
      activePostTabId: null,
      activeSearchTabId: null,
      activeWindowId: windowId || null,
      queryCursor: 0,
      searchCursorPlatformIndex: 0,
      wakeAt: null,
      waitingReason: null,
      lastProcessedAt: null,
      errorMessage: "",
      startedAt: Date.now()
    });

    await appendActivityLog({
      message: `Started run with target ${pickedDailyTarget} across ${mergedSettings.queries.length} queries.`,
      level: "info"
    });
    await openSidePanel(windowId);
    await broadcastSnapshot();
    void this.process("start");
    return runState;
  }

  async pauseRun() {
    const runState = await getRunState();
    if ([RUN_STATUS.IDLE, RUN_STATUS.COMPLETE, RUN_STATUS.STOPPED].includes(runState.status)) {
      return runState;
    }

    let remainingDelayMs = 0;
    if (runState.status === RUN_STATUS.COOLDOWN && runState.wakeAt) {
      remainingDelayMs = Math.max(0, runState.wakeAt - Date.now());
      await chrome.alarms.clear(WAKE_ALARM);
    }

    const next = await setRunState({
      status: RUN_STATUS.PAUSED,
      pausedFrom: runState.status,
      remainingDelayMs
    });
    await appendActivityLog({
      message: "Paused the workflow.",
      level: "info"
    });
    await broadcastSnapshot();
    return next;
  }

  async resumeRun() {
    const runState = await getRunState();
    if (runState.status !== RUN_STATUS.PAUSED) {
      return runState;
    }

    const resumedStatus = runState.pausedFrom || RUN_STATUS.RUNNING;
    const next = await setRunState({
      status: resumedStatus,
      pausedFrom: null
    });

    await appendActivityLog({
      message: "Resumed the workflow.",
      level: "info"
    });

    if (resumedStatus === RUN_STATUS.COOLDOWN && runState.remainingDelayMs > 0) {
      await this.scheduleWake(runState.remainingDelayMs, "resume_cooldown");
    } else if ([RUN_STATUS.RUNNING, RUN_STATUS.COOLDOWN].includes(resumedStatus)) {
      await setRunState({ status: RUN_STATUS.RUNNING, remainingDelayMs: 0, wakeAt: null, waitingReason: null });
      void this.process("resume");
    }

    await broadcastSnapshot();
    return next;
  }

  async stopRun() {
    await chrome.alarms.clear(WAKE_ALARM);
    const currentRunState = await getRunState();
    const next = await replaceRunState({
      status: RUN_STATUS.STOPPED,
      errorMessage: "",
      lastProcessedAt: Date.now()
    });
    await appendActivityLog({
      message: "Stopped the workflow.",
      level: "info"
    });
    if (currentRunState.activeSearchTabId) {
      try {
        await chrome.tabs.update(currentRunState.activeSearchTabId, { active: true });
      } catch {
        // Ignore if the tab no longer exists.
      }
    }
    await broadcastSnapshot();
    return next;
  }

  async scheduleWake(delayMs, reason) {
    const wakeAt = Date.now() + delayMs;
    await chrome.alarms.clear(WAKE_ALARM);
    await chrome.alarms.create(WAKE_ALARM, { when: wakeAt });
    await setRunState({
      status: RUN_STATUS.COOLDOWN,
      wakeAt,
      waitingReason: reason,
      remainingDelayMs: 0
    });
    await appendActivityLog({
      message: `Waiting ${Math.ceil(delayMs / 1000)}s before next step (${reason}).`,
      level: "info"
    });
  }

  async handleAlarm(alarm) {
    if (alarm.name === WAKE_ALARM) {
      const runState = await getRunState();
      if (runState.status === RUN_STATUS.COOLDOWN) {
        await setRunState({
          status: RUN_STATUS.RUNNING,
          wakeAt: null,
          waitingReason: null,
          remainingDelayMs: 0
        });
        void this.process("alarm");
      }
      return;
    }

  }

  async restoreAfterStartup() {
    await this.init();
    const runState = await getRunState();
    if (runState.status === RUN_STATUS.COOLDOWN && runState.wakeAt) {
      if (runState.wakeAt <= Date.now()) {
        await setRunState({ status: RUN_STATUS.RUNNING, wakeAt: null, waitingReason: null });
        void this.process("startup");
        return;
      }
      await chrome.alarms.create(WAKE_ALARM, { when: runState.wakeAt });
      return;
    }

    if (runState.status === RUN_STATUS.RUNNING) {
      void this.process("startup");
    }
  }

  async discoverNextQuery(snapshot, runId) {
    const { settings, runState, queueItems } = snapshot;
    if (runState.queryCursor >= settings.queries.length) {
      return false;
    }

    const query = settings.queries[runState.queryCursor];
    const adapters = getAllPlatformAdapters();
    if (!query || !adapters.length) {
      await this.advanceDiscoveryCursor(runState);
      return true;
    }

    if (runState.activeSearchTabId) {
      try {
        await chrome.tabs.remove(runState.activeSearchTabId);
      } catch {
        // Ignore if the user already closed the prior search tab.
      }
    }

    const searchUrl = adapters[0].buildSearchUrl(query, settings.timeFilter);
    const searchText = getGoogleSearchText(searchUrl);
    await appendActivityLog({
      message: `Starting Google discovery for query ${runState.queryCursor + 1}/${settings.queries.length}: ${query}`,
      level: "info"
    });
    const searchTab = await chrome.tabs.create({ url: "https://www.google.com/", active: true });
    await this.throwIfRunSuperseded(runId);
    await setRunState({
      activeSearchTabId: searchTab.id,
      activeWindowId: searchTab.windowId
    });
    const initialSearchLoad = await waitForTabComplete(searchTab.id);
    await logTabReadinessFallback(
      initialSearchLoad,
      `Google stayed in a loading state for "${query}", but the page was usable so discovery continued.`
    );
    await ensureWindowFocused(searchTab.windowId);
    await sleep(randomInt(1200, 2400));
    await this.throwIfRunSuperseded(runId);
    const visibility = await checkVisibleContext(searchTab.id);
    if (visibility.visibilityState !== "visible") {
      await appendActivityLog({
        message: `Search tab for "${query}" is not visible. Waiting to continue.`,
        level: "warning"
      });
      await this.scheduleWake(randomInt(4000, 7000), "search_visibility_wait");
      return true;
    }

    await appendActivityLog({
      message: `Typing Google search query: ${query}`,
      level: "info"
    });

    const runSearchResponse = await safeSendMessage(searchTab.id, {
      type: INTERNAL_ACTIONS.RUN_GOOGLE_SEARCH,
      payload: {
        searchText,
        searchUrl,
        typingDelayRangeMs: {
          min: 45,
          max: 95
        }
      }
    });

    if (!runSearchResponse?.ok) {
      throw new Error(runSearchResponse?.error || "Unable to type into the Google search bar.");
    }

    await waitForTabUrlMatch(searchTab.id, /^https:\/\/www\.google\.com\/search\b/i);
    await this.throwIfRunSuperseded(runId);
    const searchResultsLoad = await waitForTabComplete(searchTab.id);
    await logTabReadinessFallback(
      searchResultsLoad,
      `Google results for "${query}" kept loading, but the results DOM was usable so discovery continued.`
    );
    const currentSearchTab = await chrome.tabs.get(searchTab.id);
    await waitForGoogleResultsToSettle(searchTab.id, currentSearchTab.url || searchUrl, 10000);
    await appendActivityLog({
      message: `Google results loaded for "${query}".`,
      level: "info"
    });
    if (!isGoogleSearchUrlMatch(currentSearchTab.url || "", searchUrl)) {
      await appendActivityLog({
        message: `Applying Google time range for "${query}".`,
        level: "info"
      });
      await chrome.tabs.update(searchTab.id, { url: searchUrl });
      await waitForTabUrlPredicate(
        searchTab.id,
        (currentUrl) => isGoogleSearchUrlMatch(currentUrl, searchUrl),
        25000,
        `Google search URL ${searchUrl}`
      );
      await this.throwIfRunSuperseded(runId);
      const filteredResultsLoad = await waitForTabComplete(searchTab.id);
      await logTabReadinessFallback(
        filteredResultsLoad,
        `Google time-filtered results for "${query}" were still loading, but the page was usable so discovery continued.`
      );
      const settledSnapshot = await waitForGoogleResultsToSettle(searchTab.id, searchUrl, 15000);
      if (!isGoogleSearchUrlMatch(settledSnapshot.pageUrl, searchUrl)) {
        throw new Error(`Google did not finish applying the selected time filter for "${query}".`);
      }
      await appendActivityLog({
        message: `Verified filtered Google results for "${query}" before collecting links.`,
        level: "info"
      });
    }
    await sleep(randomInt(1600, 2800));
    await this.throwIfRunSuperseded(runId);

    const discoveryResponse = await safeSendMessage(searchTab.id, {
      type: INTERNAL_ACTIONS.DISCOVER_POSTS,
      payload: {
        adapters: adapters.map((adapter) => adapter.getRuntimeConfig()),
        limit: MAX_DISCOVERED_POSTS_PER_QUERY
      }
    });

    const rawUrls = discoveryResponse?.urls || [];
    if (discoveryResponse?.pageUrl && !isGoogleSearchUrlMatch(discoveryResponse.pageUrl, searchUrl)) {
      throw new Error(`Collected links from an unexpected Google page for "${query}".`);
    }
    await appendActivityLog({
      message: `Collected ${rawUrls.length} raw Google result links for "${query}".`,
      level: "info"
    });
    const seen = new Set(queueItems.map((item) => item.canonicalUrl));
    const newItems = [];
    for (const url of rawUrls) {
      const matchedAdapter = getAdapterForUrl(url);
      const canonicalUrl = matchedAdapter?.canonicalizeUrl(url);
      if (!matchedAdapter || !canonicalUrl || seen.has(canonicalUrl)) {
        continue;
      }
      seen.add(canonicalUrl);
      newItems.push({
        id: createId("task"),
        query,
        platform: matchedAdapter.id,
        url,
        canonicalUrl,
        status: ITEM_STATUS.PENDING,
        content: null,
        comments: [],
        selectedComment: "",
        discoveredAt: Date.now(),
        updatedAt: Date.now()
      });
    }

    if (newItems.length) {
      await appendQueueItems(newItems);
      await appendActivityLog({
        message: `Discovered ${newItems.length} matching post links from Google for "${query}".`,
        level: "info"
      });
    } else {
      await appendActivityLog({
        message: `No new matching selected-platform posts found on Google for "${query}".`,
        level: "warning"
      });
    }

    await this.advanceDiscoveryCursor(runState);
    return true;
  }

  async advanceDiscoveryCursor(runState) {
    await setRunState({
      queryCursor: runState.queryCursor + 1,
      searchCursorPlatformIndex: 0
    });
  }

  async prepareTask(task, settings, runId) {
    await this.throwIfRunSuperseded(runId);
    await updateQueueItem(task.id, {
      status: ITEM_STATUS.PROCESSING,
      processingStartedAt: Date.now(),
      updatedAt: Date.now(),
      errorMessage: ""
    });
    const adapter = getPlatformAdapter(task.platform);
    if (!adapter) {
      await updateQueueItem(task.id, {
        status: ITEM_STATUS.FAILED,
        processingStartedAt: null,
        updatedAt: Date.now(),
        errorMessage: `Unsupported platform: ${task.platform}`
      });
      await bumpDailyStats({ processed: 1 });
      return true;
    }

    if (shouldSkipWithChance(settings.skipChance)) {
      await updateQueueItem(task.id, {
        status: ITEM_STATUS.SKIPPED,
        processingStartedAt: null,
        updatedAt: Date.now(),
        skippedAt: Date.now()
      });
      await bumpDailyStats({ processed: 1, skipped: 1 });
      await appendActivityLog({
        message: `Randomized skip for ${adapter.label} post: ${task.canonicalUrl}`,
        level: "info"
      });
      await this.scheduleWake(randomInt(settings.betweenDelayRangeMs.min, settings.betweenDelayRangeMs.max), "skip_cooldown");
      return true;
    }

    const pendingItems = (await getSnapshot()).queueItems.filter((item) => item.status === ITEM_STATUS.PENDING);
    const queuePosition = pendingItems.findIndex((item) => item.id === task.id) + 1;
    await appendActivityLog({
      message: `Opening ${adapter.label} post ${queuePosition}/${pendingItems.length}: ${task.canonicalUrl}`,
      level: "info"
    });
    const postTab = await chrome.tabs.create({ url: task.canonicalUrl, active: true });
    await this.throwIfRunSuperseded(runId);
    const postTabLoad = await waitForTabComplete(postTab.id);
    await logTabReadinessFallback(
      postTabLoad,
      `${adapter.label} kept reporting a loading state, but the post DOM was usable so preparation continued.`
    );
    await ensureWindowFocused(postTab.windowId);
    await appendActivityLog({
      message: `Opened post tab for ${adapter.label}. Simulating reading delay.`,
      level: "info"
    });
    await sleep(randomInt(settings.readingDelayRangeMs.min, settings.readingDelayRangeMs.max));
    await this.throwIfRunSuperseded(runId);
    await humanScroll(postTab.id);
    const visibleContext = await checkVisibleContext(postTab.id);
    if (visibleContext.visibilityState !== "visible") {
      await appendActivityLog({
        message: "Post tab is hidden or unfocused, pausing until it is visible again.",
        level: "warning"
      });
      await this.scheduleWake(randomInt(4000, 7000), "post_visibility_wait");
      return true;
    }

    const extractResponse = await safeSendMessage(postTab.id, {
      type: INTERNAL_ACTIONS.EXTRACT_POST_CONTENT,
      payload: {
        adapter: adapter.getRuntimeConfig()
      }
    });

    if (!extractResponse?.ok) {
      await updateQueueItem(task.id, {
        status: ITEM_STATUS.FAILED,
        processingStartedAt: null,
        updatedAt: Date.now(),
        errorMessage: extractResponse?.error || "Unable to extract post content."
      });
      await bumpDailyStats({ processed: 1 });
      await appendActivityLog({
        message: `Failed to extract content for ${task.canonicalUrl}`,
        level: "error"
      });
      await this.scheduleWake(randomInt(settings.betweenDelayRangeMs.min, settings.betweenDelayRangeMs.max), "extract_failure_cooldown");
      return true;
    }

    const content = extractResponse.content;
    await appendActivityLog({
      message: `Extracted post content from ${adapter.label}. Requesting AI suggestions.`,
      level: "info"
    });
    let comments;
    try {
      await this.throwIfRunSuperseded(runId);
      comments = await generateCommentSuggestions({
        settings,
        task: {
          ...task,
          content
        }
      });
    } catch (error) {
      await updateQueueItem(task.id, {
        status: ITEM_STATUS.FAILED,
        content,
        processingStartedAt: null,
        updatedAt: Date.now(),
        errorMessage: error.message
      });
      await bumpDailyStats({ processed: 1 });
      await this.pauseForExternalError(`AI generation failed for ${adapter.label}. Fix the provider/API settings, then click Resume. Details: ${error.message}`);
      return true;
    }
    await appendActivityLog({
      message: `Received ${comments.length} AI comment suggestions for ${adapter.label}.`,
      level: "info"
    });
    const selectedComment = comments[0] || "";
    let insertedSuccessfully = false;
    if (selectedComment) {
      await this.throwIfRunSuperseded(runId);
      const insertResponse = await safeSendMessage(postTab.id, {
        type: INTERNAL_ACTIONS.INSERT_COMMENT_TEXT,
        payload: {
          adapter: adapter.getRuntimeConfig(),
          text: selectedComment,
          mode: settings.insertionMode,
          typingDelayRangeMs: settings.typingDelayRangeMs
        }
      });

      if (insertResponse?.ok) {
        insertedSuccessfully = true;
      } else {
        await appendActivityLog({
          message: `Could not prefill the ${adapter.label} comment box automatically. You can still refill it from the side panel.`,
          level: "warning"
        });
      }
    }

    await updateQueueItem(task.id, {
      status: insertedSuccessfully ? ITEM_STATUS.INSERTED : ITEM_STATUS.READY,
      content,
      comments,
      selectedComment,
      preparedTabId: postTab.id,
      processingStartedAt: null,
      insertedAt: insertedSuccessfully ? Date.now() : task.insertedAt || null,
      updatedAt: Date.now()
    });

    await setRunState({
      status: RUN_STATUS.RUNNING,
      activeTaskId: task.id,
      activePostTabId: postTab.id,
      activeWindowId: postTab.windowId,
      lastProcessedAt: Date.now()
    });
    if (insertedSuccessfully) {
      await bumpDailyStats({ inserted: 1, processed: 1 });
      await appendActivityLog({
        message: `Prefilled the ${adapter.label} comment box. Leave this tab open, review it later, manually click Post, then close the tab.`,
        level: "info"
      });
    } else {
      await bumpDailyStats({ processed: 1 });
      await appendActivityLog({
        message: `Prepared ${adapter.label} post without auto-prefill. Activate the tab later and use Refill Comment from the side panel if needed.`,
        level: "warning"
      });
    }

    await sleep(randomInt(900, 1800));
    await this.throwIfRunSuperseded(runId);
    return true;
  }

  async process(reason = "manual") {
    if (this.processing) {
      return;
    }

    this.processing = true;
    let nextProcessReason = "";
    try {
      await this.init();
      const snapshot = await getSnapshot();
      const { runState } = snapshot;
      const currentRunId = runState.runId;
      const preparedCount = getCurrentRunPreparedCount(snapshot.queueItems);

      if (runState.status !== RUN_STATUS.RUNNING) {
        return;
      }

      if (preparedCount >= (runState.pickedDailyTarget || 0)) {
        await setRunState({
          status: RUN_STATUS.COMPLETE,
          lastProcessedAt: Date.now(),
          activeTaskId: null,
          activePostTabId: null,
          activeSearchTabId: null
        });
        await appendActivityLog({
          message: `Preparation target reached (${preparedCount} prepared tabs in this run).`,
          level: "info"
        });
        await broadcastSnapshot();
        return;
      }

      const staleProcessingItems = snapshot.queueItems.filter((item) => item.status === ITEM_STATUS.PROCESSING);
      if (staleProcessingItems.length) {
        const recoverableItems = staleProcessingItems.filter((item) => reason === "startup"
          || !item.processingStartedAt
          || (Date.now() - item.processingStartedAt) > 45000);

        if (recoverableItems.length) {
          for (const item of recoverableItems) {
            await updateQueueItem(item.id, {
              status: ITEM_STATUS.PENDING,
              processingStartedAt: null,
              updatedAt: Date.now()
            });
          }
          await appendActivityLog({
            message: `Recovered ${recoverableItems.length} interrupted task(s) and returned them to the queue.`,
            level: "warning"
          });
          await broadcastSnapshot();
          nextProcessReason = `${reason}_recover_processing`;
        }
        return;
      }

      const nextPending = snapshot.queueItems.find((item) => item.status === ITEM_STATUS.PENDING);
      if (nextPending) {
        await appendActivityLog({
          message: `Queue has pending work. Moving to next URL: ${nextPending.canonicalUrl}`,
          level: "info"
        });
        await this.prepareTask(nextPending, snapshot.settings, currentRunId);
        await broadcastSnapshot();
        const latestRunState = await getRunState();
        if (latestRunState.status === RUN_STATUS.RUNNING) {
          nextProcessReason = `${reason}_next_task`;
        }
        return;
      }

      const discovered = await this.discoverNextQuery(snapshot, currentRunId);
      if (discovered) {
        await broadcastSnapshot();
        const latestRunState = await getRunState();
        if (latestRunState.status === RUN_STATUS.RUNNING) {
          nextProcessReason = `${reason}_continue`;
        }
        return;
      }

      await setRunState({
        status: RUN_STATUS.COMPLETE,
        lastProcessedAt: Date.now(),
        waitingReason: null,
        activeTaskId: null,
        activePostTabId: null,
        activeSearchTabId: null
      });
      await appendActivityLog({
        message: "No more queries or pending posts remain.",
        level: "info"
      });
      await broadcastSnapshot();
    } catch (error) {
      if (error instanceof RunSupersededError) {
        return;
      }
      await setRunState({
        status: RUN_STATUS.ERROR,
        errorMessage: error.message,
        lastProcessedAt: Date.now()
      });
      await appendActivityLog({
        message: `Workflow error: ${error.message}`,
        level: "error"
      });
      await broadcastSnapshot();
    } finally {
      this.processing = false;
      if (nextProcessReason) {
        this.scheduleProcess(nextProcessReason);
      }
    }
  }

  async insertComment({ taskId, commentText }) {
    const [snapshot, settings] = await Promise.all([getSnapshot(), getSettings()]);
    const task = snapshot.queueItems.find((item) => item.id === taskId);
    if (!task) {
      throw new Error("Task not found.");
    }

    const adapter = getPlatformAdapter(task.platform);
    if (!adapter) {
      throw new Error("Unsupported platform adapter.");
    }

    const activeTabId = snapshot.runState.activePostTabId || task.preparedTabId;
    if (!activeTabId) {
      throw new Error("No prepared post tab is available for this task.");
    }

    await ensureTabActive(activeTabId);
    const result = await safeSendMessage(activeTabId, {
      type: INTERNAL_ACTIONS.INSERT_COMMENT_TEXT,
      payload: {
        adapter: adapter.getRuntimeConfig(),
        text: commentText,
        mode: settings.insertionMode,
        typingDelayRangeMs: settings.typingDelayRangeMs
      }
    });

    if (!result?.ok) {
      throw new Error(result?.error || "Unable to insert comment into the page.");
    }

    const wasInserted = task.status === ITEM_STATUS.INSERTED;
    await updateQueueItem(taskId, {
      status: ITEM_STATUS.INSERTED,
      selectedComment: commentText,
      preparedTabId: activeTabId,
      insertedAt: wasInserted ? task.insertedAt : Date.now(),
      updatedAt: Date.now()
    });
    if (!wasInserted) {
      await bumpDailyStats({ inserted: 1 });
    }
    await setRunState({
      activeTaskId: taskId,
      activePostTabId: activeTabId,
      lastProcessedAt: Date.now()
    });
    await appendActivityLog({
      message: "Updated the prepared comment in the active tab. Review it, manually click Post, then close the tab.",
      level: "info"
    });
    await broadcastSnapshot();
  }

  async markPosted({ taskId, source = "manual confirmation" }) {
    const snapshot = await getSnapshot();
    const task = snapshot.queueItems.find((item) => item.id === taskId);
    if (!task) {
      throw new Error("Task not found.");
    }

    await updateQueueItem(taskId, {
      status: ITEM_STATUS.POSTED,
      postedAt: Date.now(),
      updatedAt: Date.now()
    });
    await bumpDailyStats({ posted: 1 });
    const runState = await getRunState();
    await setRunState({
      activeTaskId: runState.activeTaskId === taskId ? null : runState.activeTaskId,
      activePostTabId: runState.activeTaskId === taskId ? null : runState.activePostTabId,
      lastProcessedAt: Date.now()
    });
    await appendActivityLog({
      message: `Marked task as posted via ${source}. You can close that tab and continue with the next prepared one.`,
      level: "info"
    });
    await broadcastSnapshot();
  }

  async skipPost({ taskId, reason = "Skipped by user" }) {
    const snapshot = await getSnapshot();
    const task = snapshot.queueItems.find((item) => item.id === taskId);
    if (!task) {
      throw new Error("Task not found.");
    }

    await updateQueueItem(taskId, {
      status: ITEM_STATUS.SKIPPED,
      skippedAt: Date.now(),
      updatedAt: Date.now(),
      skipReason: reason
    });
    await bumpDailyStats({ skipped: 1 });
    const runState = await getRunState();
    await setRunState({
      activeTaskId: runState.activeTaskId === taskId ? null : runState.activeTaskId,
      activePostTabId: runState.activeTaskId === taskId ? null : runState.activePostTabId,
      lastProcessedAt: Date.now()
    });
    await appendActivityLog({
      message: `${reason}. You can close that tab and continue with the next prepared one.`,
      level: "info"
    });
    await broadcastSnapshot();
  }

  async regenerateComments({ taskId }) {
    const [snapshot, settings] = await Promise.all([getSnapshot(), getSettings()]);
    const task = snapshot.queueItems.find((item) => item.id === taskId);
    if (!task) {
      throw new Error("Task not found.");
    }
    if (!task.content?.text) {
      throw new Error("No extracted content available for regeneration.");
    }

    const comments = await generateCommentSuggestions({ settings, task });
    await updateQueueItem(taskId, {
      comments,
      selectedComment: comments[0] || "",
      updatedAt: Date.now()
    });
    await appendActivityLog({
      message: "Regenerated comment suggestions.",
      level: "info"
    });
    await broadcastSnapshot();
  }
}
