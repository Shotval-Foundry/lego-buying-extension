// 監聽網頁發出的請求
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
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

// 讓網頁知道擴充功能已安裝
window.postMessage({ type: "LEGO_HELPER_READY" }, "*");
