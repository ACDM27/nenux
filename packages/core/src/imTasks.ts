export type ImTaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export interface ImTaskStep {
  agentId: string; status: "running" | "succeeded" | "failed"; text: string; error?: string;
  reusedFromTaskId?: string;
  permission?: { paneId: string; requestId: string; title: string; options: Array<{ optionId: string; name: string }> };
}
export interface ImTask {
  id: string; conversationId: string; triggerMessageId: number; parentTaskId: string | null;
  attempt: number; status: ImTaskStatus; createdAt: number; updatedAt: number;
  error: string | null; resultMessageId: number | null; steps: ImTaskStep[];
  executionSettings?: ImExecutionSettings;
}
export interface ImExecutionSettings { cwd: string; leadAgentId?: string; maxTurns: number; timeoutMs: number }
