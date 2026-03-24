import { MESSAGE_TYPES } from "./src/shared/messages.js";

const elements = {
  heroCopy: document.getElementById("hero-copy"),
  memoryStatus: document.getElementById("memory-status"),
  userMemory: document.getElementById("user-memory"),
  savedWorkflows: document.getElementById("saved-workflows"),
  domainMemory: document.getElementById("domain-memory")
};

async function sendMessage(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, payload });
  if (!response?.ok) {
    throw new Error(response?.error || "Unknown extension error");
  }
  return response.snapshot;
}

function createCard(title, description, items = []) {
  const card = document.createElement("article");
  card.className = "memory-card";

  const heading = document.createElement("strong");
  heading.textContent = title;
  const copy = document.createElement("p");
  copy.textContent = description;
  card.append(heading, copy);

  if (items.length) {
    const list = document.createElement("ul");
    for (const item of items) {
      const row = document.createElement("li");
      row.textContent = item;
      list.append(row);
    }
    card.append(list);
  }

  return card;
}

function renderSnapshot(snapshot) {
  const preferences = snapshot.memory?.user?.preferences || [];
  const notes = snapshot.memory?.user?.notes || [];
  const domains = snapshot.memory?.domains || {};
  const workflows = snapshot.savedWorkflows || [];

  elements.memoryStatus.textContent = `${preferences.length + notes.length} notes`;
  elements.heroCopy.textContent = workflows.length
    ? `FlowAgent currently has ${workflows.length} saved workflow${workflows.length > 1 ? "s" : ""}, ${snapshot.recentRuns?.length || 0} recent runs, and ${Object.keys(domains).length} domain memories.`
    : "FlowAgent remembers user notes, selectors, and saved workflows here.";

  elements.userMemory.innerHTML = "";
  if (!preferences.length && !notes.length) {
    elements.userMemory.append(createCard("Nothing saved yet", "Add notes from the sidepanel and they will appear here."));
  } else {
    elements.userMemory.append(createCard(
      "User preferences",
      "These notes are added to planner context deterministically.",
      [...preferences.map((item) => `Preference: ${item}`), ...notes.map((item) => `Note: ${item}`)]
    ));
  }

  elements.savedWorkflows.innerHTML = "";
  if (!workflows.length) {
    elements.savedWorkflows.append(createCard("No workflows yet", "Save a workflow from the chat panel after you approve it."));
  } else {
    for (const workflow of workflows) {
      const templateInputs = (workflow.templateInputs || []).map((input) => `Input: ${input.label} -> ${input.key} (default ${input.defaultValue || "empty"})`);
      elements.savedWorkflows.append(createCard(
        workflow.title || "Untitled workflow",
        `${workflow.summary || workflow.goal || "Saved workflow"} · ${workflow.runCount || 0} runs · ${workflow.lastRunAt ? `last run ${new Date(workflow.lastRunAt).toLocaleString()}` : "never run"}`,
        [
          ...(workflow.steps || []).slice(0, 6).map((step, index) => `${index + 1}. ${step.label} (${step.kind})`),
          ...templateInputs
        ]
      ));
    }
  }

  elements.domainMemory.innerHTML = "";
  const domainEntries = Object.entries(domains);
  if (!domainEntries.length) {
    elements.domainMemory.append(createCard("No domain memory yet", "Selectors are learned after successful browser runs."));
  } else {
    for (const [hostname, domain] of domainEntries) {
      const selectors = Object.values(domain.selectors || {}).map((selector) => `${selector.label || selector.key}: ${selector.selector}`);
      elements.domainMemory.append(createCard(
        hostname,
        (domain.notes || []).join(" ") || "Remembered selectors and notes for this hostname.",
        selectors
      ));
    }
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === MESSAGE_TYPES.AGENT_STATUS_UPDATE && message.payload) {
    renderSnapshot(message.payload);
  }
});

void sendMessage(MESSAGE_TYPES.GET_AGENT_SNAPSHOT)
  .then(renderSnapshot)
  .catch((error) => {
    elements.memoryStatus.textContent = "Error";
    elements.heroCopy.textContent = error.message;
  });
