import type { AgentAPI } from "../../shell/shared/ipc";

declare global {
  interface Window {
    agentAPI: AgentAPI;
  }
}

export {};
