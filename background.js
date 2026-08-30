const THIRD_PARTY_KEYWORDS = ['兼容', '國產', '第三方', 'MOC', 'moc'];
const COLOR_ALIASES = {
  '深灰': ['深藍灰', '深灰', 'DBG', 'Dark Bluish Gray', 'dark bluish gray', 'dark gray'],
  '淺灰': ['淺藍灰', '淺灰', 'LBG', 'Light Bluish Gray', 'light bluish gray', 'light gray'],
  '黑':   ['黑色', '黑', 'Black', 'black'],
  '白':   ['白色', '白', 'White', 'white'],
  '紅':   ['紅色', '紅', 'Red', 'red'],
  '黃':   ['黃色', '黃', 'Yellow', 'yellow'],
  '藍':   ['藍色', '藍', 'Blue', 'blue'],
  '綠':   ['綠色', '綠', 'Green', 'green'],
  '橘':   ['橘色', '橘', 'Orange', 'orange'],
  '棕':   ['褐色', '棕色', '咖啡色', 'Brown', 'brown'],
  '透明': ['透明', '透', 'Trans', 'trans', 'Clear', 'clear'],
};

const CONCURRENCY = 5; // 同時進行的零件查詢數量上限

function isGenuine(name) {
  const hasBrand = name.includes('LEGO') || name.includes('樂高');
  const hasThirdParty = THIRD_PARTY_KEYWORDS.some(kw => name.includes(kw));
  return hasBrand && !hasThirdParty;
}

function matchColor(name, targetColor) {
  if (!targetColor || targetColor === "None") return true;
  const aliases = COLOR_ALIASES[targetColor] || [targetColor];
  const badPrefixes = ["砂", "中湛", "亮湛", "金屬", "透明", "夜光", "螢光"];
  for (const alias of aliases) {
    if (name.includes(alias)) {
      for (const bp of badPrefixes) {
        if (name.includes(bp) && !targetColor.includes(bp)) {
          if (name.includes(bp + alias)) return false;
        }
      }
      return true;
    }
  }
  return false;
}

// 批次查詢商品詳細資料。原本是逐批 for 迴圈序列等待，
// 改成用 Promise.all 讓每一批（最多 20 筆 id）同時發送，不互相等待。
async function fetchProdDetails(prodIds) {
  const batches = [];
  for (let i = 0; i < prodIds.length; i += 20) {
    batches.push(prodIds.slice(i, i + 20));
  }

  const seen = new Set();
  const results = [];

  const batchResults = await Promise.all(batches.map(async (batch) => {
    const url = `https://rtapi.ruten.com.tw/api/prod/v3/index.php/prod?id=${batch.join(',')}`;
    try {
      const resp = await fetch(url);
      if (resp.ok) {
        const data = await resp.json();
        if (Array.isArray(data)) return data;
      }
    } catch (e) {
      console.error("fetchProdDetails error:", e);
    }
    return [];
  }));

  for (const batch of batchResults) {
    for (const item of batch) {
      const pid = item.ProdId;
      if (pid && !seen.has(pid)) {
        seen.add(pid);
        results.push(item);
      }
    }
  }

  return results;
}

async function searchPart(partNumber, color) {
  const kwParts = ["lego", partNumber];
  if (color && color !== "None") kwParts.push(color);
  const searchQuery = kwParts.join(" ");

  const params = new URLSearchParams({
    q: searchQuery,
    type: "direct",
    sort: "rnk/dc",
    limit: "40",
    offset: "1"
  });

  const apiUrl = `https://rtapi.ruten.com.tw/api/search/v3/index.php/core/prod?${params.toString()}`;

  let prodIds = [];
  try {
    const resp = await fetch(apiUrl);
    if (resp.ok) {
      const data = await resp.json();
      const rows = data.Rows || [];
      prodIds = rows.map(r => r.Id).filter(Boolean);
    }
  } catch (e) {
    console.error("searchPart error:", e);
    return [];
  }

  if (prodIds.length === 0) return [];

  const prodDetails = await fetchProdDetails(prodIds);
  const results = [];

  for (const prod of prodDetails) {
    const name = prod.ProdName || '';
    const price = (prod.PriceRange && prod.PriceRange[0]) || 0;

    if (!name.includes(partNumber) || !isGenuine(name)) continue;
    if (color && color !== "None" && !matchColor(name, color)) continue;
    if (price < 1 || price > 5000) continue;
    if (["缺貨", "已售完", "停售", "補貨中"].some(kw => name.includes(kw))) continue;

    let packQty = 1;
    const qtyMatch = name.match(/(?<![\d])[xX*](\d+)/);
    if (qtyMatch) {
      packQty = parseInt(qtyMatch[1]);
    } else {
      const packMatch = name.match(/(\d+)(?:個一組|件一組|入|pcs|件)/);
      if (packMatch) packQty = parseInt(packMatch[1]);
    }

    const stockQty = parseInt(prod.StockQty || 0);
    const soldQty = parseInt(prod.SoldQty || 0);
    const realStock = Math.max(stockQty - soldQty, 0);
    if (realStock <= 0) continue;

    results.push({
      title: name,
      price: parseFloat(price),
      pack_qty: packQty,
      seller_id: prod.SellerId || '',
      seller_name: prod.SellerName || prod.SellerId || '',
      url: `https://www.ruten.com.tw/item/${prod.ProdId}/`,
      stock: realStock
    });
  }

  results.sort((a, b) => (a.price / a.pack_qty) - (b.price / b.pack_qty));
  return results;
}

/**
 * 用固定併發數的 worker pool 收集所有零件資料。
 * 每個 worker 各自跑迴圈，領到一筆處理一筆，完成立刻領下一筆，
 * 彼此不互相等待，名額隨時補滿。
 * onProgress(completed, total) 會在每完成一筆時被呼叫。
 */
async function collectRawData(parts, onProgress) {
  const rawData = {};
  let index = 0;
  let completed = 0;

  async function worker() {
    while (index < parts.length) {
      const myIndex = index++;
      const item = parts[myIndex];
      const key = `${item.part_number}_${item.color}`;
      try {
        const items = await searchPart(item.part_number, item.color);
        rawData[key] = { items };
      } catch (e) {
        rawData[key] = { error: String(e), items: [] };
      }
      completed++;
      if (onProgress) {
        try { onProgress(completed, parts.length); } catch (e) { /* 忽略回報失敗 */ }
      }
    }
  }

  const workerCount = Math.min(CONCURRENCY, parts.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return rawData;
}

async function runOptimize(parts, token, onProgress) {
  if (!token) {
    return { status: "error", message: "缺少登入憑證（token），請先在網頁登入" };
  }

  const rawData = await collectRawData(parts, onProgress);

  const resp = await fetch("https://lego-buying-backend.onrender.com/api/optimize", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`
    },
    body: JSON.stringify({ parts, raw_data: rawData })
  });

  if (resp.status === 401) {
    return { status: "error", message: "401 登入已失效，請重新登入" };
  }

  return await resp.json();
}

// 長連線通道：讓 background 能在計算過程中持續回報進度，
// 而不只是等全部做完才一次性回覆（chrome.runtime.sendMessage 只能回應一次，做不到這件事）。
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "optimize-channel") return;

  port.onMessage.addListener((message) => {
    if (message.type !== "COLLECT_AND_OPTIMIZE") return;

    runOptimize(message.parts, message.token, (completed, total) => {
      try {
        port.postMessage({ type: "PROGRESS", completed, total });
      } catch (e) { /* port 可能已關閉，忽略 */ }
    })
      .then((result) => {
        try { port.postMessage({ type: "DONE", result }); } catch (e) {}
      })
      .catch((err) => {
        try {
          port.postMessage({ type: "DONE", result: { status: "error", message: String(err) } });
        } catch (e) {}
      });
  });
});
