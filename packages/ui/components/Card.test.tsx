// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderKit, ssr, unknownClasses } from "../test/render";
import { Card } from "./Card";

describe("Card", () => {
  it("has exactly the card classes of the mockup", () => {
    const { container } = renderKit(<Card>body</Card>);
    const root = container.firstElementChild as HTMLElement;
    expect(root.tagName).toBe("DIV");
    expect([...root.classList]).toEqual(["sec-main", "sec-bg1", "bg-seccolorstyle", "noshadow"]);
  });

  it("renders another element with as", () => {
    for (const as of ["section", "article"] as const) {
      const { container, unmount } = renderKit(<Card as={as}>body</Card>);
      expect(container.firstElementChild?.tagName).toBe(as.toUpperCase());
      unmount();
    }
  });

  it("adds a class of the caller after the card classes", () => {
    const { container } = renderKit(<Card className="mb-4">body</Card>);
    expect((container.firstElementChild as HTMLElement).className).toBe(
      "sec-main sec-bg1 bg-seccolorstyle noshadow mb-4",
    );
  });

  it("renders the title as h2 by default, before the children", () => {
    const { container } = renderKit(
      <Card title="Heading">
        <p>child</p>
      </Card>,
    );
    const heading = container.querySelector("h2") as HTMLElement;
    expect(heading.textContent).toBe("Heading");
    expect(heading.className).toBe("h4 mergecolor mb-3");
    expect(heading.nextElementSibling?.tagName).toBe("P");
    expect(container.firstElementChild?.firstElementChild).toBe(heading);
  });

  it("renders the title at the chosen level", () => {
    for (const level of ["h2", "h3", "h4"] as const) {
      const { container, unmount } = renderKit(
        <Card title="Heading" titleAs={level}>
          x
        </Card>,
      );
      const heading = container.querySelector(level) as HTMLElement;
      expect(heading.textContent).toBe("Heading");
      expect(heading.className).toBe("h4 mergecolor mb-3");
      unmount();
    }
  });

  it("renders no heading without a title", () => {
    const { container } = renderKit(<Card>body</Card>);
    expect(container.querySelector("h2, h3, h4")).toBeNull();
  });

  it("uses only known classes and no style attribute", () => {
    const { container } = renderKit(<Card title="T">body</Card>);
    expect(unknownClasses(container)).toEqual([]);
    expect(ssr(<Card title="T">body</Card>)).not.toContain(" style=");
  });

  it("renders in bn and en", () => {
    for (const locale of ["bn", "en"] as const) {
      const { container, unmount } = renderKit(<Card title="T">body</Card>, { locale });
      expect(container.textContent).toBe("Tbody");
      unmount();
    }
  });
});
