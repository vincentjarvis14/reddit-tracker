// Reddit → Airtable Tracker - Content Script v2
// Détection robuste via interception réseau GraphQL + fallback DOM

(function () {
  "use strict";

  const recentActions = [];
  const DEDUP_WINDOW_MS = 5000;

  // ─── Utilitaires ───────────────────────────────────────────────────────────

  function getCurrentAccount() {
    try {
      const scripts = document.querySelectorAll("script");
      for (const s of scripts) {
        const t = s.textContent;
        const m = t.match(/"name"\s*:\s*"([^"]+)"\s*,\s*"id"\s*:\s*"t2_/);
        if (m) return m[1];
        const m2 = t.match(/{"currentUser"[^}]*"name"\s*:\s*"([^"]+)"/);
        if (m2) return m2[1];
      }
    } catch (e) {}

    const selectors = [
      'a[href*="/user/"][data-testid="user_profile_link"]',
      "#expand-user-drawer-button",
      'button[id*="user-drawer"]',
      'a[href^="/user/"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        const m = (el.href || el.getAttribute("href") || "").match(/\/user\/([^/?#]+)/);
        if (m && m[1] !== "me") return m[1];
      }
    }
    return "inconnu";
  }

  function getSubreddit() {
    const m = window.location.pathname.match(/\/r\/([^/?#]+)/);
    return m ? m[1] : "inconnu";
  }

  function isDuplicate(type, content) {
    const now = Date.now();
    while (recentActions.length && now - recentActions[0].time > DEDUP_WINDOW_MS) {
      recentActions.shift();
    }
    const key = type + "|" + String(content).substring(0, 50);
    if (recentActions.find((a) => a.key === key)) return true;
    recentActions.push({ key, time: now });
    return false;
  }

  function dispatch(type, content, url, subreddit) {
    if (!content || String(content).trim().length === 0) return;
    if (isDuplicate(type, content)) return;
    const data = {
      account: getCurrentAccount(),
      subreddit: subreddit || getSubreddit(),
      type,
      content: String(content || "").substring(0, 10000),
      url: url || window.location.href,
      timestamp: new Date().toISOString(),
    };
    console.log("[Reddit→Airtable] Action détectée:", type, data);
    chrome.runtime.sendMessage({ action: "log_reddit_action", data }, () => {
      if (chrome.runtime.lastError) {
      }
    });
  }

  // ─── Interception Fetch ────────────────────────────────────────────────────

  const _fetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : input?.url || "";
    let requestBody = null;
    try {
      requestBody = init?.body || null;
    } catch (e) {}

    const response = await _fetch(input, init);

    if (!url.includes("reddit.com") && !url.startsWith("/")) return response;

    try {
      const clone = response.clone();
      const text = await clone.text();

      if (url.includes("/api/comment")) {
        parseRestComment(text, requestBody);
      } else if (url.includes("/api/submit")) {
        parseRestSubmit(text);
      } else if (url.includes("gql.reddit.com") || url.includes("/graphql")) {
        parseGraphQL(text, requestBody);
      } else if (url.includes("gateway.reddit.com") || url.includes("/svc/shreddit")) {
        parseGateway(text, url, requestBody);
      }
    } catch (e) {}

    return response;
  };

  // ─── Interception XHR ─────────────────────────────────────────────────────

  const _xhrOpen = XMLHttpRequest.prototype.open;
  const _xhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._xurl = url;
    return _xhrOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    this.addEventListener("load", function () {
      const url = this._xurl || "";
      if (url.includes("/api/comment")) parseRestComment(this.responseText, body);
      else if (url.includes("/api/submit")) parseRestSubmit(this.responseText);
    });
    return _xhrSend.apply(this, arguments);
  };

  // ─── Parsers ──────────────────────────────────────────────────────────────

  function parseRestComment(responseText, requestBody) {
    try {
      const data = JSON.parse(responseText);
      const thing = data?.json?.data?.things?.[0]?.data;
      if (thing) {
        dispatch(
          "commentaire",
          thing.body,
          "https://reddit.com" + thing.permalink,
          thing.subreddit,
        );
        return;
      }
    } catch (e) {}
    try {
      const params = new URLSearchParams(requestBody || "");
      const text = params.get("text") || params.get("body") || "";
      if (text) dispatch("commentaire", text, window.location.href, getSubreddit());
    } catch (e) {}
  }

  function parseRestSubmit(responseText) {
    try {
      const data = JSON.parse(responseText);
      const d = data?.json?.data;
      if (d)
        dispatch(
          "post",
          d.title || d.selftext || "",
          d.url || "https://reddit.com" + d.permalink,
          d.subreddit,
        );
    } catch (e) {}
  }

  function parseGraphQL(responseText, requestBody) {
    try {
      const data = JSON.parse(responseText);
      const comment = data?.data?.createComment?.comment || data?.data?.createCommentV2?.comment;
      if (comment) {
        const body = extractRichText(comment.body || comment.richtext || comment.content);
        dispatch(
          "commentaire",
          body,
          comment.permalink ? "https://reddit.com" + comment.permalink : window.location.href,
          comment.subredditName || getSubreddit(),
        );
        return;
      }
      const post = data?.data?.submitPost?.post || data?.data?.createPost?.post;
      if (post) {
        dispatch(
          "post",
          post.title || extractRichText(post.body),
          post.permalink ? "https://reddit.com" + post.permalink : window.location.href,
          post.subreddit?.name || getSubreddit(),
        );
        return;
      }
    } catch (e) {}

    try {
      const ops = JSON.parse(requestBody || "[]");
      const list = Array.isArray(ops) ? ops : [ops];
      for (const op of list) {
        const name = op.operationName || "";
        if (name.toLowerCase().includes("comment")) {
          const text =
            op.variables?.body?.document || op.variables?.text || op.variables?.body || "";
          if (text)
            dispatch(
              "commentaire",
              typeof text === "string" ? text : JSON.stringify(text),
              window.location.href,
              getSubreddit(),
            );
        } else if (name.toLowerCase().includes("submit") || name.toLowerCase().includes("post")) {
          const title = op.variables?.title || "";
          if (title) dispatch("post", title, window.location.href, getSubreddit());
        }
      }
    } catch (e) {}
  }

  function parseGateway(responseText, url, requestBody) {
    try {
      const data = JSON.parse(responseText);
      if (url.includes("comment")) {
        const body = data?.body || data?.content || data?.text || data?.data?.body || "";
        if (body) dispatch("commentaire", body, window.location.href, getSubreddit());
      } else if (url.includes("submit") || url.includes("post")) {
        const title = data?.title || data?.data?.title || "";
        if (title) dispatch("post", title, window.location.href, getSubreddit());
      }
    } catch (e) {}
  }

  function extractRichText(content) {
    if (!content) return "";
    if (typeof content === "string") return content;
    try {
      const texts = [];
      function walk(node) {
        if (!node) return;
        if (node.t) texts.push(node.t);
        if (node.c) node.c.forEach(walk);
        if (Array.isArray(node)) node.forEach(walk);
      }
      (content?.document || content?.c || []).forEach(walk);
      return texts.join(" ") || JSON.stringify(content).substring(0, 200);
    } catch (e) {
      return "";
    }
  }

  // ─── Fallback : détection via clic sur bouton Submit ──────────────────────

  document.addEventListener(
    "click",
    (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      const text = (btn.textContent || "").trim().toLowerCase();
      const isSubmit = [
        "save",
        "comment",
        "reply",
        "post",
        "submit",
        "envoyer",
        "publier",
        "répondre",
        "commenter",
      ].some((w) => text.includes(w));
      if (!isSubmit) return;

      const form = btn.closest(
        'form, [data-testid*="comment"], [data-test-id*="comment"], .CommentForm',
      );
      if (!form) return;

      const editor = form.querySelector(
        'textarea, [contenteditable="true"], .public-DraftEditor-content',
      );
      if (!editor) return;

      const content = (editor.value || editor.textContent || editor.innerText || "").trim();
      if (content.length < 2) return;

      // Attendre la réponse réseau avant d'envoyer (le réseau a la priorité)
      setTimeout(() => {
        dispatch("commentaire", content, window.location.href, getSubreddit());
      }, 3500);
    },
    true,
  );

  // ─── Messages depuis le popup ─────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "get_page_info") {
      sendResponse({
        account: getCurrentAccount(),
        subreddit: getSubreddit(),
        url: window.location.href,
      });
    }
    if (msg.action === "test_detection") {
      dispatch(
        "commentaire",
        "[TEST] Détection manuelle - " + new Date().toLocaleTimeString(),
        window.location.href,
        getSubreddit(),
      );
      sendResponse({ ok: true });
    }
  });

  console.log("[Reddit→Airtable] v2 prêt sur", window.location.hostname);
})();
