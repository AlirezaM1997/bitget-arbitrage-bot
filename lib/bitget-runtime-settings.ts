import type { BotSettings } from "./bot-settings";

export type BitgetAccountMode = BotSettings["bitgetAccountMode"];
export type BitgetRuntimeSettings = Pick<
  BotSettings,
  "bitgetAccountMode" | "bitgetDemoTrading"
>;

const GLOBAL_STATE_KEY = Symbol.for("bitget-arbitrage.bitget-runtime-settings.v1");
const defaults: BitgetRuntimeSettings = {
  bitgetAccountMode: "uta",
  bitgetDemoTrading: false
};

function runtimeState(): BitgetRuntimeSettings {
  const root = globalThis as typeof globalThis & {
    [GLOBAL_STATE_KEY]?: BitgetRuntimeSettings;
  };
  return root[GLOBAL_STATE_KEY] ??= { ...defaults };
}

/**
 * Keeps synchronous order fences aligned with the settings loaded from the
 * dashboard store. The store calls this after every successful read or write.
 */
export function applyBitgetRuntimeSettings(
  settings: BitgetRuntimeSettings
): BitgetRuntimeSettings {
  const next = {
    bitgetAccountMode: settings.bitgetAccountMode,
    bitgetDemoTrading: settings.bitgetDemoTrading
  };
  Object.assign(runtimeState(), next);
  return next;
}

export function getBitgetRuntimeSettings(): BitgetRuntimeSettings {
  return { ...runtimeState() };
}

export function bitgetClientSettings(settings: BitgetRuntimeSettings) {
  return {
    accountMode: settings.bitgetAccountMode,
    demoTrading: settings.bitgetDemoTrading,
    ...(isBotSettings(settings) ? { orderBookMaxAgeMs: settings.orderbookMaxAgeMs } : {})
  } as const;
}

function isBotSettings(
  settings: BitgetRuntimeSettings
): settings is BitgetRuntimeSettings & Pick<BotSettings, "orderbookMaxAgeMs"> {
  return "orderbookMaxAgeMs" in settings
    && Number.isInteger(settings.orderbookMaxAgeMs);
}
