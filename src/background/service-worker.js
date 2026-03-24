import { MESSAGE_TYPES, createErrorResponse, createSuccessResponse } from "../shared/messages.js";
import { initializeStorage } from "./storage.js";
import { AgentEngine } from "./agent-engine.js";
import { getAgentSnapshot, initializeAgentStorage } from "./agent-storage.js";
import {
  deleteLlmAccount,
  refreshAccountModels,
  saveAgentSettings,
  selectModelForAccount,
  setActiveLlmAccount,
  upsertLlmAccount
} from "./provider-settings.js";

const agentEngine = new AgentEngine();

async function configureSidePanelBehavior() {
  await chrome.sidePanel.setOptions({
    enabled: true,
    path: "sidepanel.html"
  });
  if (chrome.sidePanel?.setPanelBehavior) {
    await chrome.sidePanel.setPanelBehavior({
      openPanelOnActionClick: true
    });
  }
}

async function handleMessage(message) {
  switch (message?.type) {
    case MESSAGE_TYPES.GET_AGENT_SNAPSHOT:
      return createSuccessResponse({ snapshot: await getAgentSnapshot() });

    case MESSAGE_TYPES.AGENT_STATUS_UPDATE:
      return createSuccessResponse();

    case MESSAGE_TYPES.SELECT_AGENT_TAB:
      await agentEngine.selectAgentTab(message.payload?.tab || "");
      return createSuccessResponse({ snapshot: await getAgentSnapshot() });

    case MESSAGE_TYPES.SELECT_WORKFLOW:
      await agentEngine.selectWorkflow({
        workflowId: message.payload?.workflowId || null
      });
      return createSuccessResponse({ snapshot: await getAgentSnapshot() });

    case MESSAGE_TYPES.PLAN_FROM_CHAT:
      await agentEngine.planFromChat({
        goal: message.payload?.goal || ""
      });
      return createSuccessResponse({ snapshot: await getAgentSnapshot() });

    case MESSAGE_TYPES.CHAT_WITH_PAGE:
      await agentEngine.chatWithPage({
        prompt: message.payload?.prompt || ""
      });
      return createSuccessResponse({ snapshot: await getAgentSnapshot() });

    case MESSAGE_TYPES.RESET_COPILOT_CHAT:
      await agentEngine.resetCopilotChat();
      return createSuccessResponse({ snapshot: await getAgentSnapshot() });

    case MESSAGE_TYPES.LOAD_COPILOT_CONVERSATION:
      await agentEngine.loadCopilotConversation({
        conversationId: message.payload?.conversationId || ""
      });
      return createSuccessResponse({ snapshot: await getAgentSnapshot() });

    case MESSAGE_TYPES.DELETE_COPILOT_CONVERSATION:
      await agentEngine.deleteCopilotConversation({
        conversationId: message.payload?.conversationId || ""
      });
      return createSuccessResponse({ snapshot: await getAgentSnapshot() });

    case MESSAGE_TYPES.UPDATE_DRAFT_PLAN:
      await agentEngine.updateDraftPlan({
        plan: message.payload?.plan || null
      });
      return createSuccessResponse({ snapshot: await getAgentSnapshot() });

    case MESSAGE_TYPES.DISCARD_DRAFT_PLAN:
      await agentEngine.discardDraftPlan();
      return createSuccessResponse({ snapshot: await getAgentSnapshot() });

    case MESSAGE_TYPES.APPROVE_PLAN:
      await agentEngine.approvePlan();
      return createSuccessResponse({ snapshot: await getAgentSnapshot() });

    case MESSAGE_TYPES.EXECUTE_PLAN:
      await agentEngine.executePlan();
      return createSuccessResponse({ snapshot: await getAgentSnapshot() });

    case MESSAGE_TYPES.APPROVE_STEP:
      await agentEngine.approveStep({
        stepId: message.payload?.stepId || "",
        decision: message.payload?.decision || "approve"
      });
      return createSuccessResponse({ snapshot: await getAgentSnapshot() });

    case MESSAGE_TYPES.PAUSE_EXECUTION:
      await agentEngine.pauseExecution();
      return createSuccessResponse({ snapshot: await getAgentSnapshot() });

    case MESSAGE_TYPES.STOP_EXECUTION:
      await agentEngine.stopExecution();
      return createSuccessResponse({ snapshot: await getAgentSnapshot() });

    case MESSAGE_TYPES.RESET_AGENT_SESSION:
      await agentEngine.resetSession();
      return createSuccessResponse({ snapshot: await getAgentSnapshot() });

    case MESSAGE_TYPES.SAVE_WORKFLOW:
      await agentEngine.saveWorkflow({
        workflowId: message.payload?.workflowId || null
      });
      return createSuccessResponse({ snapshot: await getAgentSnapshot() });

    case MESSAGE_TYPES.SAVE_WORKFLOW_TEMPLATE:
      await agentEngine.saveWorkflowTemplate({
        workflowId: message.payload?.workflowId || null,
        templateInputs: message.payload?.templateInputs || null
      });
      return createSuccessResponse({ snapshot: await getAgentSnapshot() });

    case MESSAGE_TYPES.LOAD_WORKFLOW:
      await agentEngine.loadWorkflow({
        workflowId: message.payload?.workflowId || ""
      });
      return createSuccessResponse({ snapshot: await getAgentSnapshot() });

    case MESSAGE_TYPES.DELETE_WORKFLOW:
      await agentEngine.deleteWorkflow({
        workflowId: message.payload?.workflowId || ""
      });
      return createSuccessResponse({ snapshot: await getAgentSnapshot() });

    case MESSAGE_TYPES.DUPLICATE_WORKFLOW:
      await agentEngine.duplicateWorkflow({
        workflowId: message.payload?.workflowId || ""
      });
      return createSuccessResponse({ snapshot: await getAgentSnapshot() });

    case MESSAGE_TYPES.PREPARE_WORKFLOW_RUN:
      await agentEngine.prepareWorkflowRun({
        workflowId: message.payload?.workflowId || ""
      });
      return createSuccessResponse({ snapshot: await getAgentSnapshot() });

    case MESSAGE_TYPES.RUN_SAVED_WORKFLOW:
      await agentEngine.runSavedWorkflow({
        workflowId: message.payload?.workflowId || "",
        inputs: message.payload?.inputs || {}
      });
      return createSuccessResponse({ snapshot: await getAgentSnapshot() });

    case MESSAGE_TYPES.UPDATE_WORKFLOW_TEMPLATE_INPUTS:
      await agentEngine.updateWorkflowTemplateInputs({
        workflowId: message.payload?.workflowId || null,
        templateInputs: message.payload?.templateInputs || null
      });
      return createSuccessResponse({ snapshot: await getAgentSnapshot() });

    case MESSAGE_TYPES.UPSERT_MEMORY:
      await agentEngine.upsertMemory(message.payload || {});
      return createSuccessResponse({ snapshot: await getAgentSnapshot() });

    case MESSAGE_TYPES.UPSERT_LLM_ACCOUNT:
      await upsertLlmAccount(message.payload?.account || {});
      return createSuccessResponse({ snapshot: await getAgentSnapshot() });

    case MESSAGE_TYPES.DELETE_LLM_ACCOUNT:
      await deleteLlmAccount(message.payload?.accountId || "");
      return createSuccessResponse({ snapshot: await getAgentSnapshot() });

    case MESSAGE_TYPES.SET_ACTIVE_LLM_ACCOUNT:
      if (message.payload?.model) {
        await selectModelForAccount({
          accountId: message.payload?.accountId || "",
          model: message.payload.model
        });
      } else {
        await setActiveLlmAccount(message.payload?.accountId || "");
      }
      return createSuccessResponse({ snapshot: await getAgentSnapshot() });

    case MESSAGE_TYPES.REFRESH_ACCOUNT_MODELS:
      await refreshAccountModels(message.payload?.accountId || "");
      return createSuccessResponse({ snapshot: await getAgentSnapshot() });

    case MESSAGE_TYPES.SAVE_AGENT_SETTINGS:
      await saveAgentSettings(message.payload || {});
      return createSuccessResponse({ snapshot: await getAgentSnapshot() });

    default:
      return createErrorResponse(`Unsupported message type: ${message?.type}`);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void initializeStorage();
  void initializeAgentStorage();
  void configureSidePanelBehavior();
});

chrome.runtime.onStartup.addListener(() => {
  void agentEngine.init();
  void configureSidePanelBehavior();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void handleMessage(message)
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse(createErrorResponse(error.message)));
  return true;
});

void agentEngine.init();
void configureSidePanelBehavior();
