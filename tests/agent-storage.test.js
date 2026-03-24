import test from "node:test";
import assert from "node:assert/strict";

import { AGENT_RUN_STATUS } from "../src/shared/constants.js";
import {
  appendCopilotMessages,
  deleteCopilotConversation,
  getAgentSnapshot,
  getCopilotHistory,
  getSavedWorkflows,
  initializeAgentStorage,
  loadCopilotConversation,
  replaceCurrentRun,
  resetCopilotConversation,
  saveDraftPlan,
  syncActiveCopilotConversation,
  upsertSavedWorkflow
} from "../src/background/agent-storage.js";
import { initializeStorage } from "../src/background/storage.js";
import { createChromeStub } from "../test-support/chrome-stub.js";

function installChromeStub(initialStorage = {}) {
  global.chrome = createChromeStub(initialStorage).chrome;
}

async function seedStorage() {
  await initializeStorage();
  await initializeAgentStorage();
}

test.beforeEach(async () => {
  installChromeStub();
  await seedStorage();
});

test("initializeAgentStorage seeds starter workflows for a fresh install", async () => {
  const workflows = await getSavedWorkflows();
  assert.ok(workflows.length >= 3);
  assert.equal(workflows[0].steps.length > 0, true);
});

test("getAgentSnapshot exposes a normalized active workflow for running template executions", async () => {
  await upsertSavedWorkflow({
    id: "workflow-1",
    title: "Saved workflow",
    goal: "Open a page",
    summary: "Reusable flow",
    steps: [
      {
        id: "step-1",
        kind: "open_url",
        label: "Open example",
        args: {
          url: "https://example.com"
        }
      }
    ]
  });

  await saveDraftPlan({
    id: "plan-run-1",
    sourceWorkflowId: "workflow-1",
    title: "Saved workflow",
    goal: "Open a page",
    status: "approved",
    requiredOrigins: ["https://example.com/*"],
    steps: [
      {
        id: "step-1",
        kind: "open_url",
        label: "Open example",
        args: {
          url: "https://example.com"
        }
      }
    ]
  });

  await replaceCurrentRun({
    runId: "run-1",
    planId: "plan-run-1",
    sourceWorkflowId: "workflow-1",
    sourceWorkflowTitle: "Saved workflow",
    status: AGENT_RUN_STATUS.RUNNING,
    currentStepIndex: 0,
    activeUrl: "https://example.com"
  });

  const snapshot = await getAgentSnapshot();

  assert.deepEqual(snapshot.activeWorkflow, {
    workflowId: "workflow-1",
    savedWorkflowId: "workflow-1",
    planId: "plan-run-1",
    title: "Saved workflow",
    status: AGENT_RUN_STATUS.RUNNING,
    hasActiveRun: true
  });
});

test("copilot history syncs, loads, and deletes conversations", async () => {
  await appendCopilotMessages([
    {
      id: "chat-1",
      type: "user_message",
      content: "Summarize this page",
      data: {},
      timestamp: Date.now()
    },
    {
      id: "chat-2",
      type: "final_result",
      content: "Summary ready",
      data: {},
      timestamp: Date.now()
    }
  ]);

  const conversation = await syncActiveCopilotConversation({
    titleHint: "Summarize this page"
  });
  let history = await getCopilotHistory();

  assert.equal(history.length, 1);
  assert.equal(history[0].id, conversation.id);
  assert.equal(history[0].title, "Summarize this page");

  await resetCopilotConversation();
  await loadCopilotConversation(conversation.id);
  const snapshot = await getAgentSnapshot();
  assert.equal(snapshot.copilotThread.length, 2);
  assert.equal(snapshot.copilotState.activeConversationId, conversation.id);

  await deleteCopilotConversation(conversation.id);
  history = await getCopilotHistory();
  assert.equal(history.length, 0);
});
