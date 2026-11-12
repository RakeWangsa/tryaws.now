export interface ImageTileProps {
  type: "radio" | "checkbox";
  name: string;
  value: string;
  label: string;
  /** A file under `/theme/assets/apps/`; no other origin and no other type (U3, U13). Null: generic icon. */
  imageSrc: string | null;
  size?: number;
  defaultChecked?: boolean;
}

const IMAGE_PATH = /^\/theme\/assets\/apps\/[A-Za-z0-9][A-Za-z0-9_-]*\.svg$/;

/**
 * A pick with a logo (header.html, `div.os`): a native input, the logo, the name and a check mark. For
 * `imageSrc: null` the logo is the generic server icon (16.3: an image without a logo).
 */
export function ImageTile({
  type,
  name,
  value,
  label,
  imageSrc,
  size = 45,
  defaultChecked,
}: ImageTileProps) {
  if (imageSrc !== null && !IMAGE_PATH.test(imageSrc)) {
    throw new RangeError(
      `ImageTile: imageSrc must be an .svg file under /theme/assets/apps/, got ${JSON.stringify(imageSrc)}`,
    );
  }
  return (
    <label className="os border-0 upping cursor-p noshadow bg-seccolorstyle tc-image-tile">
      <input
        type={type}
        name={name}
        value={value}
        className="tc-image-tile-input"
        defaultChecked={defaultChecked}
      />
      {imageSrc === null ? (
        <i className="fas fa-server tc-image-tile-generic" aria-hidden="true" />
      ) : (
        <img src={imageSrc} alt="" width={size} height={size} />
      )}
      <span className="mergecolor">{label}</span>
      <i className="fas fa-check-circle tc-image-tile-check" aria-hidden="true" />
    </label>
  );
}
