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
      loadView(viewName);
    });
  });

  function loadView(name) {
    switch (name) {
      case "status": loadStatus(); break;
      case "sessions": loadSessions(); break;
      case "logs": loadLogs(); break;
      case "memory": loadMemory(); break;
    }
  }

  // ── Fetch helper ────────────────────────────────────────────────────────

  function api(path) {
    return fetch(path).then(function (r) { return r.json(); });
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

    api("/api/tools").then(function (data) {
      var html = "";
      if (data.tools.length === 0) {
        html = "<p>No tools registered</p>";
      } else {
        data.tools.forEach(function (t) {
          html += '<div class="tool-item">';
          html += '<div class="tool-name">' + esc(t.name) + "</div>";
          html += '<div class="tool-desc">' + esc(t.description) + "</div>";
          html += '<div class="tool-caps">Capabilities: ' + esc(t.capabilities.join(", ") || "none") + "</div>";
          html += "</div>";
        });
      }
      document.getElementById("tools-content").innerHTML = html;
    });

    api("/api/config").then(function (data) {
      document.getElementById("config-content").innerHTML = "<pre>" + esc(JSON.stringify(data.config, null, 2)) + "</pre>";
    });
  }

  // ── Sessions View ───────────────────────────────────────────────────────

  function loadSessions() {
    api("/api/sessions").then(function (data) {
      var html = "";
      if (data.sessions.length === 0) {
        html = "<p>No active sessions</p>";
      } else {
        data.sessions.forEach(function (id) {
          html += '<div class="session-item" data-id="' + esc(id) + '">' + esc(id) + "</div>";
        });
      }
      document.getElementById("sessions-list").innerHTML = html;
      document.getElementById("session-detail").style.display = "none";

      document.querySelectorAll(".session-item").forEach(function (el) {
        el.addEventListener("click", function () {
          loadSessionDetail(el.dataset.id);
        });
      });
    });
  }

  function loadSessionDetail(id) {
    document.getElementById("session-detail").style.display = "block";

    api("/api/sessions/" + id + "/history").then(function (data) {
      var html = "";
      data.history.forEach(function (msg) {
        html += '<div class="chat-msg">';
        html += '<div class="chat-role ' + esc(msg.role) + '">' + esc(msg.role) + "</div>";
        html += '<div class="chat-content">' + esc(msg.content) + "</div>";
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
