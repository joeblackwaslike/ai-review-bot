export const TIMEOUT_MS = 5000;

export function withTimeout(controller: AbortController) {
  return setTimeout(() => controller.abort(), TIMEOUT_MS);
}
