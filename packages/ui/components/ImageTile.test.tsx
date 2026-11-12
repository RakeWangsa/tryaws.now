// @vitest-environment jsdom
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderKit, ssr, unknownClasses } from "../test/render";
import { ImageTile } from "./ImageTile";

const src = "/theme/assets/apps/ubuntu.svg";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../");

describe("ImageTile without a logo", () => {
  it("shows the generic server icon, no img, and keeps the input and the name", () => {
    const { container } = renderKit(
      <ImageTile
        type="radio"
        name="os"
        value="amazon_linux_2023"
        label="Amazon Linux"
        imageSrc={null}
      />,
    );
    const label = container.firstElementChild as HTMLElement;
    expect(label.querySelector("img")).toBeNull();
    const icon = label.querySelector("i.tc-image-tile-generic");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(label.querySelector("input")?.getAttribute("value")).toBe("amazon_linux_2023");
    expect(label.textContent).toBe("Amazon Linux");
  });
  it("still refuses a logo path outside the theme apps", () => {
    expect(() =>
      renderKit(
        <ImageTile type="radio" name="os" value="x" label="X" imageSrc="https://evil/x.svg" />,
      ),
    ).toThrow(RangeError);
  });
});

describe("ImageTile", () => {
  it("has the markup of the mockup (header.html, div.os)", () => {
    const { container } = renderKit(
      <ImageTile type="radio" name="os" value="ubuntu" label="Ubuntu" imageSrc={src} />,
    );
    const label = container.firstElementChild as HTMLElement;
    expect(label.tagName).toBe("LABEL");
    expect([...label.classList]).toEqual([
      "os",
      "border-0",
      "upping",
      "cursor-p",
      "noshadow",
      "bg-seccolorstyle",
      "tc-image-tile",
    ]);
    const [input, img, text, check] = [...label.children] as HTMLElement[];
    expect(input?.tagName).toBe("INPUT");
    expect(input?.classList.contains("tc-image-tile-input")).toBe(true);
    expect(input?.getAttribute("type")).toBe("radio");
    expect(input?.getAttribute("name")).toBe("os");
    expect(input?.getAttribute("value")).toBe("ubuntu");
    expect(img?.tagName).toBe("IMG");
    expect(img?.getAttribute("src")).toBe(src);
    expect(img?.getAttribute("alt")).toBe("");
    expect(img?.getAttribute("width")).toBe("45");
    expect(img?.getAttribute("height")).toBe("45");
    expect(text?.classList.contains("mergecolor")).toBe(true);
    expect(text?.textContent).toBe("Ubuntu");
    expect(check?.tagName).toBe("I");
    expect(check?.getAttribute("class")).toBe("fas fa-check-circle tc-image-tile-check");
    expect(check?.getAttribute("aria-hidden")).toBe("true");
    expect(unknownClasses(container)).toEqual([]);
  });

  it("uses size for width and height", () => {
    const { container } = renderKit(
      <ImageTile type="radio" name="os" value="u" label="Ubuntu" imageSrc={src} size={60} />,
    );
    const img = container.querySelector("img") as HTMLElement;
    expect(img.getAttribute("width")).toBe("60");
    expect(img.getAttribute("height")).toBe("60");
  });

  it("can start checked and be a checkbox", () => {
    const { container, getByLabelText } = renderKit(
      <ImageTile
        type="checkbox"
        name="os"
        value="u"
        label="Ubuntu"
        imageSrc={src}
        defaultChecked
      />,
    );
    const input = getByLabelText("Ubuntu") as HTMLInputElement;
    expect(input).toBe(container.querySelector("input"));
    expect(input.type).toBe("checkbox");
    expect(input.checked).toBe(true);
  });

  it("finds the input by its label text", () => {
    const { getByLabelText } = renderKit(
      <ImageTile type="radio" name="os" value="u" label="Ubuntu" imageSrc={src} />,
    );
    expect((getByLabelText("Ubuntu") as HTMLInputElement).value).toBe("u");
  });

  it("throws for an image that is not an svg under /theme/assets/apps/", () => {
    for (const bad of [
      "https://x/y.svg",
      "/theme/assets/apps/../x.svg",
      "/theme/assets/apps/x.png",
      "//evil.example/theme/assets/apps/x.svg",
      "/theme/assets/apps/x.svg?u=1",
    ]) {
      expect(() =>
        renderKit(<ImageTile type="radio" name="os" value="u" label="U" imageSrc={bad} />),
      ).toThrow(RangeError);
    }
  });

  it("points at a file that exists", () => {
    expect(existsSync(resolve(repoRoot, "packages/ui/theme/assets/apps/ubuntu.svg"))).toBe(true);
  });

  it("has no style attribute in bn and en", () => {
    for (const locale of ["bn", "en"] as const) {
      expect(
        ssr(<ImageTile type="radio" name="os" value="u" label="উবুন্টু" imageSrc={src} />, {
          locale,
        }),
      ).not.toContain(" style=");
    }
  });
});
