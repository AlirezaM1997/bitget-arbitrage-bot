import { z } from "zod";

const schema = z.object({
  BITGET_API_BASE: z.string().url().default("https://api.bitget.com"),
  BITGET_WS_PUBLIC: z.string().url().default("wss://ws.bitget.com/v2/ws/public"),
  BITGET_API_KEY: z.string().optional(),
  BITGET_API_SECRET: z.string().optional(),
  BITGET_API_PASSPHRASE: z.string().optional()
});

const raw = schema.parse(process.env);

export const config = {
  ...raw,
  BITGET_API_BASE: raw.BITGET_API_BASE.replace(/\/$/, ""),
  BITGET_WS_PUBLIC: raw.BITGET_WS_PUBLIC.replace(/\/$/, "")
};
