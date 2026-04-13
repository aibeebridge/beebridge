import type { ProviderCatalogItem } from "@beebridge/core";

export const providerCatalog: ProviderCatalogItem[] = [
  {
    id: "openai",
    label: "OpenAI (Codex)",
    authModes: ["api_key", "oauth"],
    models: [
      "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano",
      "gpt-5", "gpt-5-mini", "gpt-5-nano",
      "gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano",
      "o3", "o3-mini", "o4-mini",
    ],
  },
  {
    id: "anthropic",
    label: "Anthropic",
    authModes: ["api_key", "oauth"],
    models: [
      "claude-sonnet-4.6", "claude-sonnet-4", "claude-haiku-4",
      "claude-3-7-sonnet", "claude-3-5-sonnet", "claude-3-5-haiku",
      "claude-3-opus",
    ],
  },
  {
    id: "google",
    label: "Google",
    authModes: ["api_key", "oauth"],
    models: [
      "gemini-3.1-pro", "gemini-3.1-flash-lite",
      "gemini-2.5-pro", "gemini-2.5-flash",
      "gemini-2.0-flash", "gemini-2.0-flash-lite",
      "gemini-1.5-pro", "gemini-1.5-flash",
    ],
  },
  {
    id: "xai",
    label: "xAI",
    authModes: ["api_key"],
    models: [
      "grok-4.20", "grok-4.1", "grok-4.1-fast", "grok-4.1-mini",
      "grok-3", "grok-3-mini",
    ],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    authModes: ["api_key"],
    models: [
      "openai/gpt-5.4-mini", "openai/gpt-5-mini", "openai/gpt-4o", "openai/o4-mini",
      "anthropic/claude-sonnet-4.6", "anthropic/claude-sonnet-4",
      "google/gemini-2.5-pro", "google/gemini-2.5-flash",
      "meta-llama/llama-4-maverick", "meta-llama/llama-4-scout",
      "deepseek/deepseek-r1", "deepseek/deepseek-v3-0324",
      "qwen/qwen3-235b-a22b",
    ],
  },
  {
    id: "github-copilot",
    label: "GitHub Copilot",
    authModes: ["oauth", "api_key"],
    models: [
      "gpt-5.4", "gpt-5.4-mini",
      "gpt-4o", "gpt-4.1", "gpt-4o-mini",
      "o3-mini", "o4-mini",
      "claude-sonnet-4.6", "claude-sonnet-4",
      "gemini-2.5-pro", "gemini-2.0-flash",
    ],
  },
];
