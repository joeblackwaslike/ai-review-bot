import { settings } from "../settings.js";

export function withTimeout(controller: AbortController) {
  return setTimeout(() => controller.abort(), settings.requestTimeoutMs);
}
