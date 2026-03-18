import {
  DEFAULT_DAILY_STATS,
  DEFAULT_RUN_STATE,
  DEFAULT_SETTINGS,
  LOG_LIMIT,
  STORAGE_KEYS
} from "../shared/constants.js";
import {
  boundedArray,
  getLocalDateKey,
  normalizeSettings
} from "../shared/utils.js";

async function getStorage(keys) {
  return chrome.storage.local.get(keys);
}

async function setStorage(value) {
  await chrome.storage.local.set(value);
}

export async function initializeStorage() {
  const existing = await getStorage(Object.values(STORAGE_KEYS));
  const todayKey = getLocalDateKey();
  const next = {};

  if (!existing[STORAGE_KEYS.SETTINGS]) {
    next[STORAGE_KEYS.SETTINGS] = { ...DEFAULT_SETTINGS };
  }

  if (!existing[STORAGE_KEYS.RUN_STATE]) {
    next[STORAGE_KEYS.RUN_STATE] = { ...DEFAULT_RUN_STATE };
  }

  if (!existing[STORAGE_KEYS.QUEUE_ITEMS]) {
    next[STORAGE_KEYS.QUEUE_ITEMS] = [];
  }

  if (!existing[STORAGE_KEYS.DAILY_STATS]) {
    next[STORAGE_KEYS.DAILY_STATS] = { ...DEFAULT_DAILY_STATS, dateKey: todayKey };
  }

  if (!existing[STORAGE_KEYS.ACTIVITY_LOG]) {
    next[STORAGE_KEYS.ACTIVITY_LOG] = [];
  }

  if (Object.keys(next).length) {
    await setStorage(next);
  }

  await ensureDailyStatsToday();
}

export async function getSettings() {
  const data = await getStorage([STORAGE_KEYS.SETTINGS]);
  return normalizeSettings(data[STORAGE_KEYS.SETTINGS] || DEFAULT_SETTINGS);
}

export async function saveSettings(nextSettings) {
  const normalized = normalizeSettings(nextSettings);
  await setStorage({ [STORAGE_KEYS.SETTINGS]: normalized });
  return normalized;
}

export async function getRunState() {
  const data = await getStorage([STORAGE_KEYS.RUN_STATE]);
  return { ...DEFAULT_RUN_STATE, ...(data[STORAGE_KEYS.RUN_STATE] || {}) };
}

export async function setRunState(patch) {
  const current = await getRunState();
  const next = { ...current, ...patch };
  await setStorage({ [STORAGE_KEYS.RUN_STATE]: next });
  return next;
}

export async function replaceRunState(runState) {
  const next = { ...DEFAULT_RUN_STATE, ...runState };
  await setStorage({ [STORAGE_KEYS.RUN_STATE]: next });
  return next;
}

export async function getQueueItems() {
  const data = await getStorage([STORAGE_KEYS.QUEUE_ITEMS]);
  return Array.isArray(data[STORAGE_KEYS.QUEUE_ITEMS]) ? data[STORAGE_KEYS.QUEUE_ITEMS] : [];
}

export async function saveQueueItems(queueItems) {
  await setStorage({ [STORAGE_KEYS.QUEUE_ITEMS]: queueItems });
  return queueItems;
}

export async function updateQueueItem(taskId, updater) {
  const queueItems = await getQueueItems();
  const nextItems = queueItems.map((item) => {
    if (item.id !== taskId) {
      return item;
    }
    return typeof updater === "function" ? updater(item) : { ...item, ...updater };
  });
  await saveQueueItems(nextItems);
  return nextItems.find((item) => item.id === taskId) || null;
}

export async function appendQueueItems(newItems) {
  const queueItems = await getQueueItems();
  const nextItems = [...queueItems, ...newItems];
  await saveQueueItems(nextItems);
  return nextItems;
}

export async function resetQueueItems() {
  await saveQueueItems([]);
}

export async function ensureDailyStatsToday() {
  const data = await getStorage([STORAGE_KEYS.DAILY_STATS]);
  const current = data[STORAGE_KEYS.DAILY_STATS] || DEFAULT_DAILY_STATS;
  const todayKey = getLocalDateKey();
  if (current.dateKey === todayKey) {
    return current;
  }
  const next = { ...DEFAULT_DAILY_STATS, dateKey: todayKey };
  await setStorage({ [STORAGE_KEYS.DAILY_STATS]: next });
  return next;
}

export async function getDailyStats() {
  return ensureDailyStatsToday();
}

export async function bumpDailyStats(delta) {
  const current = await ensureDailyStatsToday();
  const next = {
    ...current,
    processed: current.processed + (delta.processed || 0),
    inserted: current.inserted + (delta.inserted || 0),
    posted: current.posted + (delta.posted || 0),
    skipped: current.skipped + (delta.skipped || 0)
  };
  await setStorage({ [STORAGE_KEYS.DAILY_STATS]: next });
  return next;
}

export async function getActivityLog() {
  const data = await getStorage([STORAGE_KEYS.ACTIVITY_LOG]);
  return Array.isArray(data[STORAGE_KEYS.ACTIVITY_LOG]) ? data[STORAGE_KEYS.ACTIVITY_LOG] : [];
}

export async function appendActivityLog(entry) {
  const log = await getActivityLog();
  const nextEntry = {
    id: entry.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: entry.timestamp || Date.now(),
    level: entry.level || "info",
    message: entry.message || ""
  };
  const nextLog = boundedArray([...log, nextEntry], LOG_LIMIT);
  await setStorage({ [STORAGE_KEYS.ACTIVITY_LOG]: nextLog });
  return nextEntry;
}

export async function clearActivityLog() {
  await setStorage({ [STORAGE_KEYS.ACTIVITY_LOG]: [] });
}

export async function getSnapshot() {
  await initializeStorage();
  const [settings, runState, queueItems, dailyStats, activityLog] = await Promise.all([
    getSettings(),
    getRunState(),
    getQueueItems(),
    getDailyStats(),
    getActivityLog()
  ]);

  const activeTask = queueItems.find((item) => item.id === runState.activeTaskId)
    || queueItems.find((item) => item.preparedTabId === runState.activePostTabId)
    || null;

  return {
    settings,
    runState,
    queueItems,
    dailyStats,
    activityLog,
    activeTask
  };
}
