import {
  AGENT_CHAT_LOG_LIMIT,
  AGENT_RUN_STATUS,
  AGENT_STORAGE_KEYS,
  DEFAULT_COPILOT_STATE,
  DEFAULT_AGENT_RUN_STATE,
  DEFAULT_AGENT_UI_STATE,
  DEFAULT_SESSION_MEMORY,
  DEFAULT_USER_MEMORY,
  STARTER_PROMPTS
} from "../shared/constants.js";
import { normalizeSavedWorkflow } from "../shared/agent.js";
import { getActiveLlmAccount, getProviderPreset, resolveProviderConfig } from "../shared/llm-providers.js";
import { boundedArray, createId } from "../shared/utils.js";
import { getSettings } from "./storage.js";

const RUN_HISTORY_LIMIT = 40;
const COPILOT_HISTORY_LIMIT = 30;
const ACTIVE_DETAIL_STATUSES = new Set([
  AGENT_RUN_STATUS.RUNNING,
  AGENT_RUN_STATUS.PAUSED,
  AGENT_RUN_STATUS.PAUSED_FOR_STEP_APPROVAL,
  AGENT_RUN_STATUS.PAUSED_FOR_ERROR
]);

async function getStorage(keys) {
  return chrome.storage.local.get(keys);
}

async function setStorage(value) {
  await chrome.storage.local.set(value);
}

function trimNewest(items, limit) {
  return Array.isArray(items) ? items.slice(0, limit) : [];
}

function normalizeSavedWorkflows(workflows = []) {
  return (Array.isArray(workflows) ? workflows : [])
    .map((workflow) => {
      try {
        return normalizeSavedWorkflow(workflow);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .slice(0, 30);
}

function getStarterWorkflows() {
  return normalizeSavedWorkflows([
    {
      id: "starter-summarize-page",
      title: "Summarize a web page",
      goal: "Open a page, capture the main text, and summarize it.",
      summary: "Open any page and return a concise summary.",
      templateInputs: [
        {
          id: "starter-summarize-page:step-1:url",
          key: "start_url",
          label: "Page URL",
          defaultValue: "https://openai.com",
          stepId: "starter-summarize-page-step-1",
          argKey: "url"
        }
      ],
      steps: [
        {
          id: "starter-summarize-page-step-1",
          kind: "open_url",
          label: "Open the page",
          args: {
            url: "https://openai.com"
          }
        },
        {
          id: "starter-summarize-page-step-2",
          kind: "extract_text",
          label: "Extract main text",
          args: {
            selector: "body"
          },
          outputKey: "page_text"
        },
        {
          id: "starter-summarize-page-step-3",
          kind: "summarize",
          label: "Summarize the page",
          args: {
            prompt: "Summarize the captured page text."
          },
          outputKey: "summary"
        }
      ]
    },
    {
      id: "starter-collect-links",
      title: "Collect links from a page",
      goal: "Open a page and collect the visible links on it.",
      summary: "Capture visible links from a page for quick research.",
      templateInputs: [
        {
          id: "starter-collect-links:step-1:url",
          key: "start_url",
          label: "Page URL",
          defaultValue: "https://news.ycombinator.com",
          stepId: "starter-collect-links-step-1",
          argKey: "url"
        }
      ],
      steps: [
        {
          id: "starter-collect-links-step-1",
          kind: "open_url",
          label: "Open the page",
          args: {
            url: "https://news.ycombinator.com"
          }
        },
        {
          id: "starter-collect-links-step-2",
          kind: "extract_list",
          label: "Collect visible links",
          args: {
            itemSelector: "a",
            limit: 20
          },
          outputKey: "links"
        },
        {
          id: "starter-collect-links-step-3",
          kind: "summarize",
          label: "Summarize the link set",
          args: {
            prompt: "Summarize the themes across the extracted links."
          },
          outputKey: "link_summary"
        }
      ]
    },
    {
      id: "starter-google-research",
      title: "Search and summarize",
      goal: "Search the web, extract the result page text, and summarize it.",
      summary: "Use a saved Google search workflow for quick topic research.",
      templateInputs: [
        {
          id: "starter-google-research:step-1:url",
          key: "search_url",
          label: "Search URL",
          defaultValue: "https://www.google.com/search?q=browser+automation",
          stepId: "starter-google-research-step-1",
          argKey: "url"
        }
      ],
      steps: [
        {
          id: "starter-google-research-step-1",
          kind: "open_url",
          label: "Open the search page",
          args: {
            url: "https://www.google.com/search?q=browser+automation"
          }
        },
        {
          id: "starter-google-research-step-2",
          kind: "extract_text",
          label: "Capture search results text",
          args: {
            selector: "body"
          },
          outputKey: "results_text"
        },
        {
          id: "starter-google-research-step-3",
          kind: "summarize",
          label: "Summarize results",
          args: {
            prompt: "Summarize the key findings from the search results."
          },
          outputKey: "results_summary"
        }
      ]
    }
  ]);
}

function normalizeUiState(value = {}) {
  return {
    ...DEFAULT_AGENT_UI_STATE,
    ...(value || {}),
    selectedTab: String(value?.selectedTab || DEFAULT_AGENT_UI_STATE.selectedTab).trim() || DEFAULT_AGENT_UI_STATE.selectedTab,
    selectedWorkflowId: value?.selectedWorkflowId ? String(value.selectedWorkflowId).trim() : null,
    saveWorkflowDraft: value?.saveWorkflowDraft || null
  };
}

function normalizeSessionMemory(memory = {}) {
  return {
    ...DEFAULT_SESSION_MEMORY,
    ...(memory || {}),
    runs: memory?.runs && typeof memory.runs === "object" ? memory.runs : {},
    history: trimNewest(memory?.history || [], RUN_HISTORY_LIMIT)
  };
}

function normalizeCopilotState(value = {}) {
  return {
    ...DEFAULT_COPILOT_STATE,
    ...(value || {}),
    activeConversationId: value?.activeConversationId ? String(value.activeConversationId).trim() : null
  };
}

function deriveCopilotTitle(messages = [], titleHint = "") {
  const hinted = String(titleHint || "").trim();
  if (hinted) {
    return hinted.length > 64 ? `${hinted.slice(0, 61)}...` : hinted;
  }
  const firstUserMessage = (messages || []).find((message) => message?.type === "user_message");
  const content = String(firstUserMessage?.content || "").trim();
  if (!content) {
    return "New chat";
  }
  return content.length > 64 ? `${content.slice(0, 61)}...` : content;
}

function normalizeCopilotConversation(conversation = {}) {
  return {
    id: String(conversation.id || createId("copilot")).trim(),
    title: deriveCopilotTitle(conversation.messages, conversation.title),
    messages: boundedArray(Array.isArray(conversation.messages) ? conversation.messages : [], AGENT_CHAT_LOG_LIMIT),
    updatedAt: Number(conversation.updatedAt) || Date.now()
  };
}

function normalizeCopilotHistory(history = []) {
  return (Array.isArray(history) ? history : [])
    .map((conversation) => {
      try {
        return normalizeCopilotConversation(conversation);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .slice(0, COPILOT_HISTORY_LIMIT);
}

function buildActiveWorkflow({ currentRun, draftPlan, savedWorkflows, selectedWorkflow }) {
  const runtimePlan = draftPlan && currentRun?.planId === draftPlan.id ? draftPlan : null;
  const savedWorkflow = currentRun?.sourceWorkflowId
    ? savedWorkflows.find((workflow) => workflow.id === currentRun.sourceWorkflowId) || null
    : null;
  const hasActiveRun = ACTIVE_DETAIL_STATUSES.has(currentRun?.status);
  const fallbackWorkflow = runtimePlan || selectedWorkflow || savedWorkflow || null;
  const workflowId = savedWorkflow?.id
    || currentRun?.sourceWorkflowId
    || runtimePlan?.sourceWorkflowId
    || runtimePlan?.id
    || selectedWorkflow?.id
    || null;

  if (!workflowId && !fallbackWorkflow) {
    return null;
  }

  return {
    workflowId: workflowId || fallbackWorkflow?.id || null,
    savedWorkflowId: savedWorkflow?.id || currentRun?.sourceWorkflowId || runtimePlan?.sourceWorkflowId || null,
    planId: runtimePlan?.id || currentRun?.planId || null,
    title: savedWorkflow?.title || runtimePlan?.title || selectedWorkflow?.title || currentRun?.sourceWorkflowTitle || "",
    status: currentRun?.status || AGENT_RUN_STATUS.IDLE,
    hasActiveRun
  };
}

async function getActiveTabContext() {
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const activeTab = tabs[0] || null;
    if (!activeTab) {
      return null;
    }
    return {
      tabId: activeTab.id || null,
      title: activeTab.title || "",
      url: activeTab.url || ""
    };
  } catch {
    return null;
  }
}

export async function initializeAgentStorage() {
  const existing = await getStorage(Object.values(AGENT_STORAGE_KEYS));
  const next = {};

  if (!Array.isArray(existing[AGENT_STORAGE_KEYS.CHAT_THREAD])) {
    next[AGENT_STORAGE_KEYS.CHAT_THREAD] = [];
  }

  if (!Array.isArray(existing[AGENT_STORAGE_KEYS.COPILOT_THREAD])) {
    next[AGENT_STORAGE_KEYS.COPILOT_THREAD] = [];
  }

  if (!Array.isArray(existing[AGENT_STORAGE_KEYS.COPILOT_HISTORY])) {
    next[AGENT_STORAGE_KEYS.COPILOT_HISTORY] = [];
  }

  if (!existing[AGENT_STORAGE_KEYS.COPILOT_STATE]) {
    next[AGENT_STORAGE_KEYS.COPILOT_STATE] = { ...DEFAULT_COPILOT_STATE };
  }

  if (!existing[AGENT_STORAGE_KEYS.DRAFT_PLAN]) {
    next[AGENT_STORAGE_KEYS.DRAFT_PLAN] = null;
  }

  if (!existing[AGENT_STORAGE_KEYS.CURRENT_RUN]) {
    next[AGENT_STORAGE_KEYS.CURRENT_RUN] = { ...DEFAULT_AGENT_RUN_STATE };
  }

  if (!Array.isArray(existing[AGENT_STORAGE_KEYS.SAVED_WORKFLOWS])) {
    next[AGENT_STORAGE_KEYS.SAVED_WORKFLOWS] = getStarterWorkflows();
    next[AGENT_STORAGE_KEYS.STARTER_WORKFLOWS_SEEDED] = true;
  } else if (
    existing[AGENT_STORAGE_KEYS.STARTER_WORKFLOWS_SEEDED] !== true
    && Array.isArray(existing[AGENT_STORAGE_KEYS.SAVED_WORKFLOWS])
    && existing[AGENT_STORAGE_KEYS.SAVED_WORKFLOWS].length === 0
  ) {
    next[AGENT_STORAGE_KEYS.SAVED_WORKFLOWS] = getStarterWorkflows();
    next[AGENT_STORAGE_KEYS.STARTER_WORKFLOWS_SEEDED] = true;
  }

  if (existing[AGENT_STORAGE_KEYS.STARTER_WORKFLOWS_SEEDED] == null) {
    next[AGENT_STORAGE_KEYS.STARTER_WORKFLOWS_SEEDED] = Boolean(next[AGENT_STORAGE_KEYS.STARTER_WORKFLOWS_SEEDED]);
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

  if (!existing[AGENT_STORAGE_KEYS.UI_STATE]) {
    next[AGENT_STORAGE_KEYS.UI_STATE] = { ...DEFAULT_AGENT_UI_STATE };
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
    [AGENT_STORAGE_KEYS.CHAT_THREAD]: boundedArray(messages || [], AGENT_CHAT_LOG_LIMIT)
  });
}

export async function appendChatMessages(messages) {
  const current = await getChatThread();
  const next = boundedArray([...(current || []), ...(Array.isArray(messages) ? messages : [])], AGENT_CHAT_LOG_LIMIT);
  await saveChatThread(next);
  return next;
}

export async function clearChatThread() {
  await saveChatThread([]);
}

export async function getCopilotThread() {
  const data = await getStorage([AGENT_STORAGE_KEYS.COPILOT_THREAD]);
  return Array.isArray(data[AGENT_STORAGE_KEYS.COPILOT_THREAD]) ? data[AGENT_STORAGE_KEYS.COPILOT_THREAD] : [];
}

export async function saveCopilotThread(messages) {
  await setStorage({
    [AGENT_STORAGE_KEYS.COPILOT_THREAD]: boundedArray(messages || [], AGENT_CHAT_LOG_LIMIT)
  });
}

export async function appendCopilotMessages(messages) {
  const current = await getCopilotThread();
  const next = boundedArray([...(current || []), ...(Array.isArray(messages) ? messages : [])], AGENT_CHAT_LOG_LIMIT);
  await saveCopilotThread(next);
  return next;
}

export async function clearCopilotThread() {
  await saveCopilotThread([]);
}

export async function getCopilotHistory() {
  const data = await getStorage([AGENT_STORAGE_KEYS.COPILOT_HISTORY]);
  return normalizeCopilotHistory(data[AGENT_STORAGE_KEYS.COPILOT_HISTORY]);
}

export async function saveCopilotHistory(history) {
  const normalized = normalizeCopilotHistory(history);
  await setStorage({ [AGENT_STORAGE_KEYS.COPILOT_HISTORY]: normalized });
  return normalized;
}

export async function getCopilotState() {
  const data = await getStorage([AGENT_STORAGE_KEYS.COPILOT_STATE]);
  return normalizeCopilotState(data[AGENT_STORAGE_KEYS.COPILOT_STATE]);
}

export async function saveCopilotState(state) {
  const normalized = normalizeCopilotState(state);
  await setStorage({ [AGENT_STORAGE_KEYS.COPILOT_STATE]: normalized });
  return normalized;
}

export async function syncActiveCopilotConversation({ titleHint = "" } = {}) {
  const [copilotState, copilotThread, copilotHistory] = await Promise.all([
    getCopilotState(),
    getCopilotThread(),
    getCopilotHistory()
  ]);

  if (!copilotThread.length) {
    return null;
  }

  const existingConversation = copilotState.activeConversationId
    ? copilotHistory.find((conversation) => conversation.id === copilotState.activeConversationId) || null
    : null;
  const conversation = normalizeCopilotConversation({
    id: existingConversation?.id || copilotState.activeConversationId || createId("copilot"),
    title: existingConversation?.title || titleHint,
    messages: copilotThread,
    updatedAt: Date.now()
  });

  await saveCopilotHistory([
    conversation,
    ...copilotHistory.filter((item) => item.id !== conversation.id)
  ]);
  await saveCopilotState({
    activeConversationId: conversation.id
  });

  return conversation;
}

export async function loadCopilotConversation(conversationId) {
  const copilotHistory = await getCopilotHistory();
  const conversation = copilotHistory.find((item) => item.id === conversationId) || null;
  if (!conversation) {
    return null;
  }

  await saveCopilotThread(conversation.messages || []);
  await saveCopilotState({
    activeConversationId: conversation.id
  });
  return conversation;
}

export async function deleteCopilotConversation(conversationId) {
  const [copilotHistory, copilotState] = await Promise.all([
    getCopilotHistory(),
    getCopilotState()
  ]);
  await saveCopilotHistory(copilotHistory.filter((item) => item.id !== conversationId));
  if (copilotState.activeConversationId === conversationId) {
    await clearCopilotThread();
    await saveCopilotState({
      activeConversationId: null
    });
  }
}

export async function resetCopilotConversation() {
  await clearCopilotThread();
  await saveCopilotState({
    activeConversationId: null
  });
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
  return normalizeSavedWorkflows(data[AGENT_STORAGE_KEYS.SAVED_WORKFLOWS]);
}

export async function saveSavedWorkflows(workflows) {
  const normalized = normalizeSavedWorkflows(workflows);
  await setStorage({ [AGENT_STORAGE_KEYS.SAVED_WORKFLOWS]: normalized });
  return normalized;
}

export async function upsertSavedWorkflow(workflow) {
  const current = await getSavedWorkflows();
  const normalizedWorkflow = normalizeSavedWorkflow(workflow);
  const next = [
    normalizedWorkflow,
    ...current.filter((item) => item.id !== normalizedWorkflow.id)
  ].slice(0, 30);
  return saveSavedWorkflows(next);
}

export async function deleteSavedWorkflow(workflowId) {
  const current = await getSavedWorkflows();
  return saveSavedWorkflows(current.filter((item) => item.id !== workflowId));
}

export async function updateSavedWorkflowMetadata(workflowId, patch = {}) {
  const current = await getSavedWorkflows();
  const next = current.map((workflow) => workflow.id === workflowId
    ? normalizeSavedWorkflow({
      ...workflow,
      ...patch,
      updatedAt: Date.now()
    })
    : workflow);
  return saveSavedWorkflows(next);
}

export async function getSessionMemory() {
  const data = await getStorage([AGENT_STORAGE_KEYS.SESSION_MEMORY]);
  return normalizeSessionMemory(data[AGENT_STORAGE_KEYS.SESSION_MEMORY]);
}

export async function saveSessionMemory(memory) {
  const normalized = normalizeSessionMemory(memory);
  await setStorage({ [AGENT_STORAGE_KEYS.SESSION_MEMORY]: normalized });
  return normalized;
}

export async function beginSessionRun({ runId, planId, title, goal, sourceWorkflowId = null }) {
  const current = await getSessionMemory();
  const startedAt = Date.now();
  const runRecord = {
    runId,
    planId,
    title,
    goal,
    sourceWorkflowId,
    outputs: {},
    stepResults: [],
    status: AGENT_RUN_STATUS.RUNNING,
    startedAt,
    completedAt: null,
    summary: ""
  };
  const historyEntry = {
    runId,
    planId,
    title,
    goal,
    sourceWorkflowId,
    status: AGENT_RUN_STATUS.RUNNING,
    startedAt,
    completedAt: null,
    summary: ""
  };
  const next = {
    ...current,
    currentPlanId: planId,
    currentRunId: runId,
    runs: {
      ...(current.runs || {}),
      [runId]: runRecord
    },
    history: trimNewest([historyEntry, ...(current.history || [])], RUN_HISTORY_LIMIT)
  };
  return saveSessionMemory(next);
}

export async function updateSessionRun(runId, patch = {}) {
  const current = await getSessionMemory();
  const currentRun = current.runs?.[runId] || {};
  const nextRun = {
    ...currentRun,
    ...(patch || {})
  };
  const next = {
    ...current,
    runs: {
      ...(current.runs || {}),
      [runId]: nextRun
    },
    history: (current.history || []).map((entry) => entry.runId === runId
      ? {
        ...entry,
        ...(patch || {})
      }
      : entry)
  };
  return saveSessionMemory(next);
}

export async function appendSessionStepResult(runId, stepResult, outputsPatch = {}) {
  const current = await getSessionMemory();
  const currentRun = current.runs?.[runId] || {};
  const nextRun = {
    ...currentRun,
    outputs: {
      ...(currentRun.outputs || {}),
      ...(outputsPatch || {})
    },
    stepResults: [
      ...(currentRun.stepResults || []),
      stepResult
    ]
  };
  const next = {
    ...current,
    runs: {
      ...(current.runs || {}),
      [runId]: nextRun
    }
  };
  return saveSessionMemory(next);
}

export async function getRecentRunSummaries(limit = 8) {
  const current = await getSessionMemory();
  return trimNewest(current.history || [], limit);
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

export async function getUiState() {
  const data = await getStorage([AGENT_STORAGE_KEYS.UI_STATE]);
  return normalizeUiState(data[AGENT_STORAGE_KEYS.UI_STATE]);
}

export async function saveUiState(state) {
  const normalized = normalizeUiState(state);
  await setStorage({ [AGENT_STORAGE_KEYS.UI_STATE]: normalized });
  return normalized;
}

export async function updateUiState(patch = {}) {
  const current = await getUiState();
  return saveUiState({
    ...current,
    ...(patch || {})
  });
}

export async function getAgentSnapshot() {
  await initializeAgentStorage();
  const [
    settings,
    chatThread,
    copilotThread,
    copilotHistory,
    copilotState,
    draftPlan,
    currentRun,
    savedWorkflows,
    sessionMemory,
    userMemory,
    domainMemory,
    uiState,
    activeTabContext
  ] = await Promise.all([
    getSettings(),
    getChatThread(),
    getCopilotThread(),
    getCopilotHistory(),
    getCopilotState(),
    getDraftPlan(),
    getCurrentRun(),
    getSavedWorkflows(),
    getSessionMemory(),
    getUserMemory(),
    getDomainMemory(),
    getUiState(),
    getActiveTabContext()
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

  const selectedWorkflow = (uiState.selectedWorkflowId && draftPlan?.id === uiState.selectedWorkflowId)
    ? draftPlan
    : savedWorkflows.find((workflow) => workflow.id === uiState.selectedWorkflowId) || null;
  const activeWorkflow = buildActiveWorkflow({
    currentRun,
    draftPlan,
    savedWorkflows,
    selectedWorkflow
  });

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
    copilotThread,
    copilotHistory,
    copilotState,
    draftPlan,
    currentRun,
    savedWorkflows,
    selectedWorkflow,
    activeWorkflow,
    recentRuns: trimNewest(sessionMemory.history || [], 8),
    copilotContext: activeTabContext,
    memory: {
      session: sessionMemory,
      user: userMemory,
      activeDomain: activeHostname ? domainMemory[activeHostname] || null : null,
      domains: domainMemory
    },
    ui: {
      needsApiKey: !providerConfig.apiKey,
      canExecute: Boolean(draftPlan && draftPlan.status === "approved")
        && ![AGENT_RUN_STATUS.RUNNING, AGENT_RUN_STATUS.PAUSED_FOR_STEP_APPROVAL].includes(currentRun.status),
      ...uiState
    }
  };
}
