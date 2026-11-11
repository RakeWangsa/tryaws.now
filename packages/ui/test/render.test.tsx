// @vitest-environment jsdom
import { useTranslations } from "next-intl";
import { describe, expect, it } from "vitest";
import { kitMessages, renderKit, ssr, unknownClasses } from "./render";

function Probe() {
  const t = useTranslations("kit.common");
  return <p>{t("close")}</p>;
}

describe("test helpers", () => {
  it("renders in jsdom with the kit messages", () => {
    const bn = renderKit(<Probe />, { locale: "bn" });
    expect(bn.container.textContent).toBe("বন্ধ করুন");
    bn.unmount();
    const en = renderKit(<Probe />, { locale: "en" });
    expect(en.container.textContent).toBe("Close");
  });

  it("renders in bn by default (Bengali is written first)", () => {
    const { container } = renderKit(<Probe />);
    expect(container.textContent).toBe("বন্ধ করুন");
  });

  it("kitMessages puts every group under the key kit", () => {
    const en = kitMessages("en") as { kit: { common: { cancel: string } } };
    expect(en.kit.common.cancel).toBe("Cancel");
    const bn = kitMessages("bn") as { kit: { common: { loading: string } } };
    expect(bn.kit.common.loading).toBe("লোড হচ্ছে");
  });

  it("ssr returns markup without a document", () => {
    const html = ssr(<Probe />, { locale: "en" });
    expect(html).toContain("Close");
    expect(html.startsWith("<p>")).toBe(true);
  });

  it("unknownClasses names a class no stylesheet defines", () => {
    expect(unknownClasses('<p class="btn nope-xyz">')).toEqual(["nope-xyz"]);
    expect(unknownClasses('<i class="fas fa-check-circle icon-cpu tc-x">')).toEqual(["tc-x"]);
    expect(unknownClasses('<a class="btn btn-default-yellow-fill">')).toEqual([]);
  });

  it("unknownClasses reads an element tree, svg included", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<span class="btn"><svg class="nope-svg"></svg><b class="nope-xyz nope-xyz"></b></span>';
    expect(unknownClasses(root)).toEqual(["nope-svg", "nope-xyz"]);
  });

  it("mockup hook classes are accepted", () => {
    expect(unknownClasses('<ul class="radios-filter">')).toEqual([]);
    expect(unknownClasses('<ul class="select-filter price-container btn-group-toggle">')).toEqual(
      [],
    );
  });
});
