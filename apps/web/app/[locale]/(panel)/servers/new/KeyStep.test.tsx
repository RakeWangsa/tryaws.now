// @vitest-environment jsdom
import { NextIntlClientProvider } from "next-intl";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webMessages } from "../../../../../i18n/messages.ts";

// WPU-G10. The key step in a browser: the pair is made in the tab, the private key is offered as a download
// ONCE and is not in the page afterwards, and the submit button of the form waits for the download. No
// testing library: react-dom and act are enough (no new dependency, R17).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const PRIVATE = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n";
const PUBLIC = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAAQC7";
const keygen = vi.hoisted(() => ({ fail: null as null | Error }));
vi.mock("./ssh-keygen.ts", async (importActual) => ({
  ...(await importActual<typeof import("./ssh-keygen.ts")>()),
  generateRsaKeyPair: async () => {
    if (keygen.fail !== null) throw keygen.fail;
    return { publicKey: PUBLIC, privateKey: PRIVATE };
  },
}));

const { KeyStep } = await import("./KeyStep.tsx");

const KEYS = [
  { id: "0190aaaa-0000-7000-8000-0000000000c1", name: "Laptop", fingerprint: "SHA256:a" },
];
let ready: boolean[] = [];
let downloads: { name: string; blob: Blob }[] = [];
let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount(
  keys = KEYS,
  locale: "en" | "bn" = "en",
  extra: Partial<Parameters<typeof KeyStep>[0]> = {},
) {
  ready = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <NextIntlClientProvider locale={locale} messages={webMessages[locale]} timeZone="Asia/Dhaka">
        <form>
          <KeyStep
            locale={locale}
            keys={keys}
            fieldError={() => undefined}
            nameTaken={false}
            onReady={(r) => ready.push(r)}
            {...extra}
          />
        </form>
      </NextIntlClientProvider>,
    );
  });
}

beforeEach(() => {
  keygen.fail = null;
  downloads = [];
  Object.assign(URL, {
    createObjectURL: (blob: Blob) => {
      downloads.push({ name: "", blob });
      return "blob:test";
    },
    revokeObjectURL: () => {},
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    const last = downloads.at(-1);
    if (last !== undefined) last.name = this.download;
  });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
});

const q = <T extends Element>(selector: string): T | null =>
  (host as HTMLElement).querySelector<T>(selector);
const value = (name: string): string => q<HTMLInputElement>(`[name="${name}"]`)?.value ?? "<none>";
const byText = (tag: string, pattern: RegExp): HTMLElement | null =>
  [...(host as HTMLElement).querySelectorAll<HTMLElement>(tag)].find((el) =>
    pattern.test(el.textContent ?? ""),
  ) ?? null;
const radioOf = (label: string): HTMLInputElement => {
  const l = byText("label", new RegExp(label));
  return (host as HTMLElement).querySelector<HTMLInputElement>(
    `#${l?.getAttribute("for")}`,
  ) as HTMLInputElement;
};
async function click(el: Element | null): Promise<void> {
  await act(async () => {
    el?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}
async function type(el: HTMLInputElement | HTMLTextAreaElement, text: string): Promise<void> {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const html = (): string => (host as HTMLElement).innerHTML;

describe("KeyStep", () => {
  it("with a key it starts on the existing key and is ready; the other mode posts other fields", async () => {
    await mount();
    expect(value("keyMode")).toBe("existing");
    expect(value("keyPairId")).toBe(KEYS[0]?.id);
    expect(ready.at(-1)).toBe(true);
    await click(radioOf("Upload my public key"));
    expect(value("keyMode")).toBe("paste");
    expect(q('[name="keyPairId"]')).toBeNull();
    expect(q('textarea[name="newKeyPublic"]')).not.toBeNull();
    expect(ready.at(-1)).toBe(true);
  });

  it("without a key it starts on a new pair and is not ready until the private key was downloaded", async () => {
    await mount([]);
    expect(value("keyMode")).toBe("generate");
    expect(ready.at(-1)).toBe(false);
    const make = () => byText("button", /Create key pair/) as HTMLButtonElement;
    expect(make().disabled).toBe(true); // a name is needed first
    await type(q<HTMLInputElement>('[name="newKeyName"]') as HTMLInputElement, "my laptop");
    expect(make().disabled).toBe(false);
    await click(make());
    // the pair exists: the public line is in the form, the private key is not in the page
    expect(value("newKeyPublic")).toBe(PUBLIC);
    expect(html()).not.toContain("PRIVATE KEY");
    expect(ready.at(-1)).toBe(false);
    await click(byText("button", /Download private key/));
    // downloaded once, as a file named after the key, from memory, and then gone
    expect(downloads).toHaveLength(1);
    expect(downloads[0]?.name).toBe("my-laptop.pem");
    expect(await downloads[0]?.blob.text()).toBe(PRIVATE);
    expect(byText("button", /Download private key/)).toBeNull();
    expect(html()).not.toContain("PRIVATE KEY");
    expect(html()).toContain("cannot be downloaded again");
    expect(ready.at(-1)).toBe(true);
    // the name stays in the form (read only), so it is posted with the public key
    expect(value("newKeyName")).toBe("my laptop");
    expect(q<HTMLInputElement>('[name="newKeyName"]')?.readOnly).toBe(true);
  });

  it("changing the mode after a pair was made drops the private key and the public line", async () => {
    await mount([]);
    await type(q<HTMLInputElement>('[name="newKeyName"]') as HTMLInputElement, "k");
    await click(byText("button", /Create key pair/));
    await click(radioOf("Upload my public key"));
    expect(q<HTMLTextAreaElement>('textarea[name="newKeyPublic"]')?.value).toBe("");
    await click(radioOf("Create a new key pair"));
    expect(byText("button", /Download private key/)).toBeNull();
    expect(ready.at(-1)).toBe(false);
  });

  it("a browser that cannot make the RSA pair says so and points to the other ways, and never becomes ready", async () => {
    keygen.fail = new DOMException("no", "NotSupportedError");
    await mount([]);
    await type(q<HTMLInputElement>('[name="newKeyName"]') as HTMLInputElement, "k");
    await click(byText("button", /Create key pair/));
    expect(q('[role="alert"]')?.textContent).toContain("This browser cannot create keys");
    expect(ready.at(-1)).toBe(false);
  });

  it("any other failure is a fixed message without the text of the error", async () => {
    keygen.fail = new Error("secret internal detail");
    await mount([]);
    await type(q<HTMLInputElement>('[name="newKeyName"]') as HTMLInputElement, "k");
    await click(byText("button", /Create key pair/));
    expect(q('[role="alert"]')?.textContent).toContain("could not be created");
    expect(html()).not.toContain("secret internal detail");
  });

  it("shows the error of the server for the name and for the key, in bn too", async () => {
    await mount(KEYS, "bn", {
      nameTaken: true,
      fieldError: (name) => (name === "newKeyPublic" ? "ঠিক নয়" : undefined),
    });
    await click(radioOf("আমার পাবলিক কী দেব"));
    expect(host?.textContent).toContain("এই নামে আপনার আরেকটি কী আছে");
    expect(host?.textContent).toContain("ঠিক নয়");
  });
});
