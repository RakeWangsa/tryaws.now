// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { ssr, renderKit, unknownClasses } from "../test/render";
import { Badge, StateBadge, type BadgeState } from "./Badge";

const STATES: [BadgeState, string, string][] = [
  ["creating", "badge bg-info text-dark", "fas fa-spinner"],
  ["running", "badge bg-success", "fas fa-check-circle"],
  ["stopped", "badge bg-secondary", "fas fa-stop-circle"],
  ["grace", "badge bg-warning text-dark", "fas fa-clock"],
  ["retained", "badge bg-grey", "fas fa-archive"],
  ["problem", "badge bg-danger", "fas fa-exclamation-triangle"],
  ["paid", "badge bg-success", "fas fa-check"],
  ["pending", "badge bg-warning text-dark", "fas fa-hourglass-half"],
  ["failed", "badge bg-secondary", "fas fa-times-circle"],
];

const sorted = (list: string): string[] => list.split(" ").sort();

describe("StateBadge", () => {
  it.each(STATES)("%s has the classes %s and the icon %s", (state, classes, icon) => {
    const { container } = renderKit(<StateBadge state={state} />);
    const span = container.firstElementChild as HTMLElement;
    expect(span.tagName).toBe("SPAN");
    expect([...span.classList].sort()).toEqual(sorted(classes));
    const i = span.querySelector("i") as HTMLElement;
    expect(i.getAttribute("class")).toBe(`${icon} me-1`);
    expect(i.getAttribute("aria-hidden")).toBe("true");
    expect(span.firstElementChild).toBe(i);
    expect(unknownClasses(container)).toEqual([]);
  });

  it.each(STATES)("%s has a label in both locales", (state) => {
    const bn = renderKit(<StateBadge state={state} />, { locale: "bn" });
    const bnText = (bn.container.firstElementChild as HTMLElement).textContent ?? "";
    expect(bnText.trim()).not.toBe("");
    expect(/[ঀ-৿]/.test(bnText)).toBe(true);
    bn.unmount();
    const en = renderKit(<StateBadge state={state} />, { locale: "en" });
    const enText = (en.container.firstElementChild as HTMLElement).textContent ?? "";
    expect(enText.trim()).not.toBe("");
    expect(/[ঀ-৿]/.test(enText)).toBe(false);
  });

  it("uses the exact labels of the brief", () => {
    const labels: Record<BadgeState, [string, string]> = {
      creating: ["তৈরি হচ্ছে", "Creating"],
      running: ["চলছে", "Running"],
      stopped: ["বন্ধ", "Stopped"],
      grace: ["স্থগিত, নবায়ন বাকি", "Suspended, renewal due"],
      retained: ["মুছে ফেলা হয়েছে, ব্যাকআপ রাখা আছে", "Deleted, backup kept"],
      problem: ["সমস্যা", "Problem"],
      paid: ["পরিশোধিত", "Paid"],
      pending: ["অপেক্ষমাণ", "Pending"],
      failed: ["ব্যর্থ", "Failed"],
    };
    for (const [state, [bnLabel, enLabel]] of Object.entries(labels) as [
      BadgeState,
      [string, string],
    ][]) {
      const bn = renderKit(<StateBadge state={state} />, { locale: "bn" });
      expect(bn.container.textContent).toBe(bnLabel);
      bn.unmount();
      const en = renderKit(<StateBadge state={state} />, { locale: "en" });
      expect(en.container.textContent).toBe(enLabel);
      en.unmount();
    }
  });

  it("label overrides the message", () => {
    const { container } = renderKit(<StateBadge state="running" label="Online" />);
    expect(container.textContent).toBe("Online");
  });

  it("has no style attribute in the server markup", () => {
    for (const [state] of STATES) {
      expect(ssr(<StateBadge state={state} />)).not.toContain(" style=");
      expect(ssr(<StateBadge state={state} />, { locale: "en" })).not.toContain(" style=");
    }
  });
});

describe("Badge", () => {
  it.each([
    ["purple", "badge bg-purple"],
    ["grey", "badge bg-grey"],
    ["pink", "badge bg-pink"],
    ["dark", "badge bg-dark"],
  ] as const)("tone %s has the classes %s", (tone, classes) => {
    const { container } = renderKit(<Badge tone={tone}>New</Badge>);
    const span = container.firstElementChild as HTMLElement;
    expect(span.tagName).toBe("SPAN");
    expect([...span.classList].sort()).toEqual(sorted(classes));
    expect(span.textContent).toBe("New");
    expect(unknownClasses(container)).toEqual([]);
  });

  it("feat adds feat, and className is appended", () => {
    const { container } = renderKit(
      <Badge tone="purple" feat className="mb-2">
        Popular
      </Badge>,
    );
    expect([...(container.firstElementChild as Element).classList].sort()).toEqual(
      sorted("badge bg-purple feat mb-2"),
    );
    expect(unknownClasses(container)).toEqual([]);
  });

  it("has no style attribute in the server markup", () => {
    expect(ssr(<Badge tone="pink">x</Badge>)).not.toContain(" style=");
  });
});
