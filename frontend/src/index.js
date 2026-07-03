import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@/index.css";
import App from "@/App";

// -----------------------------------------------------------------------------
// Silence the benign "ResizeObserver loop completed with undelivered
// notifications." browser warning. Radix UI's Popover/Command/Calendar
// re-measure their content on open, which triggers this notification; the
// webpack-dev-server client overlay otherwise renders it as a fake runtime
// error. This has zero impact on functionality and never appears in prod.
// -----------------------------------------------------------------------------
const RO_MSG = "ResizeObserver loop";

// (a) Patch ResizeObserver at the source: wrap each observer callback in
//     requestAnimationFrame so notifications never overflow the loop.
if (typeof window !== "undefined" && window.ResizeObserver) {
  const OriginalRO = window.ResizeObserver;
  window.ResizeObserver = class PatchedResizeObserver extends OriginalRO {
    constructor(callback) {
      super((entries, observer) => {
        window.requestAnimationFrame(() => {
          try { callback(entries, observer); } catch (err) {
            if (!(err && String(err.message || err).includes(RO_MSG))) throw err;
          }
        });
      });
    }
  };
}

// (b) Capture-phase window listeners so we run BEFORE the CRA/webpack-dev-server
//     overlay's own bubbling-phase handler and cancel the message entirely.
if (typeof window !== "undefined") {
  window.addEventListener(
    "error",
    (e) => {
      if (e && typeof e.message === "string" && e.message.includes(RO_MSG)) {
        e.stopImmediatePropagation();
        e.stopPropagation();
        e.preventDefault();
      }
    },
    true // <-- capture
  );
  window.addEventListener(
    "unhandledrejection",
    (e) => {
      const msg = (e && (e.reason?.message || String(e.reason))) || "";
      if (msg.includes(RO_MSG)) {
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    },
    true
  );

  // (c) Also silence console.error copies of the same warning.
  const _origConsoleError = window.console.error;
  window.console.error = (...args) => {
    if (args[0] && typeof args[0] === "string" && args[0].includes(RO_MSG)) return;
    _origConsoleError(...args);
  };
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      refetchOnWindowFocus: false,
    },
  },
});

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
