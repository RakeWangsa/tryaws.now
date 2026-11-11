import { afterEach } from "vitest";

// Harmless in the node environment. In jsdom it adds what Radix needs and that jsdom lacks, and it
// unmounts what a test rendered.
if (typeof window !== "undefined") {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  if (!("ResizeObserver" in window)) {
    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      writable: true,
      value: ResizeObserverStub,
    });
  }
  if (typeof window.matchMedia !== "function") {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: (query: string): MediaQueryList => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    });
  }
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.scrollIntoView ??= () => {};
  proto.hasPointerCapture ??= () => false;
  proto.releasePointerCapture ??= () => {};

  const { cleanup } = await import("@testing-library/react");
  afterEach(() => {
    cleanup();
  });
}
