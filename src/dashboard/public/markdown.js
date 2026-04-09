/* eslint-disable */
// BcMarkdown — lightweight markdown-to-HTML renderer (zero dependencies)
// XSS-safe: input is HTML-escaped before any markdown parsing.

window.BcMarkdown = (function () {
  "use strict";

  function esc(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Inline formatting on already-escaped text
  function renderInline(line) {
    // Inline code (must run first to protect contents from further formatting)
    var parts = [];
    var re = /`([^`]+)`/g;
    var last = 0;
    var m;
    while ((m = re.exec(line)) !== null) {
      parts.push(formatRuns(line.slice(last, m.index)));
      parts.push("<code>" + m[1] + "</code>");
      last = re.lastIndex;
    }
    if (parts.length === 0) return formatRuns(line);
    parts.push(formatRuns(line.slice(last)));
    return parts.join("");
  }

  function formatRuns(s) {
    // Bold+italic
    s = s.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
    // Bold
    s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/__(.+?)__/g, "<strong>$1</strong>");
    // Italic
    s = s.replace(/\*(.+?)\*/g, "<em>$1</em>");
    s = s.replace(/_(.+?)_/g, "<em>$1</em>");
    return s;
  }

  function render(raw) {
    if (!raw) return "";
    var escaped = esc(raw);
    var lines = escaped.split("\n");
    var out = [];
    var inCode = false;
    var codeLang = "";
    var codeLines = [];
    var listType = null; // "ul" or "ol"

    function closeList() {
      if (listType) {
        out.push("</" + listType + ">");
        listType = null;
      }
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];

      // Fenced code blocks
      if (!inCode && /^```/.test(line)) {
        closeList();
        inCode = true;
        codeLang = line.slice(3).trim();
        codeLines = [];
        continue;
      }
      if (inCode) {
        if (/^```/.test(line)) {
          var cls = codeLang ? ' class="language-' + codeLang + '"' : "";
          out.push("<pre><code" + cls + ">" + codeLines.join("\n") + "</code></pre>");
          inCode = false;
          codeLang = "";
        } else {
          codeLines.push(line);
        }
        continue;
      }

      // Blank line — close list, add paragraph break
      if (/^\s*$/.test(line)) {
        closeList();
        continue;
      }

      // Headings
      var hm = line.match(/^(#{1,3})\s+(.+)$/);
      if (hm) {
        closeList();
        var level = hm[1].length + 3; // h4, h5, h6
        out.push("<h" + level + ">" + renderInline(hm[2]) + "</h" + level + ">");
        continue;
      }

      // Horizontal rule
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
        closeList();
        out.push("<hr>");
        continue;
      }

      // Unordered list
      var ulm = line.match(/^[\s]*[-*]\s+(.+)$/);
      if (ulm) {
        if (listType !== "ul") {
          closeList();
          listType = "ul";
          out.push("<ul>");
        }
        out.push("<li>" + renderInline(ulm[1]) + "</li>");
        continue;
      }

      // Ordered list
      var olm = line.match(/^[\s]*\d+\.\s+(.+)$/);
      if (olm) {
        if (listType !== "ol") {
          closeList();
          listType = "ol";
          out.push("<ol>");
        }
        out.push("<li>" + renderInline(olm[1]) + "</li>");
        continue;
      }

      // Regular paragraph line
      closeList();
      out.push("<p>" + renderInline(line) + "</p>");
    }

    // Close any open blocks
    if (inCode) {
      var cls = codeLang ? ' class="language-' + codeLang + '"' : "";
      out.push("<pre><code" + cls + ">" + codeLines.join("\n") + "</code></pre>");
    }
    closeList();

    return out.join("\n");
  }

  function StreamRenderer(el) {
    var buffer = "";
    var pending = false;

    function doRender() {
      el.innerHTML = render(buffer);
      el.classList.add("md-content");
      pending = false;
    }

    this.push = function (delta) {
      buffer += delta;
      if (!pending) {
        pending = true;
        requestAnimationFrame(doRender);
      }
    };

    this.flush = function () {
      pending = false;
      doRender();
    };
  }

  return { render: render, StreamRenderer: StreamRenderer };
})();
