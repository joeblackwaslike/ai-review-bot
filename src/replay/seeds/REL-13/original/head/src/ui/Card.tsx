import type { ReactNode } from "react";

type Props = { children: ReactNode; elevated: boolean };

export function Card({ children, elevated }: Props) {
  return <section className={elevated ? "card" : "card elevated"}>{children}</section>;
}
