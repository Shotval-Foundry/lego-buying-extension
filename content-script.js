// 監聽網頁發出的請求
window.addEventListener("message", (event) => {
  if (event.source !== window) return;

  // 即時探測：網頁想知道擴充功能現在還在不在
  if (event.data?.type === "LEGO_HELPER_PING") {
    window.postMessage({ type: "LEGO_HELPER_PONG" }, "*");
    return;
  }

  if (event.data?.type !== "LEGO_HELPER_REQUEST") return;

  // 用長連線通道跟 background 溝通，這樣才能持續收到進度回報，
  // 不是只能等全部做完才拿到一次性的回應。
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

// 讓網頁知道擴充功能已安裝（頁面剛載入時的通知，仍保留）
window.postMessage({ type: "LEGO_HELPER_READY" }, "*");
