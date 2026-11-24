// Operações sobre UM elemento do portal, achado por ref (`data-colmeia-ref`,
// atravessando shadow roots abertas) ou por seletor CSS.
// Injetado como `(<esta função>)(spec)`; spec = { ref?, css?, op, value? }.
//   op "locate"  → rola até o centro e devolve centro/infos (para o clique nativo)
//   op "focus"   → foca e seleciona todo o conteúdo editável (o insertText substitui)
//   op "select"  → escolhe uma opção de <select> por valor ou texto
//   op "value"   → valor atual (input/textarea/select/contenteditable)
//   op "visible" → true se existe e está renderizado
//   op "scroll"  → rola o elemento para o centro da tela
(function (spec) {
  function find(root, ref) {
    var el = root.querySelector('[data-colmeia-ref="' + ref + '"]');
    if (el) return el;
    var every = root.querySelectorAll("*");
    for (var i = 0; i < every.length; i++) {
      if (every[i].shadowRoot) {
        var f = find(every[i].shadowRoot, ref);
        if (f) return f;
      }
    }
    return null;
  }
  var el = null;
  if (spec.ref) {
    el = find(document, spec.ref);
  } else if (spec.css) {
    try { el = document.querySelector(spec.css); }
    catch (e) { return { error: "seletor CSS inválido: " + spec.css }; }
  }
  if (spec.op === "visible") {
    if (!el) return false;
    var vr = el.getBoundingClientRect();
    return vr.width >= 1 && vr.height >= 1 && getComputedStyle(el).visibility !== "hidden";
  }
  if (!el) return { error: "missing" };

  var tag = el.tagName.toLowerCase();
  var type = (el.getAttribute("type") || "").toLowerCase();
  var NOT_TEXT = ["checkbox", "radio", "submit", "button", "reset", "image", "file", "range", "color", "hidden"];
  var editable = el.isContentEditable || tag === "textarea" || (tag === "input" && NOT_TEXT.indexOf(type) < 0);
  var password = tag === "input" && (type === "password" || (el.getAttribute("autocomplete") || "").indexOf("password") >= 0);
  function label() {
    var s = el.getAttribute("aria-label") || el.innerText || el.value || el.getAttribute("placeholder") || el.getAttribute("title") || "";
    s = String(s).replace(/\s+/g, " ").trim();
    return s.length > 60 ? s.slice(0, 59) + "…" : s;
  }
  function valueOf() {
    if (tag === "select") { var o = el.options[el.selectedIndex]; return o ? o.text.trim() : ""; }
    if (el.isContentEditable) return el.innerText;
    return el.value == null ? "" : String(el.value);
  }

  if (spec.op === "locate") {
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    var r = el.getBoundingClientRect();
    var x = r.left + r.width / 2, y = r.top + r.height / 2;
    var top = document.elementFromPoint(x, y);
    var covered = "";
    if (top && top !== el && !el.contains(top) && !top.contains(el)) {
      covered = top.tagName.toLowerCase() + (top.id ? "#" + top.id : "");
    }
    return {
      x: x, y: y, w: r.width, h: r.height, tag: tag, type: type, label: label(),
      editable: editable, select: tag === "select", password: password,
      disabled: !!el.disabled || el.getAttribute("aria-disabled") === "true",
      covered: covered, inView: r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth
    };
  }
  if (spec.op === "focus") {
    if (password) return { error: "password" };
    if (!editable) return { error: "not-editable", tag: tag, type: type };
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    el.focus();
    if (el.isContentEditable) {
      var range = document.createRange();
      range.selectNodeContents(el);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } else if (typeof el.select === "function") {
      el.select();
    }
    return { ok: true, focused: document.activeElement === el || el.contains(document.activeElement) };
  }
  if (spec.op === "select") {
    if (tag !== "select") return { error: "not-select" };
    var want = String(spec.value || "");
    var low = want.trim().toLowerCase();
    var opts = Array.prototype.slice.call(el.options);
    var pick = opts.find(function (o) { return o.value === want; }) ||
      opts.find(function (o) { return o.text.trim().toLowerCase() === low; }) ||
      opts.find(function (o) { return o.text.toLowerCase().indexOf(low) >= 0; });
    if (!pick) return { error: "no-option", options: opts.map(function (o) { return o.text.trim(); }).slice(0, 30) };
    var setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
    setter.call(el, pick.value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, value: pick.text.trim() };
  }
  if (spec.op === "value") {
    return { ok: true, value: password ? "••••" : valueOf() };
  }
  if (spec.op === "scroll") {
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    return { ok: true, label: label() };
  }
  return { error: "op desconhecida: " + spec.op };
})
