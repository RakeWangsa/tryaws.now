/** A plain empty-box drawing in `currentColor`; hand-written, no file from the theme (16.13). */
export function EmptyIllustration() {
  return (
    <svg
      className="tc-illustration"
      viewBox="0 0 120 90"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 38 L60 20 L100 38 L60 56 Z" />
      <path d="M20 38 V64 L60 82 V56" />
      <path d="M100 38 V64 L60 82" />
      <path d="M40 29 L80 47" />
    </svg>
  );
}
