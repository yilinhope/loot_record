// ==UserScript==
// @name         银河奶牛 MilkywayIdle - 掉落/产出记录器（每次记录/物品汇总）
// @namespace    https://www.milkywayidle.com/
// @version      1.1.2
// @description  记录所有行动产生的物品变更（战斗/炼金/采摘等），并提供“每次记录/按物品汇总”两种视图（时间段/分类/物品筛选/模糊搜索），带美化面板。
// @match        https://www.milkywayidle.com/*
// @require      https://update.greasyfork.org/scripts/550719/1677027/MWI_Toolkit.js
// @run-at       document-start
// @grant        none
// @license      MIT
// ==/UserScript==

(function () {
  "use strict";

  const APP = {
    id: "mw-loot-record",
    legacyDbName: "mw_loot_record_db",
    dbNameBase: "mw_loot_record_db_p",
    dbVersion: 2,
    storeName: "loot_records",
    uiStateKey: "mw_loot_record_ui_state_v1",
    invSnapshotKey: "mw_loot_record_inventory_snapshot_v1",
    migrateFlagKey: "mw_loot_record_migrated_to_per_player_v1",
    offlineMinGapMs: 60000,
    marketUrl:
      "https://raw.githubusercontent.com/holychikenz/MWIApi/main/medianmarket.json",
    marketCacheKey: "mw_loot_record_market_cache_v1",
    marketTtlMs: 300000,
    maxRecordsHint: 20000,
  };

  const runtime = {
    bootTs: Date.now(),
    db: null,
    dbOpenedName: "",
    market: {
      loaded: false,
      source: "",
      fetchedAt: 0,
      timeSec: 0,
      byHridLevel: null,
      byKey: Object.create(null),
      lastCache0: null,
    },
    sprites: {
      itemsBase: "",
      checked: false,
    },
    openRecordIds: new Set(),
    playerTotals: new Map(),
    selfName: "",
    lastAction: {
      actionHrid: "",
      actionCategory: "",
      ts: 0,
    },
    lastSaved: {
      key: "",
      ts: 0,
    },
    inventory: {
      ready: false,
      byItemHridLevel: new Map(),
    },
    i18nCache: new Map(),
    recordsCache: [],
    recordsLoaded: false,
    recordsLoadedDbName: "",
    switchSeq: 0,
    lastSwitchTs: 0,
    trimDoneDbNames: new Set(),
    ui: {
      mounted: false,
      open: false,
      tab: "records",
      mode: "gain",
      settingsOpen: false,
      settings: {
        coinFormat: "full",
        priceMode: "Lbuy_Rsell",
        marketSource: "auto",
        taxEnabled: true,
        taxRate: 0.02,
        customCategories: [],
      },
      filters: {
        from: "",
        to: "",
        category: "",
        itemHrid: "",
        q: "",
        player: "",
      },
    },
  };

  function nowTs() {
    return Date.now();
  }

  // 安全解析 JSON（解析失败时返回 null，避免脚本因异常中断）
  function safeJsonParse(text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function clampString(v, maxLen) {
    if (typeof v !== "string") return "";
    return v.length > maxLen ? v.slice(0, maxLen) : v;
  }

  function fnv1a32(str) {
    const s = String(str ?? "");
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  function getPlayerDbName(playerName) {
    const name = clampString(typeof playerName === "string" ? playerName : "", 96) || "unknown";
    const hex = fnv1a32(name).toString(16).padStart(8, "0");
    return `${APP.dbNameBase}_${hex}`;
  }

  function getActiveDbName() {
    return getPlayerDbName(runtime.selfName || "unknown");
  }

  function loadInvSnapshotStore() {
    const raw = localStorage.getItem(APP.invSnapshotKey);
    const data = safeJsonParse(raw || "");
    if (!data || typeof data !== "object") return { v: 1, byPlayer: Object.create(null) };
    const v = Number(data.v) || 1;
    const byPlayer = data.byPlayer && typeof data.byPlayer === "object" ? data.byPlayer : Object.create(null);
    return { v, byPlayer };
  }

  function saveInvSnapshotStore(store) {
    if (!store || typeof store !== "object") return;
    try {
      localStorage.setItem(APP.invSnapshotKey, JSON.stringify(store));
    } catch {}
  }

  function normalizeCharacterItemsToMap(characterItems) {
    const list = Array.isArray(characterItems) ? characterItems : [];
    const map = new Map();
    for (const it of list) {
      const hrid = it?.itemHrid;
      const lv = Number(it?.enhancementLevel ?? 0) || 0;
      const count = Math.max(0, Number(it?.count) || 0);
      if (typeof hrid !== "string" || !hrid) continue;
      const key = `${hrid}#${lv}`;
      map.set(key, { itemHrid: hrid, enhancementLevel: lv, count });
    }
    return map;
  }

  function diffCharacterItems(prevItems, nextItems) {
    const a = normalizeCharacterItemsToMap(prevItems);
    const b = normalizeCharacterItemsToMap(nextItems);
    const keys = new Set([...a.keys(), ...b.keys()]);
    const gains = [];
    const consumes = [];
    for (const k of keys) {
      const pa = a.get(k);
      const pb = b.get(k);
      const prev = pa ? pa.count : 0;
      const next = pb ? pb.count : 0;
      const delta = next - prev;
      if (delta > 0) gains.push({ itemHrid: (pb || pa).itemHrid, enhancementLevel: (pb || pa).enhancementLevel, count: delta });
      else if (delta < 0)
        consumes.push({ itemHrid: (pb || pa).itemHrid, enhancementLevel: (pb || pa).enhancementLevel, count: Math.abs(delta) });
    }
    return { gains, consumes };
  }

  function snapshotFromCharacterItems(characterItems) {
    const list = Array.isArray(characterItems) ? characterItems : [];
    const items = [];
    for (const it of list) {
      const hrid = it?.itemHrid;
      const lv = Number(it?.enhancementLevel ?? 0) || 0;
      const count = Math.max(0, Number(it?.count) || 0);
      if (typeof hrid !== "string" || !hrid) continue;
      items.push({ itemHrid: hrid, enhancementLevel: lv, count });
    }
    return items;
  }

  function getSnapshotForPlayer(playerName) {
    if (!playerName || typeof playerName !== "string") return null;
    const store = loadInvSnapshotStore();
    const snap = store.byPlayer ? store.byPlayer[playerName] : null;
    if (!snap || typeof snap !== "object") return null;
    const ts = Number(snap.ts) || 0;
    const items = Array.isArray(snap.items) ? snap.items : null;
    if (!ts || !items) return null;
    return { ts, items };
  }

  function saveSnapshotForPlayer(playerName, characterItems, ts) {
    if (!playerName || typeof playerName !== "string") return;
    const items = snapshotFromCharacterItems(characterItems);
    if (!items.length) return;
    const store = loadInvSnapshotStore();
    if (!store.byPlayer || typeof store.byPlayer !== "object") store.byPlayer = Object.create(null);
    store.byPlayer[playerName] = { ts: Number(ts) || nowTs(), items };
    saveInvSnapshotStore(store);
  }

  function getRuntimeInventoryAsCharacterItems() {
    if (!runtime.inventory.ready) return [];
    const out = [];
    for (const [hrid, levelMap] of runtime.inventory.byItemHridLevel.entries()) {
      if (typeof hrid !== "string" || !hrid) continue;
      if (!(levelMap instanceof Map)) continue;
      for (const [lv, count] of levelMap.entries()) {
        const level = Number(lv) || 0;
        const c = Math.max(0, Number(count) || 0);
        if (c <= 0) continue;
        out.push({ itemHrid: hrid, enhancementLevel: level, count: c });
      }
    }
    return out;
  }

  function hardResetForPlayerSwitch() {
    runtime.lastAction = { actionHrid: "", actionCategory: "", ts: 0 };
    runtime.lastSaved = { key: "", ts: 0 };
    runtime.openRecordIds.clear();
    runtime.inventory.ready = false;
    runtime.inventory.byItemHridLevel = new Map();
    runtime.recordsCache = [];
    runtime.recordsLoaded = false;
    runtime.recordsLoadedDbName = "";
    try {
      if (runtime.db) runtime.db.close();
    } catch {}
    runtime.db = null;
    runtime.dbOpenedName = "";
  }

  function applyActivePlayerToUi(playerName) {
    const p = typeof playerName === "string" ? playerName : "";
    runtime.ui.filters.player = p;
    saveUiState();
    if (runtime.ui.mounted) hydrateControlsFromState();
  }

  function switchToPlayerRecords(playerName) {
    const seq = ++runtime.switchSeq;
    runtime.lastSwitchTs = nowTs();
    hardResetForPlayerSwitch();
    applyActivePlayerToUi(playerName);
    ensureRecordsLoaded(true)
      .then(() => {
        if (seq !== runtime.switchSeq) return;
        updateFloatingBadge();
        if (runtime.ui.open) render();
      })
      .catch(() => {});
  }

  function setSelfName(name) {
    const v = typeof name === "string" ? name.trim() : "";
    if (!v) return;
    if (runtime.selfName === v) return;
    runtime.selfName = v;
    switchToPlayerRecords(v);
  }

  function formatNumber(n) {
    const v = Number(n) || 0;
    return Math.round(v).toLocaleString();
  }

  function formatCompact(n) {
    const v = Number(n) || 0;
    const abs = Math.abs(v);
    const sign = v < 0 ? "-" : "";
    const fmt = (x) => {
      const s = x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2);
      return s.replace(/\.0+$|(\.\d*[1-9])0+$/, "$1");
    };
    if (abs >= 1e9) return `${sign}${fmt(abs / 1e9)}b`;
    if (abs >= 1e6) return `${sign}${fmt(abs / 1e6)}m`;
    if (abs >= 1e3) return `${sign}${fmt(abs / 1e3)}k`;
    return `${sign}${formatNumber(abs)}`;
  }

  function formatCoin(n) {
    if (runtime.ui?.settings?.coinFormat === "abbr") return formatCompact(n);
    return formatNumber(n);
  }

  function formatTime(ts) {
    const d = new Date(ts);
    const pad = (x) => String(x).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
      d.getDate()
    )} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function datetimeLocalToTs(v) {
    if (!v) return null;
    const d = new Date(v);
    const ts = d.getTime();
    return Number.isFinite(ts) ? ts : null;
  }

  function toTitleCaseWords(s) {
    return String(s || "")
      .split(" ")
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }

  function getMarketNameFromItemHrid(itemHrid) {
    if (!itemHrid || typeof itemHrid !== "string") return "Unknown";
    const raw = itemHrid.replace("/items/", "").replace(/_/g, " ");
    return toTitleCaseWords(raw);
  }

  function getPreferredLang() {
    const ls = localStorage.getItem("i18nextLng");
    if (ls && typeof ls === "string") return ls;
    const lang = window.i18next?.language;
    if (lang && typeof lang === "string") return lang;
    return "zh";
  }

  function tryGetItemNameFromI18n(itemHrid, lang) {
    if (!itemHrid || typeof itemHrid !== "string") return "";
    if (!lang || typeof lang !== "string") return "";
    let name = "";
    try {
      if (window.MWI_Toolkit?.i18n?.getItemName) {
        name = window.MWI_Toolkit.i18n.getItemName(itemHrid, lang);
      } else {
        const translation = window.i18next?.options?.resources?.[lang]?.translation;
        const fromResource =
          translation && translation.itemNames ? translation.itemNames[itemHrid] : "";
        if (typeof fromResource === "string") name = fromResource;
      }
    } catch {
      name = "";
    }
    if (typeof name === "string" && name && name !== itemHrid) return name;
    return "";
  }

  function getItemDisplayName(itemHrid) {
    // 优先显示中文（用户需求：记录里不要英文），拿不到再尝试当前语言，最后回退为更易读的英文（Title Case）
    if (!itemHrid || typeof itemHrid !== "string") return "Unknown";
    if (runtime.i18nCache.has(itemHrid)) return runtime.i18nCache.get(itemHrid);

    const nameZh = tryGetItemNameFromI18n(itemHrid, "zh");
    if (nameZh) {
      runtime.i18nCache.set(itemHrid, nameZh);
      return nameZh;
    }

    const lang = getPreferredLang();
    const nameCurrent = lang && lang !== "zh" ? tryGetItemNameFromI18n(itemHrid, lang) : "";
    if (nameCurrent) {
      runtime.i18nCache.set(itemHrid, nameCurrent);
      return nameCurrent;
    }

    return getMarketNameFromItemHrid(itemHrid);
  }

  function itemNameFromHrid(itemHrid) {
    if (!itemHrid || typeof itemHrid !== "string") return "Unknown";
    return getItemDisplayName(itemHrid);
  }

  function getItemsSpriteBase() {
    if (runtime.sprites.itemsBase) return runtime.sprites.itemsBase || "";
    try {
      const useEl =
        document.querySelector('use[href*="items_sprite"]') ||
        document.querySelector('use[xlink\\:href*="items_sprite"]');
      const href = useEl?.getAttribute("href") || useEl?.getAttribute("xlink:href") || "";
      const base = href && href.includes("#") ? href.split("#")[0] : href;
      if (base) runtime.sprites.itemsBase = base;
    } catch {
    }
    return runtime.sprites.itemsBase || "";
  }

  function getItemIconHtml(itemHrid) {
    const base = getItemsSpriteBase();
    if (!base) return "";
    const hrid = typeof itemHrid === "string" ? itemHrid : "";
    const iconId = hrid.startsWith("/items/") ? hrid.slice("/items/".length) : "";
    if (!iconId) return "";
    return `<svg class="mwl-icon" aria-hidden="true"><use href="${escapeHtml(base)}#${escapeHtml(
      iconId
    )}"></use></svg>`;
  }

  function getMarketPriceRec(itemHrid, enhancementLevel = 0) {
    if (typeof itemHrid === "string" && itemHrid.endsWith("/coin")) {
      return { ask: 1, bid: 1 };
    }
    if (!runtime.market.loaded) return null;
    if (runtime.market.byHridLevel && typeof itemHrid === "string") {
      const levelMap = runtime.market.byHridLevel.get(itemHrid);
      const level = Number(enhancementLevel) || 0;
      const rec = levelMap ? levelMap.get(level) || levelMap.get(0) : null;
      if (rec && (typeof rec.ask === "number" || typeof rec.bid === "number")) {
        return { ask: rec.ask ?? null, bid: rec.bid ?? null };
      }
    }
    const key = getMarketNameFromItemHrid(itemHrid);
    const rec2 = runtime.market.byKey[key];
    if (!rec2 || typeof rec2 !== "object") return null;
    const ask = typeof rec2.ask === "number" && Number.isFinite(rec2.ask) ? rec2.ask : null;
    const bid = typeof rec2.bid === "number" && Number.isFinite(rec2.bid) ? rec2.bid : null;
    if (ask == null && bid == null) return null;
    return { ask, bid };
  }

  function getBuySellPrice(itemHrid, enhancementLevel = 0) {
    const rec = getMarketPriceRec(itemHrid, enhancementLevel);
    if (!rec) return { buy: null, sell: null };
    const mode = runtime.ui?.settings?.priceMode || "Lbuy_Rsell";
    const left = rec.ask;
    const right = rec.bid;
    const side = (s) => (s === "R" ? right : left);

    if (mode === "Lbuy_Lsell") return { buy: side("L"), sell: side("L") };
    if (mode === "Rbuy_Lsell") return { buy: side("R"), sell: side("L") };
    if (mode === "Rbuy_Rsell") return { buy: side("R"), sell: side("R") };
    return { buy: side("L"), sell: side("R") };
  }

  function getPriceModeShort(mode) {
    if (mode === "Lbuy_Lsell") return "左/左";
    if (mode === "Rbuy_Lsell") return "右/左";
    if (mode === "Rbuy_Rsell") return "右/右";
    return "左/右";
  }

  function formatPricePair(itemHrid, enhancementLevel = 0) {
    const p = getBuySellPrice(itemHrid, enhancementLevel);
    const buy = typeof p.buy === "number" ? formatCoin(p.buy) : "—";
    const sell = typeof p.sell === "number" ? formatCoin(p.sell) : "—";
    return `${buy}/${sell}`;
  }

  function loadUiState() {
    // UI 状态持久化（tab/筛选条件），避免每次刷新都要重新设置
    const raw = localStorage.getItem(APP.uiStateKey);
    const data = safeJsonParse(raw || "");
    if (!data || typeof data !== "object") return;
    if (data.tab === "records" || data.tab === "items") runtime.ui.tab = data.tab;
    if (data.mode === "gain" || data.mode === "consume" || data.mode === "net") runtime.ui.mode = data.mode;
    if (data.settings && typeof data.settings === "object") {
      const cf = data.settings.coinFormat;
      if (cf === "full" || cf === "abbr") runtime.ui.settings.coinFormat = cf;
      const pm = data.settings.priceMode;
      if (pm === "Lbuy_Lsell" || pm === "Lbuy_Rsell" || pm === "Rbuy_Lsell" || pm === "Rbuy_Rsell") {
        runtime.ui.settings.priceMode = pm;
      }
      const ms = data.settings.marketSource;
      if (ms === "auto" || ms === "official" || ms === "mooket" || ms === "median") {
        runtime.ui.settings.marketSource = ms;
      }
      const te = data.settings.taxEnabled;
      if (typeof te === "boolean") runtime.ui.settings.taxEnabled = te;
      const tr = Number(data.settings.taxRate);
      if (Number.isFinite(tr) && tr >= 0 && tr <= 0.2) runtime.ui.settings.taxRate = tr;
      if (Array.isArray(data.settings.customCategories)) {
        runtime.ui.settings.customCategories = data.settings.customCategories
          .map((x) => (typeof x === "string" ? x.trim() : ""))
          .filter(Boolean)
          .map((x) => clampString(x, 32))
          .filter(Boolean);
      }
    }
    if (data.filters && typeof data.filters === "object") {
      runtime.ui.filters.from = clampString(data.filters.from, 32);
      runtime.ui.filters.to = clampString(data.filters.to, 32);
      runtime.ui.filters.category = clampString(data.filters.category, 32);
      runtime.ui.filters.itemHrid = clampString(data.filters.itemHrid, 128);
      runtime.ui.filters.q = clampString(data.filters.q, 64);
      runtime.ui.filters.player = clampString(data.filters.player, 64);
    }
  }

  function saveUiState() {
    const payload = {
      tab: runtime.ui.tab,
      mode: runtime.ui.mode,
      settings: runtime.ui.settings,
      filters: runtime.ui.filters,
    };
    localStorage.setItem(APP.uiStateKey, JSON.stringify(payload));
  }

  function normalizeCategoryName(v) {
    const s = typeof v === "string" ? v.trim() : "";
    return clampString(s, 32);
  }

  function getCustomCategories() {
    const list = runtime.ui?.settings?.customCategories;
    return Array.isArray(list) ? list.filter((x) => typeof x === "string" && x) : [];
  }

  function addCustomCategory(name) {
    const c = normalizeCategoryName(name);
    if (!c) return false;
    if (c === "未分类") return false;
    const cur = getCustomCategories();
    if (cur.includes(c)) return false;
    runtime.ui.settings.customCategories = cur.concat(c);
    saveUiState();
    return true;
  }

  function removeCustomCategory(name) {
    const c = normalizeCategoryName(name);
    if (!c) return false;
    const cur = getCustomCategories();
    const next = cur.filter((x) => x !== c);
    if (next.length === cur.length) return false;
    runtime.ui.settings.customCategories = next;
    saveUiState();
    return true;
  }

  function ensureDbSchema(req) {
    const db = req.result;
    const store = db.objectStoreNames.contains(APP.storeName)
      ? req.transaction.objectStore(APP.storeName)
      : db.createObjectStore(APP.storeName, { keyPath: "id" });

    if (!store.indexNames.contains("ts")) store.createIndex("ts", "ts", { unique: false });
    if (!store.indexNames.contains("playerName")) store.createIndex("playerName", "playerName", { unique: false });
    if (!store.indexNames.contains("actionCategory"))
      store.createIndex("actionCategory", "meta.actionCategory", { unique: false });
    if (!store.indexNames.contains("playerTs")) store.createIndex("playerTs", ["playerName", "ts"], { unique: false });
    if (!store.indexNames.contains("categoryTs"))
      store.createIndex("categoryTs", ["meta.actionCategory", "ts"], { unique: false });
  }

  function openDbNamed(dbName) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, APP.dbVersion);
      req.onupgradeneeded = () => ensureDbSchema(req);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function openDb() {
    const activeName = getActiveDbName();
    if (runtime.db && runtime.dbOpenedName === activeName) return Promise.resolve(runtime.db);
    try {
      if (runtime.db) runtime.db.close();
    } catch {}
    runtime.db = null;
    runtime.dbOpenedName = activeName;
    return openDbNamed(activeName).then((db) => {
      runtime.db = db;
      runtime.dbOpenedName = activeName;
      return runtime.db;
    });
  }

  function withStore(mode, fn) {
    return openDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(APP.storeName, mode);
          const store = tx.objectStore(APP.storeName);
          let result;
          try {
            result = fn(store, tx);
          } catch (e) {
            reject(e);
            return;
          }
          tx.oncomplete = () => resolve(result);
          tx.onerror = () => reject(tx.error || new Error("IndexedDB 事务失败"));
          tx.onabort = () => reject(tx.error || new Error("IndexedDB 事务中止"));
        })
    );
  }

  function addRecordToDb(recordModel) {
    return withStore("readwrite", (store) => {
      store.put(recordModel);
    });
  }

  function clearAllRecordsInDb() {
    return withStore("readwrite", (store) => store.clear());
  }

  function deleteRecordsOlderThanTs(tsExclusive) {
    const t = Number(tsExclusive) || 0;
    if (!t) return Promise.resolve(0);
    return withStore("readwrite", (store) => {
      const index = store.index("ts");
      const range = IDBKeyRange.upperBound(t - 1);
      let deleted = 0;
      return new Promise((resolve, reject) => {
        const req = index.openCursor(range, "next");
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) {
            resolve(deleted);
            return;
          }
          try {
            cursor.delete();
            deleted++;
          } catch {}
          cursor.continue();
        };
        req.onerror = () => reject(req.error);
      });
    });
  }

  function loadAllRecordsFromDb() {
    return withStore("readonly", (store) => {
      const index = store.index("ts");
      const records = [];
      return new Promise((resolve, reject) => {
        const req = index.openCursor(null, "prev");
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) {
            resolve(records);
            return;
          }
          records.push(cursor.value);
          if (records.length >= APP.maxRecordsHint) {
            resolve(records);
            return;
          }
          cursor.continue();
        };
        req.onerror = () => reject(req.error);
      });
    });
  }

  function getRecordByIdFromDb(id) {
    const key = typeof id === "string" ? id : "";
    if (!key) return Promise.resolve(null);
    return withStore("readonly", (store) => {
      return new Promise((resolve, reject) => {
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    });
  }

  function updateRecordCategory(recordId, nextCategory) {
    const id = typeof recordId === "string" ? recordId : "";
    if (!id) return Promise.resolve(false);
    const c = normalizeCategoryName(nextCategory) || "未分类";
    const idx = runtime.recordsCache.findIndex((x) => x?.id === id);
    const fromCache = idx >= 0 ? runtime.recordsCache[idx] : null;

    const applyUpdate = (recordModel) => {
      if (!recordModel || typeof recordModel !== "object") return Promise.resolve(false);
      if (!recordModel.meta || typeof recordModel.meta !== "object") recordModel.meta = {};
      recordModel.meta.actionCategory = c;
      return addRecordToDb(recordModel).then(() => {
        if (idx >= 0) runtime.recordsCache[idx] = recordModel;
        return true;
      });
    };

    if (fromCache) return applyUpdate({ ...fromCache, meta: fromCache.meta ? { ...fromCache.meta } : {} });
    return getRecordByIdFromDb(id).then((r) => applyUpdate(r));
  }

  function maybeMigrateLegacyDb() {
    const already = localStorage.getItem(APP.migrateFlagKey) === "1";
    if (already) return Promise.resolve();

    const openLegacy = () => openDbNamed(APP.legacyDbName);

    const loadAllFromLegacy = (db) =>
      new Promise((resolve, reject) => {
        if (!db.objectStoreNames.contains(APP.storeName)) {
          resolve([]);
          return;
        }
        const tx = db.transaction(APP.storeName, "readonly");
        const store = tx.objectStore(APP.storeName);
        const index = store.index("ts");
        const records = [];
        const req = index.openCursor(null, "prev");
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) {
            resolve(records);
            return;
          }
          records.push(cursor.value);
          cursor.continue();
        };
        req.onerror = () => reject(req.error);
      });

    const putMany = (db, records) =>
      new Promise((resolve, reject) => {
        if (!records.length) {
          resolve();
          return;
        }
        const tx = db.transaction(APP.storeName, "readwrite");
        const store = tx.objectStore(APP.storeName);
        for (const r of records) store.put(r);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error("IndexedDB 事务失败"));
        tx.onabort = () => reject(tx.error || new Error("IndexedDB 事务中止"));
      });

    return openLegacy()
      .then((legacyDb) =>
        loadAllFromLegacy(legacyDb)
          .then((records) => {
            try {
              legacyDb.close();
            } catch {}
            if (!records.length) return;

            const byPlayer = new Map();
            for (const r of records) {
              const p = typeof r?.playerName === "string" && r.playerName ? r.playerName : "unknown";
              if (!byPlayer.has(p)) byPlayer.set(p, []);
              byPlayer.get(p).push(r);
            }

            const tasks = Array.from(byPlayer.entries()).map(([playerName, list]) => {
              const dbName = getPlayerDbName(playerName);
              return openDbNamed(dbName)
                .then((db) => putMany(db, list).finally(() => {
                  try {
                    db.close();
                  } catch {}
                }))
                .catch(() => {});
            });

            return Promise.all(tasks).then(() => {
              try {
                indexedDB.deleteDatabase(APP.legacyDbName);
              } catch {}
            });
          })
          .catch(() => {})
      )
      .finally(() => {
        try {
          localStorage.setItem(APP.migrateFlagKey, "1");
        } catch {}
      });
  }

  function ensureMarketLoaded() {
    const now = nowTs();
    if (runtime.market.loaded && now - (Number(runtime.market.fetchedAt) || 0) < APP.marketTtlMs) {
      return Promise.resolve();
    }

    const loadCache = () => {
      const cached = safeJsonParse(localStorage.getItem(APP.marketCacheKey) || "");
      const level0ByHrid = cached?.level0ByHrid;
      if (!level0ByHrid || typeof level0ByHrid !== "object") return false;
      runtime.market.lastCache0 = level0ByHrid;
      runtime.market.fetchedAt = Number(cached?.fetchedAt) || 0;
      runtime.market.timeSec = Number(cached?.timeSec) || 0;
      runtime.market.source = typeof cached?.source === "string" ? cached.source : "cache";
      runtime.market.byHridLevel = null;
      runtime.market.byKey = Object.create(null);
      runtime.market.loaded = true;
      return true;
    };

    const saveCache0 = ({ level0ByHrid, source, timeSec }) => {
      try {
        const payload = {
          fetchedAt: nowTs(),
          timeSec: Number(timeSec) || 0,
          source,
          level0ByHrid,
        };
        localStorage.setItem(APP.marketCacheKey, JSON.stringify(payload));
        runtime.market.lastCache0 = level0ByHrid;
      } catch {}
    };

    if (!runtime.market.loaded) loadCache();

    const fetchJson = (u) =>
      fetch(u).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))));

    const parseLevelMarket = (marketObj) => {
      const byHridLevel = new Map();
      const level0ByHrid = Object.create(null);
      for (const [hrid, levels] of Object.entries(marketObj || {})) {
        if (!levels || typeof levels !== "object") continue;
        const levelMap = new Map();
        for (const [lvStr, lv] of Object.entries(levels)) {
          const level = Number(lvStr) || 0;
          const ask = typeof lv?.a === "number" && Number.isFinite(lv.a) ? lv.a : null;
          const bid = typeof lv?.b === "number" && Number.isFinite(lv.b) ? lv.b : null;
          if (ask == null && bid == null) continue;
          levelMap.set(level, { ask, bid });
        }
        if (!levelMap.size) continue;
        byHridLevel.set(hrid, levelMap);
        const lv0 = levelMap.get(0);
        if (lv0 && (typeof lv0.ask === "number" || typeof lv0.bid === "number")) {
          level0ByHrid[hrid] = { a: lv0.ask ?? null, b: lv0.bid ?? null };
        }
      }
      return { byHridLevel, level0ByHrid };
    };

    const applyOutlierFallback = (byHridLevel) => {
      const prev = runtime.market.lastCache0;
      if (!prev || typeof prev !== "object") return 0;
      let replaced = 0;
      for (const [hrid, levelMap] of byHridLevel.entries()) {
        const prev0 = prev[hrid];
        if (!prev0) continue;
        const cur0 = levelMap.get(0);
        if (!cur0) continue;
        const clamp = (cur, prevV) => {
          const c = typeof cur === "number" ? cur : null;
          const p = typeof prevV === "number" ? prevV : null;
          if (c == null || p == null || c <= 0 || p <= 0) return c;
          const ratio = c / p;
          if (ratio > 10 || ratio < 0.1) return p;
          return c;
        };
        const nextAsk = clamp(cur0.ask, prev0.a);
        const nextBid = clamp(cur0.bid, prev0.b);
        if (nextAsk !== cur0.ask || nextBid !== cur0.bid) {
          levelMap.set(0, { ask: nextAsk ?? null, bid: nextBid ?? null });
          replaced++;
        }
      }
      return replaced;
    };

    const source = runtime.ui?.settings?.marketSource || "auto";
    const pickSources =
      source === "official"
        ? ["official"]
        : source === "mooket"
          ? ["mooket"]
          : source === "median"
            ? ["median"]
            : ["official", "mooket", "median"];

    const tryOfficial = () => {
      const urls = [
        "https://www.milkywayidle.com/game_data/marketplace.json",
        "https://www.milkywayidlecn.com/game_data/marketplace.json",
      ];
      const walk = (idx = 0) =>
        idx >= urls.length ? Promise.reject(new Error("all_official_failed")) : fetchJson(urls[idx]).catch(() => walk(idx + 1));
      return walk().then((json) => {
        const market = json?.market;
        if (!market || typeof market !== "object") return Promise.reject(new Error("invalid_official_json"));
        const parsed = parseLevelMarket(market);
        applyOutlierFallback(parsed.byHridLevel);
        runtime.market.byHridLevel = parsed.byHridLevel;
        runtime.market.byKey = Object.create(null);
        runtime.market.loaded = true;
        runtime.market.source = "official";
        runtime.market.fetchedAt = nowTs();
        runtime.market.timeSec = Number(json?.time) || 0;
        saveCache0({ level0ByHrid: parsed.level0ByHrid, source: "official", timeSec: runtime.market.timeSec });
      });
    };

    const tryMooket = () =>
      fetchJson("https://mooket.qi-e.top/market/api.json").then((json) => {
        const market = json?.market || json?.marketData;
        if (!market || typeof market !== "object") return Promise.reject(new Error("invalid_mooket_json"));
        const parsed = parseLevelMarket(market);
        applyOutlierFallback(parsed.byHridLevel);
        runtime.market.byHridLevel = parsed.byHridLevel;
        runtime.market.byKey = Object.create(null);
        runtime.market.loaded = true;
        runtime.market.source = "mooket";
        runtime.market.fetchedAt = nowTs();
        runtime.market.timeSec = Number(json?.timestamp) ? Number(json.timestamp) / 1000 : 0;
        saveCache0({ level0ByHrid: parsed.level0ByHrid, source: "mooket", timeSec: runtime.market.timeSec });
      });

    const tryMedian = () =>
      fetchJson(APP.marketUrl).then((json) => {
        const m = json && json.market ? json.market : {};
        runtime.market.byKey = m;
        runtime.market.byHridLevel = null;
        runtime.market.loaded = true;
        runtime.market.source = "median";
        runtime.market.fetchedAt = nowTs();
        runtime.market.timeSec = 0;
      });

    const runners = {
      official: tryOfficial,
      mooket: tryMooket,
      median: tryMedian,
    };

    let chain = Promise.reject(new Error("start"));
    for (const s of pickSources) {
      chain = chain.catch(() => runners[s]());
    }

    return chain.catch(() => {
      const ok = loadCache();
      if (ok) return;
      runtime.market.byKey = Object.create(null);
      runtime.market.byHridLevel = null;
      runtime.market.loaded = false;
    });
  }

  function ensureRecordsLoaded(force = false) {
    const activeName = getActiveDbName();
    if (force) {
      runtime.recordsLoaded = false;
      runtime.recordsCache = [];
    }
    if (!force && runtime.recordsLoaded && runtime.recordsLoadedDbName === activeName) return Promise.resolve(runtime.recordsCache);
    runtime.recordsLoadedDbName = activeName;
    return loadAllRecordsFromDb().then((list) => {
      runtime.recordsCache = Array.isArray(list) ? list : [];
      runtime.recordsLoaded = true;
      if (!runtime.trimDoneDbNames.has(activeName) && runtime.recordsCache.length >= APP.maxRecordsHint) {
        runtime.trimDoneDbNames.add(activeName);
        const oldest = runtime.recordsCache[runtime.recordsCache.length - 1];
        const threshold = Number(oldest?.ts) || 0;
        if (threshold) deleteRecordsOlderThanTs(threshold).catch(() => {});
      }
      return runtime.recordsCache;
    });
  }

  function buildRecordModel({ playerName, items, meta }) {
    // 统一的记录 model（以 model 结尾的命名约定），便于后续汇总/导出
    const ts = nowTs();
    const id = `${ts}-${Math.random().toString(16).slice(2)}`;

    const itemModels = items.map((it) => {
      const itemName = itemNameFromHrid(it.itemHrid);
      return {
        itemHrid: it.itemHrid,
        itemName,
        enhancementLevel: Number(it.enhancementLevel ?? 0) || 0,
        count: Number(it.count) || 0,
      };
    });

    return {
      id,
      ts,
      playerName,
      items: itemModels,
      meta: meta && typeof meta === "object" ? meta : null,
    };
  }

  function extractPlayers(payload) {
    const p = payload && payload.players;
    if (!p) return [];
    if (Array.isArray(p)) return p;
    if (typeof p === "object") return Object.values(p);
    return [];
  }

  function extractTotalLootMap(player) {
    if (!player || typeof player !== "object") return null;
    return player.totalLootMap || player.lootMap || null;
  }

  function normalizeLootMapEntries(lootMap) {
    if (!lootMap || typeof lootMap !== "object") return [];
    const out = [];
    for (const k of Object.keys(lootMap)) {
      const e = lootMap[k];
      if (!e || typeof e !== "object") continue;
      const itemHrid = e.itemHrid || e.hrid || null;
      const count = Number(e.count ?? e.quantity ?? 0) || 0;
      if (typeof itemHrid === "string" && count >= 0) out.push({ itemHrid, count });
    }
    return out;
  }

  function classifyActionCategory(actionHrid) {
    if (!actionHrid || typeof actionHrid !== "string") return "未分类";
    if (actionHrid.startsWith("/actions/combat/")) return "战斗";
    if (actionHrid.startsWith("/actions/alchemy/")) return "炼金";
    if (actionHrid.startsWith("/actions/enhancing/")) return "强化";
    if (actionHrid.startsWith("/actions/cooking/")) return "烹饪";
    if (actionHrid.startsWith("/actions/brewing/")) return "冲泡";
    if (actionHrid.startsWith("/actions/crafting/")) return "制作";
    if (actionHrid.startsWith("/actions/tailoring/")) return "缝纫";
    if (actionHrid.startsWith("/actions/cheesesmithing/")) return "奶酪锻造";
    if (actionHrid.startsWith("/actions/woodcutting/")) return "伐木";
    if (actionHrid.startsWith("/actions/foraging/")) return "采摘";
    if (actionHrid.startsWith("/actions/milking/")) return "挤奶";
    if (actionHrid.startsWith("/actions/gathering/")) return "采集";
    return "其他";
  }

  function getInvLevelMap(itemHrid) {
    let levelMap = runtime.inventory.byItemHridLevel.get(itemHrid);
    if (!levelMap) {
      levelMap = new Map();
      runtime.inventory.byItemHridLevel.set(itemHrid, levelMap);
    }
    return levelMap;
  }

  function updateInventoryFromCharacterItems(characterItems) {
    const next = new Map();
    const list = Array.isArray(characterItems) ? characterItems : [];
    for (const it of list) {
      const hrid = it?.itemHrid;
      const level = Number(it?.enhancementLevel ?? 0) || 0;
      const count = Number(it?.count) || 0;
      if (typeof hrid !== "string") continue;
      if (!next.has(hrid)) next.set(hrid, new Map());
      next.get(hrid).set(level, Math.max(0, count));
    }
    runtime.inventory.byItemHridLevel = next;
    runtime.inventory.ready = true;
  }

  function computeInventoryDeltaFromEndItems(endCharacterItems) {
    const list = Array.isArray(endCharacterItems) ? endCharacterItems : [];
    if (!runtime.inventory.ready) {
      return { gains: [], consumes: [] };
    }

    const deltaByKey = new Map();
    for (const it of list) {
      const hrid = it?.itemHrid;
      const level = Number(it?.enhancementLevel ?? 0) || 0;
      const nextCount = Number(it?.count) || 0;
      if (typeof hrid !== "string") continue;

      const levelMap = getInvLevelMap(hrid);
      const oldCount = levelMap.get(level) || 0;
      const safeNext = Math.max(0, nextCount);
      const delta = safeNext - oldCount;
      if (delta !== 0) {
        const key = `${hrid}#${level}`;
        deltaByKey.set(key, {
          itemHrid: hrid,
          enhancementLevel: level,
          delta: (deltaByKey.get(key)?.delta || 0) + delta,
        });
      }
      levelMap.set(level, safeNext);
    }

    const gains = [];
    const consumes = [];
    for (const v of deltaByKey.values()) {
      const delta = Number(v.delta) || 0;
      if (delta > 0) gains.push({ itemHrid: v.itemHrid, enhancementLevel: v.enhancementLevel, count: delta });
      else if (delta < 0)
        consumes.push({ itemHrid: v.itemHrid, enhancementLevel: v.enhancementLevel, count: Math.abs(delta) });
    }

    return { gains, consumes };
  }

  function buildGainsDedupeKey({ gains, consumes, actionCategory, actionHrid }) {
    const toParts = (arr, prefix) =>
      (Array.isArray(arr) ? arr : [])
        .slice()
        .sort((a, b) => {
          const ha = String(a.itemHrid);
          const hb = String(b.itemHrid);
          const c = ha.localeCompare(hb);
          if (c !== 0) return c;
          return (Number(a.enhancementLevel) || 0) - (Number(b.enhancementLevel) || 0);
        })
        .map((x) => `${prefix}${x.itemHrid}#${Number(x.enhancementLevel) || 0}:${Number(x.count) || 0}`);

    const parts = [...toParts(gains, "+"), ...toParts(consumes, "-")];
    return `${actionCategory || ""}|${actionHrid || ""}|${parts.join(",")}`;
  }

  function extractActionHridDeep(obj) {
    // 兼容不同消息结构：尽量从 payload 中找到形如 "/actions/xxx" 的字段
    const maxDepth = 5;
    const maxNodes = 300;
    const seen = new Set();
    let visited = 0;

    const walk = (v, depth) => {
      if (visited++ > maxNodes) return "";
      if (!v || depth > maxDepth) return "";
      if (typeof v === "string") return v.startsWith("/actions/") ? v : "";
      if (typeof v !== "object") return "";
      if (seen.has(v)) return "";
      seen.add(v);

      if (Array.isArray(v)) {
        for (const it of v) {
          const r = walk(it, depth + 1);
          if (r) return r;
        }
        return "";
      }

      for (const k of Object.keys(v)) {
        const r = walk(v[k], depth + 1);
        if (r) return r;
      }
      return "";
    };

    return walk(obj, 0);
  }

  function extractCharacterNameDeep(obj) {
    const maxDepth = 5;
    const maxNodes = 300;
    const seen = new Set();
    let visited = 0;

    const norm = (s) => {
      const v = typeof s === "string" ? s.trim() : "";
      if (!v) return "";
      if (v.length > 64) return "";
      return v;
    };

    const pick = (o) => {
      if (!o || typeof o !== "object") return "";
      const direct =
        norm(o.characterName) ||
        norm(o.playerName) ||
        norm(o?.character?.name) ||
        norm(o?.character?.characterName) ||
        norm(o?.characterData?.name) ||
        norm(o?.newCharacterActionData?.characterName) ||
        norm(o?.newCharacterActionData?.character?.name);
      if (direct) return direct;

      if (typeof o.name === "string" && (o.characterItems || o.endCharacterItems || o.character || o.characterData)) {
        return norm(o.name);
      }
      return "";
    };

    const walk = (v, depth) => {
      if (visited++ > maxNodes) return "";
      if (!v || depth > maxDepth) return "";
      if (typeof v !== "object") return "";
      if (seen.has(v)) return "";
      seen.add(v);

      const p = pick(v);
      if (p) return p;

      if (Array.isArray(v)) {
        for (const it of v) {
          const r = walk(it, depth + 1);
          if (r) return r;
        }
        return "";
      }

      for (const k of Object.keys(v)) {
        const r = walk(v[k], depth + 1);
        if (r) return r;
      }
      return "";
    };

    return walk(obj, 0);
  }

  function onInitCharacterData(payload) {
    // 初始化角色数据：建立库存基线，避免把“历史库存”误记为“本次获得”
    try {
      // 尽量从 init_character_data 里识别当前角色名（比 DOM 选择器更可靠）
      const possibleName =
        payload?.characterName ||
        payload?.character?.name ||
        payload?.character?.characterName ||
        payload?.characterData?.name ||
        payload?.name ||
        "";
      const nameFromPayload = typeof possibleName === "string" ? possibleName.trim() : "";
      if (nameFromPayload) setSelfName(nameFromPayload);
      const tsNow = nowTs();
      const playerName = runtime.selfName || nameFromPayload;
      if (payload?.characterItems) {
        if (!playerName) {
          if (!runtime.inventory.ready) updateInventoryFromCharacterItems(payload.characterItems);
          return;
        }
        const isBootWindow = tsNow - (Number(runtime.bootTs) || 0) < 15000;
        const isRecentSwitch = !isBootWindow && tsNow - (Number(runtime.lastSwitchTs) || 0) < 15000;
        if (isRecentSwitch) {
          updateInventoryFromCharacterItems(payload.characterItems);
          saveSnapshotForPlayer(playerName, payload.characterItems, tsNow);
          return;
        }
        const prev = getSnapshotForPlayer(playerName);
        const gap = prev ? tsNow - (Number(prev.ts) || 0) : 0;
        if (prev && gap >= APP.offlineMinGapMs) {
          const delta = diffCharacterItems(prev.items, payload.characterItems);
          const gains = delta?.gains || [];
          const consumes = delta?.consumes || [];
          if (gains.length || consumes.length) {
            ensureRecordsLoaded()
              .then(() => {
                const meta = {
                  actionHrid: null,
                  actionCategory: "离线结算",
                  sourceType: "offline_snapshot",
                  offlineFromTs: Number(prev.ts) || null,
                  offlineToTs: tsNow,
                  offlineDurationMs: gap,
                };
                const recordModel = buildRecordModel({ playerName, items: gains, meta });
                recordModel.consumes = consumes.map((x) => ({
                  itemHrid: x.itemHrid,
                  enhancementLevel: Number(x.enhancementLevel ?? 0) || 0,
                  count: Number(x.count) || 0,
                }));
                return addRecordToDb(recordModel).then(() => {
                  runtime.recordsCache.unshift(recordModel);
                  if (runtime.recordsCache.length > APP.maxRecordsHint) runtime.recordsCache.length = APP.maxRecordsHint;
                  if (runtime.ui.open) render();
                  updateFloatingBadge();
                });
              })
              .catch(() => {});
          }
        }

        if (!runtime.inventory.ready) updateInventoryFromCharacterItems(payload.characterItems);
        saveSnapshotForPlayer(playerName, payload.characterItems, tsNow);
      }
    } catch {}
  }

  function onCharacterActionData(payload) {
    // 记录最近一次行动（用于给后续物品变更打分类标签）
    try {
      const actionHrid =
        payload?.newCharacterActionData?.actionHrid ||
        payload?.newCharacterActionData?.action?.actionHrid ||
        payload?.actionHrid ||
        extractActionHridDeep(payload) ||
        "";
      if (typeof actionHrid !== "string" || !actionHrid) return;
      runtime.lastAction = {
        actionHrid,
        actionCategory: classifyActionCategory(actionHrid),
        ts: nowTs(),
      };
    } catch {}
  }

  function detectSelfName() {
    // 从页面中尽力识别当前角色名（拿不到也不影响记录，只是显示为“当前角色”）
    const nameDiv =
      document.querySelector('[class*="CharacterStatus_playerName"]') ||
      document.querySelector('[class*="CharacterName_name"][data-name]') ||
      document.querySelector("[data-name][class*='CharacterName']");
    const name =
      nameDiv?.dataset?.name ||
      (typeof nameDiv?.textContent === "string" ? nameDiv.textContent.trim() : "");
    if (name) setSelfName(name);
    if (!runtime.selfName) setTimeout(detectSelfName, 1000);
  }

  function isCoinItemHrid(itemHrid) {
    return typeof itemHrid === "string" && itemHrid.endsWith("/coin");
  }

  function isTeaItemHrid(itemHrid) {
    if (typeof itemHrid !== "string" || !itemHrid) return false;
    const s = itemHrid.toLowerCase();
    if (!s.startsWith("/items/")) return false;
    if (/(?:^|\/|_)tea(?:$|_|\/)/i.test(s)) return true;
    if (/_tea(?:$|_)/i.test(s)) return true;
    return false;
  }

  function isFoodItemHrid(itemHrid) {
    if (typeof itemHrid !== "string" || !itemHrid) return false;
    const s = itemHrid.toLowerCase();
    if (!s.startsWith("/items/")) return false;
    if (/(?:^|\/)(?:food|foods|meal|meals)(?:$|\/|_)/i.test(s)) return true;
    if (/(?:^|\/|_)(?:cooked|cooking|dish)(?:$|\/|_)/i.test(s)) return true;
    const name = getItemDisplayName(itemHrid);
    if (typeof name === "string" && name) {
      if (/(酸奶|软糖|蛋糕|甜甜圈)/i.test(name)) return true;
      if (/\b(food|meal|dish)\b/i.test(name)) return true;
    }
    return false;
  }

  function isMazeSupplyItemHrid(itemHrid) {
    const hrid = typeof itemHrid === "string" ? itemHrid : "";
    if (!hrid) return false;
    const name = getItemDisplayName(hrid);
    if (typeof name !== "string" || !name) return false;
    const keywords = ["火把", "基础斗篷", "进阶斗篷", "专家斗篷", "探照灯", "食物箱", "茶叶箱", "咖啡箱"];
    for (const k of keywords) {
      if (name.includes(k)) return true;
    }
    return false;
  }

  function isMarketplacePage() {
    try {
      return /marketplace/i.test(String(window.location?.pathname || ""));
    } catch {
      return false;
    }
  }

  function looksLikeMarketplacePayload(payload) {
    const t = payload?.type;
    if (typeof t === "string" && /marketplace|market|listing|auction|trade|buy|sell/i.test(t)) {
      return true;
    }
    if (!payload || typeof payload !== "object") return false;

    for (const k of Object.keys(payload)) {
      if (/marketplace|market|listing|auction|order|trade/i.test(k)) return true;
    }

    if (payload.marketplace || payload.market || payload.listings || payload.orders || payload.trade) return true;
    return false;
  }

  function deltaLooksLikeTrade(gains, consumes) {
    const all = [...(Array.isArray(gains) ? gains : []), ...(Array.isArray(consumes) ? consumes : [])];
    let hasCoin = false;
    let hasNonCoin = false;
    for (const it of all) {
      if (isCoinItemHrid(it?.itemHrid)) hasCoin = true;
      else hasNonCoin = true;
    }
    return hasCoin && hasNonCoin;
  }

  function onItemsUpdatedData(payload) {
    // 任意行动导致的物品变更都会走到这里（战斗/炼金/采摘/制作...）
    const nameFromPayload = extractCharacterNameDeep(payload) || "";
    if (nameFromPayload && nameFromPayload !== runtime.selfName) {
      setSelfName(nameFromPayload);
      try {
        const tsNow = nowTs();
        if (payload?.endCharacterItems) {
          updateInventoryFromCharacterItems(payload.endCharacterItems);
          saveSnapshotForPlayer(nameFromPayload, payload.endCharacterItems, tsNow);
        }
      } catch {}
      return;
    }

    if (!runtime.selfName) {
      try {
        if (payload?.endCharacterItems) updateInventoryFromCharacterItems(payload.endCharacterItems);
      } catch {}
      return;
    }

    const delta = computeInventoryDeltaFromEndItems(payload?.endCharacterItems);
    const gains = delta?.gains || [];
    const consumes = delta?.consumes || [];
    if (!gains.length && !consumes.length) return;

    const actionHridFromPayload = extractActionHridDeep(payload) || "";
    const shouldIgnoreMarketplace =
      looksLikeMarketplacePayload(payload) || (isMarketplacePage() && !actionHridFromPayload && deltaLooksLikeTrade(gains, consumes));
    if (shouldIgnoreMarketplace) {
      try {
        const playerName = runtime.selfName || nameFromPayload || "";
        if (playerName && payload?.endCharacterItems) saveSnapshotForPlayer(playerName, payload.endCharacterItems, nowTs());
      } catch {}
      return;
    }

    const tsNow = nowTs();
    const isFresh = tsNow - (Number(runtime.lastAction.ts) || 0) < 120000;
    const fallbackActionHrid = actionHridFromPayload;
    const actionHrid = isFresh ? runtime.lastAction.actionHrid || fallbackActionHrid : fallbackActionHrid;
    let actionCategory = isFresh
      ? runtime.lastAction.actionCategory || classifyActionCategory(actionHrid) || "未分类"
      : classifyActionCategory(actionHrid);

    if ((actionCategory === "未分类" || actionCategory === "其他") && !actionHrid) {
      const hasTeaConsume = (Array.isArray(consumes) ? consumes : []).some((it) => isTeaItemHrid(it?.itemHrid));
      if (hasTeaConsume) actionCategory = "茶消耗";
      else {
        const hasMazeSupplyConsume = (Array.isArray(consumes) ? consumes : []).some((it) => isMazeSupplyItemHrid(it?.itemHrid));
        if (hasMazeSupplyConsume) actionCategory = "迷宫用品";
        else {
        const hasFoodConsume = (Array.isArray(consumes) ? consumes : []).some((it) => isFoodItemHrid(it?.itemHrid));
        if (hasFoodConsume) actionCategory = "食物消耗";
        }
      }
    }

    const key = buildGainsDedupeKey({ gains, consumes, actionCategory, actionHrid });
    if (key && key === runtime.lastSaved.key && tsNow - runtime.lastSaved.ts < 1500) return;
    runtime.lastSaved = { key, ts: tsNow };

    const meta = {
      actionHrid: actionHrid || null,
      actionCategory,
      sourceType: "endCharacterItems",
    };

    const recordModel = buildRecordModel({
      playerName: runtime.selfName || "未知角色",
      items: gains,
      meta,
    });
    recordModel.consumes = consumes.map((x) => ({
      itemHrid: x.itemHrid,
      enhancementLevel: Number(x.enhancementLevel ?? 0) || 0,
      count: Number(x.count) || 0,
    }));

    addRecordToDb(recordModel)
      .then(() => {
        runtime.recordsCache.unshift(recordModel);
        if (runtime.recordsCache.length > APP.maxRecordsHint) {
          runtime.recordsCache.length = APP.maxRecordsHint;
        }
        if (runtime.ui.open) render();
        updateFloatingBadge();
      })
      .catch(() => {});

    try {
      const playerName = runtime.selfName || "";
      if (!playerName) return;
      const tsNow = nowTs();
      if (payload?.endCharacterItems) saveSnapshotForPlayer(playerName, payload.endCharacterItems, tsNow);
    } catch {}
  }

  function onBattlePayload(payload) {
    // 核心：将“累计 totalLootMap”转换为“本次新增掉落（delta）”，并按战斗生成一条记录
    // 现在记录以“物品变更(endCharacterItems)”为准，这里只用来更新最近一次行动，方便分类
    try {
      const actionHrid =
        payload?.actionHrid || payload?.battle?.actionHrid || extractActionHridDeep(payload) || "";
      if (typeof actionHrid === "string" && actionHrid) {
        runtime.lastAction = {
          actionHrid,
          actionCategory: classifyActionCategory(actionHrid),
          ts: nowTs(),
        };
      }
    } catch {}

    return;
    const players = extractPlayers(payload);
    if (!players.length) return;

    for (const p of players) {
      const playerName = typeof p?.name === "string" ? p.name : "Unknown";
      const lootMap = extractTotalLootMap(p);
      const entries = normalizeLootMapEntries(lootMap);
      if (!entries.length) continue;

      const prev = runtime.playerTotals.get(playerName) || new Map();
      const gains = [];
      for (const { itemHrid, count } of entries) {
        const prevCount = prev.get(itemHrid) || 0;
        const delta = count - prevCount;
        if (delta > 0) gains.push({ itemHrid, count: delta });
        prev.set(itemHrid, count);
      }
      runtime.playerTotals.set(playerName, prev);

      if (!gains.length) continue;

      const meta = {
        battleHrid: payload?.battleHrid || payload?.battle?.battleHrid || null,
        actionHrid: payload?.actionHrid || payload?.battle?.actionHrid || null,
      };

      const recordModel = buildRecordModel({
        playerName,
        items: gains,
        meta,
      });

      addRecordToDb(recordModel)
        .then(() => {
          runtime.recordsCache.unshift(recordModel);
          if (runtime.recordsCache.length > APP.maxRecordsHint) {
            runtime.recordsCache.length = APP.maxRecordsHint;
          }
          if (runtime.ui.open) render();
          updateFloatingBadge();
        })
        .catch(() => {});
    }
  }

  function injectWebSocketInterceptor() {
    // 通过注入脚本拦截 WebSocket，捕获 new_battle 消息并转发到 userscript
    const scriptId = `${APP.id}-ws-interceptor`;
    if (document.getElementById(scriptId)) return;

    const s = document.createElement("script");
    s.id = scriptId;
    s.textContent = `
      (function () {
        if (window.__mwLootRecordWsHooked) return;
        window.__mwLootRecordWsHooked = true;

        const OriginalWebSocket = window.WebSocket;
        if (!OriginalWebSocket) return;

        function shouldHook(url) {
          return typeof url === "string" && (url.includes("milkywayidle.com/ws") || url.includes("api.milkywayidle.com/ws") || url.includes("api-test.milkywayidle.com/ws"));
        }

        window.WebSocket = new Proxy(OriginalWebSocket, {
          construct(target, args) {
            const ws = new target(...args);
            try {
              const url = args && args[0];
              if (shouldHook(url)) {
                ws.addEventListener("message", (event) => {
                  if (!event || typeof event.data !== "string") return;
                  try {
                    const data = JSON.parse(event.data);
                    if (!data || typeof data !== "object") return;

                    if (data.type === "init_character_data") {
                      window.postMessage({ __mwLootRecord: true, type: "init_character_data", payload: data }, "*");
                    }

                    if (data.type === "new_character_action") {
                      window.postMessage({ __mwLootRecord: true, type: "character_action", payload: data }, "*");
                    }

                    if (data.type === "new_battle" && data.players) {
                      window.postMessage({ __mwLootRecord: true, type: "battle", payload: data }, "*");
                    }

                    if (data.endCharacterItems) {
                      window.postMessage({ __mwLootRecord: true, type: "items_updated", payload: data }, "*");
                    }
                  } catch {}
                });
              }
            } catch {}
            return ws;
          },
        });
      })();
    `;
    document.documentElement.appendChild(s);
  }

  function mountUi() {
    // 挂载 UI：浮动入口按钮 + 弹窗面板（两种视图 + 筛选/导出/清空）
    if (runtime.ui.mounted) return;
    runtime.ui.mounted = true;

    const style = document.createElement("style");
    style.id = `${APP.id}-style`;
    style.textContent = `
      :root {
        --mwl-bg: rgba(15, 17, 22, 0.92);
        --mwl-panel: rgba(22, 25, 33, 0.92);
        --mwl-panel2: rgba(30, 34, 44, 0.92);
        --mwl-text: rgba(255, 255, 255, 0.92);
        --mwl-muted: rgba(255, 255, 255, 0.65);
        --mwl-border: rgba(255, 255, 255, 0.12);
        --mwl-accent: #6dd5ed;
        --mwl-accent2: #2193b0;
        --mwl-good: #33d17a;
        --mwl-warn: #ffcc00;
        --mwl-bad: #ff4d4f;
        --mwl-shadow: 0 10px 30px rgba(0,0,0,0.45);
        --mwl-radius: 14px;
        --mwl-font: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji";
        --mwl-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      }

      #${APP.id}-fab {
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 999999;
        display: grid;
        grid-auto-flow: column;
        align-items: center;
        gap: 10px;
        padding: 10px 12px;
        border-radius: 999px;
        background: linear-gradient(135deg, var(--mwl-accent), var(--mwl-accent2));
        color: #071018;
        box-shadow: var(--mwl-shadow);
        cursor: pointer;
        user-select: none;
        font-family: var(--mwl-font);
        letter-spacing: 0.2px;
      }
      #${APP.id}-fab:hover { filter: brightness(1.06); }
      #${APP.id}-fab:active { transform: translateY(1px); }
      #${APP.id}-fab .mwl-fab-title { font-weight: 700; font-size: 13px; }
      #${APP.id}-fab .mwl-fab-badge {
        min-width: 22px;
        height: 18px;
        padding: 0 7px;
        border-radius: 999px;
        background: rgba(0,0,0,0.22);
        color: rgba(255,255,255,0.95);
        display: grid;
        place-items: center;
        font: 12px/1 var(--mwl-mono);
      }

      #${APP.id}-backdrop {
        position: fixed;
        inset: 0;
        z-index: 999998;
        background: rgba(0,0,0,0.55);
        backdrop-filter: blur(6px);
        -webkit-backdrop-filter: blur(6px);
        display: none;
        align-items: center;
        justify-content: center;
        padding: 22px;
      }
      #${APP.id}-modal {
        width: min(1100px, calc(100vw - 44px));
        height: min(740px, calc(100vh - 44px));
        border-radius: var(--mwl-radius);
        background: var(--mwl-bg);
        border: 1px solid var(--mwl-border);
        box-shadow: var(--mwl-shadow);
        overflow: hidden;
        display: grid;
        grid-template-rows: auto auto 1fr;
        font-family: var(--mwl-font);
        color: var(--mwl-text);
      }

      #${APP.id}-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 14px 16px;
        background: linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.0));
        border-bottom: 1px solid var(--mwl-border);
      }
      #${APP.id}-title {
        display: grid;
        gap: 2px;
      }
      #${APP.id}-title .mwl-h1 {
        font-weight: 800;
        font-size: 14px;
        letter-spacing: 0.2px;
      }
      #${APP.id}-title .mwl-sub {
        font-size: 12px;
        color: var(--mwl-muted);
      }
      #${APP.id}-actions {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }

      .mwl-btn {
        border: 1px solid var(--mwl-border);
        background: rgba(255,255,255,0.06);
        color: var(--mwl-text);
        border-radius: 10px;
        padding: 8px 10px;
        cursor: pointer;
        font-size: 12px;
        line-height: 1;
      }
      .mwl-btn:hover { background: rgba(255,255,255,0.10); }
      .mwl-btn:active { transform: translateY(1px); }
      .mwl-btn.mwl-primary {
        background: linear-gradient(135deg, rgba(109,213,237,0.24), rgba(33,147,176,0.24));
        border-color: rgba(109,213,237,0.35);
      }
      .mwl-btn.mwl-danger { border-color: rgba(255,77,79,0.45); background: rgba(255,77,79,0.12); }

      #${APP.id}-tabs {
        display: flex;
        gap: 8px;
        padding: 10px 16px;
        border-bottom: 1px solid var(--mwl-border);
        background: rgba(255,255,255,0.03);
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
      }
      #${APP.id}-tabBtns { display: flex; gap: 8px; align-items: center; }
      .mwl-tab {
        padding: 8px 10px;
        border-radius: 999px;
        border: 1px solid var(--mwl-border);
        background: rgba(255,255,255,0.04);
        color: var(--mwl-muted);
        cursor: pointer;
        font-size: 12px;
      }
      .mwl-tab.active {
        color: rgba(255,255,255,0.95);
        border-color: rgba(109,213,237,0.45);
        background: rgba(109,213,237,0.14);
      }
      #${APP.id}-filters {
        display: flex;
        gap: 10px;
        align-items: center;
        flex-wrap: wrap;
      }
      .mwl-field {
        display: grid;
        gap: 4px;
        font-size: 11px;
        color: var(--mwl-muted);
      }
      .mwl-input, .mwl-select {
        height: 32px;
        border-radius: 10px;
        border: 1px solid var(--mwl-border);
        background: rgba(0,0,0,0.25);
        color: rgba(255,255,255,0.92);
        padding: 0 10px;
        font-size: 12px;
        outline: none;
      }
      .mwl-input::placeholder { color: rgba(255,255,255,0.42); }

      #${APP.id}-body {
        overflow: hidden;
        display: grid;
        grid-template-rows: 1fr;
      }
      #${APP.id}-scroll {
        overflow: auto;
        padding: 14px 16px 16px;
      }

      .mwl-empty {
        color: var(--mwl-muted);
        font-size: 13px;
        padding: 18px;
        border-radius: 12px;
        border: 1px dashed rgba(255,255,255,0.18);
        background: rgba(255,255,255,0.03);
      }

      .mwl-record {
        border: 1px solid var(--mwl-border);
        background: var(--mwl-panel);
        border-radius: 14px;
        overflow: hidden;
        margin-bottom: 12px;
      }
      .mwl-record-hd {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 12px 12px;
        background: rgba(255,255,255,0.04);
        border-bottom: 1px solid var(--mwl-border);
        cursor: pointer;
      }
      .mwl-record-hd .mwl-left { display: grid; gap: 2px; }
      .mwl-record-hd .mwl-t { font-weight: 800; font-size: 12px; }
      .mwl-record-hd .mwl-s { font-size: 12px; color: var(--mwl-muted); font-family: var(--mwl-mono); }
      .mwl-record-hd .mwl-v { font-weight: 800; font-size: 12px; color: var(--mwl-warn); font-family: var(--mwl-mono); }
      .mwl-record-bd { padding: 12px; display: none; }
      .mwl-record.open .mwl-record-bd { display: block; }
      .mwl-cat { text-decoration: underline; cursor: pointer; }

      .mwl-items {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }
      @media (max-width: 720px) {
        .mwl-items { grid-template-columns: 1fr; }
      }
      .mwl-item {
        border: 1px solid var(--mwl-border);
        border-radius: 12px;
        background: var(--mwl-panel2);
        padding: 10px 10px;
        display: grid;
        gap: 2px;
      }
      .mwl-item .n { font-weight: 800; font-size: 12px; display: flex; align-items: center; gap: 6px; }
      .mwl-item .m { font-size: 12px; color: var(--mwl-muted); font-family: var(--mwl-mono); }
      .mwl-icon { width: 16px; height: 16px; flex: 0 0 auto; }

      .mwl-table {
        width: 100%;
        border-collapse: separate;
        border-spacing: 0;
        border: 1px solid var(--mwl-border);
        border-radius: 14px;
        overflow: hidden;
        background: var(--mwl-panel);
      }
      .mwl-table thead th {
        text-align: left;
        font-size: 12px;
        padding: 10px 10px;
        background: rgba(255,255,255,0.05);
        border-bottom: 1px solid var(--mwl-border);
        color: rgba(255,255,255,0.86);
      }
      .mwl-table tbody td {
        font-size: 12px;
        padding: 10px 10px;
        border-bottom: 1px solid rgba(255,255,255,0.08);
        color: rgba(255,255,255,0.88);
        vertical-align: top;
      }
      .mwl-table tbody tr:hover td { background: rgba(255,255,255,0.03); }
      .mwl-table .mono { font-family: var(--mwl-mono); color: rgba(255,255,255,0.82); }
      .mwl-table .muted { color: var(--mwl-muted); }
      .mwl-table .gold { color: var(--mwl-warn); font-weight: 800; }
    `;
    document.head.appendChild(style);

    const fab = document.createElement("div");
    fab.id = `${APP.id}-fab`;
    fab.innerHTML = `
      <div class="mwl-fab-title">掉落记录</div>
      <div class="mwl-fab-badge" id="${APP.id}-fab-badge">0</div>
    `;
    fab.addEventListener("click", () => toggleUi(true));
    document.body.appendChild(fab);

    const backdrop = document.createElement("div");
    backdrop.id = `${APP.id}-backdrop`;
    backdrop.innerHTML = `
      <div id="${APP.id}-modal" role="dialog" aria-modal="true">
        <div id="${APP.id}-header">
          <div id="${APP.id}-title">
            <div class="mwl-h1">掉落/产出记录器</div>
            <div class="mwl-sub">
              <span>可切换“获得/消耗/净收益”，并按行动类型筛选</span>
              <span class="muted" id="${APP.id}-marketInfo" style="margin-left:10px;"></span>
            </div>
          </div>
          <div id="${APP.id}-actions">
            <button class="mwl-btn" id="${APP.id}-export">导出CSV</button>
            <button class="mwl-btn" id="${APP.id}-settings">设置</button>
            <button class="mwl-btn" id="${APP.id}-pick-role">切换角色记录</button>
            <button class="mwl-btn mwl-danger" id="${APP.id}-clear">清空记录</button>
            <button class="mwl-btn mwl-primary" id="${APP.id}-close">关闭</button>
          </div>
        </div>
        <div id="${APP.id}-settingsPanel" style="display:none; padding: 10px 14px; border-bottom: 1px solid rgba(255,255,255,0.10);">
          <div style="display:grid; grid-template-columns: 1fr; gap: 10px;">
            <div class="mwl-field" style="margin:0;">
              <div>金币显示</div>
              <select class="mwl-select" id="${APP.id}-coinFmt">
                <option value="full">完整（10,000）</option>
                <option value="abbr">缩写（10k）</option>
              </select>
            </div>
            <div class="mwl-field" style="margin:0;">
              <div>自定义分类</div>
              <div style="display:flex; gap:8px; align-items:center;">
                <input class="mwl-input" id="${APP.id}-customCatInput" placeholder="输入新分类（如：日常/活动/整理）" />
                <button class="mwl-btn" id="${APP.id}-customCatAdd" style="white-space:nowrap;">添加</button>
              </div>
              <div id="${APP.id}-customCatList" style="display:flex; flex-wrap:wrap; gap:6px; margin-top:8px;"></div>
            </div>
          </div>
        </div>
        <div id="${APP.id}-tabs">
          <div id="${APP.id}-tabBtns">
            <button class="mwl-tab" id="${APP.id}-tab-records" data-tab="records">每次记录</button>
            <button class="mwl-tab" id="${APP.id}-tab-items" data-tab="items">物品汇总</button>
            <button class="mwl-tab" id="${APP.id}-mode-gain" data-mode="gain">获得</button>
            <button class="mwl-tab" id="${APP.id}-mode-consume" data-mode="consume">消耗</button>
            <button class="mwl-tab" id="${APP.id}-mode-net" data-mode="net">净收益</button>
            <select class="mwl-select" id="${APP.id}-priceModeQuick" style="height:28px;">
              <option value="Lbuy_Lsell">价：左/左</option>
              <option value="Lbuy_Rsell">价：左/右</option>
              <option value="Rbuy_Lsell">价：右/左</option>
              <option value="Rbuy_Rsell">价：右/右</option>
            </select>
            <select class="mwl-select" id="${APP.id}-marketSourceQuick" style="height:28px;">
              <option value="auto">源：自动</option>
              <option value="official">源：官方</option>
              <option value="mooket">源：摸客</option>
              <option value="median">源：回退</option>
            </select>
            <button class="mwl-tab" id="${APP.id}-taxToggle" data-tax="1">含税</button>
          </div>
          <div id="${APP.id}-filters">
            <div class="mwl-field">
              <div>开始时间</div>
              <input class="mwl-input" id="${APP.id}-from" type="datetime-local" />
            </div>
            <div class="mwl-field">
              <div>结束时间</div>
              <input class="mwl-input" id="${APP.id}-to" type="datetime-local" />
            </div>
            <div class="mwl-field">
              <div>角色</div>
              <select class="mwl-select" id="${APP.id}-player">
                <option value="">全部</option>
              </select>
            </div>
            <div class="mwl-field">
              <div>行动类型</div>
              <select class="mwl-select" id="${APP.id}-category">
                <option value="">全部</option>
              </select>
            </div>
            <div class="mwl-field" id="${APP.id}-itemField">
              <div>物品</div>
              <select class="mwl-select" id="${APP.id}-item">
                <option value="">全部</option>
              </select>
            </div>
            <div class="mwl-field" id="${APP.id}-qField">
              <div>模糊搜索</div>
              <input class="mwl-input" id="${APP.id}-q" placeholder="输入物品名关键字" />
            </div>
            <button class="mwl-btn" id="${APP.id}-quick-1d">今日</button>
            <button class="mwl-btn" id="${APP.id}-quick-7d">7天</button>
            <button class="mwl-btn" id="${APP.id}-quick-30d">30天</button>
            <button class="mwl-btn" id="${APP.id}-quick-all">全部</button>
          </div>
        </div>
        <div id="${APP.id}-body">
          <div id="${APP.id}-scroll"></div>
        </div>
      </div>
    `;
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) toggleUi(false);
    });
    document.body.appendChild(backdrop);

    const byId = (id) => document.getElementById(id);

    byId(`${APP.id}-close`).addEventListener("click", () => toggleUi(false));
    byId(`${APP.id}-export`).addEventListener("click", () => exportCsv());
    byId(`${APP.id}-clear`).addEventListener("click", () => clearAll());
    byId(`${APP.id}-settings`).addEventListener("click", () => {
      runtime.ui.settingsOpen = !runtime.ui.settingsOpen;
      saveUiState();
      hydrateControlsFromState();
      render();
    });

    const tabBtns = [
      byId(`${APP.id}-tab-records`),
      byId(`${APP.id}-tab-items`),
    ];
    tabBtns.forEach((btn) =>
      btn.addEventListener("click", () => {
        runtime.ui.tab = btn.dataset.tab;
        saveUiState();
        render();
      })
    );

    const modeBtns = [
      byId(`${APP.id}-mode-gain`),
      byId(`${APP.id}-mode-consume`),
      byId(`${APP.id}-mode-net`),
    ];
    modeBtns.forEach((btn) =>
      btn.addEventListener("click", () => {
        runtime.ui.mode = btn.dataset.mode;
        saveUiState();
        render();
      })
    );

    const fromEl = byId(`${APP.id}-from`);
    const toEl = byId(`${APP.id}-to`);
    const itemEl = byId(`${APP.id}-item`);
    const qEl = byId(`${APP.id}-q`);
    const playerEl = byId(`${APP.id}-player`);
    const categoryEl = byId(`${APP.id}-category`);
    const coinFmtEl = byId(`${APP.id}-coinFmt`);
    const priceModeQuickEl = byId(`${APP.id}-priceModeQuick`);
    const marketSourceQuickEl = byId(`${APP.id}-marketSourceQuick`);
    const taxToggleBtn = byId(`${APP.id}-taxToggle`);
    const customCatInputEl = byId(`${APP.id}-customCatInput`);
    const customCatAddEl = byId(`${APP.id}-customCatAdd`);
    const customCatListEl = byId(`${APP.id}-customCatList`);

    byId(`${APP.id}-pick-role`).addEventListener("click", () => {
      try {
        playerEl.focus();
        playerEl.click();
      } catch {}
    });

    coinFmtEl.addEventListener("change", () => {
      const v = coinFmtEl.value;
      runtime.ui.settings.coinFormat = v === "abbr" ? "abbr" : "full";
      saveUiState();
      render();
    });

    if (customCatAddEl && customCatInputEl) {
      const doAdd = () => {
        const name = normalizeCategoryName(customCatInputEl.value || "");
        if (!name) return;
        if (addCustomCategory(name)) {
          customCatInputEl.value = "";
          hydrateControlsFromState();
          render();
        }
      };
      customCatAddEl.addEventListener("click", doAdd);
      customCatInputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") doAdd();
      });
    }

    if (customCatListEl) {
      customCatListEl.addEventListener("click", (e) => {
        const t = e?.target;
        const btn = t && t.closest ? t.closest("[data-action='remove-custom-cat']") : null;
        if (!btn) return;
        const cat = btn.getAttribute("data-cat") || "";
        if (removeCustomCategory(cat)) {
          hydrateControlsFromState();
          render();
        }
      });
    }

    priceModeQuickEl.addEventListener("change", () => {
      const v = priceModeQuickEl.value;
      const ok =
        v === "Lbuy_Lsell" || v === "Lbuy_Rsell" || v === "Rbuy_Lsell" || v === "Rbuy_Rsell";
      runtime.ui.settings.priceMode = ok ? v : "Lbuy_Rsell";
      saveUiState();
      render();
    });

    marketSourceQuickEl.addEventListener("change", () => {
      const v = marketSourceQuickEl.value;
      const ok = v === "auto" || v === "official" || v === "mooket" || v === "median";
      runtime.ui.settings.marketSource = ok ? v : "auto";
      runtime.market.loaded = false;
      runtime.market.fetchedAt = 0;
      saveUiState();
      ensureMarketLoaded().then(() => {
        hydrateControlsFromState();
        render();
      });
    });

    taxToggleBtn.addEventListener("click", () => {
      runtime.ui.settings.taxEnabled = !runtime.ui.settings.taxEnabled;
      saveUiState();
      hydrateControlsFromState();
      render();
    });

    const onChange = () => {
      runtime.ui.filters.from = fromEl.value || "";
      runtime.ui.filters.to = toEl.value || "";
      runtime.ui.filters.category = categoryEl.value || "";
      runtime.ui.filters.itemHrid = itemEl.value || "";
      runtime.ui.filters.q = qEl.value || "";
      runtime.ui.filters.player = playerEl.value || "";
      saveUiState();
      render();
    };

    fromEl.addEventListener("change", onChange);
    toEl.addEventListener("change", onChange);
    itemEl.addEventListener("change", onChange);
    playerEl.addEventListener("change", onChange);
    categoryEl.addEventListener("change", onChange);
    qEl.addEventListener("input", debounce(onChange, 120));

    byId(`${APP.id}-quick-1d`).addEventListener("click", () => quickRangeDays(1));
    byId(`${APP.id}-quick-7d`).addEventListener("click", () => quickRangeDays(7));
    byId(`${APP.id}-quick-30d`).addEventListener("click", () => quickRangeDays(30));
    byId(`${APP.id}-quick-all`).addEventListener("click", () => quickRangeAll());
  }

  function debounce(fn, wait) {
    let t = null;
    return (...args) => {
      if (t) clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  }

  function toggleUi(open) {
    runtime.ui.open = !!open;
    const backdrop = document.getElementById(`${APP.id}-backdrop`);
    if (!backdrop) return;
    backdrop.style.display = runtime.ui.open ? "flex" : "none";
    if (runtime.ui.open) {
      ensureRecordsLoaded()
        .then(() => ensureMarketLoaded())
        .then(() => {
          hydrateControlsFromState();
          render();
          updateFloatingBadge();
        })
        .catch(() => {});
    } else {
      runtime.openRecordIds.clear();
    }
  }

  function hydrateControlsFromState() {
    const byId = (id) => document.getElementById(id);
    const settingsPanel = byId(`${APP.id}-settingsPanel`);
    const fromEl = byId(`${APP.id}-from`);
    const toEl = byId(`${APP.id}-to`);
    const itemEl = byId(`${APP.id}-item`);
    const qEl = byId(`${APP.id}-q`);
    const playerEl = byId(`${APP.id}-player`);
    const categoryEl = byId(`${APP.id}-category`);
    const coinFmtEl = byId(`${APP.id}-coinFmt`);
    const priceModeQuickEl = byId(`${APP.id}-priceModeQuick`);
    const marketSourceQuickEl = byId(`${APP.id}-marketSourceQuick`);
    const taxToggleBtn = byId(`${APP.id}-taxToggle`);
    const customCatListEl = byId(`${APP.id}-customCatList`);

    if (settingsPanel) settingsPanel.style.display = runtime.ui.settingsOpen ? "block" : "none";
    if (fromEl) fromEl.value = runtime.ui.filters.from || "";
    if (toEl) toEl.value = runtime.ui.filters.to || "";
    if (qEl) qEl.value = runtime.ui.filters.q || "";
    if (coinFmtEl) coinFmtEl.value = runtime.ui.settings.coinFormat || "full";
    if (priceModeQuickEl) priceModeQuickEl.value = runtime.ui.settings.priceMode || "Lbuy_Rsell";
    if (marketSourceQuickEl) marketSourceQuickEl.value = runtime.ui.settings.marketSource || "auto";
    if (taxToggleBtn) taxToggleBtn.textContent = runtime.ui.settings.taxEnabled ? "含税" : "不含税";

    rebuildSelectOptions(playerEl, buildPlayerOptions(), runtime.ui.filters.player);
    rebuildSelectOptions(categoryEl, buildCategoryOptions(), runtime.ui.filters.category);
    rebuildSelectOptions(itemEl, buildItemOptions(runtime.ui.mode), runtime.ui.filters.itemHrid);

    if (customCatListEl) {
      const list = getCustomCategories();
      customCatListEl.innerHTML = list.length
        ? list
            .map(
              (c) =>
                `<span style="display:inline-flex; align-items:center; gap:6px; padding:4px 8px; border:1px solid var(--mwl-border); border-radius:999px; background: var(--mwl-panel2);">
                  <span>${escapeHtml(c)}</span>
                  <button class="mwl-btn" data-action="remove-custom-cat" data-cat="${escapeHtml(
                    c
                  )}" style="height:20px; padding:0 8px; border-radius:999px;">删</button>
                </span>`
            )
            .join("")
        : `<span class="muted" style="font-size:12px;">暂无自定义分类</span>`;
    }
  }

  function rebuildSelectOptions(selectEl, options, selectedValue) {
    if (!selectEl) return;
    const keepFirst = selectEl.querySelectorAll("option").length > 0;
    const first = keepFirst ? selectEl.querySelector("option") : null;
    selectEl.innerHTML = "";
    if (first) selectEl.appendChild(first);
    for (const opt of options) {
      const o = document.createElement("option");
      o.value = opt.value;
      o.textContent = opt.label;
      selectEl.appendChild(o);
    }
    if (selectedValue) selectEl.value = selectedValue;
  }

  function buildPlayerOptions() {
    const set = new Set();
    for (const r of runtime.recordsCache) {
      if (r && typeof r.playerName === "string") set.add(r.playerName);
    }
    if (runtime.selfName) set.add(runtime.selfName);
    return Array.from(set)
      .sort((a, b) => a.localeCompare(b))
      .map((p) => ({ value: p, label: p }));
  }

  function getRecordItemsByMode(recordModel, mode) {
    if (mode === "consume") return Array.isArray(recordModel?.consumes) ? recordModel.consumes : [];
    if (mode === "net") {
      const a = Array.isArray(recordModel?.items) ? recordModel.items : [];
      const b = Array.isArray(recordModel?.consumes) ? recordModel.consumes : [];
      return a.concat(b);
    }
    return Array.isArray(recordModel?.items) ? recordModel.items : [];
  }

  function buildItemOptions(mode) {
    const map = new Map();
    for (const r of runtime.recordsCache) {
      const items = getRecordItemsByMode(r, mode);
      for (const it of items) {
        const hrid = it?.itemHrid;
        const lv = Number(it?.enhancementLevel ?? 0) || 0;
        if (typeof hrid === "string") {
          const key = `${hrid}#${lv}`;
          if (!map.has(key)) {
            const name = getItemDisplayName(hrid);
            map.set(key, lv > 0 ? `${name} +${lv}` : name);
          }
        }
      }
    }
    return Array.from(map.entries())
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([value, label]) => ({ value, label }));
  }

  function buildCategoryOptions() {
    const set = new Set();
    set.add("未分类");
    for (const c of getCustomCategories()) set.add(c);
    for (const r of runtime.recordsCache) {
      const c = r?.meta?.actionCategory;
      if (typeof c === "string" && c) set.add(c);
    }
    return Array.from(set)
      .sort((a, b) => a.localeCompare(b))
      .map((c) => ({ value: c, label: c }));
  }

  function quickRangeDays(days) {
    const now = new Date();
    const end = new Date(now);
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setTime(start.getTime() - (days - 1) * 24 * 60 * 60 * 1000);

    runtime.ui.filters.from = toDatetimeLocalValue(start);
    runtime.ui.filters.to = toDatetimeLocalValue(end);
    saveUiState();
    hydrateControlsFromState();
    render();
  }

  function quickRangeAll() {
    runtime.ui.filters.from = "";
    runtime.ui.filters.to = "";
    saveUiState();
    hydrateControlsFromState();
    render();
  }

  function toDatetimeLocalValue(d) {
    const pad = (x) => String(x).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
      d.getHours()
    )}:${pad(d.getMinutes())}`;
  }

  function applyFilters(records) {
    const fromTs = datetimeLocalToTs(runtime.ui.filters.from);
    const toTs = datetimeLocalToTs(runtime.ui.filters.to);
    const player = runtime.ui.filters.player;
    const category = runtime.ui.filters.category;
    const excludeUncategorizedInNet = runtime.ui.mode === "net" && !category;

    return records.filter((r) => {
      if (!r || typeof r.ts !== "number") return false;
      if (fromTs && r.ts < fromTs) return false;
      if (toTs && r.ts > toTs) return false;
      if (player && r.playerName !== player) return false;
      if (category && r?.meta?.actionCategory !== category) return false;
      if (excludeUncategorizedInNet) {
        const c = clampString(r?.meta?.actionCategory, 32) || "未分类";
        if (c === "未分类") return false;
      }
      return true;
    });
  }

  function getTaxRateApplied() {
    const enabled = !!runtime.ui?.settings?.taxEnabled;
    if (!enabled) return 0;
    const r = Number(runtime.ui?.settings?.taxRate);
    if (!Number.isFinite(r)) return 0;
    return Math.max(0, Math.min(0.2, r));
  }

  function computeRecordPricing(recordModel, mode) {
    const tax = getTaxRateApplied();
    const m = mode || runtime.ui.mode || "gain";
    const gains = Array.isArray(recordModel?.items) ? recordModel.items : [];
    const consumes = Array.isArray(recordModel?.consumes) ? recordModel.consumes : [];

    let totalValue = 0;
    const out = [];

    const pushLine = (it, direction) => {
      const itemHrid = it?.itemHrid;
      const enhancementLevel = Number(it?.enhancementLevel ?? 0) || 0;
      const itemName = getItemDisplayName(itemHrid);
      const count = Number(it?.count) || 0;
      const price = getBuySellPrice(itemHrid, enhancementLevel);
      const buy = typeof price.buy === "number" ? price.buy : null;
      const sell = typeof price.sell === "number" ? price.sell : null;

      let value = null;
      if (direction === "consume") {
        if (typeof buy === "number") value = buy * count;
      } else {
        if (typeof sell === "number") value = sell * count * (1 - tax);
      }

      const signed =
        direction === "consume" && m !== "consume" ? (typeof value === "number" ? -value : null) : value;
      if (typeof signed === "number") totalValue += signed;

      out.push({
        direction,
        itemHrid,
        itemName,
        enhancementLevel,
        count,
        buyPrice: buy,
        sellPrice: sell,
        value: signed,
      });
    };

    if (m === "consume") {
      consumes.forEach((it) => pushLine(it, "consume"));
      return { totalValue, items: out };
    }
    if (m === "net") {
      gains.forEach((it) => pushLine(it, "gain"));
      consumes.forEach((it) => pushLine(it, "consume"));
      return { totalValue, items: out };
    }

    gains.forEach((it) => pushLine(it, "gain"));
    return { totalValue, items: out };
  }

  function render() {
    // 根据 tab + 筛选条件渲染内容（默认“每次记录”不合并）
    const byId = (id) => document.getElementById(id);
    const scroll = byId(`${APP.id}-scroll`);
    if (!scroll) return;

    const tabRecordsBtn = byId(`${APP.id}-tab-records`);
    const tabItemsBtn = byId(`${APP.id}-tab-items`);
    if (tabRecordsBtn) tabRecordsBtn.classList.toggle("active", runtime.ui.tab === "records");
    if (tabItemsBtn) tabItemsBtn.classList.toggle("active", runtime.ui.tab === "items");

    const modeGainBtn = byId(`${APP.id}-mode-gain`);
    const modeConsumeBtn = byId(`${APP.id}-mode-consume`);
    const modeNetBtn = byId(`${APP.id}-mode-net`);
    if (modeGainBtn) modeGainBtn.classList.toggle("active", runtime.ui.mode === "gain");
    if (modeConsumeBtn) modeConsumeBtn.classList.toggle("active", runtime.ui.mode === "consume");
    if (modeNetBtn) modeNetBtn.classList.toggle("active", runtime.ui.mode === "net");

    const taxBtn = byId(`${APP.id}-taxToggle`);
    if (taxBtn) taxBtn.classList.toggle("active", !!runtime.ui?.settings?.taxEnabled);

    const marketInfoEl = byId(`${APP.id}-marketInfo`);
    if (marketInfoEl) {
      const src = runtime.market.source || "未加载";
      const srcLabel =
        src === "official" ? "官方" : src === "mooket" ? "摸客" : src === "median" ? "回退" : src;
      const t = Number(runtime.market.timeSec) ? Number(runtime.market.timeSec) * 1000 : Number(runtime.market.fetchedAt) || 0;
      const timeText = t ? formatTime(t) : "—";
      marketInfoEl.textContent = `价格源：${srcLabel}｜更新时间：${timeText}`;
    }

    const itemField = byId(`${APP.id}-itemField`);
    const qField = byId(`${APP.id}-qField`);
    if (itemField) itemField.style.display = runtime.ui.tab === "items" ? "grid" : "none";
    if (qField) qField.style.display = runtime.ui.tab === "items" ? "grid" : "none";

    const filtered = applyFilters(runtime.recordsCache);
    if (runtime.ui.tab === "records") {
      const prevScrollTop = runtime.openRecordIds.size ? scroll.scrollTop : null;
      scroll.innerHTML = renderRecordsView(filtered, runtime.ui.mode);
      bindRecordExpanders();
      bindCategoryEditors();
      applyRecordOpenStates();
      if (prevScrollTop != null) scroll.scrollTop = prevScrollTop;
      hydrateControlsFromState();
      return;
    }
    scroll.innerHTML = renderItemsView(filtered, runtime.ui.mode);
    hydrateControlsFromState();
  }

  function renderRecordsView(records, mode) {
    // 视图 1：每次记录（不合并）
    if (!records.length) return `<div class="mwl-empty">暂无记录（需要先产生行动产出/掉落后才会出现）。</div>`;

    const html = records
      .slice(0, 500)
      .map((r) => {
        const time = formatTime(r.ts);
        const priced = computeRecordPricing(r, mode);
        const total = formatCoin(priced.totalValue || 0);
        const items = priced.items;
        const category = clampString(r?.meta?.actionCategory, 32) || "未分类";
        const itemsHtml = items
          .map((it) => {
            const name = clampString(it.itemName, 80);
            const lv = Number(it.enhancementLevel) || 0;
            const lvText = lv > 0 ? ` +${lv}` : "";
            const count = formatNumber(it.count || 0);
            const prefix = it.direction === "consume" ? "-" : "+";
            const unit = formatPricePair(it.itemHrid, lv);
            const value = typeof it.value === "number" ? formatCoin(it.value) : "—";
            const valueHint = it.direction === "consume" ? "小计(按买价)" : "小计(按卖价)";
            const iconHtml = getItemIconHtml(it.itemHrid);
            return `
              <div class="mwl-item">
                <div class="n">${iconHtml}<span>${escapeHtml(name + lvText)}</span></div>
                <div class="m">${escapeHtml(prefix)} × ${count} ｜ 单价(买/卖): ${escapeHtml(unit)} ｜ ${escapeHtml(
              valueHint
            )}: ${escapeHtml(value)}</div>
              </div>
            `;
          })
          .join("");

        return `
          <div class="mwl-record" data-id="${escapeHtml(r.id)}">
            <div class="mwl-record-hd" data-action="toggle">
              <div class="mwl-left">
                <div class="mwl-t">${escapeHtml(time)} ｜ <span class="mwl-cat" data-action="edit-category" data-id="${escapeHtml(
                  r.id
                )}">${escapeHtml(category)}</span> ｜ ${escapeHtml(
          mode === "consume" ? "消耗" : mode === "net" ? "净收益" : "获得"
        )}</div>
                <div class="mwl-s">物品数：${formatNumber(items.length)}</div>
              </div>
              <div class="mwl-v">${escapeHtml(total)}</div>
            </div>
            <div class="mwl-record-bd">
              <div class="mwl-items">${
                itemsHtml ||
                `<div class="mwl-empty">本次未检测到${
                  mode === "consume" ? "消耗" : mode === "net" ? "净收益" : "获得"
                }</div>`
              }</div>
            </div>
          </div>
        `;
      })
      .join("");

    const hint =
      records.length > 500
        ? `<div class="mwl-empty">只展示最近 500 条（共 ${formatNumber(records.length)} 条），请用时间段缩小范围。</div>`
        : "";
    return hint + html;
  }

  function renderItemsView(records, mode) {
    // 视图 2：按物品汇总（相同物品合并为一行，支持时间段/物品筛选/模糊搜索）
    if (!records.length) return `<div class="mwl-empty">暂无记录可汇总。</div>`;

    const itemHridFilter = runtime.ui.filters.itemHrid;
    const q = (runtime.ui.filters.q || "").trim().toLowerCase();
    const tax = getTaxRateApplied();

    const agg = new Map();
    for (const r of records) {
      const add = (it, direction) => {
        const hrid = it?.itemHrid;
        const lv = Number(it?.enhancementLevel ?? 0) || 0;
        const name = getItemDisplayName(hrid);
        const cnt = Number(it?.count) || 0;
        if (typeof hrid !== "string" || cnt <= 0) return;

        const key = `${hrid}#${lv}`;
        const rec = agg.get(key) || {
          itemHrid: hrid,
          enhancementLevel: lv,
          itemName: name,
          gainCount: 0,
          consumeCount: 0,
          totalCount: 0,
          totalValue: 0,
          priced: false,
          firstTs: r.ts,
          lastTs: r.ts,
        };

        const price = getBuySellPrice(hrid, lv);
        if (direction === "consume") {
          rec.consumeCount += cnt;
          rec.totalCount += mode === "net" ? -cnt : cnt;
          if (typeof price.buy === "number") {
            rec.totalValue -= price.buy * cnt;
            rec.priced = true;
          }
        } else {
          rec.gainCount += cnt;
          rec.totalCount += cnt;
          if (typeof price.sell === "number") {
            rec.totalValue += price.sell * cnt * (1 - tax);
            rec.priced = true;
          }
        }

        rec.firstTs = Math.min(rec.firstTs, r.ts);
        rec.lastTs = Math.max(rec.lastTs, r.ts);
        agg.set(key, rec);
      };

      if (mode === "net") {
        const gains = Array.isArray(r?.items) ? r.items : [];
        const consumes = Array.isArray(r?.consumes) ? r.consumes : [];
        gains.forEach((it) => add(it, "gain"));
        consumes.forEach((it) => add(it, "consume"));
      } else {
        const items = getRecordItemsByMode(r, mode);
        const direction = mode === "consume" ? "consume" : "gain";
        items.forEach((it) => add(it, direction));
      }
    }

    let rows = Array.from(agg.values());
    if (itemHridFilter) {
      if (itemHridFilter.includes("#")) {
        rows = rows.filter((x) => `${x.itemHrid}#${Number(x.enhancementLevel) || 0}` === itemHridFilter);
      } else {
        rows = rows.filter((x) => x.itemHrid === itemHridFilter);
      }
    }
    if (q) rows = rows.filter((x) => x.itemName.toLowerCase().includes(q));

    rows.sort((a, b) => b.totalValue - a.totalValue || b.totalCount - a.totalCount);

    if (!rows.length) return `<div class="mwl-empty">没有匹配的物品（尝试调整时间段/物品筛选/搜索关键字）。</div>`;

    const currentTotalNetValue =
      mode === "net"
        ? rows.reduce((s, x) => s + (Number.isFinite(x.totalValue) ? x.totalValue : 0), 0)
        : 0;

    const body = rows
      .slice(0, 800)
      .map((x) => {
        const unitText = formatPricePair(x.itemHrid, x.enhancementLevel);
        const totalValue = x.priced ? formatCoin(x.totalValue) : "—";
        const lvText = String(Number(x.enhancementLevel) || 0);
        const iconHtml = getItemIconHtml(x.itemHrid);
        return `
          <tr>
            <td><div style="display:flex; align-items:center; gap:6px;">${iconHtml}<span>${escapeHtml(
          x.itemName
        )}</span></div></td>
            <td class="mono">${escapeHtml(lvText)}</td>
            ${
              mode === "net"
                ? `<td class="mono">${formatNumber(x.gainCount)}</td>
                   <td class="mono">${formatNumber(x.consumeCount)}</td>
                   <td class="mono">${escapeHtml(formatNumber(x.totalCount))}</td>`
                : `<td class="mono">${formatNumber(x.totalCount)}</td>`
            }
            <td class="mono">${escapeHtml(unitText)}</td>
            <td class="mono gold">${escapeHtml(totalValue)}</td>
            <td class="mono muted">${escapeHtml(formatTime(x.firstTs))}</td>
            <td class="mono muted">${escapeHtml(formatTime(x.lastTs))}</td>
          </tr>
        `;
      })
      .join("");

    const hint =
      rows.length > 800
        ? `<div class="mwl-empty">只展示前 800 行（共 ${formatNumber(rows.length)} 行），请用筛选缩小范围。</div>`
        : "";

    return `
      ${hint}
      ${
        mode === "net"
          ? `<div class="mwl-empty">当前总净收益：<span style="color: var(--mwl-warn); font-weight: 800; font-family: var(--mwl-mono);">${escapeHtml(
              formatCoin(currentTotalNetValue)
            )}</span></div>`
          : ""
      }
      <table class="mwl-table">
        <thead>
          <tr>
            <th style="width: 28%;">物品</th>
            <th style="width: 6%;">强化</th>
            ${
              mode === "net"
                ? `<th style="width: 8%;">获得</th>
                   <th style="width: 8%;">消耗</th>
                   <th style="width: 8%;">净数量</th>`
                : `<th style="width: 10%;">总数量</th>`
            }
            <th style="width: 10%;">当前单价(买/卖)</th>
            <th style="width: 10%;">${mode === "consume" ? "汇总成本" : mode === "net" ? "净价值" : "汇总价值"}</th>
            <th style="width: 9%;">首次${mode === "consume" ? "消耗" : mode === "net" ? "记录" : "获得"}</th>
            <th style="width: 9%;">最后${mode === "consume" ? "消耗" : mode === "net" ? "记录" : "获得"}</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    `;
  }

  function bindRecordExpanders() {
    const nodes = document.querySelectorAll(`.mwl-record [data-action="toggle"]`);
    nodes.forEach((n) => {
      n.addEventListener("click", () => {
        const root = n.closest(".mwl-record");
        if (!root) return;
        const id = root.getAttribute("data-id") || "";
        const isOpen = root.classList.toggle("open");
        if (id) {
          if (isOpen) runtime.openRecordIds.add(id);
          else runtime.openRecordIds.delete(id);
        }
      });
    });
  }

  function bindCategoryEditors() {
    const nodes = document.querySelectorAll(`.mwl-cat[data-action="edit-category"]`);
    nodes.forEach((n) => {
      n.addEventListener("click", (e) => {
        try {
          e.preventDefault();
          e.stopPropagation();
        } catch {}

        const id = n.getAttribute("data-id") || "";
        const rec = runtime.recordsCache.find((x) => x?.id === id) || null;
        const cur = clampString(rec?.meta?.actionCategory, 32) || "未分类";
        const hint = runtime.ui.mode === "net" ? "（净收益默认不统计“未分类”，可在此修改后纳入）" : "";
        const input = prompt(`修改分类${hint}\n留空=未分类`, cur);
        if (input == null) return;
        const next = normalizeCategoryName(input) || "未分类";
        if (next === cur) return;
        if (next !== "未分类") addCustomCategory(next);
        updateRecordCategory(id, next)
          .then(() => {
            hydrateControlsFromState();
            render();
          })
          .catch(() => {});
      });
    });
  }

  function cssEscapeValue(s) {
    const v = String(s ?? "");
    try {
      if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(v);
    } catch {}
    return v.replace(/"/g, '\\"');
  }

  function applyRecordOpenStates() {
    if (!runtime.openRecordIds.size) return;
    for (const id of runtime.openRecordIds) {
      const el = document.querySelector(`.mwl-record[data-id="${cssEscapeValue(id)}"]`);
      if (el) el.classList.add("open");
    }
  }

  function escapeHtml(s) {
    const v = String(s ?? "");
    return v
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function updateFloatingBadge() {
    const el = document.getElementById(`${APP.id}-fab-badge`);
    if (!el) return;
    el.textContent = String(Math.min(runtime.recordsCache.length, 9999));
  }

  function exportCsv() {
    const filtered = applyFilters(runtime.recordsCache);
    if (!filtered.length) {
      alert("当前筛选条件下没有可导出的数据。");
      return;
    }

    if (runtime.ui.tab === "records") {
      const mode = runtime.ui.mode || "gain";
      const modeLabel = mode === "consume" ? "消耗" : mode === "net" ? "净收益" : "获得";
      const src = runtime.market.source || "";
      const srcLabel =
        src === "official" ? "官方" : src === "mooket" ? "摸客" : src === "median" ? "回退" : src;
      const t = Number(runtime.market.timeSec) ? Number(runtime.market.timeSec) * 1000 : Number(runtime.market.fetchedAt) || 0;
      const timeText = t ? formatTime(t) : "";
      const rows = [
        [
          "时间",
          "角色",
          "模式",
          "方向",
          "行动类型",
          "物品",
          "强化",
          "数量",
          "单价(买/卖)",
          "本行价值",
          "本次总价值",
          "价格源",
          "价格时间",
        ].join(","),
      ];
      for (const r of filtered) {
        const priced = computeRecordPricing(r, mode);
        const items = priced.items;
        if (!items.length) continue;
        for (const it of items) {
          const dirLabel = it.direction === "consume" ? "消耗" : "获得";
          rows.push(
            [
              csvEscape(formatTime(r.ts)),
              csvEscape(r.playerName || ""),
              csvEscape(modeLabel),
              csvEscape(dirLabel),
              csvEscape(r?.meta?.actionCategory || ""),
              csvEscape(it.itemName || ""),
              String(Number(it.enhancementLevel) || 0),
              String(it.count ?? 0),
              csvEscape(formatPricePair(it.itemHrid, it.enhancementLevel)),
              it.value == null ? "" : String(it.value),
              String(priced.totalValue ?? 0),
              csvEscape(srcLabel),
              csvEscape(timeText),
            ].join(",")
          );
        }
      }
      copyText(rows.join("\n"), "已复制CSV到剪贴板（每次记录）。");
      return;
    }

    const mode = runtime.ui.mode || "gain";
    const itemHridFilter = runtime.ui.filters.itemHrid;
    const q = (runtime.ui.filters.q || "").trim().toLowerCase();
    const tax = getTaxRateApplied();
    const src = runtime.market.source || "";
    const srcLabel = src === "official" ? "官方" : src === "mooket" ? "摸客" : src === "median" ? "回退" : src;
    const t = Number(runtime.market.timeSec) ? Number(runtime.market.timeSec) * 1000 : Number(runtime.market.fetchedAt) || 0;
    const timeText = t ? formatTime(t) : "";
    const agg = new Map();
    for (const r of filtered) {
      const add = (it, direction) => {
        const hrid = it?.itemHrid;
        const lv = Number(it?.enhancementLevel ?? 0) || 0;
        const name = getItemDisplayName(hrid);
        const cnt = Number(it?.count) || 0;
        if (typeof hrid !== "string" || cnt <= 0) return;
        const key = `${hrid}#${lv}`;
        const rec = agg.get(key) || {
          itemHrid: hrid,
          enhancementLevel: lv,
          itemName: name,
          gainCount: 0,
          consumeCount: 0,
          totalCount: 0,
          totalValue: 0,
        };
        const p = getBuySellPrice(hrid, lv);
        if (direction === "consume") {
          rec.consumeCount += cnt;
          rec.totalCount += mode === "net" ? -cnt : cnt;
          if (typeof p.buy === "number") rec.totalValue -= p.buy * cnt;
        } else {
          rec.gainCount += cnt;
          rec.totalCount += cnt;
          if (typeof p.sell === "number") rec.totalValue += p.sell * cnt * (1 - tax);
        }
        agg.set(key, rec);
      };

      if (mode === "net") {
        const gains = Array.isArray(r?.items) ? r.items : [];
        const consumes = Array.isArray(r?.consumes) ? r.consumes : [];
        gains.forEach((it) => add(it, "gain"));
        consumes.forEach((it) => add(it, "consume"));
      } else {
        const items = getRecordItemsByMode(r, mode);
        const direction = mode === "consume" ? "consume" : "gain";
        items.forEach((it) => add(it, direction));
      }
    }
    let rowsAgg = Array.from(agg.values());
    if (itemHridFilter) {
      if (itemHridFilter.includes("#")) {
        rowsAgg = rowsAgg.filter((x) => `${x.itemHrid}#${Number(x.enhancementLevel) || 0}` === itemHridFilter);
      } else {
        rowsAgg = rowsAgg.filter((x) => x.itemHrid === itemHridFilter);
      }
    }
    if (q) rowsAgg = rowsAgg.filter((x) => x.itemName.toLowerCase().includes(q));
    rowsAgg.sort((a, b) => {
      return b.totalValue - a.totalValue || b.totalCount - a.totalCount || a.itemName.localeCompare(b.itemName);
    });

    const rows =
      mode === "net"
        ? [
            [
              "物品",
              "强化",
              "获得数量",
              "消耗数量",
              "净数量",
              "当前单价(买/卖)",
              "净价值",
              "价格源",
              "价格时间",
            ].join(","),
          ]
        : [
            [
              "物品",
              "强化",
              "总数量",
              "当前单价(买/卖)",
              mode === "consume" ? "汇总成本" : "汇总价值",
              "价格源",
              "价格时间",
            ].join(","),
          ];
    for (const x of rowsAgg) {
      if (mode === "net") {
        rows.push(
          [
            csvEscape(x.itemName),
            String(Number(x.enhancementLevel) || 0),
            String(x.gainCount || 0),
            String(x.consumeCount || 0),
            String(x.totalCount || 0),
            csvEscape(formatPricePair(x.itemHrid, x.enhancementLevel)),
            String(x.totalValue ?? 0),
            csvEscape(srcLabel),
            csvEscape(timeText),
          ].join(",")
        );
      } else {
        rows.push(
          [
            csvEscape(x.itemName),
            String(Number(x.enhancementLevel) || 0),
            String(x.totalCount || 0),
            csvEscape(formatPricePair(x.itemHrid, x.enhancementLevel)),
            String(x.totalValue ?? 0),
            csvEscape(srcLabel),
            csvEscape(timeText),
          ].join(",")
        );
      }
    }
    copyText(rows.join("\n"), "已复制CSV到剪贴板（物品汇总）。");
  }

  function csvEscape(s) {
    const v = String(s ?? "");
    const need = /[,"\n]/.test(v);
    const esc = v.replace(/"/g, '""');
    return need ? `"${esc}"` : esc;
  }

  function copyText(text, okMsg) {
    navigator.clipboard
      .writeText(text)
      .then(() => alert(okMsg))
      .catch(() => {
        try {
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.style.position = "fixed";
          ta.style.left = "-9999px";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
          alert(okMsg);
        } catch {
          alert("复制失败，请打开控制台手动获取。");
          console.log(text);
        }
      });
  }

  function clearAll() {
    if (!confirm("确定要清空所有记录吗？此操作不可撤销。")) return;
    clearAllRecordsInDb()
      .then(() => {
        runtime.recordsCache = [];
        updateFloatingBadge();
        render();
      })
      .catch(() => alert("清空失败（IndexedDB 可能不可用）。"));
  }

  function bootstrap() {
    loadUiState();
    injectWebSocketInterceptor();
    const mountWhenReady = () => {
      maybeMigrateLegacyDb()
        .catch(() => {})
        .finally(() => {
          detectSelfName();
          mountUi();
          ensureRecordsLoaded(true).then(() => {
            updateFloatingBadge();
            hydrateControlsFromState();
          });
        });
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", mountWhenReady, { once: true });
    } else {
      mountWhenReady();
    }
    ensureMarketLoaded();

    const trySaveSnapshotFromRuntime = () => {
      try {
        const playerName = runtime.selfName || "";
        if (!playerName) return;
        if (!runtime.inventory.ready) return;
        const items = getRuntimeInventoryAsCharacterItems();
        if (!items.length) return;
        saveSnapshotForPlayer(playerName, items, nowTs());
      } catch {}
    };

    window.addEventListener("beforeunload", trySaveSnapshotFromRuntime);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") trySaveSnapshotFromRuntime();
    });

    window.addEventListener("message", (e) => {
      const data = e?.data;
      if (!data || data.__mwLootRecord !== true) return;
      if (data.type === "battle" && data.payload) onBattlePayload(data.payload);
      if (data.type === "init_character_data" && data.payload) onInitCharacterData(data.payload);
      if (data.type === "character_action" && data.payload) onCharacterActionData(data.payload);
      if (data.type === "items_updated" && data.payload) onItemsUpdatedData(data.payload);
    });
  }

  bootstrap();
})();

