// betterClaws Dashboard — vanilla JS frontend

(function () {
  "use strict";

  // ── Theme ───────────────────────────────────────────────────────────────
  var THEME_KEY = "bc_theme";

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(THEME_KEY, theme);
  }

  applyTheme(localStorage.getItem(THEME_KEY) || "light");

  document.getElementById("theme-toggle").addEventListener("click", function () {
    var current = document.documentElement.getAttribute("data-theme");
    applyTheme(current === "dark" ? "light" : "dark");
  });

  // ── Navigation ──────────────────────────────────────────────────────────

  const navBtns = document.querySelectorAll(".nav-btn");
  const views = document.querySelectorAll(".view");
  var validViews = [];
  navBtns.forEach(function (btn) { validViews.push(btn.dataset.view); });

  function navigateToView(viewName) {
    if (validViews.indexOf(viewName) === -1) viewName = "status";
    navBtns.forEach(function (b) { b.classList.remove("active"); });
    views.forEach(function (v) { v.classList.remove("active"); });
    var btn = document.querySelector('.nav-btn[data-view="' + viewName + '"]');
    if (btn) btn.classList.add("active");
    document.getElementById("view-" + viewName).classList.add("active");
    stopLogAutoRefresh();
    stopMemoryAutoRefresh();
    loadView(viewName);
    if (viewName === "logs") startLogAutoRefresh();
  }

  navBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      location.hash = btn.dataset.view;
    });
  });

  window.addEventListener("hashchange", function () {
    var hash = location.hash.replace(/^#/, "");
    navigateToView(hash);
  });

  function loadView(name) {
    switch (name) {
      case "status": loadStatus(); break;
      case "sessions": loadSessions(); break;
      case "logs": loadLogs(); break;
      case "memory": loadMemory(); break;
      case "schedules": loadSchedules(); break;
      case "adapters": loadAdapters(); break;
      case "suggestions": loadSuggestions(); break;
      case "tools": loadTools(); break;
      case "config": loadConfig(); break;
    }
  }

  // ── Auth ─────────────────────────────────────────────────────────────────

  var authToken = sessionStorage.getItem("bc_dashboard_token") || "";

  function authHeaders(extra) {
    var h = extra || {};
    if (authToken) h["Authorization"] = "Bearer " + authToken;
    return h;
  }

  function showAuthPrompt() {
    document.getElementById("auth-overlay").style.display = "flex";
    var input = document.getElementById("auth-token-input");
    input.value = "";
    input.focus();
  }

  document.getElementById("auth-submit").addEventListener("click", submitToken);
  document.getElementById("auth-token-input").addEventListener("keydown", function (e) {
    if (e.key === "Enter") submitToken();
  });

  function submitToken() {
    var input = document.getElementById("auth-token-input");
    var token = input.value.trim();
    if (!token) return;

    authToken = token;
    sessionStorage.setItem("bc_dashboard_token", token);
    document.getElementById("auth-error").textContent = "";
    document.getElementById("auth-overlay").style.display = "none";

    // Reload the active view
    var active = document.querySelector(".nav-btn.active");
    if (active) loadView(active.dataset.view);
  }

  // ── Fetch helper ────────────────────────────────────────────────────────

  function api(path) {
    return fetch(path, { headers: authHeaders() }).then(function (r) {
      if (r.status === 401) {
        showAuthPrompt();
        return Promise.reject(new Error("Unauthorized"));
      }
      return r.json();
    });
  }

  function esc(str) {
    var div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // ── Status View ─────────────────────────────────────────────────────────

  function loadStatus() {
    api("/api/status").then(function (data) {
      var html = "";
      html += '<div class="status-row"><span class="status-label">Status</span><span class="status-value">' + esc(data.status) + "</span></div>";
      html += '<div class="status-row"><span class="status-label">Uptime</span><span class="status-value">' + Math.floor(data.uptime) + "s</span></div>";

      if (data.adapters) {
        Object.keys(data.adapters).forEach(function (id) {
          var a = data.adapters[id];
          html += '<div class="status-row"><span class="status-label">Adapter: ' + esc(a.name) + '</span><span class="status-value">' + (a.connected ? "Connected" : "Disconnected") + "</span></div>";
        });
      }

      if (data.memoryUsage) {
        var mb = Math.round(data.memoryUsage.heapUsed / 1048576);
        html += '<div class="status-row"><span class="status-label">Heap Used</span><span class="status-value">' + mb + " MB</span></div>";
      }

      document.getElementById("status-content").innerHTML = html;
    });
  }

  // ── Sessions View ───────────────────────────────────────────────────────

  function loadSessions() {
    document.getElementById("sessions-list-container").style.display = "";
    document.getElementById("session-detail").style.display = "none";

    api("/api/sessions").then(function (data) {
      var html = "";
      if (data.sessions.length === 0) {
        html = "<p>No active sessions</p>";
      } else {
        data.sessions.forEach(function (s) {
          var label = esc(s.adapterId) + " / " + esc(s.channelId) + " (" + esc(s.id) + ")";
          html += '<div class="session-item" data-id="' + esc(s.id) + '">' + label + "</div>";
        });
      }
      document.getElementById("sessions-list").innerHTML = html;

      document.querySelectorAll("#sessions-list .session-item").forEach(function (el) {
        el.addEventListener("click", function () {
          loadSessionDetail(el.dataset.id);
        });
      });
    });

    api("/api/sessions/archived").then(function (data) {
      var html = "";
      if (data.sessions.length === 0) {
        html = "<p>No archived sessions</p>";
      } else {
        data.sessions.forEach(function (s) {
          var date = new Date(s.archivedAt).toLocaleString();
          var label = esc(s.sessionId) + " — archived " + esc(date);
          html += '<div class="session-item archived" data-file="' + esc(s.filename) + '">' + label + "</div>";
        });
      }
      document.getElementById("sessions-archived").innerHTML = html;
    });
  }

  var memoryAutoRefreshTimer = null;
  var memoryRefreshSessionId = null;

  function startMemoryAutoRefresh(id) {
    stopMemoryAutoRefresh();
    memoryRefreshSessionId = id;
    memoryAutoRefreshTimer = setInterval(function () {
      api("/api/sessions/" + id + "/memory").then(renderWorkingMemory);
    }, 3000);
  }

  function stopMemoryAutoRefresh() {
    if (memoryAutoRefreshTimer !== null) {
      clearInterval(memoryAutoRefreshTimer);
      memoryAutoRefreshTimer = null;
      memoryRefreshSessionId = null;
    }
  }

  function renderWorkingMemory(data) {
    var container = document.getElementById("session-memory");
    if (!data.entries || data.entries.length === 0) {
      container.innerHTML = "<p>No working memory entries</p>";
      return;
    }

    var categoryOrder = ["goal", "fact", "decision", "correction"];
    var categoryLabels = { goal: "Goals", fact: "Facts", decision: "Decisions", correction: "Corrections" };
    var grouped = {};
    categoryOrder.forEach(function (c) { grouped[c] = []; });

    data.entries.forEach(function (entry) {
      if (grouped[entry.category]) {
        grouped[entry.category].push(entry);
      }
    });

    var html = "";
    categoryOrder.forEach(function (cat) {
      if (grouped[cat].length === 0) return;
      html += '<div class="wm-category">';
      html += '<div class="wm-category-label">' + esc(categoryLabels[cat]) + "</div>";
      grouped[cat].forEach(function (entry) {
        var updated = new Date(entry.updatedAt).toLocaleString();
        html += '<div class="wm-entry">';
        html += '<span class="wm-key">' + esc(entry.key) + "</span>";
        html += '<span class="wm-content">' + esc(entry.content) + "</span>";
        html += '<span class="wm-time">' + esc(updated) + "</span>";
        html += "</div>";
      });
      html += "</div>";
    });

    container.innerHTML = html;
  }

  document.getElementById("breadcrumb-back").addEventListener("click", function (e) {
    e.preventDefault();
    stopMemoryAutoRefresh();
    document.getElementById("session-detail").style.display = "none";
    document.getElementById("sessions-list-container").style.display = "";
  });

  function loadSessionDetail(id) {
    document.getElementById("sessions-list-container").style.display = "none";
    document.getElementById("session-detail").style.display = "block";
    document.getElementById("breadcrumb-current").textContent = "Session " + id;

    api("/api/sessions/" + id + "/history").then(function (data) {
      var html = "";
      data.history.forEach(function (msg) {
        html += '<div class="chat-msg">';
        html += '<div class="chat-role ' + esc(msg.role) + '">' + esc(msg.role);
        if (msg.timestamp) {
          html += '<span class="chat-time">' + new Date(msg.timestamp).toLocaleString() + '</span>';
        }
        html += "</div>";
        if (msg.role === "assistant") {
          html += '<div class="chat-content md-content">' + BcMarkdown.render(msg.content) + "</div>";
        } else {
          html += '<div class="chat-content">' + esc(msg.content) + "</div>";
        }
        html += "</div>";
      });
      document.getElementById("session-history").innerHTML = html || "<p>No messages</p>";
    });

    api("/api/sessions/" + id + "/memory").then(function (data) {
      renderWorkingMemory(data);
      if (data.live) {
        startMemoryAutoRefresh(id);
      }
    });

    api("/api/sessions/" + id + "/grants").then(function (data) {
      var grants = data.grants;
      var keys = Object.keys(grants);
      if (keys.length === 0) {
        document.getElementById("session-grants").innerHTML = "<p>No grants</p>";
      } else {
        var html = "";
        keys.forEach(function (cap) {
          html += '<div class="status-row"><span class="status-label">' + esc(cap) + '</span><span class="status-value">' + esc(grants[cap]) + "</span></div>";
        });
        document.getElementById("session-grants").innerHTML = html;
      }
    });
  }

  // ── Logs View ───────────────────────────────────────────────────────────

  var logOffset = 0;
  var logLimit = 50;

  function loadLogs() {
    var params = new URLSearchParams();
    var eventType = document.getElementById("log-event-type").value;
    var component = document.getElementById("log-component").value;
    var search = document.getElementById("log-search").value;

    if (eventType) params.set("eventType", eventType);
    if (component) params.set("component", component);
    if (search) params.set("search", search);
    params.set("limit", logLimit.toString());
    params.set("offset", logOffset.toString());

    api("/api/logs?" + params.toString()).then(function (data) {
      var html = "";
      if (data.logs.length === 0) {
        html = "<p>No log entries</p>";
      } else {
        data.logs.forEach(function (entry) {
          html += '<div class="log-entry">';
          html += '<span class="log-time">' + esc(entry.timestamp || "") + "</span>";
          html += '<span class="log-type">' + esc(entry.eventType || "") + "</span>";
          html += '<span class="log-component">' + esc(entry.component || "") + "</span>";
          html += '<span class="log-payload">' + esc(JSON.stringify(entry.payload || {})) + "</span>";
          html += "</div>";
        });
      }
      document.getElementById("logs-content").innerHTML = html;

      document.getElementById("log-prev").disabled = logOffset === 0;
      document.getElementById("log-next").disabled = logOffset + logLimit >= data.total;
      document.getElementById("log-page-info").textContent =
        (logOffset + 1) + "-" + Math.min(logOffset + logLimit, data.total) + " of " + data.total;
    });
  }

  var logAutoRefreshTimer = null;

  function startLogAutoRefresh() {
    stopLogAutoRefresh();
    logAutoRefreshTimer = setInterval(loadLogs, 3000);
  }

  function stopLogAutoRefresh() {
    if (logAutoRefreshTimer !== null) {
      clearInterval(logAutoRefreshTimer);
      logAutoRefreshTimer = null;
    }
  }

  document.getElementById("log-refresh").addEventListener("click", function () {
    logOffset = 0;
    loadLogs();
  });
  document.getElementById("log-prev").addEventListener("click", function () {
    logOffset = Math.max(0, logOffset - logLimit);
    loadLogs();
  });
  document.getElementById("log-next").addEventListener("click", function () {
    logOffset += logLimit;
    loadLogs();
  });

  // ── Adapters View ───────────────────────────────────────────────────────

  function loadAdapters() {
    api("/api/adapters").then(function (data) {
      var adapters = data.adapters || [];
      var html = "";

      if (adapters.length === 0) {
        html = '<p class="empty-state">No adapters configured. Add adapters in the configuration to connect betterClaws to chat platforms.</p>';
      } else {
        // Show enabled adapters first, then disabled
        var sorted = adapters.slice().sort(function (a, b) {
          if (a.enabled === b.enabled) return a.name.localeCompare(b.name);
          return a.enabled ? -1 : 1;
        });

        sorted.forEach(function (a) {
          var statusClass = a.enabled ? (a.connected ? "connected" : "error") : "disabled";
          var statusText = a.enabled ? (a.connected ? "Connected" : "Error") : "Disabled";
          var typeLabels = { "polling": "Polling", "websocket": "WebSocket", "http-server": "HTTP Server", "internal": "Internal" };

          html += '<div class="adapter-card' + (a.enabled ? "" : " adapter-disabled") + '">';
          html += '<div class="adapter-header">';
          html += '<div class="adapter-title">';
          html += '<span class="adapter-status-dot status-' + statusClass + '"></span>';
          html += '<span class="adapter-name">' + esc(a.name) + '</span>';
          html += '<span class="adapter-type-badge">' + esc(typeLabels[a.type] || a.type) + '</span>';
          html += '</div>';
          html += '<span class="adapter-status-text status-' + statusClass + '">' + esc(statusText) + '</span>';
          html += '</div>';

          html += '<div class="adapter-details">';
          if (a.host || a.port) {
            var binding = '';
            if (a.host) binding += a.host;
            if (a.port) binding += (binding ? ':' : '') + a.port;
            html += '<div class="adapter-detail"><span class="adapter-detail-label">Binding</span><span class="adapter-detail-value">' + esc(binding) + '</span></div>';
          }
          if (a.path) {
            html += '<div class="adapter-detail"><span class="adapter-detail-label">Path</span><span class="adapter-detail-value">' + esc(a.path) + '</span></div>';
          }
          html += '<div class="adapter-detail"><span class="adapter-detail-label">ID</span><span class="adapter-detail-value adapter-id">' + esc(a.id) + '</span></div>';
          html += '</div>';

          // Quick link for webchat
          if (a.id === "webchat" && a.enabled && a.url) {
            html += '<div class="adapter-link">';
            html += '<a href="' + esc(a.url) + '" target="_blank" rel="noopener" class="btn btn-sm btn-primary">Open WebChat</a>';
            html += '</div>';
          }

          html += '</div>';
        });
      }

      document.getElementById("adapters-content").innerHTML = html;
    });
  }

  // ── Suggestions View ────────────────────────────────────────────────────

  var suggestionsFilter = "pending";
  var suggestionsData = [];

  function loadSuggestions() {
    api("/api/suggestions").then(function (data) {
      suggestionsData = data.suggestions || [];
      renderSuggestions();
    });
  }

  function renderSuggestions() {
    var filtered = suggestionsFilter === "all"
      ? suggestionsData
      : suggestionsData.filter(function (s) { return s.status === suggestionsFilter; });

    var html = "";
    if (filtered.length === 0) {
      var msg = suggestionsFilter === "pending"
        ? "No pending suggestions. They'll appear here as betterClaws learns your usage patterns."
        : "No " + suggestionsFilter + " suggestions.";
      html = '<p class="empty-state">' + esc(msg) + "</p>";
    } else {
      filtered.forEach(function (s) {
        var catClass = "cat-" + s.category.replace(/[^a-z]/g, "");
        html += '<div class="suggestion-card suggestion-' + esc(s.status) + '">';
        html += '<div class="suggestion-header">';
        html += '<span class="suggestion-cat ' + catClass + '">' + esc(s.category) + "</span>";
        html += '<span class="suggestion-time">' + new Date(s.createdAt).toLocaleDateString() + "</span>";
        html += "</div>";
        html += '<div class="suggestion-title">' + esc(s.title) + "</div>";
        html += '<div class="suggestion-body">' + esc(s.body) + "</div>";
        html += '<div class="suggestion-actions">';
        if (s.status === "pending") {
          html += '<button class="btn btn-sm btn-primary sug-accept-btn" data-id="' + esc(s.id) + '">Accept</button>';
          html += '<button class="btn btn-sm sug-dismiss-btn" data-id="' + esc(s.id) + '">Dismiss</button>';
        } else if (s.status === "dismissed") {
          html += '<button class="btn btn-sm sug-restore-btn" data-id="' + esc(s.id) + '">Restore</button>';
          html += '<button class="btn btn-sm btn-danger sug-delete-btn" data-id="' + esc(s.id) + '">Delete</button>';
        } else {
          html += '<span class="suggestion-status-label">' + esc(s.status) + "</span>";
          html += '<button class="btn btn-sm btn-danger sug-delete-btn" data-id="' + esc(s.id) + '">Delete</button>';
        }
        html += "</div>";
        html += "</div>";
      });
    }
    document.getElementById("suggestions-content").innerHTML = html;

    // Bind action buttons
    document.querySelectorAll(".sug-accept-btn").forEach(function (btn) {
      btn.addEventListener("click", function () { updateSuggestionStatus(btn.dataset.id, "accepted"); });
    });
    document.querySelectorAll(".sug-dismiss-btn").forEach(function (btn) {
      btn.addEventListener("click", function () { updateSuggestionStatus(btn.dataset.id, "dismissed"); });
    });
    document.querySelectorAll(".sug-restore-btn").forEach(function (btn) {
      btn.addEventListener("click", function () { updateSuggestionStatus(btn.dataset.id, "pending"); });
    });
    document.querySelectorAll(".sug-delete-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (!confirm("Delete this suggestion permanently?")) return;
        fetch("/api/suggestions/" + btn.dataset.id, {
          method: "DELETE",
          headers: authHeaders(),
        }).then(function (r) { return r.json(); }).then(function () { loadSuggestions(); });
      });
    });
  }

  function updateSuggestionStatus(id, status) {
    fetch("/api/suggestions/" + id, {
      method: "PUT",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ status: status }),
    }).then(function (r) { return r.json(); }).then(function (result) {
      if (!result.error) {
        // Update local data
        for (var i = 0; i < suggestionsData.length; i++) {
          if (suggestionsData[i].id === id) {
            suggestionsData[i].status = status;
            suggestionsData[i].updatedAt = Date.now();
            break;
          }
        }
        renderSuggestions();
      }
    });
  }

  // Bind filter buttons
  document.querySelectorAll(".suggestions-filter-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      suggestionsFilter = btn.dataset.filter;
      document.querySelectorAll(".suggestions-filter-btn").forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
      renderSuggestions();
    });
  });

  // ── Tools View ──────────────────────────────────────────────────────────

  function loadTools() {
    api("/api/tools").then(function (data) {
      var html = "";
      if (data.tools.length === 0) {
        html = "<p>No tools registered</p>";
      } else {
        // Group tools by source
        var groups = {};
        var groupOrder = ["built-in", "plugin", "mcp", "skill"];
        var groupLabels = { "built-in": "Built-in Tools", "plugin": "Custom Tools", "mcp": "MCP Server Tools", "skill": "Skill Tools" };

        data.tools.forEach(function (t) {
          var src = t.source || "built-in";
          if (!groups[src]) groups[src] = [];
          groups[src].push(t);
        });

        groupOrder.forEach(function (src) {
          if (!groups[src] || groups[src].length === 0) return;
          html += '<div class="tools-group-header">' + esc(groupLabels[src] || src) + " (" + groups[src].length + ")</div>";
          groups[src].forEach(function (t) {
            var policy = t.policy || "auto";
            var isBuiltIn = src === "built-in";
            html += '<div class="tool-item tool-item-managed" data-policy="' + esc(policy) + '">';
            html += '<div class="tool-info">';
            html += '<div class="tool-name">' + esc(t.name);
            html += '<span class="tool-source-badge source-' + esc(src) + '">' + esc(src) + "</span>";
            html += "</div>";
            html += '<div class="tool-desc">' + esc(t.description) + "</div>";
            html += '<div class="tool-caps">Capabilities: ' + esc(t.capabilities.join(", ") || "none") + "</div>";
            html += "</div>";
            html += '<div class="tool-policy">';
            if (isBuiltIn) {
              html += '<select class="policy-select" data-tool="' + esc(t.name) + '">';
            } else {
              html += '<select class="policy-select" data-tool="' + esc(t.name) + '">';
            }
            html += '<option value="auto"' + (policy === "auto" ? " selected" : "") + '>Execute automatically</option>';
            html += '<option value="confirm"' + (policy === "confirm" ? " selected" : "") + '>Require confirmation</option>';
            html += '<option value="disabled"' + (policy === "disabled" ? " selected" : "") + '>Disabled</option>';
            html += "</select>";
            html += "</div>";
            html += "</div>";
          });
        });
      }
      document.getElementById("tools-content").innerHTML = html;

      // Bind change events
      document.querySelectorAll(".policy-select").forEach(function (sel) {
        sel.addEventListener("change", function () {
          var toolName = sel.dataset.tool;
          var newPolicy = sel.value;
          fetch("/api/tools/policy", {
            method: "POST",
            headers: authHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({ tool: toolName, policy: newPolicy }),
          }).then(function (r) { return r.json(); }).then(function (result) {
            if (result.error) {
              sel.style.borderColor = "#c77272";
            } else {
              sel.style.borderColor = "#6b8f71";
              sel.closest(".tool-item").setAttribute("data-policy", newPolicy);
              setTimeout(function () { sel.style.borderColor = ""; }, 1500);
            }
          });
        });
      });
    });
  }

  // ── Config View ─────────────────────────────────────────────────────────

  var configSchema = null;
  var configData = null;
  var activeConfigSection = null;

  function loadConfig() {
    Promise.all([
      api("/api/config/schema"),
      api("/api/config"),
    ]).then(function (results) {
      configSchema = results[0].sections;
      configData = results[1].config;
      document.getElementById("config-status").textContent = "";

      // Update JSON viewer
      document.getElementById("config-editor").value = JSON.stringify(configData, null, 2);

      // Render tabs
      renderConfigTabs();

      // Show first section or previously active
      if (!activeConfigSection && configSchema.length > 0) {
        activeConfigSection = configSchema[0].key;
      }
      if (activeConfigSection) renderConfigSection(activeConfigSection);
    });
  }

  function renderConfigTabs() {
    var tabsEl = document.getElementById("config-tabs");
    var html = "";
    configSchema.forEach(function (section) {
      var active = section.key === activeConfigSection ? " active" : "";
      html += '<button class="config-tab' + active + '" data-section="' + esc(section.key) + '">' + esc(section.label) + "</button>";
    });
    tabsEl.innerHTML = html;

    tabsEl.querySelectorAll(".config-tab").forEach(function (btn) {
      btn.addEventListener("click", function () {
        activeConfigSection = btn.dataset.section;
        tabsEl.querySelectorAll(".config-tab").forEach(function (b) { b.classList.remove("active"); });
        btn.classList.add("active");
        renderConfigSection(activeConfigSection);
      });
    });
  }

  function renderConfigSection(sectionKey) {
    var section = null;
    for (var i = 0; i < configSchema.length; i++) {
      if (configSchema[i].key === sectionKey) { section = configSchema[i]; break; }
    }
    if (!section) return;

    var sectionData = configData[sectionKey] || {};
    var html = '<p class="config-section-desc">' + esc(section.description) + "</p>";

    section.fields.forEach(function (field) {
      var value = sectionData[field.key];
      html += '<div class="config-field">';
      html += '<div class="config-field-header">';
      html += '<label class="config-field-label" for="cfg-' + esc(field.key) + '">' + esc(field.label) + "</label>";
      if (field.restart) html += '<span class="restart-badge">restart</span>';
      html += "</div>";
      html += '<div class="config-field-desc">' + esc(field.description) + "</div>";

      if (field.type === "boolean") {
        var checked = value === true;
        html += '<div class="toggle-row">';
        html += '<label class="toggle-switch">';
        html += '<input type="checkbox" id="cfg-' + esc(field.key) + '" data-field="' + esc(field.key) + '"' + (checked ? " checked" : "") + ">";
        html += '<span class="toggle-slider"></span>';
        html += "</label>";
        html += '<span class="toggle-label">' + (checked ? "Enabled" : "Disabled") + "</span>";
        html += "</div>";
      } else if (field.type === "select") {
        html += '<select id="cfg-' + esc(field.key) + '" data-field="' + esc(field.key) + '">';
        (field.options || []).forEach(function (opt) {
          html += '<option value="' + esc(opt) + '"' + (String(value) === opt ? " selected" : "") + '>' + esc(opt) + "</option>";
        });
        html += "</select>";
      } else if (field.type === "textarea") {
        html += '<textarea id="cfg-' + esc(field.key) + '" data-field="' + esc(field.key) + '" rows="3" placeholder="' + esc(field.placeholder || "") + '">' + esc(value != null ? String(value) : "") + "</textarea>";
      } else {
        var inputType = field.type === "password" ? "password" : field.type === "number" ? "number" : "text";
        var displayValue = value != null ? String(value) : "";
        var isRedacted = field.type === "password" && typeof value === "string" && value === "[REDACTED]";
        if (isRedacted) {
          displayValue = "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022";
        }
        html += '<input type="' + inputType + '" id="cfg-' + esc(field.key) + '" data-field="' + esc(field.key) + '" value="' + esc(displayValue) + '" placeholder="' + esc(field.placeholder || "") + '"';
        if (field.type === "number") html += ' step="any"';
        if (isRedacted) html += ' data-redacted="true" readonly';
        html += ">";
      }
      html += "</div>";
    });

    document.getElementById("config-section-content").innerHTML = html;

    // Bind toggle label updates
    document.querySelectorAll('#config-section-content .toggle-switch input').forEach(function (cb) {
      cb.addEventListener("change", function () {
        var label = cb.parentElement.parentElement.querySelector(".toggle-label");
        if (label) label.textContent = cb.checked ? "Enabled" : "Disabled";
      });
    });

    // Bind redacted field click-to-edit
    document.querySelectorAll('#config-section-content input[data-redacted="true"]').forEach(function (input) {
      input.addEventListener("focus", function () {
        if (input.dataset.redacted !== "true") return;
        input.value = "";
        input.removeAttribute("readonly");
        input.removeAttribute("data-redacted");
        input.placeholder = "Enter new value";
      });
    });
  }

  function collectSectionValues(sectionKey) {
    var section = null;
    for (var i = 0; i < configSchema.length; i++) {
      if (configSchema[i].key === sectionKey) { section = configSchema[i]; break; }
    }
    if (!section) return null;

    var values = {};
    section.fields.forEach(function (field) {
      var el = document.getElementById("cfg-" + field.key);
      if (!el) return;

      if (field.type === "boolean") {
        values[field.key] = el.checked;
      } else if (field.type === "number") {
        var num = parseFloat(el.value);
        if (!isNaN(num)) values[field.key] = num;
      } else if (field.type === "password") {
        // Skip if still showing redacted placeholder
        if (el.dataset.redacted === "true") return;
        // Only include if user actually typed something
        if (el.value.trim() !== "") values[field.key] = el.value.trim();
      } else {
        values[field.key] = el.value;
      }
    });
    return values;
  }

  document.getElementById("config-save").addEventListener("click", function () {
    saveConfigSection().then(function (result) {
      var statusEl = document.getElementById("config-status");
      statusEl.textContent = "Saved. " + (result.note || "");
      statusEl.className = "config-success";
      setTimeout(function () { statusEl.textContent = ""; }, 4000);
    }).catch(function () {
      // error already displayed by saveConfigSection
    });
  });

  function saveConfigSection() {
    if (!activeConfigSection) return Promise.reject(new Error("No section"));
    var statusEl = document.getElementById("config-status");
    var values = collectSectionValues(activeConfigSection);
    if (!values) return Promise.reject(new Error("No values"));

    statusEl.textContent = "Saving...";
    statusEl.className = "";

    return fetch("/api/config/section/" + activeConfigSection, {
      method: "PUT",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(values),
    }).then(function (r) { return r.json(); }).then(function (result) {
      if (result.error) {
        statusEl.textContent = result.error;
        statusEl.className = "config-error";
        return Promise.reject(new Error(result.error));
      }
      // Update local data
      if (!configData[activeConfigSection]) configData[activeConfigSection] = {};
      Object.assign(configData[activeConfigSection], values);
      document.getElementById("config-editor").value = JSON.stringify(configData, null, 2);
      return result;
    });
  }

  document.getElementById("config-save-restart").addEventListener("click", function () {
    saveConfigSection().then(function () {
      var statusEl = document.getElementById("config-status");
      statusEl.textContent = "Restarting...";
      statusEl.className = "config-success";
      return fetch("/api/restart", {
        method: "POST",
        headers: authHeaders(),
      });
    }).catch(function () {
      // save failed — status already set by saveConfigSection
    });
  });

  document.getElementById("config-toggle-json").addEventListener("click", function () {
    var area = document.getElementById("config-json-area");
    var btn = document.getElementById("config-toggle-json");
    if (area.style.display === "none") {
      area.style.display = "block";
      btn.textContent = "Hide JSON";
    } else {
      area.style.display = "none";
      btn.textContent = "View JSON";
    }
  });

  // ── Schedules View ──────────────────────────────────────────────────────

  var schedEditingId = null; // null = adding, string = editing

  function cronToHuman(cron) {
    var parts = cron.split(" ");
    if (parts.length !== 5) return cron;
    var m = parts[0], h = parts[1], dom = parts[2], mon = parts[3], dow = parts[4];
    if (m === "*" && h === "*") return "Every minute";
    if (h === "*") return "Every hour at :" + m.padStart(2, "0");
    if (dom === "*" && mon === "*" && dow === "*") return "Daily at " + h + ":" + m.padStart(2, "0");
    if (dom === "*" && mon === "*" && dow !== "*") {
      var days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      var d = parseInt(dow, 10);
      var dayName = days[d] || dow;
      return "Every " + dayName + " at " + h + ":" + m.padStart(2, "0");
    }
    return cron;
  }

  function loadSchedules() {
    api("/api/schedules").then(function (data) {
      var html = "";
      if (data.length === 0) {
        html = '<p class="empty-state">No scheduled tasks yet. Click "Add Task" to create one.</p>';
      } else {
        data.forEach(function (s) {
          var nextStr = s.nextFireTime
            ? new Date(s.nextFireTime).toLocaleString()
            : "—";
          var updatedStr = s.updatedAt
            ? new Date(s.updatedAt).toLocaleString()
            : "—";

          html += '<div class="schedule-card' + (s.enabled ? "" : " disabled") + '">';
          html += '<div class="schedule-header">';
          html += '<div class="schedule-title">';
          html += '<span class="schedule-id">#' + esc(s.id || "?") + "</span>";
          html += '<span class="schedule-name">' + esc(s.name) + "</span>";
          html += "</div>";
          html += '<label class="toggle-switch">';
          html += '<input type="checkbox" data-id="' + esc(s.id) + '"' + (s.enabled ? " checked" : "") + ">";
          html += '<span class="toggle-slider"></span>';
          html += "</label>";
          html += "</div>";

          html += '<div class="schedule-body">';
          html += '<div class="schedule-meta">';
          html += '<span class="schedule-cron" title="' + esc(s.cron) + '">' + esc(cronToHuman(s.cron)) + "</span>";
          if (s.enabled) {
            html += '<span class="schedule-next">Next: ' + esc(nextStr) + "</span>";
          }
          html += "</div>";
          html += '<div class="schedule-prompt">' + esc(s.prompt) + "</div>";
          html += '<div class="schedule-footer">';
          html += '<span class="schedule-updated">Updated: ' + esc(updatedStr) + "</span>";
          html += '<div class="schedule-actions">';
          html += '<button class="btn btn-sm sched-edit-btn" data-id="' + esc(s.id) + '" data-name="' + esc(s.name) + '" data-cron="' + esc(s.cron) + '" data-prompt="' + esc(s.prompt) + '">Edit</button>';
          html += '<button class="btn btn-sm btn-danger sched-delete-btn" data-id="' + esc(s.id) + '" data-name="' + esc(s.name) + '">Delete</button>';
          html += "</div>";
          html += "</div>";
          html += "</div>";
          html += "</div>";
        });
      }
      document.getElementById("schedules-content").innerHTML = html;

      // Bind toggle switches
      document.querySelectorAll(".schedule-card input[type=checkbox]").forEach(function (cb) {
        cb.addEventListener("change", function () {
          var id = cb.dataset.id;
          fetch("/api/schedules/" + id, {
            method: "PUT",
            headers: authHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({ enabled: cb.checked }),
          }).then(function (r) { return r.json(); }).then(function () {
            loadSchedules();
          });
        });
      });

      // Bind edit buttons
      document.querySelectorAll(".sched-edit-btn").forEach(function (btn) {
        btn.addEventListener("click", function () {
          schedEditingId = btn.dataset.id;
          document.getElementById("sched-name").value = btn.dataset.name;
          document.getElementById("sched-cron").value = btn.dataset.cron;
          document.getElementById("sched-prompt").value = btn.dataset.prompt;
          document.getElementById("schedule-form").style.display = "block";
          document.getElementById("schedule-add-btn").style.display = "none";
        });
      });

      // Bind delete buttons
      document.querySelectorAll(".sched-delete-btn").forEach(function (btn) {
        btn.addEventListener("click", function () {
          if (!confirm('Delete schedule "' + btn.dataset.name + '"?')) return;
          fetch("/api/schedules/" + btn.dataset.id, {
            method: "DELETE",
            headers: authHeaders(),
          }).then(function (r) { return r.json(); }).then(function () {
            loadSchedules();
          });
        });
      });
    });
  }

  // Add Task button
  document.getElementById("schedule-add-btn").addEventListener("click", function () {
    schedEditingId = null;
    document.getElementById("sched-name").value = "";
    document.getElementById("sched-cron").value = "";
    document.getElementById("sched-prompt").value = "";
    document.getElementById("schedule-form").style.display = "block";
    this.style.display = "none";
    document.getElementById("sched-name").focus();
  });

  // Cancel form
  document.getElementById("sched-cancel").addEventListener("click", function () {
    document.getElementById("schedule-form").style.display = "none";
    document.getElementById("schedule-add-btn").style.display = "";
  });

  // Save form (create or update)
  document.getElementById("sched-save").addEventListener("click", function () {
    var name = document.getElementById("sched-name").value.trim();
    var cron = document.getElementById("sched-cron").value.trim();
    var prompt = document.getElementById("sched-prompt").value.trim();

    if (!name || !cron || !prompt) return;

    var method = schedEditingId ? "PUT" : "POST";
    var url = schedEditingId ? "/api/schedules/" + schedEditingId : "/api/schedules";
    var body = schedEditingId
      ? { name: name, cron: cron, prompt: prompt }
      : { name: name, cron: cron, prompt: prompt, enabled: true };

    fetch(url, {
      method: method,
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    }).then(function (r) { return r.json(); }).then(function (result) {
      if (result.error) {
        alert("Error: " + result.error);
        return;
      }
      document.getElementById("schedule-form").style.display = "none";
      document.getElementById("schedule-add-btn").style.display = "";
      loadSchedules();
    });
  });

  // ── Memory View ─────────────────────────────────────────────────────────

  function loadMemory() {
    var params = new URLSearchParams();
    var category = document.getElementById("mem-category").value;
    var minConf = document.getElementById("mem-confidence").value;

    if (category) params.set("category", category);
    if (minConf) params.set("minConfidence", minConf);

    api("/api/memory?" + params.toString()).then(function (data) {
      var html = "";
      if (data.entries.length === 0) {
        html = "<p>No memory entries</p>";
      } else {
        data.entries.forEach(function (entry) {
          html += '<div class="memory-entry" data-id="' + esc(entry.id || "") + '">';
          html += '<div class="mem-meta">';
          html += '<strong>' + esc(entry.category || "unknown") + "</strong>";
          html += " | confidence: " + (entry.confidence !== undefined ? entry.confidence.toFixed(2) : "?");
          html += " | created: " + new Date(entry.created || 0).toLocaleDateString();
          if (entry.supersedes) html += " | supersedes: " + esc(entry.supersedes);
          html += "</div>";
          html += '<div class="mem-content">' + esc(entry.content || "") + "</div>";
          if (entry.tags && entry.tags.length > 0) {
            html += '<div class="mem-tags">';
            entry.tags.forEach(function (tag) {
              html += '<span class="mem-tag">' + esc(tag) + "</span>";
            });
            html += "</div>";
          }
          html += '<div class="mem-actions">';
          html += '<button class="btn btn-sm mem-edit-btn" '
            + 'data-id="' + esc(entry.id || "") + '" '
            + 'data-content="' + esc(entry.content || "") + '" '
            + 'data-confidence="' + (entry.confidence !== undefined ? entry.confidence : "") + '" '
            + 'data-tags="' + esc((entry.tags || []).join(", ")) + '"'
            + ">Edit</button>";
          html += '<button class="btn btn-sm btn-danger mem-delete-btn" '
            + 'data-id="' + esc(entry.id || "") + '"'
            + ">Delete</button>";
          html += "</div>";
          html += "</div>";
        });
      }
      html += '<p style="margin-top:12px;font-size:12px;color:#9e9891">Total: ' + data.total + " entries</p>";
      document.getElementById("memory-content").innerHTML = html;

      // Bind edit buttons
      document.querySelectorAll(".mem-edit-btn").forEach(function (btn) {
        btn.addEventListener("click", function () {
          document.getElementById("mem-edit-id").value = btn.dataset.id;
          document.getElementById("mem-edit-content").value = btn.dataset.content;
          document.getElementById("mem-edit-confidence").value = btn.dataset.confidence;
          document.getElementById("mem-edit-tags").value = btn.dataset.tags;
          document.getElementById("memory-form").style.display = "block";
        });
      });

      // Bind delete buttons
      document.querySelectorAll(".mem-delete-btn").forEach(function (btn) {
        btn.addEventListener("click", function () {
          if (!confirm("Delete this memory entry?")) return;
          fetch("/api/memory/" + btn.dataset.id, {
            method: "DELETE",
            headers: authHeaders(),
          }).then(function (r) { return r.json(); }).then(function () {
            loadMemory();
          });
        });
      });
    });
  }

  document.getElementById("mem-refresh").addEventListener("click", loadMemory);

  document.getElementById("curation-run").addEventListener("click", function () {
    var btn = document.getElementById("curation-run");
    var original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Running\u2026";

    fetch("/api/curation/run", {
      method: "POST",
      headers: authHeaders(),
    }).then(function (r) { return r.json(); }).then(function (result) {
      btn.disabled = false;
      btn.textContent = original;
      if (result.error) {
        alert("Curation error: " + result.error);
        return;
      }
      var parts = [];
      if (result.distilledSessions) parts.push(result.distilledSessions + " sessions distilled");
      if (result.entriesCreated) parts.push(result.entriesCreated + " entries created");
      if (result.consolidated) parts.push(result.consolidated + " consolidated");
      if (result.decayed) parts.push(result.decayed + " decayed");
      if (result.stale) parts.push(result.stale + " stale");
      if (result.pruned) parts.push(result.pruned + " pruned");
      var summary = parts.length ? parts.join(", ") : "No changes";
      btn.textContent = summary;
      setTimeout(function () { btn.textContent = original; }, 4000);
      loadMemory();
    }).catch(function () {
      btn.disabled = false;
      btn.textContent = original;
      alert("Failed to run curation cycle");
    });
  });

  document.getElementById("mem-cancel").addEventListener("click", function () {
    document.getElementById("memory-form").style.display = "none";
  });

  document.getElementById("mem-save").addEventListener("click", function () {
    var id = document.getElementById("mem-edit-id").value;
    var content = document.getElementById("mem-edit-content").value.trim();
    var confidence = document.getElementById("mem-edit-confidence").value;
    var tagsStr = document.getElementById("mem-edit-tags").value.trim();

    var body = {};
    if (content) body.content = content;
    if (confidence !== "") body.confidence = parseFloat(confidence);
    if (tagsStr) body.tags = tagsStr.split(",").map(function (t) { return t.trim(); }).filter(Boolean);

    fetch("/api/memory/" + id, {
      method: "PUT",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    }).then(function (r) { return r.json(); }).then(function (result) {
      if (result.error) {
        alert("Error: " + result.error);
        return;
      }
      document.getElementById("memory-form").style.display = "none";
      loadMemory();
    });
  });

  // ── Initial load ────────────────────────────────────────────────────────

  var initialHash = location.hash.replace(/^#/, "");
  navigateToView(initialHash || "status");
})();
