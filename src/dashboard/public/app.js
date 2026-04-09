// betterClaws Dashboard — vanilla JS frontend

(function () {
  "use strict";

  // ── Navigation ──────────────────────────────────────────────────────────

  const navBtns = document.querySelectorAll(".nav-btn");
  const views = document.querySelectorAll(".view");

  navBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      var viewName = btn.dataset.view;
      navBtns.forEach(function (b) { b.classList.remove("active"); });
      views.forEach(function (v) { v.classList.remove("active"); });
      btn.classList.add("active");
      document.getElementById("view-" + viewName).classList.add("active");
      stopLogAutoRefresh();
      loadView(viewName);
      if (viewName === "logs") startLogAutoRefresh();
    });
  });

  function loadView(name) {
    switch (name) {
      case "status": loadStatus(); break;
      case "sessions": loadSessions(); break;
      case "logs": loadLogs(); break;
      case "memory": loadMemory(); break;
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
    return div.innerHTML;
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
      document.getElementById("session-detail").style.display = "none";

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

  function loadSessionDetail(id) {
    document.getElementById("session-detail").style.display = "block";

    api("/api/sessions/" + id + "/history").then(function (data) {
      var html = "";
      data.history.forEach(function (msg) {
        html += '<div class="chat-msg">';
        html += '<div class="chat-role ' + esc(msg.role) + '">' + esc(msg.role) + "</div>";
        if (msg.role === "assistant") {
          html += '<div class="chat-content md-content">' + BcMarkdown.render(msg.content) + "</div>";
        } else {
          html += '<div class="chat-content">' + esc(msg.content) + "</div>";
        }
        html += "</div>";
      });
      document.getElementById("session-history").innerHTML = html || "<p>No messages</p>";
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

  // ── Tools View ──────────────────────────────────────────────────────────

  function loadTools() {
    api("/api/tools").then(function (data) {
      var html = "";
      if (data.tools.length === 0) {
        html = "<p>No tools registered</p>";
      } else {
        data.tools.forEach(function (t) {
          var policy = t.policy || "auto";
          html += '<div class="tool-item tool-item-managed">';
          html += '<div class="tool-info">';
          html += '<div class="tool-name">' + esc(t.name) + "</div>";
          html += '<div class="tool-desc">' + esc(t.description) + "</div>";
          html += '<div class="tool-caps">Capabilities: ' + esc(t.capabilities.join(", ") || "none") + "</div>";
          html += "</div>";
          html += '<div class="tool-policy">';
          html += '<select class="policy-select" data-tool="' + esc(t.name) + '">';
          html += '<option value="auto"' + (policy === "auto" ? " selected" : "") + '>Auto</option>';
          html += '<option value="confirm"' + (policy === "confirm" ? " selected" : "") + '>Confirm</option>';
          html += '<option value="disabled"' + (policy === "disabled" ? " selected" : "") + '>Disabled</option>';
          html += "</select>";
          html += "</div>";
          html += "</div>";
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
              sel.style.borderColor = "#f85149";
            } else {
              sel.style.borderColor = "#3fb950";
              setTimeout(function () { sel.style.borderColor = ""; }, 1500);
            }
          });
        });
      });
    });
  }

  // ── Config View ─────────────────────────────────────────────────────────

  function loadConfig() {
    api("/api/config").then(function (data) {
      var editor = document.getElementById("config-editor");
      editor.value = JSON.stringify(data.config, null, 2);
      document.getElementById("config-status").textContent = "";
    });
  }

  document.getElementById("config-save").addEventListener("click", function () {
    var editor = document.getElementById("config-editor");
    var statusEl = document.getElementById("config-status");
    var parsed;

    try {
      parsed = JSON.parse(editor.value);
    } catch (e) {
      statusEl.textContent = "Invalid JSON: " + e.message;
      statusEl.className = "config-error";
      return;
    }

    statusEl.textContent = "Saving...";
    statusEl.className = "";

    fetch("/api/config", {
      method: "PUT",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(parsed),
    }).then(function (r) { return r.json(); }).then(function (result) {
      if (result.error) {
        statusEl.textContent = result.error;
        statusEl.className = "config-error";
      } else {
        statusEl.textContent = "Saved. " + (result.note || "");
        statusEl.className = "config-success";
        setTimeout(function () { statusEl.textContent = ""; }, 4000);
      }
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
          html += '<div class="memory-entry">';
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
          html += "</div>";
        });
      }
      html += '<p style="margin-top:12px;font-size:12px;color:#8b949e">Total: ' + data.total + " entries</p>";
      document.getElementById("memory-content").innerHTML = html;
    });
  }

  document.getElementById("mem-refresh").addEventListener("click", loadMemory);

  // ── Initial load ────────────────────────────────────────────────────────

  loadStatus();
})();
