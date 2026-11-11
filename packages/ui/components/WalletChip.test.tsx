// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderKit, unknownClasses } from "../test/render";
import type { LinkComponent } from "./types";
import { WalletChip } from "./WalletChip";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WalletChip", () => {
  it("shows the balance in English digits and the hidden word", () => {
    const { container } = renderKit(<WalletChip balanceMinor={1234500n} topUpHref="/en/topup" />, {
      locale: "en",
    });
    const chip = container.firstElementChild as HTMLElement;
    for (const name of ["tc-wallet-chip", "d-flex", "align-items-center", "gap-2"]) {
      expect(chip.classList.contains(name)).toBe(true);
    }
    const merge = chip.querySelector("span.mergecolor") as HTMLElement;
    expect(merge.querySelector("span.visually-hidden")?.textContent).toBe("Balance");
    expect(merge.textContent).toBe("Balance৳12,345.00");
    expect(unknownClasses(container)).toEqual([]);
  });

  it("shows the balance in Bengali digits", () => {
    const { container } = renderKit(<WalletChip balanceMinor={1234500n} topUpHref="/bn/topup" />);
    expect(container.querySelector("span.mergecolor")?.textContent).toBe("ব্যালেন্স৳১২,৩৪৫.০০");
  });

  it("the top-up link is the yellow small button with the href", () => {
    const { container } = renderKit(<WalletChip balanceMinor={1n} topUpHref="/en/topup" />, {
      locale: "en",
    });
    const link = container.querySelector("a") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/en/topup");
    expect(link.classList.contains("btn-default-yellow-fill")).toBe(true);
    expect(link.classList.contains("btn-sm")).toBe(true);
    expect(link.textContent).toBe("Top up");
  });

  it("the top-up label is Bengali in bn", () => {
    const { container } = renderKit(<WalletChip balanceMinor={1n} topUpHref="/bn/topup" />);
    expect(container.querySelector("a")?.textContent).toBe("টপ আপ");
  });

  it("a negative balance keeps its sign", () => {
    const { container } = renderKit(<WalletChip balanceMinor={-500n} topUpHref="/t" />, {
      locale: "en",
    });
    expect(container.querySelector("span.mergecolor")?.textContent).toContain("-৳5.00");
  });

  it("zero is ৳0.00", () => {
    const { container } = renderKit(<WalletChip balanceMinor={0n} topUpHref="/t" />, {
      locale: "en",
    });
    expect(container.querySelector("span.mergecolor")?.textContent).toContain("৳0.00");
  });

  it("a number throws TypeError", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() =>
      renderKit(<WalletChip balanceMinor={500 as unknown as bigint} topUpHref="/t" />),
    ).toThrow(TypeError);
  });

  it("uses linkAs for the top-up link", () => {
    const Custom: LinkComponent = ({ href, className, children }) => (
      <a data-custom="1" href={href} className={className}>
        {children}
      </a>
    );
    const { container } = renderKit(
      <WalletChip balanceMinor={1n} topUpHref="/t" linkAs={Custom} />,
    );
    expect(container.querySelector("a[data-custom]")?.getAttribute("href")).toBe("/t");
  });
});
