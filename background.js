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

async function fetchProdDetails(prodIds) {
  const results = [];
  const seen = new Set();
  for (let i = 0; i < prodIds.length; i += 20) {
    const batch = prodIds.slice(i, i + 20);
    const url = `https://rtapi.ruten.com.tw/api/prod/v3/index.php/prod?id=${batch.join(',')}`;
    try {
      const resp = await fetch(url);
      if (resp.ok) {
        const data = await resp.json();
        if (Array.isArray(data)) {
          for (const item of data) {
            const pid = item.ProdId;
            if (pid && !seen.has(pid)) {
              seen.add(pid);
              results.push(item);
            }
          }
        }
      }
    } catch (e) {
      console.error("fetchProdDetails error:", e);
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

async function collectAndOptimize(parts, token) {
  if (!token) {
    return { status: "error", message: "缺少登入憑證（token），請先在網頁登入" };
  }

  const rawData = {};

  for (const item of parts) {
    const key = `${item.part_number}_${item.color}`;
    try {
      const items = await searchPart(item.part_number, item.color);
      rawData[key] = { items };
    } catch (e) {
      rawData[key] = { error: String(e), items: [] };
    }
    await new Promise(r => setTimeout(r, 300));
  }

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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "COLLECT_AND_OPTIMIZE") {
    collectAndOptimize(message.parts, message.token)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ status: "error", message: String(err) }));
    return true;
  }
});
