// Reddit → NocoDB Tracker - Background Service Worker v7.4
// Migration Airtable → NocoDB

const REDDIT_USER_AGENT = "RedditTracker/1.1 by u/whitecoco3";
const _DEFAULT_POLL_MINUTES = 5;
const MAX_LOGS = 500;

// Cache local des URLs déjà envoyées (anti-doublon sans appel API)
const urlsSentToAirtable = {};

// ─── Config NocoDB ────────────────────────────────────────────────────────────
const NC = {
  token: "huKfnUdLoeCjaUTBdc-qleQoAsdyrREMq8_7SNHf",
  baseId: "pv95s0yyapcs378",
  baseUrl: "http://localhost:8080/api/v1/db/data/noco",
  tableId: "m1yeyk96weeyujp", // Données Reddit
  shadowbanTable: "mtlnvopt4i1cvoy", // Comptes Reddit
  clientsTable: "m2tc8t5id1yg8co",
  plateformesTable: "m7e6j31mnyyomvb",
  compteRedditTable: "mtlnvopt4i1cvoy",
};

const DEFAULT_CONFIG = {
  tableId: NC.tableId,
  shadowbanTable: NC.shadowbanTable,
  fields: {
    account: "Compte Reddit",
    subreddit: "Subreddit",
    type: "Type",
    content: "Contenu",
    url: "URL",
    date: "Date de création",
  },
};

const nocoMap = {
  clients: {},
  accounts: {}, // username → NocoDB row Id
  platformReddit: null,
};

let activeClientId = null;
let activeClientName = null;
let sessionNewCount = 0;
let sessionClientName = null;

// ─── Démarrage ────────────────────────────────────────────────────────────────

async function getPollMinutes() {
  var cfg = await getConfig();
  var val = cfg && cfg.pollMinutes !== undefined ? parseInt(cfg.pollMinutes, 10) : 360;
  return Number.isNaN(val) ? 360 : val;
}

async function ensureAlarms() {
  var pollMin = await getPollMinutes();
  if (pollMin > 0) {
    chrome.alarms.get("poll_reddit", (a) => {
      if (!a) chrome.alarms.create("poll_reddit", { periodInMinutes: pollMin });
    });
  } else {
    chrome.alarms.clear("poll_reddit");
  }
  chrome.alarms.get("shadowban_check", (a) => {
    if (!a) chrome.alarms.create("shadowban_check", { periodInMinutes: 60 * 24 });
  });
  chrome.alarms.get("airtable_map", (a) => {
    if (!a) chrome.alarms.create("airtable_map", { periodInMinutes: 60 });
  });
}
ensureAlarms();
chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });

async function startupScan() {
  await sleep(2000);
  await loadActiveClient();
  await buildAirtableMap();
  pollAllAccounts();
}
startupScan();

chrome.runtime.onInstalled.addListener(() => {
  getPollMinutes().then((pollMin) => {
    chrome.alarms.clearAll(() => {
      if (pollMin > 0) {
        chrome.alarms.create("poll_reddit", { periodInMinutes: pollMin });
      }
      chrome.alarms.create("shadowban_check", { periodInMinutes: 60 * 24 });
      chrome.alarms.create("airtable_map", { periodInMinutes: 60 });
      chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });
    });
  });
  chrome.storage.local.get("airtableConfig", (r) => {
    if (!r.airtableConfig) {
      chrome.storage.local.set({ airtableConfig: DEFAULT_CONFIG });
    } else {
      var updated = Object.assign({}, r.airtableConfig, {
        tableId: NC.tableId,
        shadowbanTable: NC.shadowbanTable,
      });
      chrome.storage.local.set({ airtableConfig: updated });
    }
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") return;
  if (alarm.name === "poll_reddit") pollAllAccounts();
  if (alarm.name === "shadowban_check") runShadowbanCheck();
  if (alarm.name === "airtable_map") buildAirtableMap();
});

// ─── Messages popup ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.action === "setActiveClient") {
    activeClientId = msg.clientId || null;
    activeClientName = msg.clientName || null;
    chrome.storage.local.set({
      activeClientId: activeClientId,
      activeClientName: activeClientName,
    });
    reply({ ok: true });
    return true;
  }
  if (msg.action === "pollNow") {
    pollAllAccounts().then(() => {
      reply({ ok: true });
    });
    return true;
  }
  if (msg.action === "addAccount") {
    addAccount(msg.account).then(() => {
      reply({ ok: true });
    });
    return true;
  }
  if (msg.action === "removeAccount") {
    removeAccount(msg.account).then(() => {
      reply({ ok: true });
    });
    return true;
  }
  if (msg.action === "checkShadowbans") {
    runShadowbanCheck().then((res) => {
      reply({ results: res });
    });
    return true;
  }
  if (msg.action === "popupOpened") {
    newEntriesCount = 0;
    chrome.action.setBadgeText({ text: "" });
    reply({ ok: true });
    return true;
  }
  if (msg.action === "reloadAlarms") {
    getPollMinutes().then((pollMin) => {
      chrome.alarms.clear("poll_reddit", () => {
        if (pollMin > 0) {
          chrome.alarms.create("poll_reddit", { periodInMinutes: pollMin });
        }
        reply({ ok: true, pollMinutes: pollMin, manualOnly: pollMin === 0 });
      });
    });
    return true;
  }
  if (msg.action === "reloadConfig") {
    buildAirtableMap();
    reply({ ok: true });
    return true;
  }
  if (msg.action === "getAirtableMap") {
    reply({ map: nocoMap });
    return true;
  }
  if (msg.action === "getClients") {
    var cachedClients = Object.values(nocoMap.clients);
    if (cachedClients.length > 0) {
      reply({ clients: cachedClients, fromCache: true });
      return true;
    }
    fetch(`${NC.baseUrl}/${NC.baseId}/${NC.clientsTable}?limit=500&fields=Client`, {
      headers: { "xc-token": NC.token },
    })
      .then((r) => r.json())
      .then((json) => {
        var clients = (json.list || [])
          .filter((r) => r.Client)
          .map((r) => ({ id: r.Id, name: r.Client }));
        clients.forEach((c) => {
          nocoMap.clients[normalizeName(c.name)] = c;
        });
        reply({ clients: clients, fromCache: false });
      })
      .catch(() => {
        reply({ clients: [] });
      });
    return true;
  }
  if (msg.action === "refreshClients") {
    nocoMap.clients = {};
    fetch(`${NC.baseUrl}/${NC.baseId}/${NC.clientsTable}?limit=500&fields=Client`, {
      headers: { "xc-token": NC.token },
    })
      .then((r) => r.json())
      .then((json) => {
        var clients = (json.list || [])
          .filter((r) => r.Client)
          .map((r) => ({ id: r.Id, name: r.Client }));
        clients.forEach((c) => {
          nocoMap.clients[normalizeName(c.name)] = c;
        });
        reply({ clients: clients });
      })
      .catch(() => {
        reply({ clients: [] });
      });
    return true;
  }
  if (msg.action === "get_logs") {
    getLogs().then((logs) => {
      reply({ logs: logs });
    });
    return true;
  }
  if (msg.action === "clear_logs") {
    chrome.storage.local.set({ logs: [] }, () => {
      reply({ ok: true });
    });
    return true;
  }
  if (msg.action === "get_config") {
    getConfig().then((cfg) => {
      reply({ config: cfg });
    });
    return true;
  }
  if (msg.action === "testConnection") {
    fetch(`${NC.baseUrl}/${NC.baseId}/${NC.tableId}?limit=1`, {
      headers: { "xc-token": NC.token },
    })
      .then((r) => {
        if (r.ok)
          reply({ ok: true, msg: '✅ Connexion NocoDB OK — table "Données Reddit" accessible' });
        else reply({ ok: false, msg: `❌ NocoDB erreur ${r.status}` });
      })
      .catch((e) => {
        reply({ ok: false, msg: `❌ ${e.message}` });
      });
    return true;
  }
});

// ─── Client actif ─────────────────────────────────────────────────────────────

async function loadActiveClient() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["activeClientId", "activeClientName"], (data) => {
      activeClientId = data.activeClientId || null;
      activeClientName = data.activeClientName || null;
      resolve();
    });
  });
}

function resolveClient(_username) {
  if (activeClientId && activeClientName) {
    return { id: activeClientId, name: activeClientName };
  }
  return null;
}

// ─── Map NocoDB ───────────────────────────────────────────────────────────────

function normalizeName(str) {
  return str
    .toLowerCase()
    .replace(/[\u{1F300}-\u{1FFFF}]/gu, "")
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

async function buildAirtableMap() {
  try {
    // Clients
    var cRes = await fetch(
      `${NC.baseUrl}/${NC.baseId}/${NC.clientsTable}?limit=500&fields=Client`,
      {
        headers: { "xc-token": NC.token },
      },
    );
    if (cRes.ok) {
      var cJson = await cRes.json();
      (cJson.list || []).forEach((r) => {
        var rawName = r.Client || "";
        var key = normalizeName(rawName);
        nocoMap.clients[key] = { id: r.Id, name: rawName };
      });
    }

    // Comptes Reddit
    var aRes = await fetch(
      `${NC.baseUrl}/${NC.baseId}/${NC.shadowbanTable}?limit=500&fields=Compte%20Reddit`,
      {
        headers: { "xc-token": NC.token },
      },
    );
    if (aRes.ok) {
      var aJson = await aRes.json();
      (aJson.list || []).forEach((r) => {
        var name = (r["Compte Reddit"] || "").toLowerCase();
        if (name) nocoMap.accounts[name] = r.Id;
      });
    }

    // Plateforme Reddit
    var pRes = await fetch(
      `${NC.baseUrl}/${NC.baseId}/${NC.plateformesTable}?limit=500&fields=Plateforme`,
      {
        headers: { "xc-token": NC.token },
      },
    );
    if (pRes.ok) {
      var pJson = await pRes.json();
      (pJson.list || []).forEach((r) => {
        var name = r.Plateforme || "";
        if (normalizeName(name).includes("reddit")) {
          nocoMap.platformReddit = name;
        }
      });
    }

    console.log(
      "[Background] Map chargée —",
      Object.keys(nocoMap.clients).length,
      "clients,",
      Object.keys(nocoMap.accounts).length,
      "comptes",
    );
  } catch (e) {
    console.error("[Background] Erreur buildAirtableMap:", e.message);
  }
}

// ─── Polling ──────────────────────────────────────────────────────────────────

async function pollAllAccounts() {
  var whitelist = await getWhitelist();
  if (!whitelist.length) return;
  var config = await getConfig();
  if (!config) return;

  sessionNewCount = 0;
  sessionClientName = activeClientName;
  var sessionErrorCount = 0;

  chrome.runtime.sendMessage({ action: "scanStarted" }).catch(() => {});

  for (var i = 0; i < whitelist.length; i++) {
    await sleep(1500);
    var errors = await pollAccount(whitelist[i], config);
    sessionErrorCount += errors || 0;
  }

  if (sessionNewCount > 0) {
    showGroupedNotification(sessionNewCount, sessionClientName);
  }
  if (sessionErrorCount > 0) {
    showAlertNotification(
      "⚠️ Reddit Tracker — Erreurs",
      `${sessionErrorCount} publication(s) n'ont pas pu être envoyées. Vérife ta connexion.`,
    );
  }

  chrome.runtime
    .sendMessage({
      action: "scanFinished",
      newCount: sessionNewCount,
      errorCount: sessionErrorCount,
    })
    .catch(() => {});
}

async function pollAccount(username, config) {
  var errors = 0;
  try {
    errors += await fetchAndProcess(username, "comments", config);
    await sleep(500);
    errors += await fetchAndProcess(username, "submitted", config);
  } catch (e) {
    console.error("[Background] Erreur polling", username, ":", e.message);
    errors++;
  }
  return errors;
}

async function fetchAndProcess(username, kind, config) {
  var url =
    "https://www.reddit.com/user/" +
    encodeURIComponent(username) +
    "/" +
    kind +
    ".json?limit=25&sort=new";
  var resp = await fetch(url, { headers: { "User-Agent": REDDIT_USER_AGENT } });
  if (!resp.ok) return 0;

  var json = await resp.json();
  var items = json?.data?.children;
  if (!items?.length) return 0;

  var seenIds = await getSeenIds();
  var newItems = [];

  for (var i = 0; i < items.length; i++) {
    var item = items[i].data;
    if (!item?.id) continue;
    if (seenIds[item.id]) continue;
    if (Date.now() - item.created_utc * 1000 > 72 * 3600 * 1000) continue;
    newItems.push(item);
    seenIds[item.id] = Date.now();
  }

  if (!newItems.length) return 0;
  await saveSeenIds(seenIds);

  var client = resolveClient(username);
  var errorCount = 0;

  for (var j = 0; j < newItems.length; j++) {
    var item2 = newItems[j];
    var itemUrl = item2.permalink ? `https://www.reddit.com${item2.permalink}` : "";
    var data = {
      account: username,
      subreddit: item2.subreddit || "inconnu",
      type: kind === "comments" ? "comment" : "post",
      content: item2.body || item2.title || item2.selftext || "",
      url: itemUrl,
      timestamp: new Date(item2.created_utc * 1000).toISOString(),
      clientName: client ? client.name : null,
    };
    var result = await sendToAirtableAndLog(config, data, client);
    if (result && result.success === false) errorCount++;
    else sessionNewCount++;
    if (client?.name && !sessionClientName) sessionClientName = client.name;
  }
  return errorCount;
}

// ─── NocoDB ───────────────────────────────────────────────────────────────────

async function sendToAirtableAndLog(config, data, client) {
  var logId = Date.now() + Math.random();
  await addLog(Object.assign({}, data, { id: logId, success: null }));

  var result = await sendToAirtableWithFallback(config, data, client);

  if (result.success) {
    await updateLog(logId, { success: true });
  } else {
    await updateLog(logId, { success: false, error: result.error });
    console.error("[Background] ❌ NocoDB:", result.error);
  }
  return result;
}

async function sendToAirtableWithFallback(config, data, client) {
  if (data.url) {
    if (urlsSentToAirtable[data.url]) {
      console.log("[Background] ⏭ Doublon ignoré (cache local):", data.url);
      return { success: true, skipped: true };
    }
    var alreadyExists = await checkUrlExists(config, data.url);
    if (alreadyExists) {
      console.log("[Background] ⏭ Doublon ignoré (NocoDB):", data.url);
      urlsSentToAirtable[data.url] = Date.now();
      return { success: true, skipped: true };
    }
  }

  var result = await sendToNocoDB(config, data, client);
  if (result.success) {
    if (data.url) urlsSentToAirtable[data.url] = Date.now();
    return result;
  }
  return result;
}

async function checkUrlExists(_config, url) {
  if (!url) return false;
  try {
    var where = encodeURIComponent(`(URL,eq,${url})`);
    var checkUrl = `${NC.baseUrl}/${NC.baseId}/${NC.tableId}?where=${where}&limit=1&fields=URL`;
    var resp = await fetch(checkUrl, { headers: { "xc-token": NC.token } });
    if (!resp.ok) return false;
    var json = await resp.json();
    return json.list && json.list.length > 0;
  } catch (e) {
    console.error("[Background] Erreur checkUrlExists:", e.message);
    return false;
  }
}

async function sendToNocoDB(config, data, client) {
  try {
    var f = config.fields || DEFAULT_CONFIG.fields;
    var row = {};
    row[f.account || "Compte Reddit"] = data.account || "";
    row[f.subreddit || "Subreddit"] = data.subreddit || "";
    row[f.type || "Type"] = data.type === "post" ? "Post" : "Commentaire";
    row[f.content || "Contenu"] = (data.content || "").substring(0, 10000);
    row[f.url || "URL"] = data.url || "";
    if (f.date?.trim()) {
      row[f.date] = data.timestamp || new Date().toISOString();
    } else {
      row["Date de création"] = data.timestamp || new Date().toISOString();
    }

    var contenuTotal = `${data.content || ""} ${data.subreddit || ""}`;
    if (/shine/i.test(contenuTotal)) {
      row["🔔 Mention Shine"] = true;
    }

    var resp = await fetch(`${NC.baseUrl}/${NC.baseId}/${NC.tableId}`, {
      method: "POST",
      headers: { "xc-token": NC.token, "Content-Type": "application/json" },
      body: JSON.stringify(row),
    });
    var json = await resp.json();
    if (resp.ok) return { success: true, recordId: json.Id };

    var errMsg = json.msg || json.message || `HTTP ${resp.status}`;
    if (resp.status >= 500) {
      await sleep(2000);
      return sendToNocoDB(config, data, client);
    }
    return { success: false, error: errMsg };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ─── Notifications macOS groupées ─────────────────────────────────────────────

var newEntriesCount = 0;

function showGroupedNotification(count, clientName) {
  var typeLabel = count === 1 ? "publication" : "publications";
  var plural = count > 1 ? "es" : "e";
  var clientStr = clientName ? ` pour ${clientName}` : "";
  var msg = `${count} ${typeLabel} ajout${plural}${clientStr} ✓`;

  chrome.notifications.create(`scan_${Date.now()}`, {
    type: "basic",
    iconUrl: "icons/icon48.png",
    title: "🤖 Reddit Tracker",
    message: msg,
    priority: 2,
  });

  newEntriesCount += count;
  chrome.action.setBadgeText({ text: String(newEntriesCount) });
  chrome.action.setBadgeBackgroundColor({ color: "#ff4500" });
}

function showAlertNotification(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon48.png",
    title: title,
    message: message,
    priority: 2,
  });
}

if (chrome.action.onClicked) {
  chrome.action.onClicked.addListener(() => {
    newEntriesCount = 0;
    chrome.action.setBadgeText({ text: "" });
  });
}

// ─── Shadowban ────────────────────────────────────────────────────────────────

async function checkShadowban(username) {
  try {
    var resp = await fetch(
      `https://www.reddit.com/user/${encodeURIComponent(username)}/about.json`,
      { headers: { "User-Agent": REDDIT_USER_AGENT } },
    );
    if (resp.status === 404) return { status: "Introuvable", checked_at: new Date().toISOString() };
    if (resp.status === 403) return { status: "Suspendu", checked_at: new Date().toISOString() };
    var json = await resp.json();
    var d = json?.data;
    if (!d) return { status: "Introuvable", checked_at: new Date().toISOString() };
    if (d.is_suspended) return { status: "Suspendu", checked_at: new Date().toISOString() };
    return {
      status: "Actif",
      karma: (d.link_karma || 0) + (d.comment_karma || 0),
      checked_at: new Date().toISOString(),
    };
  } catch (_e) {
    return { status: "Erreur", checked_at: new Date().toISOString() };
  }
}

async function runShadowbanCheck() {
  var whitelist = await getWhitelist();
  if (!whitelist.length) return {};
  var results = {};

  for (var i = 0; i < whitelist.length; i++) {
    var username = whitelist[i];
    await sleep(1000);
    var result = await checkShadowban(username);
    results[username] = result;

    var rowId = nocoMap.accounts[username.toLowerCase()];
    if (rowId) {
      var fields = { Statut: result.status, "Dernière vérification": result.checked_at };
      if (result.karma != null) fields.Karma = result.karma;
      try {
        await fetch(`${NC.baseUrl}/${NC.baseId}/${NC.shadowbanTable}/${rowId}`, {
          method: "PATCH",
          headers: { "xc-token": NC.token, "Content-Type": "application/json" },
          body: JSON.stringify(fields),
        });
      } catch (e) {
        console.error("[Background] Shadowban MAJ NocoDB:", e.message);
      }
    }

    if (result.status === "Suspendu") {
      showAlertNotification("⚠️ Compte suspendu !", `u/${username} est suspendu sur Reddit`);
    }
  }

  var prev = await new Promise((r) => {
    chrome.storage.local.get("statusMap", (d) => {
      r(d.statusMap || {});
    });
  });
  Object.assign(prev, results);
  chrome.storage.local.set({ statusMap: prev });

  return results;
}

// ─── Whitelist ────────────────────────────────────────────────────────────────

async function getWhitelist() {
  return new Promise((r) => {
    chrome.storage.local.get("whitelist", (d) => {
      r(d.whitelist || []);
    });
  });
}

async function addAccount(account) {
  var list = await getWhitelist();
  var norm = account.toLowerCase();
  if (!list.includes(norm)) {
    list.push(norm);
    await new Promise((r) => {
      chrome.storage.local.set({ whitelist: list }, r);
    });
  }
}

async function removeAccount(account) {
  var list = await getWhitelist();
  var norm = account.toLowerCase();
  await new Promise((r) => {
    chrome.storage.local.set({ whitelist: list.filter((a) => a !== norm) }, r);
  });
}

// ─── Seen IDs ─────────────────────────────────────────────────────────────────

async function getSeenIds() {
  return new Promise((r) => {
    chrome.storage.local.get("seenIds", (d) => {
      r(d.seenIds || {});
    });
  });
}

async function saveSeenIds(ids) {
  var now = Date.now();
  var cleaned = {};
  Object.keys(ids).forEach((k) => {
    if (now - ids[k] < 48 * 3600 * 1000) cleaned[k] = ids[k];
  });
  return new Promise((r) => {
    chrome.storage.local.set({ seenIds: cleaned }, r);
  });
}

// ─── Logs ─────────────────────────────────────────────────────────────────────

async function getLogs() {
  return new Promise((r) => {
    chrome.storage.local.get("logs", (d) => {
      r(d.logs || []);
    });
  });
}

async function addLog(log) {
  var logs = await getLogs();
  logs.unshift(log);
  return new Promise((r) => {
    chrome.storage.local.set({ logs: logs.slice(0, MAX_LOGS) }, r);
  });
}

async function updateLog(id, patch) {
  var logs = await getLogs();
  var idx = logs.findIndex((l) => l.id === id);
  if (idx !== -1) {
    Object.assign(logs[idx], patch);
    chrome.storage.local.set({ logs: logs });
  }
}

// ─── Config ───────────────────────────────────────────────────────────────────

async function getConfig() {
  return new Promise((r) => {
    chrome.storage.local.get("airtableConfig", (d) => {
      r(d.airtableConfig || DEFAULT_CONFIG);
    });
  });
}

function sleep(ms) {
  return new Promise((r) => {
    setTimeout(r, ms);
  });
}

console.log("[Background] v7.6.4 (NocoDB) démarré ✅");
