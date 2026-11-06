type Level = "debug" | "info" | "warn" | "error";

const order: Level[] = ["debug", "info", "warn", "error"];

export function createLogger(min: Level = "info") {
  return (level: Level, message: string) => {
    if (order.indexOf(level) < order.indexOf(min)) return;
    console.log(`[${level}] ${message}`);
  };
}
