/* Website Lab presenter tools.
   Each demo page includes a <script id="lab-data" type="application/json"> block:
   { "mode": "bad" | "good", "round": 1, "site": "...", "pair": "file.html",
     "items": [{ "n": 1, "title": "...", "why": "...", "fix": "..." }] }
   Elements on the page that match an item carry data-lab="<n>".
   Press R to reveal or hide the answers. */
(function () {
  var dataEl = document.getElementById('lab-data');
  if (!dataEl) return;

  var data;
  try {
    data = JSON.parse(dataEl.textContent);
  } catch (e) {
    return;
  }

  var isBad = data.mode === 'bad';
  var count = data.items.length;
  var revealLabel = isBad ? 'Show the ' + count + ' mistakes' : 'Show what we fixed';
  var hideLabel = isBad ? 'Hide mistakes' : 'Hide fixes';

  document.body.classList.add('lab-has-bar');
  if (!isBad) document.body.classList.add('lab-good-mode');

  function el(tag, attrs, html) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) { node.setAttribute(k, attrs[k]); });
    }
    if (html != null) node.innerHTML = html;
    return node;
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // Bottom bar
  var bar = el('div', { 'class': 'lab-bar', role: 'region', 'aria-label': 'Website Lab presenter tools' });
  bar.appendChild(el('span', { 'class': 'lab-tag' }, 'Website Lab'));
  bar.appendChild(el('span', { 'class': 'lab-title' },
    'Round ' + esc(data.round) + ' · <b>' + esc(data.site) + '</b> · ' +
    (isBad ? 'the <b>bad</b> version' : 'the <b>fixed</b> version')));

  var actions = el('div', { 'class': 'lab-actions' });
  var revealBtn = el('button', { type: 'button', 'class': 'lab-btn lab-primary', 'aria-pressed': 'false' }, revealLabel);
  var pairBtn = el('a', { 'class': 'lab-btn', href: data.pair },
    isBad ? 'See the fixed version &rarr;' : '&larr; Back to the bad version');
  var homeBtn = el('a', { 'class': 'lab-btn', href: '../index.html' }, 'All sites');
  var hideBtn = el('button', { type: 'button', 'class': 'lab-btn', 'aria-label': 'Hide the presenter bar' }, 'Hide bar');
  actions.appendChild(revealBtn);
  actions.appendChild(pairBtn);
  actions.appendChild(homeBtn);
  actions.appendChild(hideBtn);
  bar.appendChild(actions);

  var pill = el('button', { type: 'button', 'class': 'lab-pill', hidden: '' }, 'Website Lab &#9650;');

  // Answer panel
  var panel = el('div', { 'class': 'lab-panel' + (isBad ? '' : ' lab-good'), hidden: '', role: 'dialog', 'aria-label': revealLabel });
  var head = el('div', { 'class': 'lab-panel-head' });
  head.appendChild(el('h2', null, isBad ? count + ' mistakes on this site' : 'What the fixed version does right'));
  var closeBtn = el('button', { type: 'button', 'class': 'lab-btn' }, 'Close');
  head.appendChild(closeBtn);
  panel.appendChild(head);

  var list = el('ol');
  data.items.forEach(function (item) {
    var li = el('li', { 'class': 'lab-item', tabindex: '0', 'data-n': item.n });
    var body = '<h3>' + esc(item.title) + '</h3>';
    if (item.why) body += '<p><b>' + (isBad ? 'Why it hurts: ' : 'Why it works: ') + '</b>' + esc(item.why) + '</p>';
    if (item.fix) body += '<p><b>Fix: </b>' + esc(item.fix) + '</p>';
    if (!document.querySelector('[data-lab="' + item.n + '"]')) {
      body += '<span class="lab-noel">Applies to the whole site</span>';
    }
    li.innerHTML = '<span class="lab-num">' + esc(item.n) + '</span><div>' + body + '</div>';
    li.addEventListener('click', function () { focusItem(item.n); });
    li.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); focusItem(item.n); }
    });
    list.appendChild(li);
  });
  panel.appendChild(list);

  var layer = el('div', { 'class': 'lab-layer', 'aria-hidden': 'true' });

  document.body.appendChild(layer);
  document.body.appendChild(panel);
  document.body.appendChild(bar);
  document.body.appendChild(pill);

  var revealed = false;

  function inFixed(node) {
    while (node && node !== document.body) {
      if (getComputedStyle(node).position === 'fixed') return true;
      node = node.parentElement;
    }
    return false;
  }

  function placeBadges() {
    layer.innerHTML = '';
    if (!revealed) return;
    var used = {};
    var placed = [];
    document.querySelectorAll('[data-lab]').forEach(function (target) {
      var n = target.getAttribute('data-lab');
      if (used[n]) return; // one badge per item
      var r = target.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return; // hidden (e.g. a closed pop-up)
      used[n] = true;
      var fixed = inFixed(target);
      var x = r.left + (fixed ? 0 : window.scrollX);
      var y = r.top + (fixed ? 0 : window.scrollY);
      x = Math.max(x, 16);
      y = Math.max(y, 16);
      // Nudge right when two items start at the same corner.
      while (placed.some(function (p) { return p.fixed === fixed && Math.abs(p.x - x) < 30 && Math.abs(p.y - y) < 30; })) x += 34;
      placed.push({ x: x, y: y, fixed: fixed });
      var badge = el('span', { 'class': 'lab-badge' + (fixed ? ' lab-fixed' : '') }, esc(n));
      badge.style.left = x + 'px';
      badge.style.top = y + 'px';
      badge.addEventListener('click', function () { openPanel(); highlightItem(n); });
      layer.appendChild(badge);
    });
  }

  function fitPanel() {
    panel.style.bottom = (bar.hidden ? 16 : bar.offsetHeight + 12) + 'px';
    panel.style.maxHeight = 'calc(100vh - ' + ((bar.hidden ? 16 : bar.offsetHeight + 12) + 24) + 'px)';
  }

  function openPanel() { fitPanel(); panel.hidden = false; }

  function highlightItem(n) {
    var li = list.querySelector('[data-n="' + n + '"]');
    if (li) { li.scrollIntoView({ block: 'nearest' }); li.focus(); }
  }

  function focusItem(n) {
    var target = document.querySelector('[data-lab="' + n + '"]');
    if (!target) return;
    var r = target.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.remove('lab-flash');
    void target.offsetWidth;
    target.classList.add('lab-flash');
  }

  function setRevealed(on) {
    revealed = on;
    document.body.classList.toggle('lab-reveal', on);
    revealBtn.textContent = on ? hideLabel : revealLabel;
    revealBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (on) openPanel(); else panel.hidden = true;
    placeBadges();
  }

  revealBtn.addEventListener('click', function () { setRevealed(!revealed); });
  closeBtn.addEventListener('click', function () { panel.hidden = true; });
  hideBtn.addEventListener('click', function () { bar.hidden = true; pill.hidden = false; panel.hidden = true; });
  pill.addEventListener('click', function () { bar.hidden = false; pill.hidden = true; });

  document.addEventListener('keydown', function (e) {
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    if ((e.key === 'r' || e.key === 'R') && !e.metaKey && !e.ctrlKey && !e.altKey) setRevealed(!revealed);
  });

  var raf = 0;
  function schedule() {
    if (!revealed || raf) return;
    raf = requestAnimationFrame(function () { raf = 0; placeBadges(); });
  }
  window.addEventListener('resize', function () { if (!panel.hidden) fitPanel(); schedule(); });
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('load', schedule);
  // Pages change themselves (pop-ups closing, banners loading), so re-place now and then.
  setInterval(schedule, 800);
})();
