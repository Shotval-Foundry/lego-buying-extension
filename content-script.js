window.addEventListener("message", (event) => {
  if (event.source !== window) return;

  if (event.data?.type === "LEGO_HELPER_PING") {
    window.postMessage({ type: "LEGO_HELPER_PONG" }, "*");
    return;
  }

  if (event.data?.type !== "LEGO_HELPER_REQUEST") return;
  const port = chrome.runtime.connect({ name: "optimize-channel" });
  port.onMessage.addListener((message) => {
    if (message.type === "PROGRESS") {
      window.postMessage(
        { type: "LEGO_HELPER_PROGRESS", completed: message.completed, total: message.total },
        "*"
      );
    } else if (message.type === "DONE") {
      window.postMessage(
        { type: "LEGO_HELPER_RESPONSE", payload: message.result },
        "*"
      );
      port.disconnect();
    }
  });

  port.postMessage({
    type: "COLLECT_AND_OPTIMIZE",
    parts: event.data.parts,
    token: event.data.token
  });
});

window.postMessage({ type: "LEGO_HELPER_READY" }, "*");