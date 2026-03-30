// popup.js v4 — Reddit Tracker
// Sélecteur client actif + design macOS + notifications groupées

// ──────────────────────────────────────────────
// UTILS
// ──────────────────────────────────────────────
function $(id) {
  return document.getElementById(id);
}

function showToast(msg, type = "success", duration = 2500) {
  const t = $("toast");
  t.className = `show ${type}`;
  $("toastIcon").textContent = type === "success" ? "✅" : "❌";
  $("toastMsg").textContent = msg;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => {
    t.className = t.className.replace("show", "").trim();
  }, duration);
}

function timeAgo(ts) {
  const d = Math.floor((Date.now() - ts) / 1000);
  if (d < 60) return `${d}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  return `${Math.floor(d / 3600)}h`;
}

// ──────────────────────────────────────────────
// TABS
// ──────────────────────────────────────────────
function initTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => {
        t.classList.remove("active");
      });
      document.querySelectorAll(".panel").forEach((p) => {
        p.classList.remove("active");
      });
      tab.classList.add("active");
      $(`panel-${tab.dataset.tab}`).classList.add("active");
    });
  });
}

// ──────────────────────────────────────────────
// SÉLECTEUR CLIENT ACTIF
// ──────────────────────────────────────────────
let clientsList = [];
let activeClientId = null;
let activeClientName = null;

async function loadClients() {
  // 1. Charger client actif depuis le storage
  await new Promise((resolve) => {
    chrome.storage.local.get(["activeClientId", "activeClientName"], (data) => {
      activeClientId = data.activeClientId || null;
      activeClientName = data.activeClientName || null;
      resolve();
    });
  });

  // 2. Demander la liste des clients au background
  //    Le background utilise le cache local → 0 appel API si déjà chargé
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: "getClients" }, (res) => {
      if (chrome.runtime.lastError) {
        console.error("[Popup] Erreur getClients:", chrome.runtime.lastError.message);
        clientsList = [];
        resolve([]);
        return;
      }
      clientsList = res?.clients ? res.clients : [];
      const source = res?.fromCache ? "(cache local)" : "(NocoDB)";
      console.log("[Popup] Clients chargés:", clientsList.length, source);
      resolve(clientsList);
    });
  });
}

// Force le rechargement depuis NocoDB (bouton manuel — 1 seul appel API)
function refreshClients() {
  const btn = $("btnRefreshClients");
  if (btn) {
    btn.textContent = "⏳";
    btn.disabled = true;
  }
  chrome.runtime.sendMessage({ action: "refreshClients" }, (res) => {
    clientsList = res?.clients ? res.clients : [];
    renderClientSelector();
    if (btn) {
      btn.textContent = "🔄";
      btn.disabled = false;
    }
    showToast(`${clientsList.length} client(s) rechargé(s) depuis NocoDB`, "success");
  });
}

function renderClientSelector() {
  const valEl = $("clientSelectorValue");
  const dotEl = $("clientDot");

  if (activeClientName) {
    valEl.textContent = activeClientName;
    valEl.classList.remove("none");
    dotEl.style.background = "#ff4500";
    dotEl.style.boxShadow = "0 0 8px rgba(255,69,0,0.5)";
  } else {
    valEl.textContent = "Aucun sélectionné";
    valEl.classList.add("none");
    dotEl.style.background = "rgba(255,255,255,0.2)";
    dotEl.style.boxShadow = "none";
  }

  const dropdown = $("clientDropdown");
  dropdown.innerHTML = "";

  // Option "Aucun"
  const noneOpt = document.createElement("div");
  noneOpt.className = `client-option${!activeClientId ? " active" : ""}`;
  noneOpt.innerHTML = `
    <span class="client-option-name client-option-none">— Aucun client —</span>
    <span class="client-option-check">✓</span>`;
  noneOpt.addEventListener("click", () => setActiveClient(null, null));
  dropdown.appendChild(noneOpt);

  clientsList.forEach((c) => {
    const opt = document.createElement("div");
    opt.className = `client-option${activeClientId === c.id ? " active" : ""}`;
    opt.innerHTML = `
      <span class="client-option-name">${c.name}</span>
      <span class="client-option-check">✓</span>`;
    opt.addEventListener("click", () => setActiveClient(c.id, c.name));
    dropdown.appendChild(opt);
  });
}

function setActiveClient(id, name) {
  activeClientId = id;
  activeClientName = name;
  chrome.storage.local.set({ activeClientId: id, activeClientName: name });
  // Notifier background.js
  chrome.runtime.sendMessage({ action: "setActiveClient", clientId: id, clientName: name });
  closeDropdown();
  renderClientSelector();
  showToast(name ? `Client : ${name}` : "Client désactivé", "success");
}

function closeDropdown() {
  $("clientDropdown").classList.remove("show");
  $("clientSelector").classList.remove("open");
}

function initClientSelector() {
  const sel = $("clientSelector");
  sel.addEventListener("click", (e) => {
    if (e.target.closest(".client-option")) return;
    const isOpen = $("clientDropdown").classList.contains("show");
    if (isOpen) {
      closeDropdown();
    } else {
      $("clientDropdown").classList.add("show");
      sel.classList.add("open");
    }
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#clientSelector")) closeDropdown();
  });
}

// ──────────────────────────────────────────────
// LOGS
// ──────────────────────────────────────────────
function renderLogs(logs) {
  const el = $("logList");
  const badge = $("logsCount");
  badge.textContent = logs.length;

  if (!logs.length) {
    el.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">👁</div>
        <p>En attente de vos<br>publications Reddit...</p>
      </div>`;
    return;
  }

  el.innerHTML = "";
  [...logs].reverse().forEach((log, i) => {
    const item = document.createElement("div");
    item.className = `log-item ${log.success ? "success" : "error"} ${i === 0 ? "new" : ""}`;

    const typeChip =
      log.type === "post"
        ? '<span class="type-chip post">post</span>'
        : '<span class="type-chip comment">comment</span>';

    const clientChip = log.clientName
      ? `<span class="log-client-chip">${log.clientName}</span>`
      : "";

    item.innerHTML = `
      <div class="log-row1">
        ${typeChip}
        <span class="log-account">u/${log.account || "?"}</span>
        <span class="log-sub">r/${log.subreddit || "?"}</span>
        ${clientChip}
      </div>
      <div class="log-content">${log.content || "(vide)"}</div>
      <div class="log-row2">
        <span class="log-time">${timeAgo(log.timestamp)}</span>
        <span class="log-status ${log.success ? "ok" : "err"}">
          ${log.success ? "✓ NocoDB" : `✗ ${log.error || "erreur"}`}
        </span>
      </div>`;
    el.appendChild(item);
  });
}

// ──────────────────────────────────────────────
// WHITELIST (comptes)
// ──────────────────────────────────────────────
function renderWhitelist(list, statusMap) {
  const el = $("wlList");
  const badge = $("wlCount");
  badge.textContent = list.length;

  if (!list.length) {
    el.innerHTML = '<div class="empty-state" style="padding:20px"><p>Aucun compte suivi</p></div>';
    return;
  }

  el.innerHTML = "";
  list.forEach((account) => {
    const info = statusMap[account] || {};
    const status = info.status || "inconnu";
    const karma = info.karma != null ? info.karma : "—";

    const pillClass =
      status === "Actif"
        ? "actif"
        : status === "Suspendu"
          ? "suspendu"
          : status === "Introuvable"
            ? "introuvable"
            : "inconnu";

    const item = document.createElement("div");
    item.className = "wl-item";
    item.innerHTML = `
      <div class="wl-left">
        <span class="wl-avatar">🟠</span>
        <div>
          <div class="wl-username"><span class="wl-prefix">u/</span>${account}</div>
          <div class="wl-meta">Karma : ${karma}</div>
        </div>
      </div>
      <div class="wl-right">
        <span class="status-pill ${pillClass}">${status}</span>
        <button class="wl-delete" data-account="${account}" title="Supprimer">×</button>
      </div>`;

    item.querySelector(".wl-delete").addEventListener("click", () => {
      chrome.runtime.sendMessage({ action: "removeAccount", account }, () => {
        loadAll();
        showToast(`u/${account} retiré`, "success");
      });
    });
    el.appendChild(item);
  });
}

// ──────────────────────────────────────────────
// STATS
// ──────────────────────────────────────────────
function renderStats(logs) {
  const posts = logs.filter((l) => l.type === "post").length;
  const comments = logs.filter((l) => l.type === "comment").length;
  const errors = logs.filter((l) => !l.success).length;
  $("statPosts").textContent = posts;
  $("statComments").textContent = comments;
  $("statTotal").textContent = logs.length;
  $("statErrors").textContent = errors;

  // Comptes
  const accountCounts = {};
  logs.forEach((l) => {
    accountCounts[l.account || "?"] = (accountCounts[l.account || "?"] || 0) + 1;
  });
  const topAccounts = Object.entries(accountCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  const aEl = $("accountStats");
  aEl.innerHTML = "";
  if (!topAccounts.length) {
    aEl.innerHTML =
      '<div style="color:var(--text3);padding:8px 10px;font-size:11px">Aucune donnée</div>';
  } else {
    topAccounts.forEach(([name, count]) => {
      const item = document.createElement("div");
      item.className = "top-item";
      item.innerHTML = `<span class="top-item-name">u/${name}</span><span class="top-item-count orange">${count}</span>`;
      aEl.appendChild(item);
    });
  }

  // Subreddits
  const subCounts = {};
  logs.forEach((l) => {
    subCounts[l.subreddit || "?"] = (subCounts[l.subreddit || "?"] || 0) + 1;
  });
  const topSubs = Object.entries(subCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  const sEl = $("subredditStats");
  sEl.innerHTML = "";
  if (!topSubs.length) {
    sEl.innerHTML =
      '<div style="color:var(--text3);padding:8px 10px;font-size:11px">Aucune donnée</div>';
  } else {
    topSubs.forEach(([name, count]) => {
      const item = document.createElement("div");
      item.className = "top-item";
      item.innerHTML = `<span class="top-item-name">r/${name}</span><span class="top-item-count green">${count}</span>`;
      sEl.appendChild(item);
    });
  }
}

// ──────────────────────────────────────────────
// INDICATEUR VISUEL SCAN (Amélioration 6)
// ──────────────────────────────────────────────
function showScanOverlay(show) {
  const overlay = $("scanOverlay");
  if (!overlay) return;
  if (show) {
    overlay.classList.add("visible");
  } else {
    overlay.classList.remove("visible");
  }
}

// Écouter les messages du background (scan démarré / terminé)
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === "scanStarted") {
    showScanOverlay(true);
  }
  if (msg.action === "scanFinished") {
    showScanOverlay(false);
    loadAll();
    if (msg.newCount > 0) {
      showToast(`${msg.newCount} nouvelle(s) publication(s) ajoutée(s) !`, "success");
    }
  }
});

// ──────────────────────────────────────────────
// CONNEXION STATUS
// ──────────────────────────────────────────────
function updateConnBadge(ok) {
  const badge = $("connBadge");
  const label = $("connLabel");
  if (ok) {
    badge.className = "conn-pill on";
    label.textContent = "connecté";
  } else {
    badge.className = "conn-pill";
    label.textContent = "offline";
  }
}

// ──────────────────────────────────────────────
// CONFIG
// ──────────────────────────────────────────────
function loadConfig() {
  chrome.storage.local.get("airtableConfig", (data) => {
    const cfg = data.airtableConfig || {};
    $("f_account").value = cfg.fields?.account || "Compte Reddit";
    $("f_subreddit").value = cfg.fields?.subreddit || "Subreddit";
    $("f_type").value = cfg.fields?.type || "Type";
    $("f_content").value = cfg.fields?.content || "Contenu";
    $("f_url").value = cfg.fields?.url || "URL";
    $("f_date").value = cfg.fields?.date || "";
    $("shadowbanTable").value = cfg.shadowbanTable || "Comptes Reddit";
    const pollVal = cfg.pollMinutes !== undefined ? String(cfg.pollMinutes) : "360";
    $("pollMinutes").value = pollVal;
    updatePollInfo(parseInt(pollVal, 10));
  });
}

function saveConfig() {
  const cfg = {
    shadowbanTable: $("shadowbanTable").value.trim(),
    pollMinutes: parseInt($("pollMinutes").value, 10),
    fields: {
      account: $("f_account").value.trim(),
      subreddit: $("f_subreddit").value.trim(),
      type: $("f_type").value.trim(),
      content: $("f_content").value.trim(),
      url: $("f_url").value.trim(),
      date: $("f_date").value.trim(),
    },
  };
  chrome.storage.local.set({ airtableConfig: cfg }, () => {
    showAlert("alertBox", "✅ Configuration sauvegardée !", "success");
    chrome.runtime.sendMessage({ action: "reloadConfig" });
    chrome.runtime.sendMessage({ action: "reloadAlarms" }, (res) => {
      if (res) updatePollInfo(res.pollMinutes);
    });
  });
}

function updatePollInfo(pollMinutes) {
  const el = $("pollInfo");
  const btn = $("btnPollNowAccounts");
  if (!el) return;
  if (pollMinutes === 0) {
    el.textContent = "🖱 Mode manuel — aucun scan automatique";
    el.style.color = "#ff4500";
    if (btn) btn.style.display = "block";
  } else if (pollMinutes < 60) {
    el.textContent = `🔄 Scan automatique toutes les ${pollMinutes} min`;
    el.style.color = "";
    if (btn) btn.style.display = "block";
  } else {
    var h = pollMinutes / 60;
    el.textContent = `🔄 Scan automatique toutes les ${h}h`;
    el.style.color = "";
    if (btn) btn.style.display = "block";
  }
}

async function testConfig() {
  chrome.runtime.sendMessage({ action: "testConnection" }, (r) => {
    if (chrome.runtime.lastError) {
      showAlert("alertBox", `❌ ${chrome.runtime.lastError.message}`, "error");
      return;
    }
    if (r?.ok) {
      showAlert("alertBox", r.msg || "✅ Connexion NocoDB OK !", "success");
      updateConnBadge(true);
    } else {
      showAlert("alertBox", r?.msg || "❌ Connexion NocoDB échouée", "error");
    }
  });
}

function showAlert(id, msg, type) {
  const el = $(id);
  el.textContent = msg;
  el.className = `alert ${type} show`;
  setTimeout(() => {
    el.className = el.className.replace(" show", "");
  }, 3000);
}

// ──────────────────────────────────────────────
// CHARGEMENT GLOBAL
// ──────────────────────────────────────────────
function loadAll() {
  chrome.storage.local.get(["logs", "whitelist", "statusMap", "airtableConfig"], (data) => {
    const logs = data.logs || [];
    const whitelist = data.whitelist || [];
    const statusMap = data.statusMap || {};
    const _cfg = data.airtableConfig || {};

    renderLogs(logs);
    renderWhitelist(whitelist, statusMap);
    renderStats(logs);
    updateConnBadge(true);
  });
}

// ──────────────────────────────────────────────
// EVENT LISTENERS
// ──────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  // Amélioration 3 : reset du badge dès l'ouverture du popup
  chrome.runtime.sendMessage({ action: "popupOpened" });

  initTabs();
  initClientSelector();
  loadConfig();

  // Charger clients depuis NocoDB PUIS afficher
  await loadClients();
  renderClientSelector();
  loadAll();

  // Recharger les clients depuis NocoDB (manuel)
  const btnRefresh = $("btnRefreshClients");
  if (btnRefresh) btnRefresh.addEventListener("click", refreshClients);

  // Bouton scan manuel dans l'onglet Comptes
  const btnPollNowAccounts = $("btnPollNowAccounts");
  if (btnPollNowAccounts) {
    btnPollNowAccounts.addEventListener("click", () => {
      chrome.runtime.sendMessage({ action: "pollNow" });
      showScanOverlay(true);
      showToast("Scan lancé !", "success");
      setTimeout(() => {
        showScanOverlay(false);
        loadAll();
      }, 4000);
    });
  }

  // Ajouter un compte
  const wlInput = $("wlInput");
  $("wlAddBtn").addEventListener("click", () => {
    const account = wlInput.value.replace(/^u\//i, "").trim();
    if (!account) return;
    chrome.runtime.sendMessage({ action: "addAccount", account }, (_res) => {
      wlInput.value = "";
      loadAll();
      showToast(`u/${account} ajouté`, "success");
    });
  });
  wlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("wlAddBtn").click();
  });

  // Check shadowban manuel
  $("btnCheckShadowban").addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "checkShadowbans" });
    showToast("Vérification en cours...", "success");
    setTimeout(loadAll, 3000);
  });

  // Config
  $("btnSave").addEventListener("click", saveConfig);
  $("btnTest").addEventListener("click", testConfig);

  // Stats
  $("btnPollNow").addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "pollNow" });
    showScanOverlay(true);
    showToast("Scan lancé !", "success");
    setTimeout(() => {
      showScanOverlay(false);
      loadAll();
    }, 4000);
  });
  $("btnClear").addEventListener("click", () => {
    chrome.storage.local.set({ logs: [] }, () => {
      loadAll();
      showToast("Historique vidé", "success");
    });
  });

  // Rafraîchissement auto toutes les 10s
  setInterval(loadAll, 10000);
});
