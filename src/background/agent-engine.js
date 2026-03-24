import {
  AGENT_TABS,
  AGENT_RUN_STATUS,
  APPROVAL_MODES,
  CHAT_MESSAGE_TYPES,
  DEFAULT_AGENT_RUN_STATE,
  FAILURE_MODES,
  STARTER_PROMPTS,
  WORKFLOW_PLAN_STATUS
} from "../shared/constants.js";
import { MESSAGE_TYPES } from "../shared/messages.js";
import {
  applyTemplateInputsToPlan,
  buildFinalResultMessage,
  buildPlannerMemoryContext,
  buildSelectorMemoryKey,
  createTemplateInputCandidates,
  createChatMessage,
  isDomStep,
  mergeUserMemory,
  normalizeSavedWorkflow,
  normalizeTemplateInputs,
  resolveTemplateVariables,
  upsertDomainSelector,
  validateWorkflowPlan
} from "../shared/agent.js";
import { createId, sleep } from "../shared/utils.js";
import { pageToolExecutor } from "../content/page-tools.js";
import { getSettings, initializeStorage } from "./storage.js";
import {
  appendCopilotMessages,
  appendSessionStepResult,
  beginSessionRun,
  appendChatMessages,
  clearChatThread,
  deleteCopilotConversation,
  deleteSavedWorkflow,
  getAgentSnapshot,
  getCopilotHistory,
  getCopilotState,
  getCopilotThread,
  getCurrentRun,
  getDomainMemory,
  getDraftPlan,
  getSavedWorkflows,
  getSessionMemory,
  getUiState,
  getUserMemory,
  initializeAgentStorage,
  loadCopilotConversation,
  replaceCurrentRun,
  resetCopilotConversation,
  saveDomainMemory,
  saveDraftPlan,
  saveUserMemory,
  setCurrentRun,
  syncActiveCopilotConversation,
  updateSavedWorkflowMetadata,
  updateSessionRun,
  updateUiState,
  upsertSavedWorkflow
} from "./agent-storage.js";
import { chatWithPage, planWorkflow, repairStep, summarizeRun } from "./llm-client.js";

async function broadcastAgentSnapshot() {
  const snapshot = await getAgentSnapshot();
  try {
    await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.AGENT_STATUS_UPDATE,
      payload: snapshot
    });
  } catch {
    // Sidepanel or popup may not be open.
  }
  return snapshot;
}

async function waitForTabComplete(tabId, timeoutMs = 25000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") {
      return tab;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for tab ${tabId} to load.`);
}

function truncateText(text, limit = 900) {
  const safe = String(text || "").trim();
  if (safe.length <= limit) {
    return safe;
  }
  return `${safe.slice(0, limit - 1)}…`;
}

async function getTab(tabId) {
  if (!tabId) {
    return null;
  }
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

function buildWorkflowMessageData({ planId = null, sourceWorkflowId = null, title = "" } = {}) {
  return {
    ...(planId ? { planId } : {}),
    ...(sourceWorkflowId ? { sourceWorkflowId } : {}),
    ...(title ? { title } : {})
  };
}

function buildSaveWorkflowDraft(plan, templateInputs = null) {
  const candidates = createTemplateInputCandidates(plan);
  const nextTemplateInputs = normalizeTemplateInputs(
    templateInputs || plan.templateInputs || [],
    candidates
  );
  return {
    workflowId: plan.id,
    title: plan.title,
    inputCandidates: candidates,
    templateInputs: nextTemplateInputs,
    updatedAt: Date.now()
  };
}

export class AgentEngine {
  constructor(options = {}) {
    this.processing = false;
    this.hooks = {
      planWorkflowImpl: options.planWorkflowImpl || planWorkflow,
      repairStepImpl: options.repairStepImpl || repairStep,
      summarizeRunImpl: options.summarizeRunImpl || summarizeRun,
      chatWithPageImpl: options.chatWithPageImpl || chatWithPage
    };
  }

  scheduleProcess() {
    queueMicrotask(() => {
      void this.process();
    });
  }

  async init() {
    await initializeStorage();
    await initializeAgentStorage();
  }

  async getCurrentPlan() {
    return getDraftPlan();
  }

  async appendChat(type, content, data = {}) {
    await appendChatMessages([createChatMessage(type, content, data)]);
  }

  async appendWorkflowChat(type, content, plan, extraData = {}) {
    await this.appendChat(
      type,
      content,
      {
        ...buildWorkflowMessageData({
          planId: plan?.id || null,
          sourceWorkflowId: extraData.sourceWorkflowId || plan?.id || null,
          title: plan?.title || extraData.title || ""
        }),
        ...extraData
      }
    );
  }

  async appendCopilotChat(type, content, data = {}) {
    await appendCopilotMessages([createChatMessage(type, content, data)]);
  }

  async selectAgentTab(tab) {
    await this.init();
    await updateUiState({
      selectedTab: tab === AGENT_TABS.COPILOT ? AGENT_TABS.COPILOT : AGENT_TABS.WORKFLOWS
    });
    return broadcastAgentSnapshot();
  }

  async selectWorkflow({ workflowId = null }) {
    await this.init();
    await updateUiState({
      selectedTab: AGENT_TABS.WORKFLOWS,
      selectedWorkflowId: workflowId ? String(workflowId).trim() : null
    });
    return broadcastAgentSnapshot();
  }

  async planFromChat({ goal }) {
    await this.init();
    const trimmedGoal = String(goal || "").trim();
    if (!trimmedGoal) {
      throw new Error("Describe the browser task you want automated.");
    }

    const userMessage = createChatMessage(CHAT_MESSAGE_TYPES.USER_MESSAGE, trimmedGoal);
    await appendChatMessages([userMessage]);

    const [userMemory, domainMemory, savedWorkflows, settings] = await Promise.all([
      getUserMemory(),
      getDomainMemory(),
      getSavedWorkflows(),
      getSettings()
    ]);

    try {
      const plannerResponse = await this.hooks.planWorkflowImpl({
        goal: trimmedGoal,
        sourceMessageId: userMessage.id,
        settings,
        memoryContext: buildPlannerMemoryContext({
          goal: trimmedGoal,
          userMemory,
          domainMemory,
          savedWorkflows
        }),
        starterPrompts: STARTER_PROMPTS
      });

      if (plannerResponse.mode === "question") {
        await saveDraftPlan(null);
        await replaceCurrentRun({
          status: AGENT_RUN_STATUS.IDLE,
          planId: null,
          error: ""
        });
        await updateUiState({
          selectedTab: AGENT_TABS.WORKFLOWS,
          selectedWorkflowId: null,
          saveWorkflowDraft: null
        });
        await this.appendChat(CHAT_MESSAGE_TYPES.ASSISTANT_QUESTION, plannerResponse.question, {
          suggestions: plannerResponse.suggestions || []
        });
        return broadcastAgentSnapshot();
      }

      await saveDraftPlan(plannerResponse.plan);
      await updateUiState({
        selectedTab: AGENT_TABS.WORKFLOWS,
        selectedWorkflowId: plannerResponse.plan.id,
        saveWorkflowDraft: null
      });
      await replaceCurrentRun({
        status: AGENT_RUN_STATUS.NEEDS_PLAN_APPROVAL,
        planId: plannerResponse.plan.id,
        currentStepIndex: 0,
        awaitingApprovalStepId: null,
        error: "",
        summary: ""
      });
      await this.appendWorkflowChat(
        CHAT_MESSAGE_TYPES.ASSISTANT_PLAN,
        plannerResponse.plan.summary || `Drafted a ${plannerResponse.plan.steps.length}-step workflow.`,
        plannerResponse.plan
      );
      await this.appendWorkflowChat(
        CHAT_MESSAGE_TYPES.APPROVAL_REQUEST,
        "Review the generated steps, adjust anything you want, then approve the plan before execution.",
        plannerResponse.plan,
        {
          mode: "plan"
        }
      );
      return broadcastAgentSnapshot();
    } catch (error) {
      await replaceCurrentRun({
        status: AGENT_RUN_STATUS.ERROR,
        planId: null,
        error: error.message
      });
      await this.appendChat(CHAT_MESSAGE_TYPES.ERROR_EVENT, error.message);
      return broadcastAgentSnapshot();
    }
  }

  async updateDraftPlan({ plan }) {
    await this.init();
    const validated = validateWorkflowPlan(plan);
    const currentPlan = await getDraftPlan();
    const nextPlan = {
      ...validated,
      id: validated.id || currentPlan?.id || createId("plan"),
      sourceMessageId: validated.sourceMessageId || currentPlan?.sourceMessageId || null,
      status: currentPlan?.status === WORKFLOW_PLAN_STATUS.APPROVED
        ? WORKFLOW_PLAN_STATUS.APPROVED
        : WORKFLOW_PLAN_STATUS.DRAFT
    };
    await saveDraftPlan(nextPlan);
    await updateUiState({
      selectedTab: AGENT_TABS.WORKFLOWS,
      selectedWorkflowId: nextPlan.id
    });
    await setCurrentRun({
      planId: nextPlan.id,
      status: nextPlan.status === WORKFLOW_PLAN_STATUS.APPROVED
        ? AGENT_RUN_STATUS.IDLE
        : AGENT_RUN_STATUS.NEEDS_PLAN_APPROVAL,
      error: ""
    });
    await this.appendWorkflowChat(
      CHAT_MESSAGE_TYPES.TOOL_EVENT,
      "Updated the draft workflow steps.",
      nextPlan
    );
    return broadcastAgentSnapshot();
  }

  async discardDraftPlan() {
    await this.init();
    await saveDraftPlan(null);
    await updateUiState({
      selectedWorkflowId: null,
      saveWorkflowDraft: null
    });
    await replaceCurrentRun({
      ...DEFAULT_AGENT_RUN_STATE,
      status: AGENT_RUN_STATUS.IDLE,
      error: "",
      summary: ""
    });
    await this.appendChat(
      CHAT_MESSAGE_TYPES.TOOL_EVENT,
      "Dismissed the draft workflow."
    );
    return broadcastAgentSnapshot();
  }

  async approvePlan() {
    await this.init();
    const plan = await getDraftPlan();
    if (!plan) {
      throw new Error("There is no draft plan to approve.");
    }
    const approvedPlan = {
      ...plan,
      status: WORKFLOW_PLAN_STATUS.APPROVED,
      approvedAt: Date.now()
    };
    await saveDraftPlan(approvedPlan);
    await setCurrentRun({
      planId: approvedPlan.id,
      status: AGENT_RUN_STATUS.IDLE,
      error: ""
    });
    await this.appendWorkflowChat(
      CHAT_MESSAGE_TYPES.TOOL_EVENT,
      "Plan approved. Execution is still manual until you click Run.",
      approvedPlan
    );
    return broadcastAgentSnapshot();
  }

  async startWorkflowRun(plan, { sourceWorkflowId = null, sourceWorkflowTitle = "" } = {}) {
    const runId = createId("run");
    const startedAt = Date.now();

    await replaceCurrentRun({
      runId,
      planId: plan.id,
      sourceWorkflowId,
      sourceWorkflowTitle: sourceWorkflowTitle || plan.title,
      status: AGENT_RUN_STATUS.RUNNING,
      currentStepIndex: 0,
      awaitingApprovalStepId: null,
      activeTabId: null,
      activeUrl: "",
      outputs: {},
      error: "",
      approvedStepIds: [],
      openTabIds: [],
      lastStepResult: null,
      pendingResolution: null,
      startedAt,
      completedAt: null,
      summary: "",
      needsPermissionOrigins: []
    });

    await beginSessionRun({
      runId,
      planId: plan.id,
      title: plan.title,
      goal: plan.goal,
      sourceWorkflowId
    });

    if (sourceWorkflowId) {
      const workflows = await getSavedWorkflows();
      const sourceWorkflow = workflows.find((workflow) => workflow.id === sourceWorkflowId);
      if (sourceWorkflow) {
        await updateSavedWorkflowMetadata(sourceWorkflowId, {
          runCount: Number(sourceWorkflow.runCount || 0) + 1,
          lastRunAt: startedAt,
          lastRunStatus: AGENT_RUN_STATUS.RUNNING
        });
      }
    }

    await this.appendWorkflowChat(
      CHAT_MESSAGE_TYPES.TOOL_EVENT,
      `Started workflow: ${plan.title}`,
      plan,
      {
        sourceWorkflowId
      }
    );
    await broadcastAgentSnapshot();
    this.scheduleProcess();
    return getAgentSnapshot();
  }

  async executePlan() {
    await this.init();
    const plan = await getDraftPlan();
    const currentRun = await getCurrentRun();
    const savedWorkflows = await getSavedWorkflows();
    if (!plan) {
      throw new Error("Create a plan before running anything.");
    }
    if (plan.status !== WORKFLOW_PLAN_STATUS.APPROVED) {
      throw new Error("Approve the plan before execution.");
    }

    if (currentRun.planId === plan.id && currentRun.status === AGENT_RUN_STATUS.PAUSED) {
      await setCurrentRun({
        status: AGENT_RUN_STATUS.RUNNING,
        error: ""
      });
      await this.appendWorkflowChat(
        CHAT_MESSAGE_TYPES.TOOL_EVENT,
        `Resumed workflow: ${plan.title}`,
        plan,
        {
          sourceWorkflowId: currentRun.sourceWorkflowId || null
        }
      );
      await broadcastAgentSnapshot();
      this.scheduleProcess();
      return getAgentSnapshot();
    }

    const sourceWorkflow = savedWorkflows.find((workflow) => workflow.id === plan.id) || null;
    return this.startWorkflowRun(plan, {
      sourceWorkflowId: sourceWorkflow?.id || null,
      sourceWorkflowTitle: sourceWorkflow?.title || plan.title
    });
  }

  async pauseExecution() {
    const run = await getCurrentRun();
    if (run.status !== AGENT_RUN_STATUS.RUNNING) {
      return broadcastAgentSnapshot();
    }
    await setCurrentRun({
      status: AGENT_RUN_STATUS.PAUSED
    });
    const plan = await getDraftPlan();
    await this.appendWorkflowChat(
      CHAT_MESSAGE_TYPES.TOOL_EVENT,
      "Paused execution.",
      plan || { id: run.planId, title: run.sourceWorkflowTitle || "Workflow" },
      {
        sourceWorkflowId: run.sourceWorkflowId || null
      }
    );
    return broadcastAgentSnapshot();
  }

  async stopExecution() {
    const run = await getCurrentRun();
    if (run.runId) {
      await updateSessionRun(run.runId, {
        status: AGENT_RUN_STATUS.STOPPED,
        completedAt: Date.now()
      });
    }
    if (run.sourceWorkflowId) {
      await updateSavedWorkflowMetadata(run.sourceWorkflowId, {
        lastRunStatus: AGENT_RUN_STATUS.STOPPED,
        lastRunAt: run.startedAt || Date.now()
      });
    }
    await setCurrentRun({
      status: AGENT_RUN_STATUS.STOPPED,
      error: "",
      awaitingApprovalStepId: null,
      pendingResolution: null,
      completedAt: Date.now()
    });
    const draftPlan = await getDraftPlan();
    await this.appendWorkflowChat(
      CHAT_MESSAGE_TYPES.TOOL_EVENT,
      run.status === AGENT_RUN_STATUS.COMPLETED
        ? "Workflow is already complete."
        : "Stopped execution.",
      draftPlan || { id: run.planId, title: run.sourceWorkflowTitle || "Workflow" },
      {
        sourceWorkflowId: run.sourceWorkflowId || null
      }
    );
    return broadcastAgentSnapshot();
  }

  async resetSession() {
    await this.init();
    await clearChatThread();
    await saveDraftPlan(null);
    await updateUiState({
      selectedWorkflowId: null,
      saveWorkflowDraft: null,
      selectedTab: AGENT_TABS.WORKFLOWS
    });
    await replaceCurrentRun({
      ...DEFAULT_AGENT_RUN_STATE,
      status: AGENT_RUN_STATUS.IDLE,
      error: "",
      summary: ""
    });
    return broadcastAgentSnapshot();
  }

  async approveStep({ stepId, decision = "approve" }) {
    await this.init();
    const run = await getCurrentRun();
    const plan = await getDraftPlan();
    if (!plan || !run.awaitingApprovalStepId || run.awaitingApprovalStepId !== stepId) {
      throw new Error("No matching step is waiting for approval.");
    }

    if (decision === "stop") {
      return this.stopExecution();
    }

    if (decision === "skip") {
      const step = plan.steps.find((item) => item.id === stepId);
      await this.recordStepResult(step, {
        status: "skipped",
        output: null,
        note: "User skipped this step."
      });
      await setCurrentRun({
        status: AGENT_RUN_STATUS.RUNNING,
        currentStepIndex: run.currentStepIndex + 1,
        awaitingApprovalStepId: null,
        pendingResolution: null,
        error: ""
      });
      await this.appendWorkflowChat(
        CHAT_MESSAGE_TYPES.TOOL_EVENT,
        `Skipped step: ${step?.label || stepId}`,
        plan,
        {
          sourceWorkflowId: run.sourceWorkflowId || null
        }
      );
      await broadcastAgentSnapshot();
      this.scheduleProcess();
      return getAgentSnapshot();
    }

    await setCurrentRun({
      status: AGENT_RUN_STATUS.RUNNING,
      awaitingApprovalStepId: null,
      pendingResolution: null,
      approvedStepIds: [...new Set([...(run.approvedStepIds || []), stepId])],
      error: ""
    });
    await this.appendWorkflowChat(
      CHAT_MESSAGE_TYPES.TOOL_EVENT,
      "Approved the pending step. Execution resumed.",
      plan,
      {
        sourceWorkflowId: run.sourceWorkflowId || null
      }
    );
    await broadcastAgentSnapshot();
    this.scheduleProcess();
    return getAgentSnapshot();
  }

  async saveWorkflow({ workflowId = null }) {
    return this.saveWorkflowTemplate({
      workflowId,
      templateInputs: null
    });
  }

  async updateWorkflowTemplateInputs({ workflowId = null, templateInputs = null }) {
    await this.init();
    const [plan, workflows] = await Promise.all([
      getDraftPlan(),
      getSavedWorkflows()
    ]);
    const target = (workflowId && plan?.id === workflowId)
      ? plan
      : workflows.find((item) => item.id === workflowId) || plan;
    if (!target) {
      throw new Error("There is no workflow available for template inputs.");
    }
    const saveWorkflowDraft = buildSaveWorkflowDraft(target, templateInputs);
    await updateUiState({
      selectedWorkflowId: target.id,
      saveWorkflowDraft
    });
    return broadcastAgentSnapshot();
  }

  async saveWorkflowTemplate({ workflowId = null, templateInputs = null }) {
    await this.init();
    const [plan, workflows, uiState] = await Promise.all([
      getDraftPlan(),
      getSavedWorkflows(),
      getUiState()
    ]);
    const target = (workflowId && plan?.id === workflowId)
      ? plan
      : workflows.find((item) => item.id === workflowId) || plan;
    if (!target) {
      throw new Error("There is no workflow to save.");
    }
    const saveDraft = uiState.saveWorkflowDraft?.workflowId === target.id
      ? uiState.saveWorkflowDraft
      : buildSaveWorkflowDraft(target, templateInputs);
    const nextTemplateInputs = templateInputs == null
      ? (saveDraft.templateInputs || [])
      : normalizeTemplateInputs(templateInputs, saveDraft.inputCandidates || createTemplateInputCandidates(target));
    const existing = workflows.find((item) => item.id === target.id) || null;
    const workflow = normalizeSavedWorkflow({
      ...(existing || {}),
      ...target,
      id: workflowId || target.id,
      templateInputs: nextTemplateInputs,
      createdAt: existing?.createdAt || target.createdAt || Date.now(),
      updatedAt: Date.now(),
      savedAt: Date.now(),
      lastRunAt: existing?.lastRunAt || null,
      lastRunStatus: existing?.lastRunStatus || "",
      runCount: existing?.runCount || 0
    });
    await upsertSavedWorkflow(workflow);
    await updateUiState({
      selectedTab: AGENT_TABS.WORKFLOWS,
      selectedWorkflowId: workflow.id,
      saveWorkflowDraft: null
    });
    await this.appendWorkflowChat(
      CHAT_MESSAGE_TYPES.TOOL_EVENT,
      `Saved workflow template: ${workflow.title}`,
      workflow,
      {
        sourceWorkflowId: workflow.id
      }
    );
    return broadcastAgentSnapshot();
  }

  async loadWorkflow({ workflowId }) {
    await this.init();
    const workflows = await getSavedWorkflows();
    const workflow = workflows.find((item) => item.id === workflowId);
    if (!workflow) {
      throw new Error("Saved workflow not found.");
    }
    const loadedPlan = {
      ...workflow,
      status: WORKFLOW_PLAN_STATUS.DRAFT,
      loadedAt: Date.now()
    };
    await saveDraftPlan(loadedPlan);
    await updateUiState({
      selectedTab: AGENT_TABS.WORKFLOWS,
      selectedWorkflowId: loadedPlan.id,
      saveWorkflowDraft: null
    });
    await replaceCurrentRun({
      planId: loadedPlan.id,
      status: AGENT_RUN_STATUS.NEEDS_PLAN_APPROVAL,
      error: ""
    });
    await this.appendWorkflowChat(
      CHAT_MESSAGE_TYPES.TOOL_EVENT,
      `Loaded workflow template: ${loadedPlan.title}`,
      loadedPlan,
      {
        sourceWorkflowId: workflow.id
      }
    );
    return broadcastAgentSnapshot();
  }

  async duplicateWorkflow({ workflowId }) {
    await this.init();
    const workflows = await getSavedWorkflows();
    const workflow = workflows.find((item) => item.id === workflowId);
    if (!workflow) {
      throw new Error("Saved workflow not found.");
    }
    const duplicated = {
      ...workflow,
      id: createId("plan"),
      title: `${workflow.title} copy`,
      status: WORKFLOW_PLAN_STATUS.DRAFT,
      loadedAt: Date.now()
    };
    await saveDraftPlan(duplicated);
    await updateUiState({
      selectedTab: AGENT_TABS.WORKFLOWS,
      selectedWorkflowId: duplicated.id,
      saveWorkflowDraft: null
    });
    await replaceCurrentRun({
      ...DEFAULT_AGENT_RUN_STATE,
      planId: duplicated.id,
      status: AGENT_RUN_STATUS.NEEDS_PLAN_APPROVAL
    });
    await this.appendWorkflowChat(
      CHAT_MESSAGE_TYPES.TOOL_EVENT,
      `Duplicated workflow: ${workflow.title}`,
      duplicated,
      {
        sourceWorkflowId: workflow.id
      }
    );
    return broadcastAgentSnapshot();
  }

  async deleteWorkflow({ workflowId }) {
    await this.init();
    const draftPlan = await getDraftPlan();
    await deleteSavedWorkflow(workflowId);
    await updateUiState({
      selectedWorkflowId: draftPlan?.id === workflowId ? draftPlan.id : null,
      saveWorkflowDraft: null
    });
    return broadcastAgentSnapshot();
  }

  async prepareWorkflowRun({ workflowId }) {
    await this.init();
    await updateUiState({
      selectedTab: AGENT_TABS.WORKFLOWS,
      selectedWorkflowId: workflowId
    });
    return broadcastAgentSnapshot();
  }

  async runSavedWorkflow({ workflowId, inputs = {} }) {
    await this.init();
    const workflows = await getSavedWorkflows();
    const workflow = workflows.find((item) => item.id === workflowId);
    if (!workflow) {
      throw new Error("Saved workflow not found.");
    }
    const runtimePlan = {
      ...applyTemplateInputsToPlan(workflow, inputs),
      id: createId("plan"),
      status: WORKFLOW_PLAN_STATUS.APPROVED,
      sourceMessageId: workflow.sourceMessageId || null,
      sourceWorkflowId: workflow.id,
      generatedFromTemplateAt: Date.now()
    };
    await saveDraftPlan(runtimePlan);
    await updateUiState({
      selectedTab: AGENT_TABS.WORKFLOWS,
      selectedWorkflowId: workflow.id,
      saveWorkflowDraft: null
    });
    return this.startWorkflowRun(runtimePlan, {
      sourceWorkflowId: workflow.id,
      sourceWorkflowTitle: workflow.title
    });
  }

  async upsertMemory({ preferences = [], notes = [], defaults = {} }) {
    await this.init();
    const nextMemory = mergeUserMemory(await getUserMemory(), {
      preferences,
      notes,
      defaults
    });
    await saveUserMemory(nextMemory);
    await this.appendChat(
      CHAT_MESSAGE_TYPES.TOOL_EVENT,
      "Saved the memory note for future plans."
    );
    return broadcastAgentSnapshot();
  }

  async recordStepResult(step, result) {
    const run = await getCurrentRun();
    if (!run.runId) {
      return;
    }
    await appendSessionStepResult(
      run.runId,
      {
        stepId: step?.id || null,
        label: step?.label || "",
        status: result.status,
        output: result.output ?? null,
        note: result.note || "",
        timestamp: Date.now()
      },
      step?.outputKey && result.output !== undefined
        ? { [step.outputKey]: result.output }
        : {}
    );
  }

  async resetCopilotChat() {
    await this.init();
    await resetCopilotConversation();
    await updateUiState({
      selectedTab: AGENT_TABS.COPILOT
    });
    return broadcastAgentSnapshot();
  }

  async loadCopilotConversation({ conversationId }) {
    await this.init();
    const conversation = await loadCopilotConversation(conversationId);
    if (!conversation) {
      throw new Error("Copilot conversation not found.");
    }
    await updateUiState({
      selectedTab: AGENT_TABS.COPILOT
    });
    return broadcastAgentSnapshot();
  }

  async deleteCopilotConversation({ conversationId }) {
    await this.init();
    await deleteCopilotConversation(conversationId);
    await updateUiState({
      selectedTab: AGENT_TABS.COPILOT
    });
    return broadcastAgentSnapshot();
  }

  async chatWithPage({ prompt }) {
    await this.init();
    const trimmedPrompt = String(prompt || "").trim();
    if (!trimmedPrompt) {
      throw new Error("Ask Copilot something about the current page.");
    }
    await appendCopilotMessages([createChatMessage(CHAT_MESSAGE_TYPES.USER_MESSAGE, trimmedPrompt)]);
    await syncActiveCopilotConversation({
      titleHint: trimmedPrompt
    });
    await updateUiState({
      selectedTab: AGENT_TABS.COPILOT
    });
    try {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const activeTab = tabs[0] || null;
      if (!activeTab?.id) {
        throw new Error("Open a browser tab before using Copilot.");
      }
      const inspectResult = await this.executePageStep(activeTab.id, "inspect_page", {}, 5000);
      if (!inspectResult?.ok) {
        throw new Error(inspectResult?.error || "Could not read the current page.");
      }
      const [settings, copilotThread] = await Promise.all([
        getSettings(),
        getCopilotThread()
      ]);
      const response = await this.hooks.chatWithPageImpl({
        settings,
        prompt: trimmedPrompt,
        pageSnapshot: inspectResult.output,
        conversation: copilotThread
      });
      await this.appendCopilotChat(
        CHAT_MESSAGE_TYPES.FINAL_RESULT,
        response.answer,
        {
          pageTitle: inspectResult.output?.title || ""
        }
      );
      await syncActiveCopilotConversation({
        titleHint: trimmedPrompt
      });
      return broadcastAgentSnapshot();
    } catch (error) {
      await this.appendCopilotChat(CHAT_MESSAGE_TYPES.ERROR_EVENT, error.message);
      await syncActiveCopilotConversation({
        titleHint: trimmedPrompt
      });
      return broadcastAgentSnapshot();
    }
  }

  async resolveStep(step, outputs) {
    return {
      ...step,
      args: resolveTemplateVariables(step.args, outputs)
    };
  }

  async executePageStep(tabId, action, payload, timeoutMs) {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: pageToolExecutor,
      args: [{
        action,
        payload,
        timeoutMs
      }]
    });
    return result?.result || { ok: false, error: "Unknown page execution failure." };
  }

  async summarizeStep({ step, runState, plan }) {
    const settings = await getSettings();
    const summary = await this.hooks.summarizeRunImpl({
      settings,
      plan,
      step,
      outputs: runState.outputs
    });
    return {
      status: "success",
      output: summary.summary
    };
  }

  async executeStep(step, runState, plan) {
    const resolvedStep = await this.resolveStep(step, runState.outputs);
    switch (resolvedStep.kind) {
      case "open_url": {
        const targetUrl = String(resolvedStep.args.url || "").trim();
        const shouldReuse = resolvedStep.args.reuseActiveTab === true && runState.activeTabId;
        const tab = shouldReuse
          ? await chrome.tabs.update(runState.activeTabId, { url: targetUrl, active: true })
          : await chrome.tabs.create({ url: targetUrl, active: true });
        await waitForTabComplete(tab.id, resolvedStep.timeoutMs || 25000);
        await setCurrentRun({
          activeTabId: tab.id,
          activeUrl: targetUrl,
          openTabIds: [...new Set([...(runState.openTabIds || []), tab.id])]
        });
        return {
          status: "success",
          output: targetUrl
        };
      }

      case "switch_tab": {
        const tabs = await Promise.all((runState.openTabIds || []).map((tabId) => getTab(tabId)));
        const candidates = tabs.filter(Boolean);
        let target = null;
        if (Number.isInteger(resolvedStep.args.tabIndex)) {
          target = candidates[resolvedStep.args.tabIndex] || null;
        }
        if (!target && resolvedStep.args.urlContains) {
          target = candidates.find((tab) => (tab.url || "").includes(resolvedStep.args.urlContains)) || null;
        }
        if (!target && resolvedStep.args.titleContains) {
          target = candidates.find((tab) => (tab.title || "").includes(resolvedStep.args.titleContains)) || null;
        }
        if (!target && candidates.length) {
          target = candidates.at(-1);
        }
        if (!target) {
          throw new Error("No matching tab was available to switch to.");
        }
        await chrome.tabs.update(target.id, { active: true });
        await setCurrentRun({
          activeTabId: target.id,
          activeUrl: target.url || runState.activeUrl
        });
        return {
          status: "success",
          output: target.url || ""
        };
      }

      case "close_tab": {
        const targetTabId = resolvedStep.args.tabId || runState.activeTabId;
        if (!targetTabId) {
          throw new Error("There is no active tab to close.");
        }
        await chrome.tabs.remove(targetTabId);
        const nextOpenTabs = (runState.openTabIds || []).filter((tabId) => tabId !== targetTabId);
        const nextActiveTab = nextOpenTabs.at(-1) || null;
        const nextTab = await getTab(nextActiveTab);
        await setCurrentRun({
          activeTabId: nextActiveTab,
          activeUrl: nextTab?.url || "",
          openTabIds: nextOpenTabs
        });
        return {
          status: "success",
          output: targetTabId
        };
      }

      case "summarize":
        return this.summarizeStep({
          step: resolvedStep,
          runState,
          plan
        });

      case "ask_user":
        await setCurrentRun({
          status: AGENT_RUN_STATUS.PAUSED_FOR_STEP_APPROVAL,
          awaitingApprovalStepId: resolvedStep.id,
          pendingResolution: {
            type: "ask_user",
            message: resolvedStep.args.question || resolvedStep.label
          }
        });
        await this.appendWorkflowChat(
          CHAT_MESSAGE_TYPES.APPROVAL_REQUEST,
          resolvedStep.args.question || resolvedStep.label,
          plan,
          {
            stepId: resolvedStep.id,
            mode: "ask_user",
            sourceWorkflowId: runState.sourceWorkflowId || null
          }
        );
        return { status: "paused" };

      default: {
        if (!runState.activeTabId) {
          throw new Error(`Step "${resolvedStep.label}" requires an active browser tab.`);
        }
        const result = await this.executePageStep(
          runState.activeTabId,
          resolvedStep.kind,
          resolvedStep.args,
          resolvedStep.timeoutMs || 15000
        );
        if (!result?.ok) {
          throw new Error(result?.error || `Step "${resolvedStep.label}" failed.`);
        }
        const tab = await getTab(runState.activeTabId);
        await setCurrentRun({
          activeUrl: tab?.url || runState.activeUrl
        });
        return {
          status: "success",
          output: result.output
        };
      }
    }
  }

  async executeWithRecovery(step, runState, plan) {
    let repairedStep = null;
    let lastError = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await this.executeStep(repairedStep || step, runState, plan);
        return {
          ...result,
          executedStep: repairedStep || step
        };
      } catch (error) {
        lastError = error;
      }
    }

    if (step.onFailure !== FAILURE_MODES.REPAIR || !isDomStep(step) || !runState.activeTabId) {
      throw lastError;
    }

    const inspectResult = await this.executePageStep(runState.activeTabId, "inspect_page", {}, 4000);
    if (!inspectResult?.ok) {
      throw lastError;
    }

    const settings = await getSettings();
    repairedStep = await this.hooks.repairStepImpl({
      settings,
      plan,
      step,
      errorMessage: lastError.message,
      pageSnapshot: inspectResult.output,
      outputs: runState.outputs
    });

    try {
      const repairedResult = await this.executeStep(repairedStep, runState, plan);
      await saveDraftPlan({
        ...plan,
        steps: plan.steps.map((item) => item.id === step.id ? repairedStep : item)
      });
      return {
        ...repairedResult,
        executedStep: repairedStep
      };
    } catch (repairError) {
      const nextError = repairError.message || lastError.message;
      await setCurrentRun({
        status: AGENT_RUN_STATUS.PAUSED_FOR_ERROR,
        awaitingApprovalStepId: step.id,
        error: nextError,
        pendingResolution: {
          type: "step_failure",
          stepId: step.id,
          message: nextError
        }
      });
      await this.appendWorkflowChat(
        CHAT_MESSAGE_TYPES.ERROR_EVENT,
        `Step failed after retry and repair: ${step.label}. Edit the step, skip it, or stop the run.`,
        plan,
        {
          stepId: step.id,
          error: nextError,
          sourceWorkflowId: runState.sourceWorkflowId || null
        }
      );
      return { status: "paused" };
    }
  }

  async maybePersistDomainMemory(step, runState) {
    const selector = String(step?.args?.selector || "").trim();
    if (!selector || !runState.activeUrl) {
      return;
    }
    try {
      const hostname = new URL(runState.activeUrl).hostname.replace(/^www\./i, "");
      const nextMemory = upsertDomainSelector(await getDomainMemory(), {
        hostname,
        key: buildSelectorMemoryKey(step),
        selector,
        label: step.label
      });
      await saveDomainMemory(nextMemory);
    } catch {
      // Ignore domain memory failures for non-URL tabs.
    }
  }

  async completeRun(plan, runState) {
    const settings = await getSettings();
    const sessionMemory = await getSessionMemory();
    const runMemory = sessionMemory.runs?.[runState.runId] || {};
    const summaryResponse = await this.hooks.summarizeRunImpl({
      settings,
      plan,
      outputs: runState.outputs,
      runState,
      runMemory
    });
    if (runState.runId) {
      await updateSessionRun(runState.runId, {
        status: AGENT_RUN_STATUS.COMPLETED,
        completedAt: Date.now(),
        summary: summaryResponse.summary || ""
      });
    }
    if (runState.sourceWorkflowId) {
      await updateSavedWorkflowMetadata(runState.sourceWorkflowId, {
        lastRunStatus: AGENT_RUN_STATUS.COMPLETED,
        lastRunAt: runState.startedAt || Date.now()
      });
    }
    await setCurrentRun({
      status: AGENT_RUN_STATUS.COMPLETED,
      completedAt: Date.now(),
      summary: summaryResponse.summary || "",
      error: "",
      awaitingApprovalStepId: null,
      pendingResolution: null
    });
    await appendChatMessages([
      buildFinalResultMessage(
        summaryResponse.summary || "Workflow completed.",
        buildWorkflowMessageData({
          planId: plan.id,
          sourceWorkflowId: runState.sourceWorkflowId || null,
          title: plan.title
        })
      )
    ]);
    return broadcastAgentSnapshot();
  }

  async process() {
    if (this.processing) {
      return;
    }

    this.processing = true;
    try {
      await this.init();
      const [plan, runState] = await Promise.all([
        getDraftPlan(),
        getCurrentRun()
      ]);

      if (!plan || runState.status !== AGENT_RUN_STATUS.RUNNING) {
        return;
      }

      const step = plan.steps[runState.currentStepIndex];
      if (!step) {
        await this.completeRun(plan, runState);
        return;
      }

      if (
        step.approvalMode === APPROVAL_MODES.ALWAYS
        && !(runState.approvedStepIds || []).includes(step.id)
      ) {
        await setCurrentRun({
          status: AGENT_RUN_STATUS.PAUSED_FOR_STEP_APPROVAL,
          awaitingApprovalStepId: step.id,
          pendingResolution: {
            type: "approval",
            stepId: step.id
          }
        });
        await this.appendWorkflowChat(
          CHAT_MESSAGE_TYPES.APPROVAL_REQUEST,
          `Approval required before "${step.label}".`,
          plan,
          {
            stepId: step.id,
            mode: "risky_step",
            sourceWorkflowId: runState.sourceWorkflowId || null
          }
        );
        await broadcastAgentSnapshot();
        return;
      }

      await this.appendWorkflowChat(
        CHAT_MESSAGE_TYPES.TOOL_EVENT,
        `Running step ${runState.currentStepIndex + 1}/${plan.steps.length}: ${step.label}`,
        plan,
        {
          sourceWorkflowId: runState.sourceWorkflowId || null
        }
      );
      const result = await this.executeWithRecovery(step, runState, plan);
      if (result.status === "paused") {
        await broadcastAgentSnapshot();
        return;
      }

      const executedStep = result.executedStep || step;
      const nextOutputs = executedStep.outputKey
        ? { ...(runState.outputs || {}), [executedStep.outputKey]: result.output }
        : { ...(runState.outputs || {}) };

      await this.recordStepResult(executedStep, result);
      await this.maybePersistDomainMemory(executedStep, {
        ...runState,
        activeUrl: (await getCurrentRun()).activeUrl
      });
      await setCurrentRun({
        status: AGENT_RUN_STATUS.RUNNING,
        currentStepIndex: runState.currentStepIndex + 1,
        outputs: nextOutputs,
        error: "",
        awaitingApprovalStepId: null,
        pendingResolution: null,
        lastStepResult: {
          stepId: executedStep.id,
          label: executedStep.label,
          status: result.status,
          outputPreview: truncateText(result.output)
        }
      });
      await this.appendWorkflowChat(
        CHAT_MESSAGE_TYPES.STEP_RESULT,
        `${executedStep.label} completed.`,
        plan,
        {
          stepId: executedStep.id,
          outputPreview: truncateText(result.output),
          sourceWorkflowId: runState.sourceWorkflowId || null
        }
      );
      await broadcastAgentSnapshot();
      this.scheduleProcess();
    } catch (error) {
      const currentRun = await getCurrentRun();
      if (currentRun.runId) {
        await updateSessionRun(currentRun.runId, {
          status: AGENT_RUN_STATUS.ERROR,
          completedAt: Date.now(),
          summary: error.message
        });
      }
      if (currentRun.sourceWorkflowId) {
        await updateSavedWorkflowMetadata(currentRun.sourceWorkflowId, {
          lastRunStatus: AGENT_RUN_STATUS.ERROR,
          lastRunAt: currentRun.startedAt || Date.now()
        });
      }
      await setCurrentRun({
        status: AGENT_RUN_STATUS.ERROR,
        error: error.message,
        pendingResolution: null,
        awaitingApprovalStepId: null
      });
      await this.appendWorkflowChat(
        CHAT_MESSAGE_TYPES.ERROR_EVENT,
        error.message,
        (await getDraftPlan()) || { id: currentRun.planId, title: currentRun.sourceWorkflowTitle || "Workflow" },
        {
          sourceWorkflowId: currentRun.sourceWorkflowId || null
        }
      );
      await broadcastAgentSnapshot();
    } finally {
      this.processing = false;
    }
  }
}
