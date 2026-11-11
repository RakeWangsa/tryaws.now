import { cx } from "./cx";

export type StatTileTone = "purple" | "grey" | "pink" | "dark";

export interface StatTileProps {
  value: string;
  description: string;
  tag?: { text: string; tone: StatTileTone };
}

const TONE_CLASS: Record<StatTileTone, string> = {
  purple: "bg-purple",
  grey: "bg-grey",
  pink: "bg-pink",
  dark: "bg-dark",
};

/** A figure with a line of text and an optional tag (about.html, `section#clientstats`). */
export function StatTile({ value, description, tag }: StatTileProps) {
  return (
    <div className="wrapper price-container text-start bg-seccolorstyle noshadow">
      {tag ? <div className={cx("plans badge feat", TONE_CLASS[tag.tone])}>{tag.text}</div> : null}
      <div className="top-content pb-5">
        <div className="title mergecolor">{value}</div>
        <div className="fromer pt-3 seccolor">{description}</div>
      </div>
    </div>
  );
}
