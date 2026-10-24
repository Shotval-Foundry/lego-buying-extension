// © 2026 Shotval Foundry｜僅供本站授權使用，禁止未經同意之複製、修改或轉發用於其他服務

const THIRD_PARTY_KEYWORDS = ['兼容', '國產', '第三方', 'MOC', 'moc'];
const BACKEND_URL = "https://lego-buying-backend.onrender.com";
const CONCURRENCY = 5;
const SEARCH_PAGE_SIZE = 40;        
const SEARCH_MAX_PAGES = 5;         
const SEARCH_ENOUGH_RATIO = 2;
const SEARCH_OFFSET_IS_RECORD_INDEX = false;
const FETCH_RETRIES = 3;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJsonWithRetry(url, tries = FETCH_RETRIES) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const resp = await fetch(url);
      if (resp.ok) return await resp.json();
      lastErr = new Error(`HTTP ${resp.status}`);
    } catch (e) {
      lastErr = e;
    }
    if (i < tries) await sleep(400 * i);
  }
  throw lastErr;
}

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function storageSet(items) {
  return new Promise((resolve) => chrome.storage.local.set(items, resolve));
}

function buildColorLookup(aliasesMap) {
  const lookup = {};
  const isChinese = (s) => /[\u4e00-\u9fa5]/.test(s);

  for (const [key, aliases] of Object.entries(aliasesMap)) {
    const zh = isChinese(key) ? key : (aliases.find(isChinese) || key);
    lookup[key.toLowerCase()] = zh;
    for (const alias of aliases) {
      lookup[alias.toLowerCase()] = zh;
    }
  }
  return lookup;
}

async function fetchRemoteAliases(token) {
  const resp = await fetch(`${BACKEND_URL}/api/color-aliases`, {
    headers: { "Authorization": `Bearer ${token}` }
  });
  if (!resp.ok) throw new Error(`抓取顏色對照表失敗：HTTP ${resp.status}`);
  return await resp.json(); 
}

async function fetchRemoteVersion(token) {
  const resp = await fetch(`${BACKEND_URL}/api/color-aliases/version`, {
    headers: { "Authorization": `Bearer ${token}` }
  });
  if (!resp.ok) throw new Error(`查詢顏色對照表版本失敗：HTTP ${resp.status}`);
  const data = await resp.json();
  return data.version;
}

async function ensureColorAliases(token) {
  const cached = await storageGet(['color_alias_version', 'color_aliases']);

  let remoteVersion = null;
  try {
    remoteVersion = await fetchRemoteVersion(token);
  } catch (e) {
    console.error("查詢顏色對照表版本失敗，若有本地快取將沿用舊版:", e);
  }

  if (remoteVersion && remoteVersion === cached.color_alias_version && cached.color_aliases) {
    return { aliases: cached.color_aliases, lookup: buildColorLookup(cached.color_aliases) };
  }

  try {
    const data = await fetchRemoteAliases(token);
    await storageSet({ color_alias_version: data.version, color_aliases: data.aliases });
    return { aliases: data.aliases, lookup: buildColorLookup(data.aliases) };
  } catch (e) {
    console.error("下載最新顏色對照表失敗:", e);
    if (cached.color_aliases) {
      console.warn("改用本地舊快取繼續執行");
      return { aliases: cached.color_aliases, lookup: buildColorLookup(cached.color_aliases) };
    }
    return { aliases: {}, lookup: {} };
  }
}

function normalizeColor(inputColor, lookup) {
  const trimmed = String(inputColor || '').trim();
  if (!trimmed || trimmed.toLowerCase() === 'none') return 'None';
  return lookup[trimmed.toLowerCase()] || trimmed;
}

function isGenuine(name) {
  const hasBrand = name.includes('LEGO') || name.includes('樂高');
  const hasThirdParty = THIRD_PARTY_KEYWORDS.some(kw => name.includes(kw));
  return hasBrand && !hasThirdParty;
}

const COLOR_MODIFIERS_ZH = ["亮淡", "中湛", "亮湛", "螢光", "夜光", "金屬", "透明", "珍珠", "砂", "沙", "淡", "亮", "暗", "深", "淺", "中"];
const COLOR_MODIFIERS_EN = ["dark", "light", "bright", "medium", "trans", "reddish", "sand", "metallic", "pearl", "neon", "glow"];

function hasColorModifierBefore(name, idx, targetColor) {
  const before = name.slice(0, idx);
  for (const m of COLOR_MODIFIERS_ZH) {
    if (targetColor.includes(m)) continue;
    if (before.endsWith(m)) return true;
  }
  const beforeLower = before.toLowerCase();
  const targetLower = targetColor.toLowerCase();
  for (const m of COLOR_MODIFIERS_EN) {
    if (targetLower.includes(m)) continue;
    if (new RegExp(`${m}[\\s\\-]*$`).test(beforeLower)) return true;
  }
  return false;
}

function matchColor(name, targetColor, aliasesMap) {
  if (!targetColor || targetColor === "None") return true;
  const aliases = aliasesMap[targetColor] || [targetColor];
  let found = false;
  for (const alias of aliases) {
    if (!alias) continue;
    let from = 0;
    let idx;
    while ((idx = name.indexOf(alias, from)) !== -1) {
      found = true;
      if (hasColorModifierBefore(name, idx, targetColor)) return false;
      from = idx + alias.length;
    }
  }
  return found;
}

async function fetchProdDetails(prodIds) {
  const batches = [];
  for (let i = 0; i < prodIds.length; i += 20) {
    batches.push(prodIds.slice(i, i + 20));
  }

  const seen = new Set();
  const results = [];
  let failedBatches = 0;
  const batchResults = await Promise.all(batches.map(async (batch) => {
    const url = `https://rtapi.ruten.com.tw/api/prod/v3/index.php/prod?id=${batch.join(',')}`;
    try {
      const data = await fetchJsonWithRetry(url);
      if (Array.isArray(data)) return data;
    } catch (e) {
      console.error("fetchProdDetails error:", e);
    }
    failedBatches++;
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
  return { items: results, failedBatches };
}

async function searchPart(partNumber, color, needed, aliasesMap, lookup) {
  const normalizedColor = normalizeColor(color, lookup);
  const kwParts = ["lego", partNumber];
  if (normalizedColor && normalizedColor !== "None") kwParts.push(normalizedColor);
  const searchQuery = kwParts.join(" ");
  const stats = {
    pages: 0, fetched: 0,
    drop_name: 0, drop_genuine: 0, drop_color: 0, drop_price: 0, drop_flag: 0, drop_stock: 0,
    kept: 0, failed_batches: 0
  };
  const seenIds = new Set();
  const results = [];
  let totalUnits = 0;
  let partial = false;

  for (let page = 1; page <= SEARCH_MAX_PAGES; page++) {
    const offset = SEARCH_OFFSET_IS_RECORD_INDEX ? (page - 1) * SEARCH_PAGE_SIZE + 1 : page;
    const params = new URLSearchParams({
      q: searchQuery,
      type: "direct",
      sort: "rnk/dc",
      limit: String(SEARCH_PAGE_SIZE),
      offset: String(offset)
    });
    const apiUrl = `https://rtapi.ruten.com.tw/api/search/v3/index.php/core/prod?${params.toString()}`;

    let rows;
    try {
      const data = await fetchJsonWithRetry(apiUrl);
      rows = data.Rows || [];
    } catch (e) {
      console.error("searchPart error:", e);
      partial = true;
      break;
    }
    stats.pages = page;

    const newIds = rows.map(r => r.Id).filter(id => id && !seenIds.has(id));
    newIds.forEach(id => seenIds.add(id));
    stats.fetched += newIds.length;

    if (newIds.length > 0) {
      const { items: prodDetails, failedBatches } = await fetchProdDetails(newIds);
      if (failedBatches > 0) {
        partial = true;
        stats.failed_batches += failedBatches;
      }

      for (const prod of prodDetails) {
        const name = prod.ProdName || '';
        const price = (prod.PriceRange && prod.PriceRange[0]) || 0;

        if (!name.includes(partNumber)) { stats.drop_name++; continue; }
        if (!isGenuine(name)) { stats.drop_genuine++; continue; }
        if (normalizedColor && normalizedColor !== "None" && !matchColor(name, normalizedColor, aliasesMap)) { stats.drop_color++; continue; }
        if (price < 1 || price > 5000) { stats.drop_price++; continue; }
        if (["缺貨", "已售完", "停售", "補貨中"].some(kw => name.includes(kw))) { stats.drop_flag++; continue; }

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
        if (realStock <= 0) { stats.drop_stock++; continue; }

        results.push({
          title: name,
          price: parseFloat(price),
          pack_qty: packQty,
          seller_id: prod.SellerId || '',
          seller_name: prod.SellerName || prod.SellerId || '',
          url: `https://www.ruten.com.tw/item/${prod.ProdId}/`,
          stock: realStock
        });
        stats.kept++;
        totalUnits += realStock * packQty;
      }
    }

    if (rows.length < SEARCH_PAGE_SIZE) break;               
    if (newIds.length < Math.ceil(rows.length / 2)) break;   
    if (totalUnits >= needed * SEARCH_ENOUGH_RATIO) break;
  }

  results.sort((a, b) => (a.price / a.pack_qty) - (b.price / b.pack_qty));
  return { items: results, stats, partial };
}

async function collectRawData(parts, token, onProgress) {
  const rawData = {};
  const debugStats = {};
  const incomplete = [];
  let index = 0;
  let completed = 0;

  const { aliases, lookup } = await ensureColorAliases(token);

  async function worker() {
    while (index < parts.length) {
      const myIndex = index++;
      const item = parts[myIndex];
      const key = `${item.part_number}_${item.color}`;
      const needed = parseInt(item.required_qty, 10) || 1;
      try {
        const { items, stats, partial } = await searchPart(item.part_number, item.color, needed, aliases, lookup);
        rawData[key] = { items };
        debugStats[key] = { needed, ...stats };
        if (partial) incomplete.push(key);
      } catch (e) {
        rawData[key] = { error: String(e), items: [] };
        incomplete.push(key);
      }
      completed++;
      if (onProgress) {
        try { onProgress(completed, parts.length); } catch (e) { /* 忽略回報失敗 */ }
      }
    }
  }

  const workerCount = Math.min(CONCURRENCY, parts.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  console.log("collect stats", debugStats);
  await storageSet({ last_collect_stats: { time: Date.now(), stats: debugStats } });

  return { rawData, incomplete };
}

async function runOptimize(parts, token, onProgress) {
  if (!token) {
    return { status: "error", message: "缺少登入憑證（token），請先在網頁登入" };
  }

  const { rawData, incomplete } = await collectRawData(parts, token, onProgress);
  const resp = await fetch(`${BACKEND_URL}/api/optimize`, {
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

  const result = await resp.json();
  if (incomplete.length > 0 && result && typeof result === "object") {
    result.collect_incomplete = incomplete;
  }
  return result;
}

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