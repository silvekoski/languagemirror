import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm';

const $ = id => document.getElementById(id);
const css = getComputedStyle(document.documentElement);
const color = key => css.getPropertyValue(`--${key}`).trim();
const fmt = d3.utcFormat('%d %b %Y');
const num = d3.format(',');
let weeks = [], spikes = [], article = null, brush, pulseSvg, selectedWindow = null;
let articleToken = 0, readToken = 0, topToken = 0, searchToken = 0;
let currentA, currentB, moveCursors = () => {};
let readTimer, searchTimer;

async function api(path) {
  const response = await fetch(path);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
function errorAt(id, error) { $(id).textContent = error.message; }
function tip(event, text) {
  const el = $('tooltip');
  el.textContent = text; el.hidden = false;
  el.style.left = `${Math.min(event.clientX + 14, Math.max(8, innerWidth - 290))}px`;
  el.style.top = `${Math.max(8, Math.min(event.clientY + 14, innerHeight - el.offsetHeight - 12))}px`;
}
function hideTip() { $('tooltip').hidden = true; }
function table(id, columns, data) {
  const root = $(id); root.replaceChildren();
  const table = document.createElement('table');
  const head = table.createTHead().insertRow();
  columns.forEach(([label]) => { const th = document.createElement('th'); th.scope = 'col'; th.textContent = label; head.append(th); });
  const body = table.createTBody();
  data.forEach(row => { const tr = body.insertRow(); columns.forEach(([, value]) => { tr.insertCell().textContent = value(row); }); });
  root.append(table);
}
function axes(svg, x, y, width, height, margin) {
  svg.append('g').attr('class', 'grid').attr('transform', `translate(${margin.left},0)`)
    .call(d3.axisLeft(y).ticks(4).tickSize(-(width - margin.left - margin.right)).tickFormat(''));
  svg.append('g').attr('class', 'axis').attr('transform', `translate(0,${height - margin.bottom})`)
    .call(d3.axisBottom(x).ticks(Math.max(3, width / 110)).tickSizeOuter(0));
  svg.append('g').attr('class', 'axis').attr('transform', `translate(${margin.left},0)`)
    .call(d3.axisLeft(y).ticks(4).tickFormat(d3.format('~s')).tickSizeOuter(0));
}
function patterns(svg) {
  const defs = svg.append('defs');
  ['registered', 'anonymous', 'bot'].forEach((key, i) => {
    const p = defs.append('pattern').attr('id', `pattern-${key}`).attr('width', 7).attr('height', 7)
      .attr('patternUnits', 'userSpaceOnUse').attr('patternTransform', `rotate(${i === 1 ? -45 : 45})`);
    p.append('rect').attr('width', 7).attr('height', 7).attr('fill', color(key));
    if (i !== 0) p.append('path').attr('d', 'M0 0V7').attr('stroke', color('surface')).attr('stroke-width', i === 1 ? 2 : 4);
  });
}
function drawPulse() {
  if (!weeks.length) return;
  const root = $('pulse-chart'); root.replaceChildren();
  const width = Math.max(620, root.clientWidth), height = 390;
  const m = {left: 56, right: 24, top: 110, bottom: 34};
  const x = d3.scaleUtc().domain([new Date('2003-01-01Z'), new Date('2027-01-01Z')]).range([m.left, width - m.right]);
  const y = d3.scaleLinear().domain([0, d3.max(weeks, d => d.edits) * 1.08]).nice().range([height - m.bottom, m.top]);
  pulseSvg = d3.select(root).append('svg').attr('viewBox', `0 0 ${width} ${height}`).attr('role', 'img').attr('aria-label', 'Weekly edits from 2003 through 2026; drag horizontally to filter');
  pulseSvg.append('title').text('Weekly edits, stacked by editor type. Reverts use the same edit-count axis.');
  patterns(pulseSvg); axes(pulseSvg, x, y, width, height, m);
  const keys = ['registered', 'anonymous', 'bot'];
  const layers = d3.stack().keys(['registered', 'anon', 'bot'])(weeks);
  pulseSvg.selectAll('.area').data(layers).join('path').attr('class', 'area')
    .attr('fill', (_, i) => $('texture').checked ? `url(#pattern-${keys[i]})` : color(keys[i]))
    .attr('stroke', color('surface')).attr('stroke-width', 1.5)
    .attr('d', d3.area().x(d => x(d.data.date)).y0(d => y(d[0])).y1(d => y(d[1])));
  pulseSvg.append('path').datum(weeks).attr('fill', 'none').attr('stroke', color('revert')).attr('stroke-width', 1.3)
    .attr('d', d3.line().x(d => x(d.date)).y(d => y(d.reverts)));
  // Greedy lane packing: labels never share horizontal space within a lane.
  const occupied = [[], [], [], []];
  for (const spike of spikes) {
    const sx = x(new Date(spike.week));
    const label = spike.title.length > 27 ? `${spike.title.slice(0, 26)}…` : spike.title;
    const len = label.length * 6.3 + 12;
    const left = Math.max(m.left, Math.min(sx - len / 2, width - m.right - len));
    const lane = occupied.findIndex(runs => runs.every(([a, b]) => left + len + 8 < a || left > b + 8));
    if (lane < 0) continue;
    occupied[lane].push([left, left + len]);
    const labelY = 21 + lane * 21;
    const week = weeks.find(d => d.week === spike.week);
    pulseSvg.append('path').attr('d', `M${left + len / 2},${labelY + 5}L${sx},${m.top - 5}L${sx},${y(week?.edits || spike.edits)}`)
      .attr('fill', 'none').attr('stroke', '#71869a').attr('stroke-opacity', .45);
    pulseSvg.append('text').attr('class', 'spike-label').attr('x', left).attr('y', labelY)
      .attr('tabindex', 0).attr('role', 'button').attr('aria-label', `Read ${spike.title}, ${spike.week}, ${spike.edits} edits`)
      .text(label).on('click', () => openArticle(spike.page_id))
      .on('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openArticle(spike.page_id); } })
      .on('pointermove', event => tip(event, `${spike.title}\nWeek of ${spike.week}\n${num(spike.edits)} edits, ${num(spike.reverts)} reverts`)).on('pointerleave', hideTip);
  }
  const cross = pulseSvg.append('line').attr('y1', m.top).attr('y2', height - m.bottom).attr('stroke', color('ink')).attr('stroke-opacity', .5).attr('pointer-events', 'none').attr('display', 'none');
  brush = d3.brushX().extent([[m.left, m.top], [width - m.right, height - m.bottom]])
    .on('end', event => {
      if (!event.sourceEvent) return;
      const [a, b] = event.selection ? event.selection.map(x.invert) : x.domain();
      loadTop(a, b);
    });
  pulseSvg.append('g').attr('class', 'brush').call(brush);
  if (selectedWindow) pulseSvg.select('.brush').call(brush.move, selectedWindow.map(x));
  pulseSvg.on('pointermove', event => {
    const [px, py] = d3.pointer(event);
    if (py < m.top || px < m.left || px > width - m.right) { cross.attr('display', 'none'); return; }
    const index = d3.bisector(d => d.date).center(weeks, x.invert(px));
    const d = weeks[index]; cross.attr('x1', x(d.date)).attr('x2', x(d.date)).attr('display', null);
    tip(event, `Week of ${d.week}\n${num(d.edits)} edits\nRegistered ${num(d.registered)} / Anonymous ${num(d.anon)} / Bot ${num(d.bot)}\n${num(d.reverts)} reverts`);
  }).on('pointerleave', () => { cross.attr('display', 'none'); hideTip(); });
}
async function loadTop(start, end) {
  const token = ++topToken;
  selectedWindow = [start, end];
  $('from-date').value = start.toISOString().slice(0, 10);
  $('to-date').value = end.toISOString().slice(0, 10);
  $('window-label').textContent = `${fmt(start)} – ${fmt(end)} (end exclusive)`;
  $('top-status').textContent = 'Finding the busiest articles…';
  try {
    const data = await api(`/api/seismo/top?${new URLSearchParams({from: start.toISOString(), to: end.toISOString()})}`);
    if (token !== topToken) return;
    $('top-list').replaceChildren();
    data.forEach(d => {
      const li = document.createElement('li'), button = document.createElement('button');
      const title = document.createElement('strong'), sub = document.createElement('small');
      title.textContent = d.title; sub.textContent = `${num(d.edits)} edits · ${num(d.reverts)} reverts · ${Math.round(d.anon_share * 100)}% anonymous`;
      button.append(title, sub); button.onclick = () => openArticle(d.page_id); li.append(button); $('top-list').append(li);
    });
    $('top-status').textContent = data.length ? 'Articles with the most edits' : 'No edits in this window. Try a wider selection.';
  } catch (error) { if (token === topToken) errorAt('top-status', error); }
}
async function openArticle(id) {
  const token = ++articleToken; ++readToken; clearTimeout(readTimer);
  article = null; $('article-panel').hidden = true; $('article-empty').hidden = false;
  $('article-empty').textContent = 'Opening the article history…';
  $('search-results').replaceChildren(); hideTip();
  try {
    const data = await api(`/api/article/${id}/timeline`);
    if (token !== articleToken) return;
    article = data; article.versions.forEach(d => d.date = new Date(d.ts));
    $('article-empty').hidden = true; $('article-panel').hidden = false;
    $('article-title').textContent = article.title;
    $('article-meta').textContent = `${num(article.versions.length)} versions · ${article.has_text ? 'Historical text available' : 'Timeline only: text not loaded yet'}`;
    $('compare').checked = false; $('compare').disabled = !article.has_text;
    $('compare-control').hidden = true;
    currentA = article.versions[0].date; currentB = article.versions.at(-1).date;
    $('cursor-a').value = 0; $('cursor-b').value = 1000;
    drawArticle(); updateDates(); readArticle();
    table('article-table', [['Time (UTC)', d => d.ts], ['User', d => d.user || 'Unknown'], ['Bytes', d => num(d.bytes)], ['Edit type', d => [d.is_revert ? 'Revert' : '', d.anonymous ? 'Anonymous' : '', d.bot ? 'Bot' : ''].filter(Boolean).join(', ') || 'Registered'], ['Summary', d => d.comment || '']], article.versions);
  } catch (error) { if (token === articleToken) errorAt('article-empty', error); }
}
function timeDomain() {
  const first = article.versions[0].date, last = article.versions.at(-1).date;
  return [+first === +last ? new Date(+first - 86400000) : first, last];
}
function updateDates() {
  $('date-a').textContent = fmt(currentA); $('date-b').textContent = fmt(currentB);
  moveCursors();
}
function scheduleRead() { clearTimeout(readTimer); ++readToken; readTimer = setTimeout(readArticle, 180); }
function drawArticle() {
  if (!article) return;
  const root = $('article-chart'); root.replaceChildren();
  const width = Math.max(540, root.clientWidth), height = 230, m = {left: 54, right: 20, top: 22, bottom: 32};
  const x = d3.scaleUtc().domain(timeDomain()).range([m.left, width - m.right]);
  const y = d3.scaleLinear().domain([0, d3.max(article.versions, d => d.bytes) || 1]).nice().range([height - m.bottom, m.top]);
  const svg = d3.select(root).append('svg').attr('viewBox', `0 0 ${width} ${height}`).attr('role', 'img').attr('aria-label', 'Article bytes over time. Drag either time cursor or use the sliders below.');
  axes(svg, x, y, width, height, m);
  svg.append('path').datum(article.versions).attr('fill', 'none').attr('stroke', color('registered')).attr('stroke-width', 2)
    .attr('d', d3.line().curve(d3.curveStepAfter).x(d => x(d.date)).y(d => y(d.bytes)));
  svg.selectAll('.edit').data(article.versions).join('circle').attr('class', 'edit').attr('cx', d => x(d.date)).attr('cy', d => y(d.bytes))
    .attr('r', 4).attr('fill', d => d.anonymous ? color('surface') : d.is_revert ? color('revert') : color('registered'))
    .attr('stroke', d => d.is_revert ? color('revert') : color('registered')).attr('stroke-width', 1.5);
  // A nearest-edit hover layer keeps even dense timelines inspectable.
  const cross = svg.append('line').attr('y1', m.top).attr('y2', height - m.bottom).attr('stroke', color('muted')).attr('stroke-dasharray', '3 3').attr('display', 'none');
  svg.append('rect').attr('x', m.left).attr('y', m.top).attr('width', width - m.left - m.right).attr('height', height - m.top - m.bottom).attr('fill', 'transparent')
    .on('pointermove', event => {
      const d = article.versions[d3.bisector(d => d.date).center(article.versions, x.invert(d3.pointer(event)[0]))];
      cross.attr('x1', x(d.date)).attr('x2', x(d.date)).attr('display', null);
      tip(event, `${fmt(d.date)} · ${d.user || 'Unknown'}\n${num(d.bytes)} bytes${d.is_revert ? ' · Revert' : ''}${d.anonymous ? ' · Anonymous' : ''}\n${d.comment || ''}`);
    }).on('pointerleave', () => { cross.attr('display', 'none'); hideTip(); })
    .on('click', event => { currentB = x.invert(Math.max(m.left, Math.min(width - m.right, d3.pointer(event)[0]))); syncSlider('b'); updateDates(); scheduleRead(); });
  const cursorGroups = {};
  for (const which of ['a', 'b']) {
    const g = svg.append('g').style('cursor', 'ew-resize'); cursorGroups[which] = g;
    g.append('line').attr('y1', m.top).attr('y2', height - m.bottom).attr('stroke', color('ink')).attr('stroke-width', 1.5).attr('stroke-dasharray', which === 'a' ? '5 4' : null);
    g.append('rect').attr('x', -12).attr('y', m.top - 12).attr('width', 24).attr('height', height - m.top - m.bottom + 12).attr('fill', 'transparent');
    g.append('path').attr('d', 'M-6,8L0,15L6,8Z').attr('fill', color('ink'));
    g.call(d3.drag().on('start', hideTip).on('drag', event => {
      const at = x.invert(Math.max(m.left, Math.min(width - m.right, event.x)));
      if (which === 'a') currentA = at; else currentB = at;
      syncSlider(which); updateDates(); scheduleRead();
    }).on('end', scheduleRead));
  }
  moveCursors = () => {
    cursorGroups.a.attr('transform', `translate(${x(currentA)},0)`).attr('display', $('compare').checked ? null : 'none');
    cursorGroups.b.attr('transform', `translate(${x(currentB)},0)`);
  };
  moveCursors();
}
function syncSlider(which) {
  const [a, b] = timeDomain();
  $(`cursor-${which}`).value = Math.round(1000 * ((which === 'a' ? currentA : currentB) - a) / (b - a));
}
async function readArticle() {
  if (!article) return;
  const token = ++readToken, id = article.page_id;
  $('article-text').replaceChildren(); $('revision-link').hidden = true;
  if (!article.has_text) { $('read-status').textContent = 'Text is not loaded for this article. You can still explore every edit above.'; return; }
  $('read-status').textContent = 'Reading from the historical record…';
  try {
    if ($('compare').checked) {
      const a = new Date(Math.min(currentA, currentB)), b = new Date(Math.max(currentA, currentB));
      const diff = await api(`/api/article/${id}/diff?${new URLSearchParams({a: a.toISOString(), b: b.toISOString()})}`);
      if (token !== readToken) return;
      diff.forEach(d => {
        const el = document.createElement('div'); el.className = `diff-block ${d.op}`;
        el.textContent = (d.op === 'insert' ? '+ Added\n' : d.op === 'delete' ? '− Removed\n' : '') + d.text;
        $('article-text').append(el);
      });
      $('read-status').textContent = `${fmt(a)} → ${fmt(b)} · additions and removals`;
    } else {
      const data = await api(`/api/article/${id}/asof?${new URLSearchParams({t: currentB.toISOString()})}`);
      if (token !== readToken) return;
      $('article-text').textContent = data.text || 'This revision has no readable text after cleaning.';
      $('read-status').textContent = `${fmt(new Date(data.row_start))} · ${data.user || 'Unknown editor'}`;
      $('revision-link').href = `https://fi.wikipedia.org/?oldid=${data.rev_id}`; $('revision-link').hidden = false;
    }
  } catch (error) { if (token === readToken) errorAt('read-status', error); }
}
for (const which of ['a', 'b']) $(`cursor-${which}`).addEventListener('input', () => {
  if (!article) return;
  const [a, b] = timeDomain(), at = new Date(+a + ($(`cursor-${which}`).value / 1000) * (b - a));
  if (which === 'a') currentA = at; else currentB = at;
  updateDates(); scheduleRead();
});
$('compare').onchange = () => { $('compare-control').hidden = !$('compare').checked; moveCursors(); scheduleRead(); };
$('reset').onclick = () => { if (pulseSvg && brush) pulseSvg.select('.brush').call(brush.move, null); loadTop(new Date('2003-01-01Z'), new Date('2027-01-01Z')); };
$('window-form').onsubmit = event => {
  event.preventDefault();
  const start = new Date(`${$('from-date').value}T00:00:00Z`), end = new Date(`${$('to-date').value}T00:00:00Z`);
  if (!(start < end)) { $('window-error').textContent = 'Choose an end date after the start.'; return; }
  $('window-error').textContent = ''; loadTop(start, end); drawPulse();
};
$('texture').onchange = drawPulse;
$('search-form').onsubmit = event => { event.preventDefault(); $('search-results').querySelector('button')?.click(); };
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer); const token = ++searchToken, q = $('search').value.trim();
  $('search-results').replaceChildren(); if (!q) return;
  searchTimer = setTimeout(async () => {
    try {
      const data = await api(`/api/article/search?${new URLSearchParams({q})}`);
      if (token !== searchToken) return;
      $('search-results').replaceChildren();
      data.forEach(d => { const button = document.createElement('button'); button.type = 'button'; button.textContent = `${d.title} (${num(d.versions)} edits)`; button.onclick = () => openArticle(d.page_id); $('search-results').append(button); });
      if (!data.length) $('search-results').textContent = 'No matching articles. Try another title.';
    } catch (error) { if (token === searchToken) errorAt('search-results', error); }
  }, 230);
});
$('search').onkeydown = event => { if (event.key === 'Escape') { ++searchToken; $('search-results').replaceChildren(); } };
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { drawPulse(); drawArticle(); }, 150); });
async function init() {
  loadTop(new Date('2003-01-01Z'), new Date('2027-01-01Z'));
  openArticle(1256);
  try {
    const [pulse, annotations] = await Promise.all([api('/api/seismo/pulse'), api('/api/seismo/spikes?n=40')]);
    weeks = pulse.map(d => ({...d, date: new Date(d.week)})); spikes = annotations;
    drawPulse();
    table('pulse-table', [['Week', d => d.week], ['Edits', d => num(d.edits)], ['Registered', d => num(d.registered)], ['Anonymous', d => num(d.anon)], ['Bot', d => num(d.bot)], ['Reverts', d => num(d.reverts)]], weeks);
  } catch (error) { errorAt('pulse-status', error); }
}
init();
