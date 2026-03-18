import { AGENT_RUN_STATUS, APPROVAL_MODES, FAILURE_MODES, WORKFLOW_STEP_KINDS } from "./src/shared/constants.js";
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

const DANGER_RUN_STATUSES = new Set([
  AGENT_RUN_STATUS.ERROR,
  AGENT_RUN_STATUS.PAUSED_FOR_ERROR
]);

const MUTED_RUN_STATUSES = new Set([
  AGENT_RUN_STATUS.IDLE,
  AGENT_RUN_STATUS.NEEDS_PLAN_APPROVAL,
  AGENT_RUN_STATUS.STOPPED
]);

const elements = {
  accountSelect: document.getElementById("account-select"),
  modelSelect: document.getElementById("model-select"),
  runPill: document.getElementById("run-pill"),
  newChat: document.getElementById("new-chat"),
  memoryWindow: document.getElementById("memory-window"),
  keysButton: document.getElementById("keys-button"),
  thread: document.getElementById("thread"),
  composerHint: document.getElementById("composer-hint"),
  promptInput: document.getElementById("prompt-input"),
  sendPrompt: document.getElementById("send-prompt"),
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
  isSendingPrompt: false,
  pendingPrompt: ""
};

function clone(value) {
  return value ? JSON.parse(JSON.stringify(value)) : value;
}

function formatStatus(status) {
  return String(status || AGENT_RUN_STATUS.IDLE)
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
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

async function sendMessage(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, payload });
  if (!response?.ok) {
    throw new Error(response?.error || "Unknown extension error");
  }
  return response.snapshot;
}

function setSheetStatus(message, danger = false) {
  elements.sheetStatus.textContent = message;
  elements.sheetStatus.className = `status-pill${danger ? " danger" : " muted"}`;
}

function setComposerState(snapshot) {
  const activeAccount = getActiveAccount(snapshot);
  const needsApiKey = snapshot.ui?.needsApiKey;
  const currentStatus = snapshot.currentRun?.status || AGENT_RUN_STATUS.IDLE;

  elements.runPill.textContent = formatStatus(currentStatus);
  elements.runPill.className = `status-pill${DANGER_RUN_STATUSES.has(currentStatus) ? " danger" : MUTED_RUN_STATUSES.has(currentStatus) ? " muted" : ""}`;

  elements.promptInput.disabled = Boolean(needsApiKey);
  elements.sendPrompt.disabled = Boolean(needsApiKey || state.isSendingPrompt);
  elements.sendPrompt.textContent = state.isSendingPrompt ? "Sending..." : "Send";
  elements.promptInput.placeholder = needsApiKey
    ? "Add a provider key first."
    : "Ask the agent to browse, compare, collect, or fill a web workflow.";

  if (needsApiKey) {
    elements.composerHint.textContent = "Add at least one provider account first. Chat stays locked until a key is configured.";
    return;
  }

  elements.composerHint.textContent = state.isSendingPrompt
    ? "Sending your task to the planner..."
    : `Using ${activeAccount?.label || "active account"} · ${activeAccount?.selectedModel || "select a model"}`;
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

function createButton(label, className, onClick, disabled = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener("click", onClick);
  return button;
}

function createPill(text, className = "") {
  const pill = document.createElement("span");
  pill.className = `status-pill${className ? ` ${className}` : ""}`;
  pill.textContent = text;
  return pill;
}

function createStepBadge(text, className = "") {
  const badge = document.createElement("span");
  badge.className = `step-badge${className ? ` ${className}` : ""}`;
  badge.textContent = text;
  return badge;
}

function createMessageNode(entry) {
  const message = document.createElement("article");
  const bubbleClass = entry.type === "user_message"
    ? "user_message"
    : entry.type === "error_event"
      ? "system_message error_event"
      : "assistant_message";
  message.className = `message ${bubbleClass}${entry.pending ? " pending" : ""}`;

  const head = document.createElement("div");
  head.className = "message-head";
  const badge = document.createElement("span");
  badge.className = "message-badge";
  badge.textContent = MESSAGE_LABELS[entry.type] || "Agent";
  head.append(badge);
  message.append(head);

  if (entry.content) {
    const content = document.createElement("p");
    content.textContent = entry.content;
    message.append(content);
  }

  if (entry.pending) {
    const note = document.createElement("p");
    note.className = "inline-note";
    note.textContent = "Sending...";
    message.append(note);
  }

  if (entry.data?.title) {
    const note = document.createElement("p");
    note.className = "inline-note";
    note.textContent = entry.data.title;
    message.append(note);
  }

  if (entry.data?.outputPreview) {
    const preview = document.createElement("pre");
    preview.className = "message-preview";
    preview.textContent = entry.data.outputPreview;
    message.append(preview);
  }

  if (Array.isArray(entry.data?.suggestions) && entry.data.suggestions.length) {
    const chips = document.createElement("div");
    chips.className = "inline-chips";
    for (const suggestion of entry.data.suggestions) {
      chips.append(createButton(suggestion, "ghost", () => {
        elements.promptInput.value = suggestion;
        elements.promptInput.focus();
      }));
    }
    message.append(chips);
  }

  return message;
}

function renderThreadMessages(snapshot) {
  for (const entry of snapshot.chatThread || []) {
    elements.thread.append(createMessageNode(entry));
  }

  if (state.pendingPrompt) {
    elements.thread.append(createMessageNode({
      type: "user_message",
      content: state.pendingPrompt,
      pending: true
    }));
  }
}

function renderNoKeyCard() {
  const card = document.createElement("article");
  card.className = "empty-card";

  const eyebrow = document.createElement("div");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "Setup required";

  const title = document.createElement("h2");
  title.className = "card-title";
  title.textContent = "Add your API key to start";

  const copy = document.createElement("p");
  copy.textContent = "This sidepanel stays chat-first. Save one or more provider accounts here, then pick any available model from the top bar.";

  const actions = document.createElement("div");
  actions.className = "empty-actions";
  actions.append(
    createButton("Add first key", "primary", () => {
      state.editingAccountId = null;
      openAccountSheet();
    }),
    createButton("Open memory window", "ghost", () => {
      void openMemoryWindow();
    })
  );

  card.append(eyebrow, title, copy, actions);
  elements.thread.append(card);
}

function renderWelcomeCard(snapshot) {
  if (snapshot.chatThread?.length) {
    return;
  }

  const card = document.createElement("article");
  card.className = "welcome-card";

  const eyebrow = document.createElement("div");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "New task";

  const title = document.createElement("h2");
  title.className = "card-title";
  title.textContent = "Ask like you would ask a coding agent";

  const copy = document.createElement("p");
  copy.className = "muted-copy";
  copy.textContent = "The workflow draft, approvals, and run updates will stay in this thread. Memory lives in a separate window so the chat stays uncluttered.";

  const suggestions = document.createElement("div");
  suggestions.className = "starter-grid";
  for (const prompt of snapshot.starterPrompts || []) {
    suggestions.append(createButton(prompt, "ghost", () => {
      elements.promptInput.value = prompt;
      elements.promptInput.focus();
    }));
  }

  card.append(eyebrow, title, copy, suggestions);
  elements.thread.append(card);
}

function renderPlanCard(snapshot) {
  const plan = state.workingPlan;
  if (!plan) {
    return;
  }

  const runStatus = snapshot.currentRun?.status || AGENT_RUN_STATUS.IDLE;
  const canApply = state.dirtyPlan && state.invalidStepIds.size === 0;
  const canApprove = plan.status !== "approved" && state.invalidStepIds.size === 0;
  const canRun = plan.status === "approved"
    && state.invalidStepIds.size === 0
    && ![AGENT_RUN_STATUS.RUNNING, AGENT_RUN_STATUS.PAUSED_FOR_STEP_APPROVAL].includes(runStatus);

  const card = document.createElement("article");
  card.className = "plan-card";

  const titleRow = document.createElement("div");
  titleRow.className = "status-row";
  const left = document.createElement("div");
  const kicker = document.createElement("div");
  kicker.className = "card-kicker";
  kicker.textContent = "Task draft";
  const title = document.createElement("h2");
  title.className = "card-title";
  title.textContent = plan.title || "Untitled workflow";
  const summary = document.createElement("p");
  summary.className = "plan-summary";
  summary.textContent = plan.summary || `${plan.steps.length} steps planned from the current request.`;
  const meta = document.createElement("div");
  meta.className = "plan-meta";
  meta.append(
    createPill(`${plan.steps.length} steps`, "muted"),
    createPill(`${plan.requiredOrigins?.length || 0} sites`, "muted"),
    createPill(plan.status === "approved" ? "Approved" : "Needs review", plan.status === "approved" ? "" : "muted")
  );
  left.append(kicker, title, summary, meta);

  titleRow.append(left);

  const goalField = document.createElement("label");
  goalField.className = "field";
  const goalLabel = document.createElement("span");
  goalLabel.textContent = "Goal";
  const goalInput = document.createElement("input");
  goalInput.type = "text";
  goalInput.value = plan.goal || "";
  goalInput.addEventListener("input", (event) => {
    updatePlanField("goal", event.target.value);
  });
  goalField.append(goalLabel, goalInput);

  const stepList = document.createElement("div");
  stepList.className = "step-list";
  plan.steps.forEach((step, index) => {
    const stepCard = document.createElement("article");
    stepCard.className = `step-card${state.editingStepId === step.id ? " editing" : ""}${isRiskyStep(step) ? " risky" : ""}`;

    const head = document.createElement("div");
    head.className = "step-head";

    const textWrap = document.createElement("div");
    const strong = document.createElement("strong");
    strong.textContent = `${index + 1}. ${step.label || `Step ${index + 1}`}`;
    const pills = document.createElement("div");
    pills.className = "step-pills";
    pills.append(
      createStepBadge(step.kind),
      createStepBadge(step.approvalMode === "always" ? "manual approval" : "auto approval"),
      createStepBadge(`on ${step.onFailure}`)
    );
    if (step.outputKey) {
      pills.append(createStepBadge(`out: ${step.outputKey}`));
    }
    if (isRiskyStep(step)) {
      pills.append(createStepBadge("risky", "risky"));
    }
    textWrap.append(strong, pills);

    const actions = document.createElement("div");
    actions.className = "step-actions";
    actions.append(
      createButton(state.editingStepId === step.id ? "Done" : "Edit", "ghost", () => {
        state.editingStepId = state.editingStepId === step.id ? null : step.id;
        renderSnapshot(snapshot);
      }),
      createButton("Delete", "danger", () => {
        removeStep(step.id);
      }, plan.steps.length <= 1)
    );

    head.append(textWrap, actions);
    stepCard.append(head);

    if (state.editingStepId === step.id) {
      const editor = document.createElement("div");
      editor.className = "step-editor";

      const rowOne = document.createElement("div");
      rowOne.className = "field-row";
      const labelField = document.createElement("label");
      labelField.className = "field";
      const labelSpan = document.createElement("span");
      labelSpan.textContent = "Label";
      const labelInput = document.createElement("input");
      labelInput.type = "text";
      labelInput.value = step.label || "";
      labelInput.addEventListener("input", (event) => {
        updateStep(step.id, { label: event.target.value });
      });
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
      kindSelect.addEventListener("change", (event) => {
        updateStep(step.id, { kind: event.target.value });
      });
      kindField.append(kindSpan, kindSelect);
      rowOne.append(labelField, kindField);

      const rowTwo = document.createElement("div");
      rowTwo.className = "field-row";
      const outputField = document.createElement("label");
      outputField.className = "field";
      const outputSpan = document.createElement("span");
      outputSpan.textContent = "Output key";
      const outputInput = document.createElement("input");
      outputInput.type = "text";
      outputInput.value = step.outputKey || "";
      outputInput.addEventListener("input", (event) => {
        updateStep(step.id, { outputKey: event.target.value });
      });
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
      approvalSelect.addEventListener("change", (event) => {
        updateStep(step.id, { approvalMode: event.target.value });
      });
      approvalField.append(approvalSpan, approvalSelect);
      rowTwo.append(outputField, approvalField);

      const rowThree = document.createElement("div");
      rowThree.className = "field-row";
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
      failureSelect.addEventListener("change", (event) => {
        updateStep(step.id, { onFailure: event.target.value });
      });
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
      rowThree.append(failureField, timeoutField);

      const argsField = document.createElement("label");
      argsField.className = "field";
      const argsSpan = document.createElement("span");
      argsSpan.textContent = "Args JSON";
      const argsTextarea = document.createElement("textarea");
      argsTextarea.value = JSON.stringify(step.args || {}, null, 2);
      argsTextarea.addEventListener("input", () => {
        setArgsJson(step.id, argsTextarea);
      });
      if (state.invalidStepIds.has(step.id)) {
        argsTextarea.classList.add("invalid-json");
      }
      argsField.append(argsSpan, argsTextarea);

      editor.append(rowOne, rowTwo, rowThree, argsField);
      stepCard.append(editor);
    }

    stepList.append(stepCard);
  });

  const note = document.createElement("p");
  note.className = "inline-note";
  note.textContent = state.invalidStepIds.size
    ? "Fix invalid JSON before approving or running."
    : "Approvals and risky-step decisions stay in this thread.";

  const cardActions = document.createElement("div");
  cardActions.className = "card-actions";
  cardActions.append(
    createButton("Add step", "ghost", () => {
      state.workingPlan.steps.push(createEmptyStep());
      state.dirtyPlan = true;
      renderSnapshot(snapshot);
    }),
    createButton("Apply edits", "ghost", () => {
      void applyPlanEdits();
    }, !canApply),
    createButton("Dismiss", "danger", () => {
      void discardPlan();
    }),
    createButton("Approve", "ghost", () => {
      void approvePlan();
    }, !canApprove),
    createButton(runStatus === AGENT_RUN_STATUS.PAUSED ? "Resume" : "Run", "primary", () => {
      void runPlan();
    }, !canRun),
    createButton("Save", "ghost", () => {
      void saveWorkflow();
    }, state.invalidStepIds.size > 0)
  );

  card.append(titleRow, goalField, stepList, note, cardActions);
  elements.thread.append(card);
}

function renderTaskCard(snapshot) {
  const run = snapshot.currentRun || {};
  const plan = state.workingPlan || snapshot.draftPlan || null;
  if (!plan || [AGENT_RUN_STATUS.IDLE, AGENT_RUN_STATUS.STOPPED, AGENT_RUN_STATUS.NEEDS_PLAN_APPROVAL].includes(run.status)) {
    return;
  }

  const card = document.createElement("article");
  card.className = `task-card${DANGER_RUN_STATUSES.has(run.status) ? " error" : ""}`;

  const titleRow = document.createElement("div");
  titleRow.className = "status-row";
  const titleWrap = document.createElement("div");
  const kicker = document.createElement("div");
  kicker.className = "card-kicker";
  kicker.textContent = "Task";
  const title = document.createElement("h2");
  title.className = "card-title";
  title.textContent = plan.title || "Workflow run";
  const copy = document.createElement("p");
  copy.className = "task-copy";
  copy.textContent = run.pendingResolution?.message
    || run.error
    || run.summary
    || "Execution updates will keep appearing in this thread.";
  titleWrap.append(kicker, title, copy);

  const pill = createPill(formatStatus(run.status), DANGER_RUN_STATUSES.has(run.status) ? "danger" : MUTED_RUN_STATUSES.has(run.status) ? "muted" : "");
  titleRow.append(titleWrap, pill);

  const facts = document.createElement("div");
  facts.className = "task-facts";
  const currentStep = plan.steps?.[run.currentStepIndex] || run.lastStepResult || null;
  const factItems = [
    { label: "Current step", value: currentStep?.label || "-" },
    { label: "Progress", value: `${Math.min(run.currentStepIndex || 0, plan.steps?.length || 0)} / ${plan.steps?.length || 0}` },
    { label: "Active URL", value: run.activeUrl || "-" }
  ];
  for (const item of factItems) {
    const fact = document.createElement("article");
    fact.className = "task-fact";
    const meta = document.createElement("span");
    meta.className = "step-meta";
    meta.textContent = item.label;
    const value = document.createElement("strong");
    value.textContent = item.value;
    fact.append(meta, value);
    facts.append(fact);
  }

  const actions = document.createElement("div");
  actions.className = "card-actions";
  if ([AGENT_RUN_STATUS.PAUSED_FOR_STEP_APPROVAL, AGENT_RUN_STATUS.PAUSED_FOR_ERROR].includes(run.status) && run.awaitingApprovalStepId) {
    actions.append(
      createButton(run.pendingResolution?.type === "step_failure" ? "Retry step" : "Approve step", "primary", () => {
        void approvePendingStep("approve");
      }),
      createButton("Skip", "ghost", () => {
        void approvePendingStep("skip");
      }),
      createButton("Stop", "danger", () => {
        void approvePendingStep("stop");
      })
    );
  } else {
    if (run.status === AGENT_RUN_STATUS.RUNNING) {
      actions.append(createButton("Pause", "ghost", () => {
        void pauseRun();
      }));
    }
    if (run.status === AGENT_RUN_STATUS.PAUSED) {
      actions.append(createButton("Resume", "primary", () => {
        void runPlan();
      }));
    }
    if (![AGENT_RUN_STATUS.COMPLETED, AGENT_RUN_STATUS.STOPPED].includes(run.status)) {
      actions.append(createButton("Stop run", "danger", () => {
        void stopRun();
      }));
    }
  }

  card.append(titleRow, facts, actions);
  elements.thread.append(card);
}

function renderTopbar(snapshot) {
  const accounts = snapshot.llmAccounts || [];
  const activeAccount = getActiveAccount(snapshot);

  elements.accountSelect.innerHTML = "";
  if (!accounts.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No provider key";
    elements.accountSelect.append(option);
  } else {
    for (const account of accounts) {
      const option = document.createElement("option");
      option.value = account.id;
      option.textContent = `${account.label} · ${getProviderPreset(account.providerId).label}`;
      option.selected = account.id === snapshot.activeLlmAccountId;
      elements.accountSelect.append(option);
    }
  }
  elements.accountSelect.disabled = !accounts.length;

  elements.modelSelect.innerHTML = "";
  if (!activeAccount) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Select model";
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
      copy.textContent = `${getProviderPreset(account.providerId).label} · ${account.selectedModel || "No model selected"} · ${getAvailableModels(account).length} models`;
      content.append(title, copy);

      const actions = document.createElement("div");
      actions.className = "account-actions";
      actions.append(
        createButton("Use", "ghost", () => {
          void sendMessage(MESSAGE_TYPES.SET_ACTIVE_LLM_ACCOUNT, { accountId: account.id })
            .then(renderSnapshot)
            .catch((error) => setSheetStatus(error.message, true));
        }, snapshot.activeLlmAccountId === account.id),
        createButton("Edit", "ghost", () => {
          loadAccountIntoForm(account);
        }),
        createButton("Refresh", "ghost", () => {
          void refreshModels(account.id);
        }),
        createButton("Delete", "danger", () => {
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
  setAccountSheetOpen(true);
  if (!state.editingAccountId) {
    resetAccountForm(state.snapshot);
  }
}

function closeAccountSheet() {
  setAccountSheetOpen(false);
  setSheetStatus("Ready");
}

function renderSnapshot(snapshot) {
  if (state.isSendingPrompt && snapshot?.chatThread?.length) {
    state.isSendingPrompt = false;
    state.pendingPrompt = "";
  }
  state.snapshot = snapshot;
  syncWorkingPlan(snapshot);
  renderTopbar(snapshot);
  renderAccountSheet(snapshot);
  setComposerState(snapshot);

  elements.thread.innerHTML = "";
  renderThreadMessages(snapshot);
  if (snapshot.ui?.needsApiKey) {
    renderNoKeyCard();
  } else {
    renderWelcomeCard(snapshot);
  }
  renderPlanCard(snapshot);
  renderTaskCard(snapshot);
  elements.thread.scrollTop = elements.thread.scrollHeight;
}

async function refresh() {
  renderSnapshot(await sendMessage(MESSAGE_TYPES.GET_AGENT_SNAPSHOT));
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
  const snapshot = await sendMessage(MESSAGE_TYPES.APPROVE_PLAN);
  state.dirtyPlan = false;
  renderSnapshot(snapshot);
}

async function discardPlan() {
  const snapshot = await sendMessage(MESSAGE_TYPES.DISCARD_DRAFT_PLAN);
  state.dirtyPlan = false;
  state.editingStepId = null;
  renderSnapshot(snapshot);
}

async function requestPlanPermissions() {
  const origins = state.workingPlan?.requiredOrigins || state.snapshot?.draftPlan?.requiredOrigins || [];
  if (!origins.length) {
    return;
  }
  const allowed = await chrome.permissions.contains({ origins });
  if (allowed) {
    return;
  }
  const granted = await chrome.permissions.request({ origins });
  if (!granted) {
    throw new Error("Site access was denied. Grant site access before running this workflow.");
  }
}

async function runPlan() {
  if (state.invalidStepIds.size > 0) {
    throw new Error("Fix invalid JSON before running the workflow.");
  }
  if (state.dirtyPlan) {
    await applyPlanEdits();
  }
  await requestPlanPermissions();
  const snapshot = await sendMessage(MESSAGE_TYPES.EXECUTE_PLAN);
  state.dirtyPlan = false;
  renderSnapshot(snapshot);
}

async function saveWorkflow() {
  if (state.dirtyPlan) {
    await applyPlanEdits();
  }
  const snapshot = await sendMessage(MESSAGE_TYPES.SAVE_WORKFLOW);
  state.dirtyPlan = false;
  renderSnapshot(snapshot);
}

async function approvePendingStep(decision) {
  const stepId = state.snapshot?.currentRun?.awaitingApprovalStepId;
  if (!stepId) {
    return;
  }
  if (decision === "approve" && state.dirtyPlan) {
    await applyPlanEdits();
  }
  const snapshot = await sendMessage(MESSAGE_TYPES.APPROVE_STEP, {
    stepId,
    decision
  });
  renderSnapshot(snapshot);
}

async function pauseRun() {
  renderSnapshot(await sendMessage(MESSAGE_TYPES.PAUSE_EXECUTION));
}

async function stopRun() {
  renderSnapshot(await sendMessage(MESSAGE_TYPES.STOP_EXECUTION));
}

async function resetSession() {
  renderSnapshot(await sendMessage(MESSAGE_TYPES.RESET_AGENT_SESSION));
  elements.promptInput.value = "";
  elements.promptInput.focus();
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

async function openMemoryWindow() {
  await chrome.windows.create({
    url: chrome.runtime.getURL("options.html"),
    type: "popup",
    width: 980,
    height: 760
  });
}

elements.newChat.addEventListener("click", () => {
  void resetSession().catch((error) => {
    setSheetStatus(error.message, true);
  });
});

elements.keysButton.addEventListener("click", () => {
  openAccountSheet();
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

elements.memoryWindow.addEventListener("click", () => {
  void openMemoryWindow();
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
  })
    .then(renderSnapshot)
    .catch((error) => {
      setSheetStatus(error.message, true);
    });
});

elements.sendPrompt.addEventListener("click", () => {
  const goal = elements.promptInput.value.trim();
  if (!goal || state.isSendingPrompt) {
    return;
  }

  state.isSendingPrompt = true;
  state.pendingPrompt = goal;
  elements.promptInput.value = "";
  if (state.snapshot) {
    renderSnapshot(state.snapshot);
  } else {
    setComposerState({
      ui: { needsApiKey: false },
      currentRun: { status: AGENT_RUN_STATUS.IDLE },
      llmAccounts: []
    });
  }

  void sendMessage(MESSAGE_TYPES.PLAN_FROM_CHAT, { goal })
    .then((snapshot) => {
      state.isSendingPrompt = false;
      state.pendingPrompt = "";
      renderSnapshot(snapshot);
    })
    .catch((error) => {
      state.isSendingPrompt = false;
      state.pendingPrompt = "";
      if (!elements.promptInput.value.trim()) {
        elements.promptInput.value = goal;
      }
      if (state.snapshot) {
        renderSnapshot(state.snapshot);
      }
      setSheetStatus(error.message, true);
    });
});

elements.promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    elements.sendPrompt.click();
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === MESSAGE_TYPES.AGENT_STATUS_UPDATE && message.payload) {
    if (state.isSendingPrompt) {
      state.isSendingPrompt = false;
      state.pendingPrompt = "";
    }
    renderSnapshot(message.payload);
  }
});

void refresh().catch((error) => {
  setSheetStatus(error.message, true);
});
