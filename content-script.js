// 監聽網頁發出的請求
window.addEventListener("message", (event) => {
  if (event.source !== window) return;

  // 即時探測：網頁想知道擴充功能現在還在不在
  if (event.data?.type === "LEGO_HELPER_PING") {
    window.postMessage({ type: "LEGO_HELPER_PONG" }, "*");
    return;
  }

  if (event.data?.type !== "LEGO_HELPER_REQUEST") return;

  // 轉發給 background script（含 token）
  chrome.runtime.sendMessage(
    { type: "COLLECT_AND_OPTIMIZE", parts: event.data.parts, token: event.data.token },
    (response) => {
      // 收到結果後，轉發回網頁
      window.postMessage(
        { type: "LEGO_HELPER_RESPONSE", payload: response },
        "*"
      );
    }
  );
});

// 讓網頁知道擴充功能已安裝（頁面剛載入時的通知，仍保留）
window.postMessage({ type: "LEGO_HELPER_READY" }, "*");
