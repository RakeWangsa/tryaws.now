/**
 * WPU-Z16 (AEO): the plain answer of a page, 40 to 60 words of prose near the top, in the hero
 * subtitle class of the mockup (`.top-header .wrapper .subheading`). ANSWER_SELECTOR of
 * server/public/seo.ts and `geo.answerBlockSelector` of omnirank.config.json name this class; the
 * speakable part of the page's WebPage JSON-LD points at it. No list markup inside.
 */
export function AnswerBlock({ text }: { text: string }) {
  return <p className="subheading fw-normal text-muted tc-muted mb-4">{text}</p>;
}
