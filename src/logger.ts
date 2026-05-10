import pino from "pino";
import { env } from "./env.js";

const isDev = env.NODE_ENV !== "production";

export const logger = pino({
  level: isDev ? "debug" : "info",
  base: { service: "linq-video-editor" },
  ...(isDev && {
    transport: {
      target: "pino-pretty",
      options: { colorize: true, translateTime: "SYS:HH:MM:ss.l" },
    },
  }),
});
