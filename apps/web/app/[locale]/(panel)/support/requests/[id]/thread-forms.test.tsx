// @vitest-environment jsdom
import { NextIntlClientProvider } from "next-intl";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { webMessages } from "../../../../../../i18n/messages.ts";
import type { ThreadActionResult } from "./actions.ts";

// WPU-Z6: the reply and close forms in a browser. The reply sends the request id, the hidden key of this
// render and the text; after a reply that went through the form waits for the page to bring a new key, so
// a used key is never sent again with another text (R7). No testing library: react-dom and act are enough.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const refresh = vi.hoisted(() => ({ count: 0 }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: () => {
      refresh.count += 1;
    },
  }),
}));

const { CloseRequestForm, ReplyForm } = await import("./ThreadForms.tsx");

const REQUEST = "0191a000-0000-7000-8000-0000000000e1";
const KEY_1 = "0191a000-0000-7000-8000-0000000000a1";
const KEY_2 = "0191a000-0000-7000-8000-0000000000a2";

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  refresh.count = 0;
});

async function mount(node: React.ReactNode): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <NextIntlClientProvider locale="en" messages={webMessages.en} timeZone="Asia/Dhaka">
        {node}
      </NextIntlClientProvider>,
    );
  });
  return host;
}

async function rerender(node: React.ReactNode): Promise<void> {
  await act(async () => {
    root?.render(
      <NextIntlClientProvider locale="en" messages={webMessages.en} timeZone="Asia/Dhaka">
        {node}
      </NextIntlClientProvider>,
    );
  });
}

async function type(el: HTMLElement, text: string): Promise<void> {
  const area = el.querySelector("textarea") as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(area, text);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit(el: HTMLElement): Promise<void> {
  const form = el.querySelector("form") as HTMLFormElement;
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

const button = (el: HTMLElement): HTMLButtonElement =>
  el.querySelector('button[type="submit"]') as HTMLButtonElement;

describe("ReplyForm", () => {
  it("sends the request id, the hidden key of this render and the text", async () => {
    const sent: unknown[] = [];
    const action = async (input: unknown): Promise<ThreadActionResult> => {
      sent.push(input);
      return { ok: true, id: "m1", replayed: false };
    };
    const el = await mount(
      <ReplyForm requestId={REQUEST} idempotencyKey={KEY_1} closed={false} action={action} />,
    );
    await type(el, "Any news?");
    await submit(el);
    expect(sent).toEqual([{ requestId: REQUEST, idempotencyKey: KEY_1, body: "Any news?" }]);
    expect(el.textContent).toContain("Your reply was added.");
    expect((el.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
    expect(refresh.count).toBe(1);
  });

  it("after a reply it waits for a new key; the used key is never sent again", async () => {
    const sent: { idempotencyKey: string }[] = [];
    const action = async (input: unknown): Promise<ThreadActionResult> => {
      sent.push(input as { idempotencyKey: string });
      return { ok: true, id: "m1", replayed: false };
    };
    const node = (key: string) => (
      <ReplyForm requestId={REQUEST} idempotencyKey={key} closed={false} action={action} />
    );
    const el = await mount(node(KEY_1));
    await type(el, "first");
    await submit(el);
    expect(button(el).disabled).toBe(true);
    await type(el, "second");
    await submit(el);
    expect(sent.map((s) => s.idempotencyKey)).toEqual([KEY_1]);
    // The page is rendered again with a new key: the form takes it.
    await rerender(node(KEY_2));
    expect(button(el).disabled).toBe(false);
    await submit(el);
    expect(sent.map((s) => s.idempotencyKey)).toEqual([KEY_1, KEY_2]);
  });

  it("shows the field error of a refused text and keeps the text", async () => {
    const action = async (): Promise<ThreadActionResult> => ({
      ok: false,
      error: "validation",
      fields: { body: "invalid" },
    });
    const el = await mount(
      <ReplyForm requestId={REQUEST} idempotencyKey={KEY_1} closed={false} action={action} />,
    );
    await type(el, "x");
    await submit(el);
    expect(el.textContent).toContain("Some details are wrong.");
    expect(el.textContent).toContain("Write 1 to 5000 characters");
    expect((el.querySelector("textarea") as HTMLTextAreaElement).value).toBe("x");
    expect(button(el).disabled).toBe(false);
  });

  it("a thrown action is a platform message, never the error text", async () => {
    const action = async (): Promise<ThreadActionResult> => {
      throw new Error("raw database text");
    };
    const el = await mount(
      <ReplyForm requestId={REQUEST} idempotencyKey={KEY_1} closed={true} action={action} />,
    );
    expect(el.textContent).toContain(
      "This request is closed. Writing a reply below opens it again.",
    );
    await type(el, "hello");
    await submit(el);
    expect(el.textContent).toContain("We could not finish this now.");
    expect(el.textContent).not.toContain("raw database text");
  });
});

describe("CloseRequestForm", () => {
  it("sends only the request id, says it is closed and refreshes the page", async () => {
    const sent: unknown[] = [];
    const action = async (input: unknown): Promise<ThreadActionResult> => {
      sent.push(input);
      return { ok: true, id: REQUEST, replayed: false };
    };
    const el = await mount(<CloseRequestForm requestId={REQUEST} action={action} />);
    expect(el.textContent).toContain("Close request");
    await submit(el);
    expect(sent).toEqual([{ requestId: REQUEST }]);
    expect(el.textContent).toContain("The request was closed.");
    expect(refresh.count).toBe(1);
  });

  it("shows a refusal as a platform message", async () => {
    const action = async (): Promise<ThreadActionResult> => ({ ok: false, error: "rate_limited" });
    const el = await mount(<CloseRequestForm requestId={REQUEST} action={action} />);
    await submit(el);
    expect(el.textContent).toContain("Too many attempts in a short time.");
    expect(refresh.count).toBe(0);
  });
});
