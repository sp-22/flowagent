import {
  AGENT_CHAT_LOG_LIMIT,
  AGENT_RUN_STATUS,
  AGENT_STORAGE_KEYS,
  DEFAULT_AGENT_RUN_STATE,
  DEFAULT_SESSION_MEMORY,
  DEFAULT_USER_MEMORY,
  STARTER_PROMPTS
} from "../shared/constants.js";
import { boundedArray } from "../shared/utils.js";
import { getActiveLlmAccount, getProviderPreset, resolveProviderConfig } from "../shared/llm-providers.js";
import { getSettings } from "./storage.js";

async function getStorage(keys) {
  return chrome.storage.local.get(keys);
}

async function setStorage(value) {
  await chrome.storage.local.set(value);
}

export async function initializeAgentStorage() {
  const existing = await getStorage(Object.values(AGENT_STORAGE_KEYS));
  const next = {};

  if (!Array.isArray(existing[AGENT_STORAGE_KEYS.CHAT_THREAD])) {
    next[AGENT_STORAGE_KEYS.CHAT_THREAD] = [];
  }

  if (!existing[AGENT_STORAGE_KEYS.DRAFT_PLAN]) {
    next[AGENT_STORAGE_KEYS.DRAFT_PLAN] = null;
  }

  if (!existing[AGENT_STORAGE_KEYS.CURRENT_RUN]) {
    next[AGENT_STORAGE_KEYS.CURRENT_RUN] = { ...DEFAULT_AGENT_RUN_STATE };
  }

  if (!Array.isArray(existing[AGENT_STORAGE_KEYS.SAVED_WORKFLOWS])) {
    next[AGENT_STORAGE_KEYS.SAVED_WORKFLOWS] = [];
  }

  if (!existing[AGENT_STORAGE_KEYS.SESSION_MEMORY]) {
    next[AGENT_STORAGE_KEYS.SESSION_MEMORY] = { ...DEFAULT_SESSION_MEMORY };
  }

  if (!existing[AGENT_STORAGE_KEYS.USER_MEMORY]) {
    next[AGENT_STORAGE_KEYS.USER_MEMORY] = { ...DEFAULT_USER_MEMORY };
  }

  if (!existing[AGENT_STORAGE_KEYS.DOMAIN_MEMORY]) {
    next[AGENT_STORAGE_KEYS.DOMAIN_MEMORY] = {};
  }

  if (Object.keys(next).length) {
    await setStorage(next);
  }
}

export async function getChatThread() {
  const data = await getStorage([AGENT_STORAGE_KEYS.CHAT_THREAD]);
  return Array.isArray(data[AGENT_STORAGE_KEYS.CHAT_THREAD]) ? data[AGENT_STORAGE_KEYS.CHAT_THREAD] : [];
}

export async function saveChatThread(messages) {
  await setStorage({
    [AGENT_STORAGE_KEYS.CHAT_THREAD]: boundedArray(messages, AGENT_CHAT_LOG_LIMIT)
  });
}

export async function appendChatMessages(messages) {
  const current = await getChatThread();
  const next = boundedArray([...current, ...messages], AGENT_CHAT_LOG_LIMIT);
  await saveChatThread(next);
  return next;
}

export async function clearChatThread() {
  await saveChatThread([]);
}

export async function getDraftPlan() {
  const data = await getStorage([AGENT_STORAGE_KEYS.DRAFT_PLAN]);
  return data[AGENT_STORAGE_KEYS.DRAFT_PLAN] || null;
}

export async function saveDraftPlan(plan) {
  await setStorage({ [AGENT_STORAGE_KEYS.DRAFT_PLAN]: plan || null });
  return plan || null;
}

export async function getCurrentRun() {
  const data = await getStorage([AGENT_STORAGE_KEYS.CURRENT_RUN]);
  return {
    ...DEFAULT_AGENT_RUN_STATE,
    ...(data[AGENT_STORAGE_KEYS.CURRENT_RUN] || {})
  };
}

export async function replaceCurrentRun(runState) {
  const next = {
    ...DEFAULT_AGENT_RUN_STATE,
    ...(runState || {}),
    updatedAt: Date.now()
  };
  await setStorage({ [AGENT_STORAGE_KEYS.CURRENT_RUN]: next });
  return next;
}

export async function setCurrentRun(patch) {
  const current = await getCurrentRun();
  return replaceCurrentRun({
    ...current,
    ...(patch || {})
  });
}

export async function getSavedWorkflows() {
  const data = await getStorage([AGENT_STORAGE_KEYS.SAVED_WORKFLOWS]);
  return Array.isArray(data[AGENT_STORAGE_KEYS.SAVED_WORKFLOWS]) ? data[AGENT_STORAGE_KEYS.SAVED_WORKFLOWS] : [];
}

export async function saveSavedWorkflows(workflows) {
  await setStorage({ [AGENT_STORAGE_KEYS.SAVED_WORKFLOWS]: workflows });
  return workflows;
}

export async function upsertSavedWorkflow(workflow) {
  const current = await getSavedWorkflows();
  const next = [
    workflow,
    ...current.filter((item) => item.id !== workflow.id)
  ].slice(0, 20);
  return saveSavedWorkflows(next);
}

export async function getSessionMemory() {
  const data = await getStorage([AGENT_STORAGE_KEYS.SESSION_MEMORY]);
  return {
    ...DEFAULT_SESSION_MEMORY,
    ...(data[AGENT_STORAGE_KEYS.SESSION_MEMORY] || {})
  };
}

export async function saveSessionMemory(memory) {
  await setStorage({ [AGENT_STORAGE_KEYS.SESSION_MEMORY]: memory });
  return memory;
}

export async function updateSessionMemoryForRun(planId, patch) {
  const current = await getSessionMemory();
  const currentRunMemory = current.runs?.[planId] || {};
  const next = {
    ...current,
    currentPlanId: planId,
    runs: {
      ...(current.runs || {}),
      [planId]: {
        ...currentRunMemory,
        ...(patch || {}),
        updatedAt: Date.now()
      }
    }
  };
  await saveSessionMemory(next);
  return next;
}

export async function getUserMemory() {
  const data = await getStorage([AGENT_STORAGE_KEYS.USER_MEMORY]);
  return {
    ...DEFAULT_USER_MEMORY,
    ...(data[AGENT_STORAGE_KEYS.USER_MEMORY] || {})
  };
}

export async function saveUserMemory(memory) {
  await setStorage({ [AGENT_STORAGE_KEYS.USER_MEMORY]: memory });
  return memory;
}

export async function getDomainMemory() {
  const data = await getStorage([AGENT_STORAGE_KEYS.DOMAIN_MEMORY]);
  return data[AGENT_STORAGE_KEYS.DOMAIN_MEMORY] || {};
}

export async function saveDomainMemory(memory) {
  await setStorage({ [AGENT_STORAGE_KEYS.DOMAIN_MEMORY]: memory });
  return memory;
}

export async function getAgentSnapshot() {
  await initializeAgentStorage();
  const [settings, chatThread, draftPlan, currentRun, savedWorkflows, sessionMemory, userMemory, domainMemory] = await Promise.all([
    getSettings(),
    getChatThread(),
    getDraftPlan(),
    getCurrentRun(),
    getSavedWorkflows(),
    getSessionMemory(),
    getUserMemory(),
    getDomainMemory()
  ]);
  const activeAccount = getActiveLlmAccount(settings);
  const providerConfig = resolveProviderConfig(settings);
  const providerPreset = getProviderPreset(providerConfig.id);

  let activeHostname = "";
  try {
    activeHostname = currentRun.activeUrl
      ? new URL(currentRun.activeUrl).hostname.replace(/^www\./i, "")
      : "";
  } catch {
    activeHostname = "";
  }

  return {
    settings,
    providerStatus: {
      provider: providerPreset.label,
      model: providerConfig.model || providerPreset.defaultModel,
      configured: Boolean(providerConfig.apiKey),
      accountLabel: activeAccount?.label || "",
      accountId: activeAccount?.id || null
    },
    llmAccounts: settings.llmAccounts || [],
    activeLlmAccountId: settings.activeLlmAccountId || null,
    starterPrompts: STARTER_PROMPTS,
    chatThread,
    draftPlan,
    currentRun,
    savedWorkflows,
    memory: {
      session: sessionMemory,
      user: userMemory,
      activeDomain: activeHostname ? domainMemory[activeHostname] || null : null,
      domains: domainMemory
    },
    ui: {
      needsApiKey: !providerConfig.apiKey,
      canExecute: Boolean(draftPlan && draftPlan.status === "approved")
        && ![AGENT_RUN_STATUS.RUNNING, AGENT_RUN_STATUS.PAUSED_FOR_STEP_APPROVAL].includes(currentRun.status)
    }
  };
}
