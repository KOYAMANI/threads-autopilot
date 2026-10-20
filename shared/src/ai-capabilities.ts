/** Public capabilities, served by the backend. Option IDs are provider/model scoped. */
export type AiThinkingCapabilities = {
  provider: string;
  model: string;
  version: string;
  supported: boolean;
  options: Array<{ id: string; label: string; description: string }>;
  defaultId: string;
};
export const AI_GENERATION_TIMEOUT_MS = 300_000;
