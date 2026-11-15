// WPU-X21: the official "Pay with EPS" badge (dark, two rows of payment methods, "Verified by EPS"),
// supplied by the owner. A self-hosted image (U3), explicit size, lazy, no inline style (U4); the
// responsive width is the class `tc-eps-badge` of tc.css. The alt text is a message of the caller (U5).
export const EPS_BADGE_SRC = "/brand/eps-pay-dark.png";
export const EPS_BADGE_WIDTH = 1120;
export const EPS_BADGE_HEIGHT = 196;

export function EpsBadge({ alt, className }: { alt: string; className?: string }) {
  return (
    <img
      className={className === undefined ? "tc-eps-badge" : `tc-eps-badge ${className}`}
      src={EPS_BADGE_SRC}
      width={EPS_BADGE_WIDTH}
      height={EPS_BADGE_HEIGHT}
      loading="lazy"
      alt={alt}
    />
  );
}
