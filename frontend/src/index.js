import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@/index.css";
import App from "@/App";

// -----------------------------------------------------------------------------
// Silence the benign "ResizeObserver loop" browser warning.
// Radix UI's Popover/Command/Calendar remeasure on open which triggers this
// harmless notification; CRA's dev overlay otherwise treats it as an error.
// This runs before any render so the overlay never sees it.
// -----------------------------------------------------------------------------
const RESIZE_OBSERVER_MSG = "ResizeObserver loop";
const _origError = window.console.error;
window.console.error = (...args) => {
  if (args[0] && typeof args[0] === "string" && args[0].includes(RESIZE_OBSERVER_MSG)) return;
  _origError(...args);
};
window.addEventListener("error", (e) => {
  if (e?.message && e.message.includes(RESIZE_OBSERVER_MSG)) {
    e.stopImmediatePropagation();
    e.preventDefault();
  }
});
window.addEventListener("unhandledrejection", (e) => {
  const msg = e?.reason?.message || String(e?.reason || "");
  if (msg.includes(RESIZE_OBSERVER_MSG)) {
    e.stopImmediatePropagation();
    e.preventDefault();
  }
});

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
