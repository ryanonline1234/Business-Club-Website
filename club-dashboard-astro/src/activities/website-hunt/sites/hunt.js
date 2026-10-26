/* Website Hunt: the participant bar on each competition site.
   Shows the round, and keeps the team's own list of mistakes on this device.
   It holds no answers. Config comes from:
   <script id="hunt-data" type="application/json">{ "key", "round", "site" }</script> */
(function () {
  var cfgEl = document.getElementById('hunt-data');
  if (!cfgEl) return;

  var cfg;
  try {
    cfg = JSON.parse(cfgEl.textContent);
  } catch (e) {
    return;
  }

  var KEY = 'website-hunt-' + cfg.key;
  var items = load();

  function load() {
    try {
      var v = JSON.parse(localStorage.getItem(KEY));
      return Array.isArray(v) ? v : [];
    } catch (e) {
      return [];
    }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(items)); } catch (e) { /* storage unavailable: the list lasts for this visit */ }
  }

  function el(tag, attrs, html) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { node.setAttribute(k, attrs[k]); });
    if (html != null) node.innerHTML = html;
    return node;
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  document.body.classList.add('lab-has-bar');

  // Bottom bar
  var bar = el('div', { 'class': 'lab-bar', role: 'region', 'aria-label': 'Website Hunt' });
  bar.appendChild(el('span', { 'class': 'lab-tag' }, 'Website Hunt'));
  bar.appendChild(el('span', { 'class': 'lab-title' },
    'Round ' + esc(cfg.round) + ' · <b>' + esc(cfg.site) + '</b> · 12 mistakes hidden'));
  var actions = el('div', { 'class': 'lab-actions' });
  var listBtn = el('button', { type: 'button', 'class': 'lab-btn lab-primary', 'aria-expanded': 'false' });
  var homeBtn = el('a', { 'class': 'lab-btn', href: '../index.html' }, 'All rounds');
  var hideBtn = el('button', { type: 'button', 'class': 'lab-btn', 'aria-label': 'Hide this bar' }, 'Hide bar');
  actions.appendChild(listBtn);
  actions.appendChild(homeBtn);
  actions.appendChild(hideBtn);
  bar.appendChild(actions);

  var pill = el('button', { type: 'button', 'class': 'lab-pill', hidden: '' }, 'Website Hunt &#9650;');

  // Team list panel
  var panel = el('div', { 'class': 'lab-panel', hidden: '', role: 'dialog', 'aria-label': "Your team's list" });
  var head = el('div', { 'class': 'lab-panel-head' });
  head.appendChild(el('h2', null, "Your team's list"));
  var closeBtn = el('button', { type: 'button', 'class': 'lab-btn' }, 'Close');
  head.appendChild(closeBtn);
  panel.appendChild(head);

  var form = el('form', { 'class': 'hunt-form' });
  var input = el('input', { type: 'text', id: 'hunt-input', autocomplete: 'off', maxlength: '160', placeholder: 'Describe a mistake you found', 'aria-label': 'Describe a mistake' });
  var addBtn = el('button', { type: 'submit', 'class': 'lab-btn lab-primary' }, 'Add');
  form.appendChild(input);
  form.appendChild(addBtn);
  panel.appendChild(form);

  var list = el('ol', { 'class': 'hunt-list' });
  panel.appendChild(list);
  var empty = el('p', { 'class': 'hunt-empty' }, 'Nothing yet. Scroll the whole page, click things, and add every mistake you spot.');
  panel.appendChild(empty);

  var foot = el('div', { 'class': 'hunt-foot' });
  foot.appendChild(el('p', { 'class': 'hunt-note' }, 'Saved on this device only. Read your list out when time’s up.'));
  var clearBtn = el('button', { type: 'button', 'class': 'hunt-clear' }, 'Clear list');
  foot.appendChild(clearBtn);
  panel.appendChild(foot);

  document.body.appendChild(panel);
  document.body.appendChild(bar);
  document.body.appendChild(pill);

  function render() {
    list.innerHTML = '';
    items.forEach(function (text, i) {
      var li = el('li');
      li.appendChild(el('span', { 'class': 'lab-num' }, String(i + 1)));
      var t = el('span');
      t.textContent = text;
      li.appendChild(t);
      var del = el('button', { type: 'button', 'class': 'hunt-del', 'aria-label': 'Remove: ' + text }, '&times;');
      del.addEventListener('click', function () {
        items.splice(i, 1);
        save();
        render();
      });
      li.appendChild(del);
      list.appendChild(li);
    });
    empty.hidden = items.length > 0;
    clearBtn.hidden = items.length === 0;
    listBtn.textContent = 'My list (' + items.length + ')';
    clearArmed = false;
    clearBtn.textContent = 'Clear list';
  }

  function fitPanel() {
    var gap = bar.hidden ? 16 : bar.offsetHeight + 12;
    panel.style.bottom = gap + 'px';
    panel.style.maxHeight = 'calc(100vh - ' + (gap + 24) + 'px)';
  }
  function openPanel() {
    fitPanel();
    panel.hidden = false;
    listBtn.setAttribute('aria-expanded', 'true');
    input.focus();
  }
  function closePanel() {
    panel.hidden = true;
    listBtn.setAttribute('aria-expanded', 'false');
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    items.push(text);
    save();
    input.value = '';
    render();
    list.lastElementChild.scrollIntoView({ block: 'nearest' });
    input.focus();
  });

  // Two taps to clear, so nobody wipes the list by accident.
  var clearArmed = false;
  clearBtn.addEventListener('click', function () {
    if (!clearArmed) {
      clearArmed = true;
      clearBtn.textContent = 'Tap again to clear all ' + items.length;
      return;
    }
    items = [];
    save();
    render();
  });

  listBtn.addEventListener('click', function () { if (panel.hidden) openPanel(); else closePanel(); });
  closeBtn.addEventListener('click', closePanel);
  hideBtn.addEventListener('click', function () { bar.hidden = true; pill.hidden = false; closePanel(); });
  pill.addEventListener('click', function () { bar.hidden = false; pill.hidden = true; });
  window.addEventListener('resize', function () { if (!panel.hidden) fitPanel(); });

  render();
})();
