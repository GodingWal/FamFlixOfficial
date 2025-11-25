import { config } from "../config";
import type { ITTSProvider } from "./TTSProvider";
import { F5Provider } from "./providers/f5";
import { RVCProvider } from "./providers/rvc";

const providers: Partial<Record<string, ITTSProvider>> = {};

providers.F5 = new F5Provider();
providers.RVC = new RVCProvider();

export function getTTSProvider(provider?: string): ITTSProvider {
  const key = provider ?? config.TTS_PROVIDER;
  const instance = providers[key];

  if (!instance) {
    throw new Error(`TTS provider '${key}' is not configured`);
  }

  return instance;
}

export function hasTTSProvider(provider: string): boolean {
  return Boolean(providers[provider]);
}
