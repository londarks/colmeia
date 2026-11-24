// Snapshot do portal: varre o DOM (e shadow roots abertas) atrás de elementos
// interativos visíveis, marca cada um com `data-colmeia-ref="eN"` (estável
// enquanto o documento viver) e devolve linhas compactas + o texto da página.
// Injetado como `(<esta função>)(opts)` via Runtime.evaluate.
(function (opts) {
  var MAX_TEXT = opts.maxText || 4000;
  var MAX_ELS = opts.maxEls || 200;
  var SEL = [
    "a[href]", "button", "input", "select", "textarea", "summary",
    "[role=button]", "[role=link]", "[role=checkbox]", "[role=radio]", "[role=tab]",
    "[role=menuitem]", "[role=menuitemcheckbox]", "[role=option]", "[role=switch]",
    "[role=textbox]", "[role=combobox]", "[role=searchbox]", "[role=slider]",
    "[contenteditable='']", "[contenteditable='true']", "[onclick]",
    "[tabindex]:not([tabindex='-1'])"
  ].join(",");
  var W = window.innerWidth, H = window.innerHeight;
  if (typeof window.__colmeiaSeq !== "number") window.__colmeiaSeq = 0;

  function clean(s, n) {
    s = String(s || "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }
  function q(s) { return JSON.stringify(s); }

  var all = [];
  function walk(root) {
    var found = root.querySelectorAll(SEL);
    for (var i = 0; i < found.length; i++) all.push(found[i]);
    var every = root.querySelectorAll("*");
    for (var j = 0; j < every.length; j++) if (every[j].shadowRoot) walk(every[j].shadowRoot);
  }
  walk(document);

  function visibleRect(el) {
    var r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    var cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || parseFloat(cs.opacity) === 0) return null;
    return r;
  }

  var BUTTON_TYPES = ["submit", "button", "reset", "image"];
  function labelOf(el) {
    var aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria;
    var lb = el.getAttribute("aria-labelledby");
    if (lb) {
      var t = lb.split(/\s+/).map(function (id) {
        var n = document.getElementById(id);
        return n ? (n.innerText || n.textContent || "") : "";
      }).join(" ");
      if (t.trim()) return t;
    }
    var tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      if (el.labels && el.labels.length) {
        var lt = Array.prototype.map.call(el.labels, function (l) { return l.innerText || ""; }).join(" ");
        if (lt.trim()) return lt;
      }
      var type = (el.getAttribute("type") || "").toLowerCase();
      if (tag === "INPUT" && BUTTON_TYPES.indexOf(type) >= 0) return el.value || el.getAttribute("alt") || "";
      return el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name") || "";
    }
    var txt = el.innerText;
    if (txt && txt.trim()) return txt;
    var img = el.querySelector && el.querySelector("img[alt]");
    if (img && img.getAttribute("alt")) return img.getAttribute("alt");
    return el.getAttribute("title") || "";
  }

  function kindOf(el) {
    var tag = el.tagName.toLowerCase();
    var role = el.getAttribute("role");
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "input") {
      var t = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "checkbox" || t === "radio") return t;
      if (BUTTON_TYPES.indexOf(t) >= 0) return "button";
      return "input[" + t + "]";
    }
    if (tag === "select" || tag === "textarea" || tag === "summary") return tag;
    if (role) return role;
    if (el.isContentEditable) return "editable";
    return tag + "(clicável)";
  }

  var lines = [];
  var seen = new Set();
  var count = 0;
  for (var k = 0; k < all.length; k++) {
    var el = all[k];
    if (seen.has(el)) continue;
    seen.add(el);
    var r = visibleRect(el);
    if (!r) continue;
    count++;
    if (lines.length >= MAX_ELS) continue;
    var ref = el.getAttribute("data-colmeia-ref");
    if (!ref) {
      window.__colmeiaSeq += 1;
      ref = "e" + window.__colmeiaSeq;
      el.setAttribute("data-colmeia-ref", ref);
    }
    var line = "@" + ref + " " + kindOf(el);
    var label = clean(labelOf(el), 80);
    if (label) line += " " + q(label);
    var tg = el.tagName;
    if (tg === "INPUT" || tg === "TEXTAREA") {
      var it = (el.type || "").toLowerCase();
      if (it === "checkbox" || it === "radio") line += el.checked ? " [x]" : " [ ]";
      else if (it === "password") line += el.value ? " = \"••••\" (senha)" : " (senha)";
      else if (BUTTON_TYPES.indexOf(it) < 0) line += " = " + q(clean(el.value, 80));
    } else if (tg === "SELECT") {
      var sel = el.options[el.selectedIndex];
      line += " = " + q(sel ? clean(sel.text, 60) : "");
      var names = Array.prototype.slice.call(el.options, 0, 12).map(function (o) { return clean(o.text, 30); });
      line += " opções=" + q(names.join(" | ") + (el.options.length > 12 ? " | …" : ""));
    } else if (el.isContentEditable) {
      line += " = " + q(clean(el.innerText, 80));
    }
    var ac = el.getAttribute("aria-checked");
    if (ac === "true") line += " [x]";
    else if (ac === "false") line += " [ ]";
    if (tg === "A") {
      var href = el.getAttribute("href") || "";
      if (href && href.indexOf("javascript:") !== 0) line += " → " + clean(href, 80);
    }
    if (el.disabled || el.getAttribute("aria-disabled") === "true") line += " (desabilitado)";
    if (el.required) line += " (obrigatório)";
    if (document.activeElement === el) line += " *foco*";
    var inView = r.bottom > 0 && r.right > 0 && r.top < H && r.left < W;
    if (!inView) line += r.top >= H ? " ↓" : (r.bottom <= 0 ? " ↑" : " ↔");
    lines.push(line);
  }

  var raw = document.body ? (document.body.innerText || "") : "";
  var text = raw.split("\n").map(function (l) { return l.replace(/\s+/g, " ").trim(); })
    .filter(function (l) { return l.length > 0; }).join("\n");
  var se = document.scrollingElement || document.documentElement;
  return {
    title: document.title,
    url: location.href,
    w: W,
    h: H,
    sy: Math.round(se.scrollTop),
    sh: Math.round(se.scrollHeight),
    lines: lines,
    count: count,
    text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + "\n…(texto cortado: " + text.length + " caracteres no total)" : text
  };
})
