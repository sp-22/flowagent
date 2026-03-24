import {
  AGENT_RUN_STATUS,
  AGENT_TABS,
  APPROVAL_MODES,
  FAILURE_MODES,
  WORKFLOW_STEP_KINDS
} from "./src/shared/constants.js";
import { isRiskyStep } from "./src/shared/agent.js";
import { MESSAGE_TYPES } from "./src/shared/messages.js";
import { getProviderFallbackModels, getProviderPreset } from "./src/shared/llm-providers.js";

const MESSAGE_LABELS = {
  user_message: "You",
  assistant_plan: "Plan",
  assistant_question: "Question",
  approval_request: "Approval",
  tool_event: "Task",
  step_result: "Step",
  error_event: "Error",
  final_result: "Result"
};

const RUNNING_STATUSES = new Set([
  AGENT_RUN_STATUS.RUNNING,
  AGENT_RUN_STATUS.PAUSED,
  AGENT_RUN_STATUS.PAUSED_FOR_STEP_APPROVAL,
  AGENT_RUN_STATUS.PAUSED_FOR_ERROR
]);

const DANGER_STATUSES = new Set([
  AGENT_RUN_STATUS.ERROR,
  AGENT_RUN_STATUS.PAUSED_FOR_ERROR
]);

const elements = {
  tabWorkflows: document.getElementById("tab-workflows"),
  tabCopilot: document.getElementById("tab-copilot"),
  modelPill: document.getElementById("model-pill"),
  utilityToggle: document.getElementById("utility-toggle"),
  utilityMenu: document.getElementById("utility-menu"),
  utilityState: document.getElementById("utility-state"),
  accountSelect: document.getElementById("account-select"),
  modelSelect: document.getElementById("model-select"),
  memoryWindow: document.getElementById("memory-window"),
  keysButton: document.getElementById("keys-button"),
  workflowsPane: document.getElementById("workflows-pane"),
  copilotPane: document.getElementById("copilot-pane"),
  accountSheet: document.getElementById("account-sheet"),
  closeSheet: document.getElementById("close-sheet"),
  accountList: document.getElementById("account-list"),
  accountForm: document.getElementById("account-form"),
  accountProvider: document.getElementById("account-provider"),
  accountLabel: document.getElementById("account-label"),
  accountKey: document.getElementById("account-key"),
  accountBaseUrl: document.getElementById("account-base-url"),
  settingsMaxOutputTokens: document.getElementById("settings-max-output-tokens"),
  settingsPromptSuffix: document.getElementById("settings-prompt-suffix"),
  refreshModels: document.getElementById("refresh-models"),
  sheetStatus: document.getElementById("sheet-status")
};

const state = {
  snapshot: null,
  workingPlan: null,
  dirtyPlan: false,
  invalidStepIds: new Set(),
  editingStepId: null,
  editingAccountId: null,
  pendingWorkflowPrompt: "",
  isSendingWorkflowPrompt: false,
  pendingCopilotPrompt: "",
  isSendingCopilotPrompt: false,
  templateDraft: null,
  templateDraftDirty: false,
  showTemplateEditor: false,
  preparedRun: null,
  utilityOpen: false,
  workflowListMode: "library",
  copilotMode: "chat",
  showWorkflowComposer: false
};

function clone(value) {
  return value ? JSON.parse(JSON.stringify(value)) : value;
}

function formatStatus(status) {
  return String(status || AGENT_RUN_STATUS.IDLE)
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatDateTime(timestamp) {
  if (!timestamp) {
    return "Never";
  }
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    }).format(new Date(timestamp));
  } catch {
    return new Date(timestamp).toLocaleString();
  }
}

function createStepId() {
  if (globalThis.crypto?.randomUUID) {
    return `step-${crypto.randomUUID()}`;
  }
  return `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createEmptyStep() {
  return {
    id: createStepId(),
    kind: "open_url",
    label: "New step",
    args: {
      url: "https://example.com"
    },
    outputKey: "",
    approvalMode: APPROVAL_MODES.AUTO,
    onFailure: FAILURE_MODES.STOP,
    timeoutMs: null
  };
}

function getActiveAccount(snapshot = state.snapshot) {
  if (!snapshot) {
    return null;
  }
  const accounts = snapshot.llmAccounts || [];
  return accounts.find((account) => account.id === snapshot.activeLlmAccountId) || accounts[0] || null;
}

function getAvailableModels(account) {
  if (!account) {
    return [];
  }
  return account.availableModels?.length
    ? account.availableModels
    : getProviderFallbackModels(account.providerId);
}

function hasActiveRun(snapshot = state.snapshot) {
  return RUNNING_STATUSES.has(snapshot?.currentRun?.status);
}

function createMessageCard(entry, options = {}) {
  const card = document.createElement("article");
  const kindClass = entry.type === "user_message"
    ? "user"
    : entry.type === "error_event"
      ? "error"
      : "assistant";
  card.className = `message-card ${kindClass}${options.copilot ? " copilot-message" : ""}`;

  const badge = document.createElement("div");
  badge.className = "message-badge";
  badge.textContent = MESSAGE_LABELS[entry.type] || "Agent";
  card.append(badge);

  const content = document.createElement("p");
  content.textContent = entry.content || "";
  card.append(content);

  if (entry.data?.outputPreview) {
    const preview = document.createElement("pre");
    preview.textContent = entry.data.outputPreview;
    card.append(preview);
  }

  if (entry.pending) {
    const meta = document.createElement("p");
    meta.className = "message-meta";
    meta.textContent = "Sending...";
    card.append(meta);
  }

  return card;
}

function createButton(label, className, onClick, disabled = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener("click", () => {
    try {
      const result = onClick?.();
      if (result && typeof result.catch === "function") {
        result.catch((error) => setSheetStatus(error.message, true));
      }
    } catch (error) {
      setSheetStatus(error.message, true);
    }
  });
  return button;
}

function createPill(text, className = "") {
  const pill = document.createElement("span");
  pill.className = `pill${className ? ` ${className}` : ""}`;
  pill.textContent = text;
  return pill;
}

function createSectionBlock(title, note = "") {
  const section = document.createElement("section");
  section.className = "section-block";
  const head = document.createElement("div");
  head.className = "section-head";
  const titleNode = document.createElement("div");
  titleNode.className = "section-title";
  titleNode.textContent = title;
  head.append(titleNode);
  section.append(head);
  if (note) {
    const copy = document.createElement("p");
    copy.className = "muted-copy";
    copy.textContent = note;
    section.append(copy);
  }
  return section;
}

function createEmptyState(title, copy, actions = []) {
  const card = document.createElement("section");
  card.className = "empty-state";

  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "FlowAgent";

  const heading = document.createElement("h2");
  heading.textContent = title;

  const body = document.createElement("p");
  body.className = "empty-copy";
  body.textContent = copy;

  card.append(eyebrow, heading, body);
  if (actions.length) {
    const row = document.createElement("div");
    row.className = "empty-actions";
    for (const action of actions) {
      row.append(action);
    }
    card.append(row);
  }
  return card;
}

function createDisclosure(title, meta = "", open = false) {
  const details = document.createElement("details");
  details.className = "disclosure";
  details.open = Boolean(open);

  const summary = document.createElement("summary");
  const label = document.createElement("div");
  label.className = "section-title";
  label.textContent = title;
  summary.append(label);
  if (meta) {
    summary.append(createPill(meta));
  }
  details.append(summary);

  const body = document.createElement("div");
  body.className = "disclosure-body";
  details.append(body);
  return { details, body };
}

function setSheetStatus(message, danger = false) {
  elements.sheetStatus.textContent = message;
  elements.sheetStatus.className = `status-pill${danger ? " danger" : " muted"}`;
}

function setUtilityOpen(open) {
  state.utilityOpen = Boolean(open);
  elements.utilityMenu.hidden = !state.utilityOpen;
}

function setAccountSheetOpen(open) {
  if (open) {
    elements.accountSheet.hidden = false;
    elements.accountSheet.removeAttribute("hidden");
    elements.accountSheet.style.display = "grid";
    return;
  }
  elements.accountSheet.hidden = true;
  elements.accountSheet.setAttribute("hidden", "");
  elements.accountSheet.style.display = "none";
}

function openAccountSheet() {
  setUtilityOpen(false);
  setAccountSheetOpen(true);
  if (!state.editingAccountId) {
    resetAccountForm(state.snapshot);
  }
}

function closeAccountSheet() {
  setAccountSheetOpen(false);
  setSheetStatus("Ready");
}

function resetAccountForm(snapshot = state.snapshot) {
  state.editingAccountId = null;
  const preset = getProviderPreset("openai");
  elements.accountProvider.value = "openai";
  elements.accountLabel.value = "";
  elements.accountKey.value = "";
  elements.accountBaseUrl.value = preset.defaultBaseUrl;
  elements.settingsMaxOutputTokens.value = snapshot?.settings?.maxOutputTokens || 300;
  elements.settingsPromptSuffix.value = snapshot?.settings?.customPromptSuffix || "";
}

function loadAccountIntoForm(account) {
  state.editingAccountId = account.id;
  elements.accountProvider.value = account.providerId;
  elements.accountLabel.value = account.label || "";
  elements.accountKey.value = account.apiKey || "";
  elements.accountBaseUrl.value = account.apiBaseUrl || getProviderPreset(account.providerId).defaultBaseUrl;
  setSheetStatus(`Editing ${account.label}`);
}

function syncWorkingPlan(snapshot) {
  const draftPlan = snapshot?.draftPlan || null;
  if (!draftPlan) {
    state.workingPlan = null;
    state.dirtyPlan = false;
    state.invalidStepIds = new Set();
    state.editingStepId = null;
    return;
  }

  const shouldReplace = !state.workingPlan
    || state.workingPlan.id !== draftPlan.id
    || !state.dirtyPlan;

  if (shouldReplace) {
    state.workingPlan = clone(draftPlan);
    state.dirtyPlan = false;
    state.invalidStepIds = new Set();
  }
}

function syncTemplateDraft(snapshot) {
  const saveDraft = snapshot?.ui?.saveWorkflowDraft || null;
  if (!saveDraft) {
    if (!state.showTemplateEditor) {
      state.templateDraft = null;
      state.templateDraftDirty = false;
    }
    return;
  }
  const shouldReplace = !state.templateDraft
    || state.templateDraft.workflowId !== saveDraft.workflowId
    || !state.templateDraftDirty;
  if (shouldReplace) {
    state.templateDraft = clone(saveDraft);
    state.templateDraftDirty = false;
  }
}

function updatePlanField(field, value) {
  if (!state.workingPlan) {
    return;
  }
  state.workingPlan[field] = value;
  state.dirtyPlan = true;
}

function updateStep(stepId, updater) {
  if (!state.workingPlan) {
    return;
  }
  state.workingPlan.steps = state.workingPlan.steps.map((step) => {
    if (step.id !== stepId) {
      return step;
    }
    return typeof updater === "function" ? updater(step) : { ...step, ...updater };
  });
  state.dirtyPlan = true;
}

function removeStep(stepId) {
  if (!state.workingPlan) {
    return;
  }
  state.workingPlan.steps = state.workingPlan.steps.filter((step) => step.id !== stepId);
  state.invalidStepIds.delete(stepId);
  if (state.editingStepId === stepId) {
    state.editingStepId = null;
  }
  state.dirtyPlan = true;
  renderSnapshot(state.snapshot);
}

function setArgsJson(stepId, textarea) {
  try {
    const parsed = textarea.value.trim() ? JSON.parse(textarea.value) : {};
    updateStep(stepId, { args: parsed });
    textarea.classList.remove("invalid-json");
    state.invalidStepIds.delete(stepId);
  } catch {
    textarea.classList.add("invalid-json");
    state.invalidStepIds.add(stepId);
  }
}

async function sendMessage(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, payload });
  if (!response?.ok) {
    throw new Error(response?.error || "Unknown extension error");
  }
  return response.snapshot;
}

function getWorkflowMessages(snapshot, detail) {
  if (!detail?.workflow) {
    return [];
  }
  const messageThread = snapshot.chatThread || [];
  const planIds = new Set([
    detail.draftPlan?.id,
    detail.runtimePlan?.id,
    detail.savedWorkflow?.id
  ].filter(Boolean));
  const sourceWorkflowId = detail.savedWorkflow?.id || detail.workflow.sourceWorkflowId || null;

  return messageThread.filter((entry) => {
    if (detail.workflow.sourceMessageId && entry.id === detail.workflow.sourceMessageId) {
      return true;
    }
    if (entry.data?.planId && planIds.has(entry.data.planId)) {
      return true;
    }
    if (sourceWorkflowId && entry.data?.sourceWorkflowId === sourceWorkflowId) {
      return true;
    }
    return false;
  });
}

function buildWorkflowDetail(snapshot, workflowId) {
  if (!workflowId) {
    return null;
  }

  const exactDraftPlan = snapshot.draftPlan && snapshot.draftPlan.id === workflowId
    ? snapshot.draftPlan
    : null;

  const savedWorkflow = (snapshot.savedWorkflows || []).find((workflow) => workflow.id === workflowId)
    || (snapshot.activeWorkflow?.savedWorkflowId
      ? (snapshot.savedWorkflows || []).find((workflow) => workflow.id === snapshot.activeWorkflow.savedWorkflowId) || null
      : null);

  const runtimePlan = snapshot.draftPlan && snapshot.currentRun?.planId === snapshot.draftPlan.id
    ? snapshot.draftPlan
    : null;

  const draftPlan = exactDraftPlan;

  const workflow = hasActiveRun(snapshot)
    ? runtimePlan || draftPlan || savedWorkflow
    : draftPlan || savedWorkflow || null;

  if (!workflow) {
    return null;
  }

  return {
    id: workflowId,
    workflow,
    savedWorkflow,
    draftPlan,
    runtimePlan,
    hasActiveRun: hasActiveRun(snapshot) && Boolean(runtimePlan || savedWorkflow)
  };
}

function getCurrentSurface(snapshot) {
  if ((snapshot?.ui?.selectedTab || AGENT_TABS.WORKFLOWS) === AGENT_TABS.COPILOT) {
    return { kind: "copilot", detail: null };
  }

  if (snapshot?.activeWorkflow?.hasActiveRun && snapshot.activeWorkflow.workflowId) {
    return {
      kind: "workflow_detail",
      detail: buildWorkflowDetail(snapshot, snapshot.activeWorkflow.workflowId)
    };
  }

  if (snapshot?.ui?.selectedWorkflowId) {
    return {
      kind: "workflow_detail",
      detail: buildWorkflowDetail(snapshot, snapshot.ui.selectedWorkflowId)
    };
  }

  return { kind: "workflows_inbox", detail: null };
}

function renderTopbar(snapshot) {
  const selectedTab = snapshot?.ui?.selectedTab || AGENT_TABS.WORKFLOWS;
  const providerStatus = snapshot.providerStatus || {};
  const activeAccount = getActiveAccount(snapshot);

  elements.tabWorkflows.classList.toggle("active", selectedTab === AGENT_TABS.WORKFLOWS);
  elements.tabWorkflows.setAttribute("aria-selected", String(selectedTab === AGENT_TABS.WORKFLOWS));
  elements.tabCopilot.classList.toggle("active", selectedTab === AGENT_TABS.COPILOT);
  elements.tabCopilot.setAttribute("aria-selected", String(selectedTab === AGENT_TABS.COPILOT));

  elements.workflowsPane.hidden = selectedTab !== AGENT_TABS.WORKFLOWS;
  elements.copilotPane.hidden = selectedTab !== AGENT_TABS.COPILOT;

  if (snapshot.ui?.needsApiKey) {
    elements.modelPill.textContent = "Add key";
    elements.modelPill.title = "Add your first provider key";
  } else {
    elements.modelPill.textContent = providerStatus.model || activeAccount?.selectedModel || "Model";
    elements.modelPill.title = `${providerStatus.provider || "Model"}${providerStatus.accountLabel ? ` - ${providerStatus.accountLabel}` : ""}`;
  }
  const accounts = snapshot.llmAccounts || [];
  elements.accountSelect.innerHTML = "";
  if (!accounts.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No account";
    elements.accountSelect.append(option);
  } else {
    for (const account of accounts) {
      const option = document.createElement("option");
      option.value = account.id;
      option.textContent = `${account.label} - ${getProviderPreset(account.providerId).label}`;
      option.selected = account.id === snapshot.activeLlmAccountId;
      elements.accountSelect.append(option);
    }
  }
  elements.accountSelect.disabled = !accounts.length;

  elements.modelSelect.innerHTML = "";
  if (!activeAccount) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No model";
    elements.modelSelect.append(option);
  } else {
    for (const model of getAvailableModels(activeAccount)) {
      const option = document.createElement("option");
      option.value = model;
      option.textContent = model;
      option.selected = model === activeAccount.selectedModel;
      elements.modelSelect.append(option);
    }
  }
  elements.modelSelect.disabled = !activeAccount;

  elements.utilityState.textContent = snapshot.ui?.needsApiKey
    ? "Add a provider key to start"
    : `${providerStatus.provider || "Provider"}${providerStatus.accountLabel ? ` - ${providerStatus.accountLabel}` : ""}`;

  elements.utilityMenu.hidden = !state.utilityOpen;
}

function renderAccountSheet(snapshot) {
  const accounts = snapshot.llmAccounts || [];
  elements.accountList.innerHTML = "";

  if (!accounts.length) {
    const empty = document.createElement("article");
    empty.className = "account-row";
    const copy = document.createElement("p");
    copy.className = "account-copy";
    copy.textContent = "No provider accounts saved yet.";
    empty.append(copy);
    elements.accountList.append(empty);
  } else {
    for (const account of accounts) {
      const row = document.createElement("article");
      row.className = "account-row";

      const content = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = account.label;
      const copy = document.createElement("p");
      copy.className = "account-copy";
      copy.textContent = `${getProviderPreset(account.providerId).label} - ${account.selectedModel || "No model selected"} - ${getAvailableModels(account).length} models`;
      content.append(title, copy);

      const actions = document.createElement("div");
      actions.className = "account-actions";
      actions.append(
        createButton("Use", "chrome-button", () => {
          void sendMessage(MESSAGE_TYPES.SET_ACTIVE_LLM_ACCOUNT, { accountId: account.id })
            .then(renderSnapshot)
            .catch((error) => setSheetStatus(error.message, true));
        }, snapshot.activeLlmAccountId === account.id),
        createButton("Edit", "chrome-button", () => {
          loadAccountIntoForm(account);
        }),
        createButton("Refresh", "chrome-button", () => {
          void refreshModels(account.id);
        }),
        createButton("Delete", "danger-button", () => {
          void sendMessage(MESSAGE_TYPES.DELETE_LLM_ACCOUNT, { accountId: account.id })
            .then((nextSnapshot) => {
              if (state.editingAccountId === account.id) {
                resetAccountForm(nextSnapshot);
              }
              renderSnapshot(nextSnapshot);
              setSheetStatus("Account deleted");
            })
            .catch((error) => setSheetStatus(error.message, true));
        })
      );

      row.append(content, actions);
      elements.accountList.append(row);
    }
  }

  if (document.activeElement !== elements.settingsMaxOutputTokens) {
    elements.settingsMaxOutputTokens.value = snapshot.settings?.maxOutputTokens || 300;
  }
  if (document.activeElement !== elements.settingsPromptSuffix) {
    elements.settingsPromptSuffix.value = snapshot.settings?.customPromptSuffix || "";
  }
}

function createCommandBar(snapshot) {
  const shell = document.createElement("section");
  shell.className = "command-shell";

  const bar = document.createElement("div");
  bar.className = "command-bar";

  const textarea = document.createElement("textarea");
  textarea.className = "command-input";
  textarea.placeholder = state.isSendingWorkflowPrompt
    ? "Drafting workflow..."
    : "Describe a workflow...";
  textarea.disabled = state.isSendingWorkflowPrompt;
  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendWorkflowPrompt(textarea.value).catch((error) => setSheetStatus(error.message, true));
    }
  });

  const actions = document.createElement("div");
  actions.className = "command-actions";
  actions.append(
    createButton(
      state.isSendingWorkflowPrompt ? "Sending..." : "Send",
      "primary-button",
      () => sendWorkflowPrompt(textarea.value),
      state.isSendingWorkflowPrompt
    )
  );

  bar.append(textarea, actions);
  shell.append(bar);
  return shell;
}

function renderWorkflowComposerOverlay(snapshot) {
  const overlay = document.createElement("div");
  overlay.className = "workflow-chat-overlay";

  const modal = document.createElement("section");
  modal.className = "workflow-chat-modal";

  const header = document.createElement("div");
  header.className = "workflow-chat-header";
  const titleWrap = document.createElement("div");
  const title = document.createElement("div");
  title.className = "section-title";
  title.textContent = "New workflow";
  const note = document.createElement("p");
  note.className = "muted-copy";
  note.textContent = "Describe what should happen in the browser.";
  titleWrap.append(title, note);
  header.append(
    titleWrap,
    createButton("Close", "ghost-button", () => {
      state.showWorkflowComposer = false;
      renderSnapshot(state.snapshot);
    })
  );
  modal.append(header);

  const thread = document.createElement("div");
  thread.className = "workflow-chat-thread";
  const assistantCard = document.createElement("article");
  assistantCard.className = "message-card assistant";
  const badge = document.createElement("div");
  badge.className = "message-badge";
  badge.textContent = "Agent";
  const content = document.createElement("p");
  content.textContent = "Tell me the workflow, and I will turn it into steps you can review before running.";
  assistantCard.append(badge, content);
  thread.append(assistantCard);

  if (Array.isArray(snapshot.starterPrompts) && snapshot.starterPrompts.length) {
    const promptRow = document.createElement("div");
    promptRow.className = "workflow-prompt-row";
    for (const prompt of snapshot.starterPrompts.slice(0, 3)) {
      promptRow.append(createButton(prompt, "ghost-button", () => {
        const textarea = modal.querySelector(".command-input");
        if (textarea) {
          textarea.value = prompt;
          textarea.focus();
        }
      }));
    }
    thread.append(promptRow);
  }

  modal.append(thread);
  modal.append(createCommandBar(snapshot));
  overlay.append(modal);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      state.showWorkflowComposer = false;
      renderSnapshot(state.snapshot);
    }
  });
  return overlay;
}

function createWorkflowRow(workflow, actions = []) {
  const row = document.createElement("article");
  row.className = "row-card workflow-box";

  const head = document.createElement("div");
  head.className = "row-head";

  const content = document.createElement("div");
  const title = document.createElement("div");
  title.className = "row-title";
  title.textContent = workflow.title || "Untitled workflow";
  const copy = document.createElement("p");
  copy.className = "row-copy";
  copy.textContent = workflow.summary || workflow.goal || `${(workflow.steps || []).length} steps`;
  content.append(title, copy);

  const meta = document.createElement("div");
  meta.className = "list-meta";
  meta.append(
    createPill(`${(workflow.steps || []).length} steps`),
    createPill(`${workflow.runCount || 0} runs`),
    workflow.lastRunStatus
      ? createPill(formatStatus(workflow.lastRunStatus), DANGER_STATUSES.has(workflow.lastRunStatus) ? "danger" : "active")
      : createPill("Template")
  );

  head.append(content, meta);
  row.append(head);

  if (actions.length) {
    const actionRow = document.createElement("div");
    actionRow.className = "row-actions";
    for (const action of actions) {
      actionRow.append(action);
    }
    row.append(actionRow);
  }

  return row;
}

function createPlainRow({ title, summary = "", meta = "", actions = [] }) {
  const row = document.createElement("article");
  row.className = "row-card";

  const head = document.createElement("div");
  head.className = "row-head";

  const content = document.createElement("div");
  const titleNode = document.createElement("div");
  titleNode.className = "row-title";
  titleNode.textContent = title;
  content.append(titleNode);

  if (summary) {
    const copy = document.createElement("p");
    copy.className = "row-copy";
    copy.textContent = summary;
    content.append(copy);
  }

  head.append(content);
  if (meta) {
    head.append(createPill(meta));
  }
  row.append(head);

  if (actions.length) {
    const actionRow = document.createElement("div");
    actionRow.className = "row-actions";
    for (const action of actions) {
      actionRow.append(action);
    }
    row.append(actionRow);
  }

  return row;
}

function createRunRow(run) {
  const row = document.createElement("article");
  row.className = "row-card";

  const head = document.createElement("div");
  head.className = "row-head";

  const content = document.createElement("div");
  const title = document.createElement("div");
  title.className = "row-title";
  title.textContent = run.title || "Recent run";
  const copy = document.createElement("p");
  copy.className = "row-copy";
  copy.textContent = run.summary || `${formatStatus(run.status)} - ${formatDateTime(run.startedAt)}`;
  content.append(title, copy);

  head.append(
    content,
    createPill(formatStatus(run.status), DANGER_STATUSES.has(run.status) ? "danger" : "active")
  );

  row.append(head);

  if (run.sourceWorkflowId) {
    const actionRow = document.createElement("div");
    actionRow.className = "row-actions";
    actionRow.append(
      createButton("Open", "chrome-button", () => {
        void sendMessage(MESSAGE_TYPES.SELECT_WORKFLOW, {
          workflowId: run.sourceWorkflowId
        }).then(renderSnapshot);
      })
    );
    row.append(actionRow);
  }

  return row;
}

function renderWorkflowsInbox(snapshot) {
  const layout = document.createElement("div");
  layout.className = "inbox-layout";

  if (snapshot.ui?.needsApiKey) {
    layout.append(createEmptyState(
      "Add your API key to start",
      "Add a provider key, then create and rerun browser workflows from here.",
      [createButton("Add key", "primary-button", () => {
        openAccountSheet();
      })]
    ));
    return layout;
  }

  const toolbar = document.createElement("div");
  toolbar.className = "surface-toolbar";
  const toolbarLeft = document.createElement("div");
  toolbarLeft.className = "surface-toolbar-left";
  toolbarLeft.append(
    createButton(
      "+",
      "icon-button",
      () => {
        state.showWorkflowComposer = true;
        renderSnapshot(state.snapshot);
      }
    )
  );
  const toolbarRight = document.createElement("div");
  toolbarRight.className = "surface-toolbar-right";
  toolbarRight.append(
    createButton(
      state.workflowListMode === "history" ? "Workflows" : "History",
      "ghost-button",
      () => {
        state.workflowListMode = state.workflowListMode === "history" ? "library" : "history";
        renderSnapshot(state.snapshot);
      }
    )
  );
  toolbar.append(toolbarLeft, toolbarRight);
  layout.append(toolbar);

  if (state.isSendingWorkflowPrompt && state.pendingWorkflowPrompt) {
    layout.append(createPlainRow({
      title: "Drafting workflow",
      summary: state.pendingWorkflowPrompt,
      meta: "Sending"
    }));
  }

  const librarySection = document.createElement("div");
  librarySection.className = "surface-list";

  if (state.workflowListMode === "history") {
    if (!(snapshot.recentRuns || []).length) {
      const empty = document.createElement("p");
      empty.className = "thread-empty";
      empty.textContent = "No runs yet.";
      librarySection.append(empty);
    } else {
      for (const run of snapshot.recentRuns) {
        librarySection.append(createRunRow(run));
      }
    }
    layout.append(librarySection);
    return layout;
  }

  if (snapshot.draftPlan && !hasActiveRun(snapshot) && !snapshot.ui?.selectedWorkflowId) {
    librarySection.append(createPlainRow({
      title: snapshot.draftPlan.title || "Draft workflow",
      summary: snapshot.draftPlan.goal || snapshot.draftPlan.summary || "",
      meta: "Draft",
      actions: [
        createButton("Open", "primary-button", () => {
          void sendMessage(MESSAGE_TYPES.SELECT_WORKFLOW, {
            workflowId: snapshot.draftPlan.sourceWorkflowId || snapshot.draftPlan.id
          }).then(renderSnapshot);
        }),
        createButton("Discard", "ghost-button", () => {
          void discardPlan();
        })
      ]
    }));
  }

  if (!(snapshot.savedWorkflows || []).length) {
    const empty = document.createElement("p");
    empty.className = "thread-empty";
    empty.textContent = snapshot.draftPlan ? "No saved workflows yet." : "No workflows yet.";
    librarySection.append(empty);
  } else {
    const workflowGrid = document.createElement("div");
    workflowGrid.className = "workflow-grid";
    for (const workflow of snapshot.savedWorkflows) {
      workflowGrid.append(createWorkflowRow(workflow, [
        createButton("Open", "primary-button", () => {
          void sendMessage(MESSAGE_TYPES.SELECT_WORKFLOW, {
            workflowId: workflow.id
          }).then(renderSnapshot);
        }),
        createButton("Run", "ghost-button", () => {
          openPreparedRun(workflow);
        })
      ]));
    }
    librarySection.append(workflowGrid);
  }

  layout.append(librarySection);

  if (state.showWorkflowComposer) {
    layout.append(renderWorkflowComposerOverlay(snapshot));
  }

  return layout;
}

function renderDetailSummary(snapshot, detail) {
  const section = document.createElement("section");
  section.className = "detail-summary";

  const back = createButton("Back", "ghost-button detail-back", () => {
    state.preparedRun = null;
    state.showTemplateEditor = false;
    void sendMessage(MESSAGE_TYPES.SELECT_WORKFLOW, {
      workflowId: null
    }).then(renderSnapshot);
  });
  section.append(back);

  const title = document.createElement("h1");
  title.className = "detail-title";
  title.textContent = detail.workflow.title || "Untitled workflow";

  const goal = document.createElement("p");
  goal.className = "detail-goal";
  goal.textContent = detail.workflow.summary || detail.workflow.goal || "Workflow detail";

  const meta = document.createElement("div");
  meta.className = "row-meta";
  meta.append(
    createPill(`${(detail.workflow.steps || []).length} steps`),
    createPill(detail.hasActiveRun
      ? formatStatus(snapshot.currentRun.status)
      : detail.savedWorkflow?.lastRunStatus
        ? formatStatus(detail.savedWorkflow.lastRunStatus)
        : detail.draftPlan?.status === "approved"
          ? "Approved"
          : "Draft",
    detail.hasActiveRun
      ? "active"
      : detail.savedWorkflow?.lastRunStatus && DANGER_STATUSES.has(detail.savedWorkflow.lastRunStatus)
        ? "danger"
        : ""),
    createPill(detail.savedWorkflow?.runCount != null ? `${detail.savedWorkflow.runCount} runs` : "Unsent")
  );
  section.append(title, goal, meta);

  const run = snapshot.currentRun || {};
  const actions = document.createElement("div");
  actions.className = "detail-actions";

  if (detail.hasActiveRun) {
    if (run.status === AGENT_RUN_STATUS.RUNNING) {
      actions.append(createButton("Pause", "chrome-button", () => pauseRun()));
    }
    if (run.status === AGENT_RUN_STATUS.PAUSED) {
      actions.append(createButton("Resume", "primary-button", () => runDraftPlan()));
    }
    if ([AGENT_RUN_STATUS.PAUSED_FOR_STEP_APPROVAL, AGENT_RUN_STATUS.PAUSED_FOR_ERROR].includes(run.status)) {
      actions.append(
        createButton("Approve", "primary-button", () => approvePendingStep("approve")),
        createButton("Skip", "ghost-button", () => approvePendingStep("skip"))
      );
    }
    actions.append(createButton("Stop", "danger-button", () => stopRun()));
  } else if (detail.draftPlan) {
    actions.append(
      createButton("Apply", "chrome-button", () => applyPlanEdits(), !(state.dirtyPlan && state.invalidStepIds.size === 0)),
      createButton("Approve", "ghost-button", () => approvePlan(), detail.draftPlan.status === "approved" || state.invalidStepIds.size > 0),
      createButton("Run", "primary-button", () => runDraftPlan(), detail.draftPlan.status !== "approved" || state.invalidStepIds.size > 0),
      createButton("Save Template", "chrome-button", () => openTemplateEditor(detail.workflow.id)),
      createButton("Discard", "danger-button", () => discardPlan())
    );
  } else {
    actions.append(
      createButton("Run", "primary-button", () => openPreparedRun(detail.savedWorkflow || detail.workflow)),
      createButton("Edit", "chrome-button", () => {
        void sendMessage(MESSAGE_TYPES.LOAD_WORKFLOW, {
          workflowId: detail.savedWorkflow.id
        }).then(renderSnapshot);
      }),
      createButton("Duplicate", "ghost-button", () => {
        void sendMessage(MESSAGE_TYPES.DUPLICATE_WORKFLOW, {
          workflowId: detail.savedWorkflow.id
        }).then(renderSnapshot);
      }),
      createButton("Delete", "danger-button", () => deleteWorkflow(detail.savedWorkflow.id))
    );
  }

  section.append(actions);
  return section;
}

function renderThreadSection(snapshot, detail) {
  const shell = document.createElement("section");
  shell.className = "thread-shell";

  const head = document.createElement("div");
  head.className = "section-head";
  const title = document.createElement("div");
  title.className = "section-title";
  title.textContent = "Task thread";
  head.append(title);
  shell.append(head);

  const run = snapshot.currentRun || {};
  if (detail.hasActiveRun || run.status === AGENT_RUN_STATUS.COMPLETED || run.status === AGENT_RUN_STATUS.ERROR) {
    const statusCard = document.createElement("article");
    statusCard.className = "status-card";
    const statusMeta = document.createElement("div");
    statusMeta.className = "row-meta";
    statusMeta.append(
      createPill(formatStatus(run.status), DANGER_STATUSES.has(run.status) ? "danger" : "active"),
      createPill(run.lastStepResult?.label || run.pendingResolution?.message || "Waiting")
    );
    const statusCopy = document.createElement("p");
    statusCopy.className = "status-copy";
    statusCopy.textContent = run.pendingResolution?.message
      || run.lastStepResult?.outputPreview
      || run.summary
      || run.error
      || "Workflow run in progress.";
    statusCard.append(statusMeta, statusCopy);

    if ([AGENT_RUN_STATUS.PAUSED_FOR_STEP_APPROVAL, AGENT_RUN_STATUS.PAUSED_FOR_ERROR].includes(run.status)) {
      const approvalActions = document.createElement("div");
      approvalActions.className = "approval-actions";
      approvalActions.append(
        createButton("Approve", "primary-button", () => approvePendingStep("approve")),
        createButton("Skip", "ghost-button", () => approvePendingStep("skip")),
        createButton("Stop", "danger-button", () => approvePendingStep("stop"))
      );
      statusCard.append(approvalActions);
    }

    shell.append(statusCard);
  }

  const stack = document.createElement("div");
  stack.className = "message-stack";
  const messages = getWorkflowMessages(snapshot, detail);
  for (const message of messages) {
    stack.append(createMessageCard(message));
  }
  if (!messages.length) {
    const empty = document.createElement("p");
    empty.className = "thread-empty";
    empty.textContent = "Updates appear here.";
    stack.append(empty);
  }
  shell.append(stack);
  return shell;
}

function renderPreparedRunForm(workflow) {
  if (!state.preparedRun || state.preparedRun.workflowId !== workflow.id) {
    return null;
  }
  const form = document.createElement("section");
  form.className = "inline-form";

  const copy = document.createElement("p");
  copy.className = "muted-copy";
  copy.textContent = "Fill the workflow inputs before starting a new run.";
  form.append(copy);

  for (const input of workflow.templateInputs || []) {
    const field = document.createElement("label");
    field.className = "field";
    const span = document.createElement("span");
    span.textContent = input.label;
    const control = document.createElement("input");
    control.className = "run-input";
    control.type = "text";
    control.value = state.preparedRun.values[input.key] ?? input.defaultValue ?? "";
    control.addEventListener("input", (event) => {
      state.preparedRun.values[input.key] = event.target.value;
    });
    field.append(span, control);
    form.append(field);
  }

  const actions = document.createElement("div");
  actions.className = "run-form-actions";
  actions.append(
    createButton("Start run", "primary-button", () => runPreparedWorkflow(workflow.id)),
    createButton("Cancel", "ghost-button", () => {
      state.preparedRun = null;
      renderSnapshot(state.snapshot);
    })
  );
  form.append(actions);
  return form;
}

function renderTemplateEditor(detail) {
  if (!state.showTemplateEditor || !state.templateDraft || state.templateDraft.workflowId !== detail.workflow.id) {
    return null;
  }

  const form = document.createElement("section");
  form.className = "inline-form";

  const copy = document.createElement("p");
  copy.className = "muted-copy";
  copy.textContent = "Choose which workflow fields become reusable inputs.";
  form.append(copy);

  const candidates = state.templateDraft.inputCandidates || [];
  if (!candidates.length) {
    const empty = document.createElement("p");
    empty.className = "thread-empty";
    empty.textContent = "No reusable string fields were found in this workflow.";
    form.append(empty);
  }

  for (const candidate of candidates) {
    const selectedInput = (state.templateDraft.templateInputs || []).find((input) => input.id === candidate.id) || null;
    const row = document.createElement("div");
    row.className = "template-row";

    const info = document.createElement("div");
    info.className = "template-info";
    const label = document.createElement("div");
    label.className = "row-title";
    label.textContent = candidate.label;
    const meta = document.createElement("div");
    meta.className = "template-label";
    meta.textContent = candidate.value;
    info.append(label, meta);

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = Boolean(selectedInput);
    checkbox.addEventListener("change", () => {
      const currentInputs = state.templateDraft.templateInputs || [];
      state.templateDraft.templateInputs = checkbox.checked
        ? [...currentInputs, {
          id: candidate.id,
          key: candidate.suggestedKey,
          label: candidate.label,
          defaultValue: candidate.value,
          stepId: candidate.stepId,
          argKey: candidate.argKey
        }]
        : currentInputs.filter((input) => input.id !== candidate.id);
      state.templateDraftDirty = true;
      renderSnapshot(state.snapshot);
    });

    row.append(info, checkbox);
    form.append(row);

    if (selectedInput) {
      const grid = document.createElement("div");
      grid.className = "field-grid";

      const labelField = document.createElement("label");
      labelField.className = "field";
      const labelSpan = document.createElement("span");
      labelSpan.textContent = "Label";
      const labelInput = document.createElement("input");
      labelInput.type = "text";
      labelInput.value = selectedInput.label;
      labelInput.addEventListener("input", (event) => {
        selectedInput.label = event.target.value;
        state.templateDraftDirty = true;
      });
      labelField.append(labelSpan, labelInput);

      const keyField = document.createElement("label");
      keyField.className = "field";
      const keySpan = document.createElement("span");
      keySpan.textContent = "Key";
      const keyInput = document.createElement("input");
      keyInput.type = "text";
      keyInput.value = selectedInput.key;
      keyInput.addEventListener("input", (event) => {
        selectedInput.key = event.target.value;
        state.templateDraftDirty = true;
      });
      keyField.append(keySpan, keyInput);

      const defaultField = document.createElement("label");
      defaultField.className = "field";
      const defaultSpan = document.createElement("span");
      defaultSpan.textContent = "Default";
      const defaultInput = document.createElement("input");
      defaultInput.type = "text";
      defaultInput.value = selectedInput.defaultValue;
      defaultInput.addEventListener("input", (event) => {
        selectedInput.defaultValue = event.target.value;
        state.templateDraftDirty = true;
      });
      defaultField.append(defaultSpan, defaultInput);

      grid.append(labelField, keyField, defaultField);
      form.append(grid);
    }
  }

  const actions = document.createElement("div");
  actions.className = "detail-actions";
  actions.append(
    createButton("Save template", "primary-button", () => saveWorkflowTemplate(detail.workflow.id)),
    createButton("Cancel", "ghost-button", () => {
      state.showTemplateEditor = false;
      state.templateDraft = null;
      state.templateDraftDirty = false;
      renderSnapshot(state.snapshot);
    })
  );
  form.append(actions);
  return form;
}

function renderTemplateInputs(detail) {
  const workflow = detail.savedWorkflow || detail.workflow;
  const { details, body } = createDisclosure(
    "Template inputs",
    `${(workflow.templateInputs || []).length || 0} reusable`,
    Boolean(state.preparedRun || state.showTemplateEditor)
  );

  const preparedRunForm = detail.savedWorkflow ? renderPreparedRunForm(detail.savedWorkflow) : null;
  if (preparedRunForm) {
    body.append(preparedRunForm);
  }

  const editor = renderTemplateEditor(detail);
  if (editor) {
    body.append(editor);
  }

  if (!(workflow.templateInputs || []).length && !preparedRunForm && !editor) {
    const empty = document.createElement("p");
    empty.className = "thread-empty";
    empty.textContent = "No reusable inputs defined yet.";
    body.append(empty);
  } else if (!editor && !preparedRunForm) {
    for (const input of workflow.templateInputs || []) {
      const row = document.createElement("div");
      row.className = "template-row";
      const info = document.createElement("div");
      info.className = "template-info";
      const label = document.createElement("div");
      label.className = "row-title";
      label.textContent = input.label;
      const meta = document.createElement("div");
      meta.className = "template-label";
      meta.textContent = `${input.key} - default ${input.defaultValue || "empty"}`;
      info.append(label, meta);
      row.append(info);
      body.append(row);
    }
  }

  return details;
}

function renderWorkflowSteps(detail) {
  const plan = detail.draftPlan ? state.workingPlan : (detail.runtimePlan || detail.savedWorkflow);
  const { details, body } = createDisclosure(
    "Steps",
    `${(plan?.steps || []).length || 0} total`,
    Boolean(detail.draftPlan && state.editingStepId)
  );

  const stack = document.createElement("div");
  stack.className = "step-stack";

  for (const [index, step] of (plan?.steps || []).entries()) {
    const card = document.createElement("article");
    card.className = "step-card";

    const head = document.createElement("div");
    head.className = "step-head";
    const info = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = `${index + 1}. ${step.label}`;
    const meta = document.createElement("div");
    meta.className = "step-meta";
    meta.append(
      createPill(step.kind),
      createPill(step.approvalMode === "always" ? "manual" : "auto"),
      createPill(step.onFailure)
    );
    if (isRiskyStep(step)) {
      meta.append(createPill("risky", "danger"));
    }
    info.append(title, meta);
    head.append(info);

    if (detail.draftPlan) {
      const actions = document.createElement("div");
      actions.className = "row-actions";
      actions.append(
        createButton(state.editingStepId === step.id ? "Done" : "Edit", "ghost-button", () => {
          state.editingStepId = state.editingStepId === step.id ? null : step.id;
          renderSnapshot(state.snapshot);
        }),
        createButton("Delete", "danger-button", () => removeStep(step.id), (plan.steps || []).length <= 1)
      );
      head.append(actions);
    }

    const note = document.createElement("p");
    note.className = "step-note";
    note.textContent = JSON.stringify(step.args || {});
    card.append(head, note);

    if (detail.draftPlan && state.editingStepId === step.id) {
      const editor = document.createElement("div");
      editor.className = "step-editor";

      const gridOne = document.createElement("div");
      gridOne.className = "field-grid";

      const labelField = document.createElement("label");
      labelField.className = "field";
      const labelSpan = document.createElement("span");
      labelSpan.textContent = "Label";
      const labelInput = document.createElement("input");
      labelInput.type = "text";
      labelInput.value = step.label || "";
      labelInput.addEventListener("input", (event) => updateStep(step.id, { label: event.target.value }));
      labelField.append(labelSpan, labelInput);

      const kindField = document.createElement("label");
      kindField.className = "field";
      const kindSpan = document.createElement("span");
      kindSpan.textContent = "Kind";
      const kindSelect = document.createElement("select");
      for (const kind of WORKFLOW_STEP_KINDS) {
        const option = document.createElement("option");
        option.value = kind;
        option.textContent = kind;
        option.selected = kind === step.kind;
        kindSelect.append(option);
      }
      kindSelect.addEventListener("change", (event) => updateStep(step.id, { kind: event.target.value }));
      kindField.append(kindSpan, kindSelect);

      gridOne.append(labelField, kindField);

      const gridTwo = document.createElement("div");
      gridTwo.className = "field-grid";

      const outputField = document.createElement("label");
      outputField.className = "field";
      const outputSpan = document.createElement("span");
      outputSpan.textContent = "Output key";
      const outputInput = document.createElement("input");
      outputInput.type = "text";
      outputInput.value = step.outputKey || "";
      outputInput.addEventListener("input", (event) => updateStep(step.id, { outputKey: event.target.value }));
      outputField.append(outputSpan, outputInput);

      const approvalField = document.createElement("label");
      approvalField.className = "field";
      const approvalSpan = document.createElement("span");
      approvalSpan.textContent = "Approval";
      const approvalSelect = document.createElement("select");
      for (const value of Object.values(APPROVAL_MODES)) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value;
        option.selected = value === step.approvalMode;
        approvalSelect.append(option);
      }
      approvalSelect.addEventListener("change", (event) => updateStep(step.id, { approvalMode: event.target.value }));
      approvalField.append(approvalSpan, approvalSelect);

      gridTwo.append(outputField, approvalField);

      const gridThree = document.createElement("div");
      gridThree.className = "field-grid";

      const failureField = document.createElement("label");
      failureField.className = "field";
      const failureSpan = document.createElement("span");
      failureSpan.textContent = "On failure";
      const failureSelect = document.createElement("select");
      for (const value of Object.values(FAILURE_MODES)) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value;
        option.selected = value === step.onFailure;
        failureSelect.append(option);
      }
      failureSelect.addEventListener("change", (event) => updateStep(step.id, { onFailure: event.target.value }));
      failureField.append(failureSpan, failureSelect);

      const timeoutField = document.createElement("label");
      timeoutField.className = "field";
      const timeoutSpan = document.createElement("span");
      timeoutSpan.textContent = "Timeout (ms)";
      const timeoutInput = document.createElement("input");
      timeoutInput.type = "number";
      timeoutInput.value = step.timeoutMs || "";
      timeoutInput.addEventListener("input", (event) => {
        updateStep(step.id, { timeoutMs: event.target.value ? Number(event.target.value) : null });
      });
      timeoutField.append(timeoutSpan, timeoutInput);

      gridThree.append(failureField, timeoutField);

      const argsField = document.createElement("label");
      argsField.className = "field";
      const argsSpan = document.createElement("span");
      argsSpan.textContent = "Args JSON";
      const argsTextarea = document.createElement("textarea");
      argsTextarea.value = JSON.stringify(step.args || {}, null, 2);
      argsTextarea.addEventListener("input", () => setArgsJson(step.id, argsTextarea));
      if (state.invalidStepIds.has(step.id)) {
        argsTextarea.classList.add("invalid-json");
      }
      argsField.append(argsSpan, argsTextarea);

      editor.append(gridOne, gridTwo, gridThree, argsField);
      card.append(editor);
    }

    stack.append(card);
  }

  body.append(stack);

  if (detail.draftPlan) {
    const actions = document.createElement("div");
    actions.className = "detail-actions";
    actions.append(createButton("Add step", "ghost-button", () => {
      state.workingPlan.steps.push(createEmptyStep());
      state.dirtyPlan = true;
      renderSnapshot(state.snapshot);
    }));
    body.append(actions);
  }

  return details;
}

function renderWorkflowDetail(snapshot, detail) {
  const layout = document.createElement("div");
  layout.className = "detail-layout";
  layout.append(
    renderDetailSummary(snapshot, detail),
    renderThreadSection(snapshot, detail),
    renderTemplateInputs(detail),
    renderWorkflowSteps(detail)
  );
  return layout;
}

function renderWorkflowsPane(snapshot) {
  elements.workflowsPane.innerHTML = "";
  const surface = getCurrentSurface(snapshot);
  elements.workflowsPane.append(
    surface.kind === "workflow_detail" && surface.detail
      ? renderWorkflowDetail(snapshot, surface.detail)
      : renderWorkflowsInbox(snapshot)
  );
}

function renderCopilotPane(snapshot) {
  elements.copilotPane.innerHTML = "";
  const layout = document.createElement("div");
  layout.className = "copilot-layout";

  if (snapshot.ui?.needsApiKey) {
    layout.append(createEmptyState(
      "Add your API key to use Copilot",
      "Add a provider key first.",
      [createButton("Add key", "primary-button", () => openAccountSheet())]
    ));
    elements.copilotPane.append(layout);
    return;
  }

  const toolbar = document.createElement("div");
  toolbar.className = "surface-toolbar";
  const toolbarLeft = document.createElement("div");
  toolbarLeft.className = "surface-toolbar-left";
  toolbarLeft.append(
    createButton("New chat", "ghost-button", () => {
      state.pendingCopilotPrompt = "";
      state.isSendingCopilotPrompt = false;
      state.copilotMode = "chat";
      void sendMessage(MESSAGE_TYPES.RESET_COPILOT_CHAT).then(renderSnapshot);
    })
  );
  const toolbarRight = document.createElement("div");
  toolbarRight.className = "surface-toolbar-right";
  toolbarRight.append(
    createButton(
      state.copilotMode === "history" ? "Current chat" : "History",
      "ghost-button",
      () => {
        state.copilotMode = state.copilotMode === "history" ? "chat" : "history";
        renderSnapshot(state.snapshot);
      }
    )
  );
  toolbar.append(toolbarLeft, toolbarRight);
  layout.append(toolbar);

  if (state.copilotMode === "history") {
    const historySection = document.createElement("div");
    historySection.className = "surface-list";
    if (!(snapshot.copilotHistory || []).length) {
      const empty = document.createElement("p");
      empty.className = "thread-empty";
      empty.textContent = "No chats yet.";
      historySection.append(empty);
    } else {
      for (const conversation of snapshot.copilotHistory) {
        historySection.append(createPlainRow({
          title: conversation.title || "New chat",
          summary: `${(conversation.messages || []).length} messages`,
          meta: formatDateTime(conversation.updatedAt),
          actions: [
            createButton("Open", "primary-button", () => {
              state.copilotMode = "chat";
              void sendMessage(MESSAGE_TYPES.LOAD_COPILOT_CONVERSATION, {
                conversationId: conversation.id
              }).then(renderSnapshot);
            }),
            createButton("Delete", "ghost-button", () => {
              void sendMessage(MESSAGE_TYPES.DELETE_COPILOT_CONVERSATION, {
                conversationId: conversation.id
              }).then(renderSnapshot);
            })
          ]
        }));
      }
    }
    elements.copilotPane.append(layout);
    return;
  }

  const shell = document.createElement("section");
  shell.className = "chat-shell";

  const contextLine = document.createElement("div");
  contextLine.className = "chat-meta";
  contextLine.append(
    createPill(snapshot.copilotContext?.title || "Current page"),
    snapshot.copilotState?.activeConversationId
      ? createPill("Saved", "active")
      : createPill("New")
  );
  shell.append(contextLine);

  const stack = document.createElement("div");
  stack.className = "message-stack chat-thread";
  for (const entry of snapshot.copilotThread || []) {
    stack.append(createMessageCard(entry, { copilot: true }));
  }
  if (state.pendingCopilotPrompt) {
    stack.append(createMessageCard({
      type: "user_message",
      content: state.pendingCopilotPrompt,
      pending: true
    }, { copilot: true }));
  }
  if (!(snapshot.copilotThread || []).length && !state.pendingCopilotPrompt) {
    const empty = document.createElement("p");
    empty.className = "chat-empty";
    empty.textContent = "Start a new chat about this page.";
    stack.append(empty);
  }
  shell.append(stack);

  const composer = document.createElement("section");
  composer.className = "chat-composer";
  const textarea = document.createElement("textarea");
  textarea.className = "command-input";
  textarea.placeholder = state.isSendingCopilotPrompt
    ? "Sending..."
    : "Ask about this page...";
  textarea.disabled = state.isSendingCopilotPrompt;
  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendCopilotPrompt(textarea.value).catch((error) => setSheetStatus(error.message, true));
    }
  });
  const actions = document.createElement("div");
  actions.className = "command-actions";
  actions.append(
    createButton(
      state.isSendingCopilotPrompt ? "Sending..." : "Send",
      "primary-button",
      () => sendCopilotPrompt(textarea.value),
      state.isSendingCopilotPrompt
    )
  );
  composer.append(textarea, actions);
  shell.append(composer);
  layout.append(shell);

  elements.copilotPane.append(layout);
}

function renderSnapshot(snapshot) {
  state.snapshot = snapshot;
  syncWorkingPlan(snapshot);
  syncTemplateDraft(snapshot);
  renderTopbar(snapshot);
  renderAccountSheet(snapshot);
  renderWorkflowsPane(snapshot);
  renderCopilotPane(snapshot);
}

async function applyPlanEdits() {
  if (!state.workingPlan) {
    return;
  }
  if (state.invalidStepIds.size > 0) {
    throw new Error("Fix invalid JSON before applying plan edits.");
  }
  const snapshot = await sendMessage(MESSAGE_TYPES.UPDATE_DRAFT_PLAN, {
    plan: state.workingPlan
  });
  state.dirtyPlan = false;
  renderSnapshot(snapshot);
}

async function approvePlan() {
  if (state.dirtyPlan) {
    await applyPlanEdits();
  }
  renderSnapshot(await sendMessage(MESSAGE_TYPES.APPROVE_PLAN));
}

async function discardPlan() {
  state.showTemplateEditor = false;
  state.templateDraft = null;
  state.templateDraftDirty = false;
  state.preparedRun = null;
  renderSnapshot(await sendMessage(MESSAGE_TYPES.DISCARD_DRAFT_PLAN));
}

async function requestPlanPermissions(origins = null) {
  const requiredOrigins = origins || state.workingPlan?.requiredOrigins || state.snapshot?.draftPlan?.requiredOrigins || [];
  if (!requiredOrigins.length) {
    return;
  }
  const allowed = await chrome.permissions.contains({ origins: requiredOrigins });
  if (allowed) {
    return;
  }
  const granted = await chrome.permissions.request({ origins: requiredOrigins });
  if (!granted) {
    throw new Error("Site access was denied. Grant site access before running this workflow.");
  }
}

async function runDraftPlan() {
  if (state.invalidStepIds.size > 0) {
    throw new Error("Fix invalid JSON before running the workflow.");
  }
  if (state.dirtyPlan) {
    await applyPlanEdits();
  }
  await requestPlanPermissions();
  renderSnapshot(await sendMessage(MESSAGE_TYPES.EXECUTE_PLAN));
}

async function approvePendingStep(decision) {
  const stepId = state.snapshot?.currentRun?.awaitingApprovalStepId;
  if (!stepId) {
    return;
  }
  renderSnapshot(await sendMessage(MESSAGE_TYPES.APPROVE_STEP, {
    stepId,
    decision
  }));
}

async function pauseRun() {
  renderSnapshot(await sendMessage(MESSAGE_TYPES.PAUSE_EXECUTION));
}

async function stopRun() {
  renderSnapshot(await sendMessage(MESSAGE_TYPES.STOP_EXECUTION));
}

async function deleteWorkflow(workflowId) {
  state.preparedRun = null;
  renderSnapshot(await sendMessage(MESSAGE_TYPES.DELETE_WORKFLOW, { workflowId }));
}

function openPreparedRun(workflow) {
  if (!(workflow.templateInputs || []).length) {
    void runPreparedWorkflow(workflow.id, {});
    return;
  }
  state.preparedRun = {
    workflowId: workflow.id,
    values: Object.fromEntries((workflow.templateInputs || []).map((input) => [input.key, input.defaultValue || ""]))
  };
  renderSnapshot(state.snapshot);
}

async function runPreparedWorkflow(workflowId, values = null) {
  const workflow = (state.snapshot.savedWorkflows || []).find((item) => item.id === workflowId);
  const inputs = values || state.preparedRun?.values || {};
  await requestPlanPermissions(workflow?.requiredOrigins || []);
  state.preparedRun = null;
  renderSnapshot(await sendMessage(MESSAGE_TYPES.RUN_SAVED_WORKFLOW, {
    workflowId,
    inputs
  }));
}

async function openTemplateEditor(workflowId) {
  const snapshot = await sendMessage(MESSAGE_TYPES.UPDATE_WORKFLOW_TEMPLATE_INPUTS, {
    workflowId,
    templateInputs: state.workingPlan?.templateInputs || []
  });
  state.showTemplateEditor = true;
  renderSnapshot(snapshot);
}

async function saveWorkflowTemplate(workflowId) {
  const templateInputs = (state.templateDraft?.templateInputs || []).map((input) => ({
    id: input.id,
    key: input.key,
    label: input.label,
    defaultValue: input.defaultValue,
    stepId: input.stepId,
    argKey: input.argKey
  }));
  state.showTemplateEditor = false;
  state.templateDraft = null;
  state.templateDraftDirty = false;
  renderSnapshot(await sendMessage(MESSAGE_TYPES.SAVE_WORKFLOW_TEMPLATE, {
    workflowId,
    templateInputs
  }));
}

async function sendWorkflowPrompt(rawPrompt) {
  const goal = String(rawPrompt || "").trim();
  if (!goal || state.isSendingWorkflowPrompt) {
    return;
  }
  state.isSendingWorkflowPrompt = true;
  state.pendingWorkflowPrompt = goal;
  renderSnapshot(state.snapshot);
  try {
    const snapshot = await sendMessage(MESSAGE_TYPES.PLAN_FROM_CHAT, { goal });
    state.isSendingWorkflowPrompt = false;
    state.pendingWorkflowPrompt = "";
    state.showWorkflowComposer = false;
    renderSnapshot(snapshot);
  } catch (error) {
    state.isSendingWorkflowPrompt = false;
    state.pendingWorkflowPrompt = "";
    renderSnapshot(state.snapshot);
    throw error;
  }
}

async function sendCopilotPrompt(rawPrompt) {
  const prompt = String(rawPrompt || "").trim();
  if (!prompt || state.isSendingCopilotPrompt) {
    return;
  }
  state.isSendingCopilotPrompt = true;
  state.pendingCopilotPrompt = prompt;
  renderSnapshot(state.snapshot);
  try {
    const snapshot = await sendMessage(MESSAGE_TYPES.CHAT_WITH_PAGE, { prompt });
    state.isSendingCopilotPrompt = false;
    state.pendingCopilotPrompt = "";
    renderSnapshot(snapshot);
  } catch (error) {
    state.isSendingCopilotPrompt = false;
    state.pendingCopilotPrompt = "";
    renderSnapshot(state.snapshot);
    throw error;
  }
}

async function refreshModels(accountId = null) {
  const targetAccountId = accountId || state.editingAccountId || getActiveAccount(state.snapshot)?.id;
  if (!targetAccountId) {
    throw new Error("Save or select an account before refreshing models.");
  }
  setSheetStatus("Refreshing models...");
  const snapshot = await sendMessage(MESSAGE_TYPES.REFRESH_ACCOUNT_MODELS, {
    accountId: targetAccountId
  });
  renderSnapshot(snapshot);
  setSheetStatus("Models refreshed");
}

async function saveAccount() {
  const hadNoAccounts = !(state.snapshot?.llmAccounts || []).length;
  const providerId = elements.accountProvider.value;
  const preset = getProviderPreset(providerId);
  const account = {
    id: state.editingAccountId || undefined,
    providerId,
    label: elements.accountLabel.value.trim() || preset.label,
    apiKey: elements.accountKey.value.trim(),
    apiBaseUrl: elements.accountBaseUrl.value.trim() || preset.defaultBaseUrl
  };

  if (!account.apiKey) {
    throw new Error("Add an API key before saving the account.");
  }

  setSheetStatus("Saving account...");
  let snapshot = await sendMessage(MESSAGE_TYPES.UPSERT_LLM_ACCOUNT, { account });
  const savedAccount = state.editingAccountId
    ? (snapshot.llmAccounts || []).find((item) => item.id === state.editingAccountId)
    : (snapshot.llmAccounts || [])[0];

  if (savedAccount) {
    snapshot = await sendMessage(MESSAGE_TYPES.SET_ACTIVE_LLM_ACCOUNT, {
      accountId: savedAccount.id
    });
    try {
      snapshot = await sendMessage(MESSAGE_TYPES.REFRESH_ACCOUNT_MODELS, {
        accountId: savedAccount.id
      });
    } catch (error) {
      setSheetStatus(error.message, true);
    }
  }

  snapshot = await sendMessage(MESSAGE_TYPES.SAVE_AGENT_SETTINGS, {
    maxOutputTokens: Number(elements.settingsMaxOutputTokens.value) || 300,
    customPromptSuffix: elements.settingsPromptSuffix.value.trim()
  });

  state.editingAccountId = null;
  renderSnapshot(snapshot);
  resetAccountForm(snapshot);
  if (hadNoAccounts) {
    closeAccountSheet();
    return;
  }
  setSheetStatus("Account saved");
}

async function openMemoryWindow() {
  await chrome.windows.create({
    url: chrome.runtime.getURL("options.html"),
    type: "popup",
    width: 980,
    height: 760
  });
}

elements.tabWorkflows.addEventListener("click", () => {
  setUtilityOpen(false);
  void sendMessage(MESSAGE_TYPES.SELECT_AGENT_TAB, {
    tab: AGENT_TABS.WORKFLOWS
  }).then(renderSnapshot).catch((error) => {
    setSheetStatus(error.message, true);
  });
});

elements.tabCopilot.addEventListener("click", () => {
  setUtilityOpen(false);
  void sendMessage(MESSAGE_TYPES.SELECT_AGENT_TAB, {
    tab: AGENT_TABS.COPILOT
  }).then(renderSnapshot).catch((error) => {
    setSheetStatus(error.message, true);
  });
});

elements.utilityToggle.addEventListener("click", () => {
  setUtilityOpen(!state.utilityOpen);
});

elements.keysButton.addEventListener("click", () => {
  openAccountSheet();
});

elements.memoryWindow.addEventListener("click", () => {
  void openMemoryWindow();
});

elements.closeSheet.addEventListener("click", () => {
  closeAccountSheet();
});

elements.accountSheet.addEventListener("click", (event) => {
  if (event.target === elements.accountSheet) {
    closeAccountSheet();
  }
});

elements.accountProvider.addEventListener("change", () => {
  const preset = getProviderPreset(elements.accountProvider.value);
  if (!elements.accountBaseUrl.value || state.editingAccountId === null) {
    elements.accountBaseUrl.value = preset.defaultBaseUrl;
  }
  if (!elements.accountLabel.value.trim()) {
    elements.accountLabel.value = preset.label;
  }
});

elements.accountForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveAccount().catch((error) => {
    setSheetStatus(error.message, true);
  });
});

elements.refreshModels.addEventListener("click", () => {
  void refreshModels().catch((error) => {
    setSheetStatus(error.message, true);
  });
});

elements.accountSelect.addEventListener("change", () => {
  const accountId = elements.accountSelect.value;
  if (!accountId) {
    return;
  }
  void sendMessage(MESSAGE_TYPES.SET_ACTIVE_LLM_ACCOUNT, { accountId })
    .then(renderSnapshot)
    .catch((error) => {
      setSheetStatus(error.message, true);
    });
});

elements.modelSelect.addEventListener("change", () => {
  const activeAccount = getActiveAccount(state.snapshot);
  if (!activeAccount) {
    return;
  }
  void sendMessage(MESSAGE_TYPES.SET_ACTIVE_LLM_ACCOUNT, {
    accountId: activeAccount.id,
    model: elements.modelSelect.value
  }).then(renderSnapshot).catch((error) => {
    setSheetStatus(error.message, true);
  });
});

document.addEventListener("click", (event) => {
  if (!state.utilityOpen) {
    return;
  }
  const target = event.target;
  if (
    target instanceof Node
    && !elements.utilityMenu.contains(target)
    && !elements.utilityToggle.contains(target)
    && !elements.modelPill.contains(target)
  ) {
    setUtilityOpen(false);
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === MESSAGE_TYPES.AGENT_STATUS_UPDATE && message.payload) {
    renderSnapshot(message.payload);
  }
});

void sendMessage(MESSAGE_TYPES.GET_AGENT_SNAPSHOT)
  .then(renderSnapshot)
  .catch((error) => {
    setSheetStatus(error.message, true);
  });
