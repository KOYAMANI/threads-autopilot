import { AI_DEFAULT_MODEL } from "./types";

export const AI_DATA_POLICY_VERSION = "2026-09-09-v2";
export const AI_MODELS = {
  gemini: [
    { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite（軽量・低コスト）" },
    { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash（高性能）" },
  ],
  openrouter: [{ id: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6（Anthropic）" }],
} as const;
export function isGeminiTextModel(model: string): boolean {
  return /^gemini-(?:[0-9][a-z0-9.-]*|(?:flash|flash-lite|pro)-latest)$/.test(model) && /(?:flash|pro)/.test(model) && !/(?:image|audio|tts|live|robotics|embedding|computer-use|deep-research)/.test(model);
}
export function isAllowedAiModel(provider: string, model: string | null | undefined): boolean {
  if (provider !== "gemini" && provider !== "openrouter") return false;
  return AI_MODELS[provider].some(item => item.id === (model?.trim() || AI_DEFAULT_MODEL[provider]));
}
export function hasAiDataConsent(row: {provider: string; model?: string | null; data_policy_version?: string | null} | null | undefined): boolean {
  return Boolean(row && row.data_policy_version === AI_DATA_POLICY_VERSION && isAllowedAiModel(row.provider, row.model));
}
