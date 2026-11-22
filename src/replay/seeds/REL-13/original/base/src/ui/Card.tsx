import type { ReactNode } from "react";

export function Card({ children, elevated }: { children: ReactNode; elevated: boolean }) {
  return <section className={elevated ? "card elevated" : "card"}>{children}</section>;
}
