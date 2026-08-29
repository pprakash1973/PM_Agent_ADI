import { getSystemSetting } from "@/lib/system-settings";

export type Provider = "anthropic" | "openai" | "deepseek";

const ENV_VARS: Record<Provider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai:    "OPENAI_API_KEY",
  deepseek:  "DEEPSEEK_API_KEY",
};

// 60-second in-process TTL cache
const _cache = new Map<Provider, { value: string; expiresAt: number }>();

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}

export async function getApiKey(provider: Provider): Promise<string | undefined> {
  const hit = _cache.get(provider);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  try {
    const val = await getSystemSetting(`api_key.${provider}`);
    if (val) {
      const clean = stripBom(val);
      _cache.set(provider, { value: clean, expiresAt: Date.now() + 60_000 });
      return clean;
    }
  } catch {
    // Fall through to env var
  }

  const envVal = process.env[ENV_VARS[provider]];
  return envVal ? stripBom(envVal) : undefined;
}

export function invalidateApiKey(provider?: Provider) {
  if (provider) _cache.delete(provider);
  else _cache.clear();
}
