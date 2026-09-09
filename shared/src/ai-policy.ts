import { AI_DEFAULT_MODEL } from "./types";

export const AI_DATA_POLICY_VERSION = "2026-09-09-v2";
export const AI_MODELS = {
  gemini: [{ id: "gemini-2.5-flash", label: "Gemini 2.5 Flash（Google）" }],
  openrouter: [{ id: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6（Anthropic）" }],
} as const;
export function isAllowedAiModel(provider: string, model: string | null | undefined): boolean {
  if (provider !== "gemini" && provider !== "openrouter") return false;
  return AI_MODELS[provider].some(item => item.id === (model?.trim() || AI_DEFAULT_MODEL[provider]));
}
export function hasAiDataConsent(row: {provider: string; model?: string | null; data_policy_version?: string | null} | null | undefined): boolean {
  return Boolean(row && row.data_policy_version === AI_DATA_POLICY_VERSION && isAllowedAiModel(row.provider, row.model));
}
