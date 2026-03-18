import { MESSAGE_TYPES } from "./src/shared/messages.js";

const elements = {
  providerStatus: document.getElementById("provider-status"),
  runStatus: document.getElementById("run-status"),
  workspaceNote: document.getElementById("workspace-note"),
  workflowList: document.getElementById("workflow-list"),
  openWorkspace: document.getElementById("open-workspace"),
  openOptions: document.getElementById("open-options")
};

function formatStatus(status) {
  return String(status || "idle")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

async function sendMessage(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, payload });
  if (!response?.ok) {
    throw new Error(response?.error || "Unknown extension error");
  }
  return response.snapshot;
}

async function openWorkspace() {
  const [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });
  await chrome.sidePanel.setOptions({
    enabled: true,
    path: "sidepanel.html"
  });
  await chrome.sidePanel.open({
    windowId: activeTab?.windowId
  });
}

function renderWorkflows(snapshot) {
  elements.workflowList.innerHTML = "";
  const workflows = snapshot.savedWorkflows || [];
  if (!workflows.length) {
    const empty = document.createElement("p");
    empty.className = "workflow-empty";
    empty.textContent = "No saved workflows yet. Draft one in the sidepanel and save it for reuse.";
    elements.workflowList.append(empty);
    return;
  }

  for (const workflow of workflows.slice(0, 4)) {
    const card = document.createElement("article");
    card.className = "workflow-card";

    const meta = document.createElement("div");
    meta.className = "workflow-meta";

    const titleWrap = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = workflow.title || "Untitled workflow";
    const label = document.createElement("small");
    label.textContent = `${(workflow.steps || []).length} steps`;
    titleWrap.append(title, label);

    const loadButton = document.createElement("button");
    loadButton.type = "button";
    loadButton.className = "ghost";
    loadButton.textContent = "Load";
    loadButton.addEventListener("click", () => {
      void openWorkspace()
        .then(() => sendMessage(MESSAGE_TYPES.LOAD_WORKFLOW, { workflowId: workflow.id }))
        .then(renderSnapshot)
        .catch((error) => {
          elements.workspaceNote.textContent = error.message;
        });
    });

    const summary = document.createElement("p");
    summary.textContent = workflow.summary || workflow.goal || "Saved browser workflow";

    meta.append(titleWrap, loadButton);
    card.append(meta, summary);
    elements.workflowList.append(card);
  }
}

function renderSnapshot(snapshot) {
  const provider = snapshot.providerStatus;
  elements.providerStatus.textContent = provider.configured
    ? `${provider.provider} · ${provider.model}`
    : "Add API key in settings";
  elements.runStatus.textContent = formatStatus(snapshot.currentRun?.status);
  elements.workspaceNote.textContent = provider.configured
    ? "The sidepanel is ready for chat-driven planning."
    : "Add a provider key before planning or running workflows.";
  renderWorkflows(snapshot);
}

async function refresh() {
  const snapshot = await sendMessage(MESSAGE_TYPES.GET_AGENT_SNAPSHOT);
  renderSnapshot(snapshot);
}

elements.openWorkspace.addEventListener("click", () => {
  void openWorkspace().catch((error) => {
    elements.workspaceNote.textContent = error.message;
  });
});

elements.openOptions.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === MESSAGE_TYPES.AGENT_STATUS_UPDATE && message.payload) {
    renderSnapshot(message.payload);
  }
});

void refresh().catch((error) => {
  elements.workspaceNote.textContent = error.message;
});
