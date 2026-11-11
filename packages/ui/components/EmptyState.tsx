import type { ReactNode } from "react";
import { EmptyIllustration } from "./EmptyIllustration";

export interface EmptyStateProps {
  title: string;
  description?: string;
  /** One primary action; the caller passes a `Button`. */
  action?: ReactNode;
  /** Replaces the default drawing. */
  illustration?: ReactNode;
  /** The page of 404.html: a `section.sec-normal.notfound` around the state, and the title is the h1. */
  fullPage?: boolean;
}

/** One sentence, one primary button (U11). */
export function EmptyState({
  title,
  description,
  action,
  illustration,
  fullPage = false,
}: EmptyStateProps) {
  const Heading = fullPage ? "h1" : "h2";
  const state = (
    <div className="tc-empty text-center">
      {illustration ?? <EmptyIllustration />}
      <Heading className="h4 mergecolor">{title}</Heading>
      {description ? <p className="seccolor">{description}</p> : null}
      {action}
    </div>
  );
  if (!fullPage) return state;
  return (
    <section className="sec-normal notfound pt-150">
      <div className="container">{state}</div>
    </section>
  );
}
