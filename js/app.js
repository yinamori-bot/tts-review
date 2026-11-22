import * as db from './db.js';

// ---------------------------------------------------------------- 小道具
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = t => { t = Math.max(0, t || 0); const m = Math.floor(t / 60), s = Math.floor(t % 60); return `${m}:${String(s).padStart(2, '0')}`; };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
let toastTimer;
function toast(msg, ms = 2600) {
  const el = $('toast'); el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.hidden = true, ms);
}

const STAGE = { new: '未送付', sent: 'Macの返事待ち', answered: '返事あり', done: '済み' };
const STAGE_RANK = { new: 4, answered: 3, sent: 2, done: 1 };

const settings = Object.assign({ delay: 1, skip: 5, theme: '', rate: 1 }, db.load('settings', {}));
function saveSettings() { db.save('settings', settings); }
function applyTheme() { if (settings.theme) document.documentElement.dataset.theme = settings.theme; else delete document.documentElement.dataset.theme; }
applyTheme();

// ---------------------------------------------------------------- 状態
const audio = $('audio');
const altAudio = new Audio();
let ch = null;            // 開いている講
let issues = [];          // その講の指摘
let alts = new Map();     // issueId -> [代案]
let audioURL = null;
let curIdx = -1;
let unitEls = [];
let manualScrollAt = 0;
let seg = null;           // { end, then } 範囲再生
let filter = 'open';
let altURLs = new Map();

// ---------------------------------------------------------------- 一覧
async function renderHome() {
  const list = (await db.all('chapters')).sort((a, b) => a.id.localeCompare(b.id, 'ja'));
  const allIssues = await db.all('issues');
  const box = $('chapters');
  if (!list.length) {
    box.innerHTML = '<p class="muted card">まだ講がありません。上の「ファイルを選ぶ」から取り込んでください。</p>';
  } else {
    box.innerHTML = list.map(c => {
      const mine = allIssues.filter(i => i.chapter === c.id);
      const n = k => mine.filter(i => i.stage === k).length;
      const pos = db.load('pos:' + c.id, 0);
      const pct = c.duration ? Math.min(100, pos / c.duration * 100) : 0;
      const b = [];
      if (c.passed) b.push('<span class="badge b-pass">合格</span>');
      if (n('new')) b.push(`<span class="badge b-new">未送付 ${n('new')}</span>`);
      if (n('answered')) b.push(`<span class="badge b-ans">返事あり ${n('answered')}</span>`);
      if (n('sent')) b.push(`<span class="badge b-sent">返事待ち ${n('sent')}</span>`);
      if (n('done')) b.push(`<span class="badge b-done">済み ${n('done')}</span>`);
      return `<button class="chap" data-id="${esc(c.id)}">
        <b>${esc(c.title)}</b>
        <div class="meta">${esc(c.heading || '')}</div>
        <div class="meta">${fmt(c.duration)}・${c.units.length}文${c.hasAudio ? '' : '・<span style="color:var(--flag)">音がまだありません</span>'}</div>
        <div class="badges">${b.join('')}</div>
        <div class="bar"><i style="width:${pct}%"></i></div>
      </button>`;
    }).join('');
  }
  box.querySelectorAll('.chap').forEach(el => el.onclick = () => openChapter(el.dataset.id));
  try {
    const e = await navigator.storage?.estimate?.();
    if (e) $('storage-info').textContent = `保存している量: ${(e.usage / 1048576).toFixed(0)} MB`;
  } catch {}
}

$('set-delay').value = String(settings.delay);
$('set-skip').value = String(settings.skip);
$('set-theme').value = settings.theme;
$('set-delay').onchange = e => { settings.delay = +e.target.value; saveSettings(); };
$('set-skip').onchange = e => { settings.skip = +e.target.value; saveSettings(); setSkipLabels(); };
$('set-theme').onchange = e => { settings.theme = e.target.value; saveSettings(); applyTheme(); };
function setSkipLabels() { $('rew').querySelector('small').textContent = settings.skip; $('fwd').querySelector('small').textContent = settings.skip; }
setSkipLabels();

// ---------------------------------------------------------------- 取り込み
$('import').onchange = async e => {
  const files = [...e.target.files]; e.target.value = '';
  if (!files.length) return;
  db.persist();
  const msgs = [];
  const jsons = [], audios = [];
  for (const f of files) {
    if (/\.json$/i.test(f.name) || f.type === 'application/json') jsons.push(f); else audios.push(f);
  }
  const parsed = [];
  for (const f of jsons) {
    try { parsed.push({ f, d: JSON.parse(await f.text()) }); }
    catch { msgs.push(`${f.name}: 読めませんでした`); }
  }
  // 講の情報 → 音 → 返事 の順に入れる
  for (const { f, d } of parsed.filter(p => p.d.format === 'tts-review/chapter')) msgs.push(await importChapter(d));
  for (const f of audios) msgs.push(await importAudio(f));
  for (const { f, d } of parsed.filter(p => p.d.format === 'tts-review/reply')) msgs.push(await importReply(d));
  for (const { f, d } of parsed.filter(p => !['tts-review/chapter', 'tts-review/reply'].includes(p.d.format)))
    msgs.push(`${f.name}: このアプリのファイルではありません`);
  toast(msgs.filter(Boolean).join('\n'), 5000);
  if (ch) await openChapter(ch.id, true); else renderHome();
};

async function importChapter(d) {
  const old = await db.get('chapters', d.id);
  const c = {
    id: d.id, title: d.title, heading: d.heading, album: d.album, artist: d.artist,
    audioId: d.audioId, audioFile: d.audioFile, audioSize: d.audioSize, duration: d.duration,
    units: d.units, importedAt: new Date().toISOString(),
    hasAudio: false, passed: old?.passed || false, prevAudioId: null,
  };
  if (old && old.audioId === d.audioId) { c.hasAudio = old.hasAudio; c.prevAudioId = old.prevAudioId; }
  else if (old) {
    c.prevAudioId = old.audioId;
    // 文の並びが変わっても、前の指摘が同じ文を指すように付け直す
    for (const i of await db.byIndex('issues', 'chapter', d.id)) {
      if (d.units[i.unit]?.display === i.unitText) continue;
      let best = -1, dist = 1e9;
      d.units.forEach((u, k) => { if (u.display === i.unitText && Math.abs(k - i.unit) < dist) { best = k; dist = Math.abs(k - i.unit); } });
      if (best >= 0) { i.unit = best; await db.put('issues', i); }
    }
  }
  await db.put('chapters', c);
  return old && old.audioId !== d.audioId ? `${d.title}: 新しい版の情報を入れました` : `${d.title}: 文 ${d.units.length} 個`;
}

async function importAudio(f) {
  const list = await db.all('chapters');
  const c = list.find(c => c.audioFile === f.name) || list.find(c => c.audioFile.normalize('NFC') === f.name.normalize('NFC'));
  if (!c) return `${f.name}: 合う講の .json が見つかりません（.json も一緒に選んでください）`;
  if (c.audioSize && f.size !== c.audioSize) return `${f.name}: .json と版が違います（大きさが合わない）。新しい .json も選んでください`;
  await db.put('audio', { id: c.id, blob: f, audioId: c.audioId });
  c.hasAudio = true; await db.put('chapters', c);
  return `${c.title}: 音を入れました（${(f.size / 1048576).toFixed(1)} MB）`;
}

async function importReply(d) {
  let n = 0, na = 0;
  for (const it of d.items || []) {
    const i = await db.get('issues', it.issue);
    if (!i) continue;
    i.replies = i.replies || [];
    if (!i.replies.some(r => r.id === it.id)) i.replies.push({ id: it.id || uid(), at: d.created, note: it.note || '', status: it.status || 'alts' });
    for (const a of it.alts || []) {
      if (await db.get('alts', a.id)) continue;
      const blob = await (await fetch(`data:${a.mime || 'audio/mp4'};base64,${a.data}`)).blob();
      await db.put('alts', { id: a.id, issue: i.id, label: a.label || '代案', note: a.note || '', dur: a.dur || 0, blob, created: d.created });
      na++;
    }
    if ((it.alts || []).length && i.decision?.choice === 'none') {
      (i.pastDecisions = i.pastDecisions || []).push(i.decision); i.decision = null;
    }
    if (it.status === 'fixed') { i.stage = 'done'; i.resolution = i.resolution || 'fixed'; }
    else if (i.stage !== 'done') i.stage = 'answered';
    i.updated = new Date().toISOString();
    await db.put('issues', i); n++;
  }
  return `返事を入れました: 指摘 ${n} 件・代案 ${na} 本`;
}

// ---------------------------------------------------------------- 講を開く
async function openChapter(id, keepView = false) {
  const c = await db.get('chapters', id);
  if (!c) return;
  const same = ch && ch.id === id && ch.audioId === c.audioId && audioURL;
  ch = c;
  issues = await db.byIndex('issues', 'chapter', id);
  alts = new Map();
  for (const a of await db.all('alts')) {
    if (!issues.some(i => i.id === a.issue)) continue;
    if (!alts.has(a.issue)) alts.set(a.issue, []);
    alts.get(a.issue).push(a);
  }
  $('title').textContent = c.title;
  $('back').hidden = false; $('tabs').hidden = false;
  $('v-home').hidden = true; $('v-chapter').hidden = false;
  $('passed').checked = !!c.passed;
  const warn = $('ver-warn');
  if (c.prevAudioId) { warn.hidden = false; warn.textContent = '音が新しい版になりました。前の版での指摘には「前の版」と出ます。直ったか聞いて確かめてください。'; }
  else warn.hidden = true;
  if (!same) {
    renderUnits();
    if (audioURL) { URL.revokeObjectURL(audioURL); audioURL = null; }
    const a = await db.get('audio', id);
    if (a) {
      audioURL = URL.createObjectURL(a.blob);
      audio.src = audioURL;
      audio.playbackRate = settings.rate;
      const pos = db.load('pos:' + id, 0);
      pendingSeek = pos;
      audio.addEventListener('loadedmetadata', () => { audio.playbackRate = settings.rate; }, { once: true });
      $('player').hidden = false; document.body.classList.add('has-player');
      setMediaSession();
    } else {
      audio.removeAttribute('src');
      $('player').hidden = true; document.body.classList.remove('has-player');
      toast('この講の音がまだありません。.m4a を取り込んでください', 4000);
    }
  } else markDots();
  renderIssues();
  if (!keepView) showTab('text');
  history.replaceState(null, '', '#' + encodeURIComponent(id));
}

function goHome() {
  if (ch) savePos();
  audio.pause(); altAudio.pause();
  ch = null; curIdx = -1;
  $('title').textContent = '読み上げ修正';
  $('back').hidden = true; $('tabs').hidden = true;
  $('v-home').hidden = false; $('v-chapter').hidden = true;
  $('player').hidden = true; document.body.classList.remove('has-player');
  history.replaceState(null, '', location.pathname);
  renderHome();
}
$('back').onclick = goHome;

function showTab(t) {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  $('v-text').hidden = t !== 'text'; $('v-issues').hidden = t !== 'issues';
  if (t === 'text' && curIdx >= 0) scrollToCur(true);
}
document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => showTab(b.dataset.tab));

// ---------------------------------------------------------------- 本文
function renderUnits() {
  const box = $('units');
  box.innerHTML = ch.units.map((u, k) =>
    `<div class="u ${u.kind}" data-k="${k}"><i class="mk"></i><span class="tm">${fmt(u.t0)}</span>${esc(u.display)}<i class="dot"></i></div>`).join('');
  unitEls = [...box.children];
  curIdx = -1;
  loadMarks();
  markDots();
}

// 左の印: 聞きながら「あとで指摘する」文に付けておく。指摘を保存するとその文の印は消える。
// 版が変わっても付け直せるよう、文の番号と倉庫のキーを一緒に覚える。
let marks = new Set();
function loadMarks() {
  marks = new Set();
  for (const m of db.load('marks:' + ch.id, [])) {
    if (ch.units[m.k]?.key === m.key) { marks.add(m.k); continue; }
    let best = -1;
    ch.units.forEach((u, k) => { if (u.key === m.key && (best < 0 || Math.abs(k - m.k) < Math.abs(best - m.k))) best = k; });
    if (best >= 0) marks.add(best);
  }
  saveMarks();
}
function saveMarks() {
  db.save('marks:' + ch.id, [...marks].sort((a, b) => a - b).map(k => ({ k, key: ch.units[k].key })));
  unitEls.forEach((el, k) => el.classList.toggle('marked', marks.has(k)));
  $('next-mark').textContent = `● 次の印へ（${marks.size}）`;
  $('next-mark').hidden = !marks.size;
}
function unmark(k) { if (marks.delete(k)) saveMarks(); }
$('next-mark').onclick = () => {
  if (!marks.size) return;
  const ks = [...marks].sort((a, b) => a - b);
  const from = curIdx;
  const k = ks.find(x => x > from) ?? ks[0];
  stopSeg(); altAudio.pause();
  seekTo(ch.units[k].t0 + 0.01);
  manualScrollAt = 0; $('follow').hidden = true;
  setCur(k); scrollToCur(true); updateTime();
};

$('units').addEventListener('click', e => {
  const el = e.target.closest('.u'); if (!el) return;
  if (e.target.closest('.mk')) {
    const k = +el.dataset.k;
    if (marks.has(k)) marks.delete(k); else marks.add(k);
    saveMarks();
    return;
  }
  const k = +el.dataset.k;
  if (el.dataset.st && e.clientX > el.getBoundingClientRect().right - 40) {   // 右端のポッチ → その指摘を直す
    const list = issuesOn(k); const i = list.find(x => x.stage !== 'done') || list[0];
    if (i) { audio.pause(); stopSeg(); openSheet(i); return; }
  }
  stopSeg(); altAudio.pause();
  seekTo(ch.units[k].t0 + 0.01);
  setCur(k); manualScrollAt = 0; $('follow').hidden = true;
  updateTime();
});

function markDots() {
  const st = new Map();
  for (const i of issues) {
    const s = i.stage; const o = st.get(i.unit);
    if (!o || STAGE_RANK[s] > STAGE_RANK[o]) st.set(i.unit, s);
  }
  unitEls.forEach((el, k) => { const s = st.get(k); if (s) el.dataset.st = s; else delete el.dataset.st; });
  const open = issues.filter(i => i.stage !== 'done').length;
  $('issue-count').textContent = open ? `(${open})` : '';
}

function findUnit(t) {
  const u = ch.units; let lo = 0, hi = u.length - 1, ans = 0;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (u[m].t0 <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}
function setCur(k) {
  if (k === curIdx) return;
  unitEls[curIdx]?.classList.remove('cur');
  curIdx = k;
  unitEls[k]?.classList.add('cur');
  scrollToCur();
}
function scrollToCur(force) {
  if ($('v-text').hidden) return;
  if (!force && Date.now() - manualScrollAt < 6000) return;
  unitEls[curIdx]?.scrollIntoView({ block: 'center', behavior: force ? 'auto' : 'smooth' });
}
for (const ev of ['touchmove', 'wheel']) window.addEventListener(ev, () => {
  if (!ch || $('v-text').hidden) return;
  manualScrollAt = Date.now();
  if (!audio.paused) $('follow').hidden = false;
}, { passive: true });
$('follow').onclick = () => { manualScrollAt = 0; $('follow').hidden = true; scrollToCur(true); };

// ---------------------------------------------------------------- 再生

// iPhone の Safari は、音を読み込む前の位置合わせを黙って無視する。読み込んでから合わせる。
let pendingSeek = null;
function seekTo(t) {
  if (audio.readyState >= 1) { audio.currentTime = t; return; }
  pendingSeek = t;
  if (audio.networkState === 0 || audio.networkState === 3) audio.load();
}
audio.addEventListener('loadedmetadata', () => {
  if (pendingSeek != null) { audio.currentTime = pendingSeek; pendingSeek = null; updateTime(); }
});
function tick() {
  if (ch && audio.src) {
    if (seg && audio.currentTime >= seg.end) { const then = seg.then; seg = null; audio.pause(); then?.(); }
    setCur(findUnit(audio.currentTime));
    updateTime();
  }
  if (!audio.paused) requestAnimationFrame(tick);
}
let lastPosSave = 0;
function updateTime() {
  const d = audio.duration || ch?.duration || 0;
  $('t-now').textContent = fmt(pendingSeek ?? audio.currentTime);
  $('t-dur').textContent = fmt(d);
  if (!seeking) $('seek').value = d ? Math.round(audio.currentTime / d * 1000) : 0;
  if (Date.now() - lastPosSave > 3000) savePos();
}
function savePos() { if (ch && audio.src && !seg) { db.save('pos:' + ch.id, audio.currentTime); lastPosSave = Date.now(); } }
audio.addEventListener('play', () => { $('play').textContent = '❚❚'; requestAnimationFrame(tick); });
audio.addEventListener('pause', () => { $('play').textContent = '▶'; $('follow').hidden = true; savePos(); updateTime(); });
audio.addEventListener('timeupdate', () => { if (document.hidden) tick(); });
audio.addEventListener('ended', () => { $('play').textContent = '▶'; });

function stopSeg() { seg = null; }
$('play').onclick = () => {
  altAudio.pause();
  if (audio.paused) { stopSeg(); audio.play(); } else audio.pause();
};
$('rew').onclick = () => { stopSeg(); seekTo(Math.max(0, audio.currentTime - settings.skip)); manualScrollAt = 0; updateTime(); setCur(findUnit(audio.currentTime)); };
$('fwd').onclick = () => { stopSeg(); seekTo(Math.min(audio.duration || 1e9, audio.currentTime + settings.skip)); manualScrollAt = 0; updateTime(); setCur(findUnit(audio.currentTime)); };
const RATES = [0.8, 0.9, 1, 1.1, 1.25, 1.5];
function showRate() { $('rate').textContent = (settings.rate === 1 ? '1.0' : String(settings.rate)) + '×'; }
showRate();
$('rate').onclick = () => {
  const k = RATES.indexOf(settings.rate);
  settings.rate = RATES[(k + 1) % RATES.length]; saveSettings();
  audio.playbackRate = settings.rate; showRate();
};
let seeking = false;
$('seek').addEventListener('input', e => {
  seeking = true;
  const d = audio.duration || ch.duration;
  const t = e.target.value / 1000 * d;
  $('t-now').textContent = fmt(t);
});
$('seek').addEventListener('change', e => {
  const d = audio.duration || ch.duration;
  stopSeg(); seekTo(e.target.value / 1000 * d); seeking = false;
  manualScrollAt = 0; setCur(findUnit(audio.currentTime)); updateTime();
});

// ある範囲だけ鳴らす（文を聞く・元の音）
function playRange(t0, t1, then) {
  altAudio.pause();
  seekTo(Math.max(0, t0 - 0.05));
  seg = { end: t1 + 0.15, then };
  audio.play().catch(() => {});
}
function playUnit(k, then) { const u = ch.units[k]; playRange(u.t0, u.t1, then); }
function playAlt(a, btn) {
  audio.pause(); stopSeg();
  let url = altURLs.get(a.id);
  if (!url) { url = URL.createObjectURL(a.blob); altURLs.set(a.id, url); }
  altAudio.src = url; altAudio.playbackRate = settings.rate;
  document.querySelectorAll('.playing-btn').forEach(b => b.classList.remove('playing-btn'));
  btn?.classList.add('playing-btn');
  altAudio.onended = altAudio.onpause = () => btn?.classList.remove('playing-btn');
  altAudio.play().catch(() => {});
}

function setMediaSession() {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({ title: ch.title, artist: ch.artist || '', album: ch.album || '' });
  navigator.mediaSession.setActionHandler('play', () => audio.play());
  navigator.mediaSession.setActionHandler('pause', () => audio.pause());
  navigator.mediaSession.setActionHandler('seekbackward', () => $('rew').click());
  navigator.mediaSession.setActionHandler('seekforward', () => $('fwd').click());
}

// ---------------------------------------------------------------- 指摘の入力
let draft = null;          // 入力中の指摘
let anchor = -1;

$('flag').onclick = () => {
  if (!ch) return;
  const wasPlaying = !audio.paused;
  audio.pause(); stopSeg();
  const now = pendingSeek ?? audio.currentTime;
  const t = Math.max(0, now - (wasPlaying ? settings.delay : 0));
  openSheet({ unit: findUnit(t), at: now });
};

function openSheet(base) {
  draft = Object.assign({ id: null, kind: '', span: null, reading: '', heard: '', pattern: '', heardPattern: '', gap: '', note: '' }, structuredClone(base));
  anchor = -1;
  $('s-title').textContent = draft.id ? '指摘を直す' : '指摘';
  $('s-delete').hidden = !draft.id;
  $('s-reading').value = draft.reading; $('s-heard').value = draft.heard;
  $('s-heardpat').value = draft.heardPattern; $('s-note').value = draft.note;
  $('s-at').textContent = draft.at != null ? `再生位置 ${fmt(draft.at)}` : '';
  renderSheetUnit(); renderKind(); renderPat();
  $('sheet').hidden = false; $('sheet-bg').hidden = false;
  $('sheet').querySelector('.sheet-body').scrollTop = 0;
}
function closeSheet() { $('sheet').hidden = true; $('sheet-bg').hidden = true; draft = null; audio.pause(); stopSeg(); }

function renderSheetUnit() {
  const u = ch.units[draft.unit];
  $('s-unit-no').textContent = `${draft.unit + 1}/${ch.units.length}・${fmt(u.t0)}`;
  const chars = [...u.display];
  const s = draft.span;
  $('s-chars').innerHTML = chars.map((c, k) => {
    const cls = [];
    if (s && k >= s.s && k <= s.e) cls.push('sel');
    if (anchor === k) cls.push('anchor');
    return `<span data-c="${k}" class="${cls.join(' ')}">${esc(c)}</span>`;
  }).join('');
  $('s-read').textContent = u.read !== u.display ? `合成器に渡した字: ${u.read}` : '';
  $('s-prev').disabled = draft.unit <= 0; $('s-next').disabled = draft.unit >= ch.units.length - 1;
  // 同じ文にもう指摘があれば、新しく作らずにそれを直せるようにする
  const same = issuesOn(draft.unit).filter(i => i.id !== draft.id);
  const box = $('s-existing');
  box.hidden = !same.length;
  box.innerHTML = same.length ? `<div class="small">${draft.id ? 'この文にはほかにも指摘があります' : 'この文にはもう指摘があります。直すならこちら（このまま保存すると別の指摘として増えます）'}</div>`
    + same.map(i => `<button data-edit="${i.id}" class="small-btn">${describe(i).replace(/<br>.*/, '')}（${new Date(i.updated || i.created).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}）を直す</button>`).join('') : '';
}
function issuesOn(k) { return issues.filter(i => i.chapter === ch.id && i.unit === k).sort((a, b) => (b.updated || '').localeCompare(a.updated || '')); }
$('s-existing').addEventListener('click', e => {
  const b = e.target.closest('[data-edit]'); if (!b) return;
  const i = issues.find(x => x.id === b.dataset.edit); if (i) openSheet(i);
});
$('s-chars').addEventListener('click', e => {
  const sp = e.target.closest('span[data-c]'); if (!sp) return;
  const k = +sp.dataset.c;
  const chars = [...ch.units[draft.unit].display];
  if (anchor < 0) { anchor = k; draft.span = { s: k, e: k, text: chars[k] }; }
  else {
    const a = Math.min(anchor, k), b = Math.max(anchor, k);
    draft.span = { s: a, e: b, text: chars.slice(a, b + 1).join('') }; anchor = -1;
  }
  renderSheetUnit();
});
$('s-prev').onclick = () => { draft.unit--; draft.span = null; anchor = -1; renderSheetUnit(); };
$('s-next').onclick = () => { draft.unit++; draft.span = null; anchor = -1; renderSheetUnit(); };
$('s-hear').onclick = () => playUnit(draft.unit);

function renderKind() {
  document.querySelectorAll('#s-kinds button').forEach(b => b.classList.toggle('on', b.dataset.k === draft.kind));
  for (const k of ['読み', '抑揚', '間']) $('k-' + k).hidden = draft.kind !== k;
  document.querySelectorAll('#s-gap button').forEach(b => b.classList.toggle('on', b.dataset.g === draft.gap));
}
document.querySelectorAll('#s-kinds button').forEach(b => b.onclick = () => { draft.kind = draft.kind === b.dataset.k ? '' : b.dataset.k; renderKind(); });
document.querySelectorAll('#s-gap button').forEach(b => b.onclick = () => { draft.gap = draft.gap === b.dataset.g ? '' : b.dataset.g; renderKind(); });
function renderPat() { $('s-pat').textContent = draft.pattern ? draft.pattern.split('').join(' ') + `（${draft.pattern.length}字）` : '（未入力）'; }
$('p-u').onclick = () => { draft.pattern += 'U'; renderPat(); };
$('p-d').onclick = () => { draft.pattern += 'D'; renderPat(); };
$('p-bs').onclick = () => { draft.pattern = draft.pattern.slice(0, -1); renderPat(); };
$('p-clr').onclick = () => { draft.pattern = ''; renderPat(); };

$('s-cancel').onclick = closeSheet;
$('sheet-bg').onclick = closeSheet;
let saving = false;
$('s-save').onclick = async () => {
  if (saving || !draft) return;
  draft.reading = $('s-reading').value.trim(); draft.heard = $('s-heard').value.trim();
  draft.heardPattern = $('s-heardpat').value.trim().toUpperCase(); draft.note = $('s-note').value.trim();
  if (!draft.kind) { toast('種類（読み・抑揚・間…）を選んでください'); return; }
  saving = true;
  try {
  const u = ch.units[draft.unit];
  const now = new Date().toISOString();
  const old = draft.id ? issues.find(i => i.id === draft.id) : null;
  const i = Object.assign(old || { id: uid(), chapter: ch.id, created: now, stage: 'new', replies: [], verdicts: {} }, {
    unit: draft.unit, unitText: u.display, unitRead: u.read, unitKey: u.key, t0: u.t0,
    at: draft.at, kind: draft.kind, span: draft.span, reading: draft.reading, heard: draft.heard,
    pattern: draft.kind === '抑揚' ? draft.pattern : '', heardPattern: draft.kind === '抑揚' ? draft.heardPattern : '',
    gap: draft.kind === '間' ? draft.gap : '', note: draft.note, updated: now, unsent: true,
  });
  if (!old) i.audioId = ch.audioId;
  if (old && old.stage === 'sent') i.stage = 'new';
  await db.put('issues', i);
  if (!old) issues.push(i);
  unmark(i.unit);
  closeSheet(); markDots(); renderIssues();
  toast(old ? '直しました' : '指摘を保存しました（「指摘」タブ → Macに渡す）');
  } finally { saving = false; }
};
$('s-delete').onclick = async () => {
  if (!confirm('この指摘を消しますか？')) return;
  await db.del('issues', draft.id);
  for (const a of alts.get(draft.id) || []) await db.del('alts', a.id);
  issues = issues.filter(i => i.id !== draft.id); alts.delete(draft.id);
  closeSheet(); markDots(); renderIssues();
};

// ---------------------------------------------------------------- 指摘の一覧
document.querySelectorAll('#filter button').forEach(b => b.onclick = () => {
  filter = b.dataset.f;
  document.querySelectorAll('#filter button').forEach(x => x.classList.toggle('on', x === b));
  renderIssues();
});

function describe(i) {
  const w = i.span ? `「${esc(i.span.text)}」` : '';
  const out = [];
  if (i.kind === '読み') out.push(`読み${w}${i.reading ? ' → <b>' + esc(i.reading) + '</b>' : ''}${i.heard ? `（聞こえ: ${esc(i.heard)}）` : ''}`);
  else if (i.kind === '抑揚') out.push(`抑揚${w}${i.pattern ? ' → <b>' + esc(i.pattern) + '</b>' : ''}${i.heardPattern ? `（聞こえ: ${esc(i.heardPattern)}）` : ''}`);
  else if (i.kind === '間') out.push(`間${w}${i.gap ? '：<b>' + esc(i.gap) + '</b>' : ''}`);
  else out.push(`${esc(i.kind === '語尾' ? '語尾の切れ' : i.kind === '崩れ' ? '音の崩れ' : i.kind)}${w}`);
  if (i.note) out.push(esc(i.note));
  return out.join('<br>');
}
function markText(i) {
  const chars = [...i.unitText];
  if (!i.span) return esc(i.unitText);
  return esc(chars.slice(0, i.span.s).join('')) + '<mark>' + esc(chars.slice(i.span.s, i.span.e + 1).join('')) + '</mark>' + esc(chars.slice(i.span.e + 1).join(''));
}

// 評価（各案）と最終判断（どれか一つ／全部不採用）は別のもの。
const RATE = [['good', '◎ 良い'], ['ok', '○ 可'], ['close', '△ 惜しい'], ['reject', '× 不可']];
function normIssue(i) {
  i.verdicts = i.verdicts || {};
  for (const v of Object.values(i.verdicts)) if (v.v === 'adopt') v.v = 'good';   // 前の版の「採用」
  if (!i.decision && i.resolution?.startsWith('adopt:')) i.decision = { choice: i.resolution.slice(6) };
}
const shortLabel = a => (a.label.match(/^案\s*\d+/) || [a.label])[0];
function proposalsHtml(i, as) {
  const d = i.decision || {};
  const rows = as.map(a => {
    const v = i.verdicts[a.id] || {};
    return `<div class="alt" data-alt="${a.id}">
      <div class="arow"><button class="pbtn" data-act="alt">▶</button>
        <div><div class="lbl">${esc(a.label)}</div>${a.note ? `<div class="muted small">${esc(a.note)}</div>` : ''}</div></div>
      <div class="verdicts">${RATE.map(([k, t]) => `<button data-v="${k}" class="${v.v === k ? 'on' : ''}">${t}</button>`).join('')}</div>
      <input data-act="vnote" placeholder="この案へのコメント" value="${esc(v.note || '')}">
    </div>`;
  }).join('');
  const choices = as.map(a => `<button data-choice="${a.id}" class="${d.choice === a.id ? 'on' : ''}">${esc(shortLabel(a))}にする</button>`).join('')
    + `<button data-choice="none" class="none ${d.choice === 'none' ? 'on' : ''}">全部不採用</button>`;
  const past = (i.pastDecisions || []).filter(p => p.instruction).map(p => `<div class="muted small">前に出した指示: ${esc(p.instruction)}</div>`).join('');
  return `<div class="props">
    <div class="props-h">提案 ${as.length} 案</div>
    <div class="arow orig"><button class="pbtn" data-act="orig">▶</button><div class="lbl">元の音</div></div>
    ${rows}
    <div class="decide">
      <div class="props-h">最終判断</div>
      <div class="choices">${choices}</div>
      ${d.choice === 'none' ? `<textarea data-act="instr" rows="3" placeholder="新しい指示（どう直してほしいか。例: 「の」を上げたまま、もう少しゆっくり）">${esc(d.instruction || '')}</textarea>` : ''}
      ${past}
    </div>
  </div>`;
}

function renderIssues() {
  issues.forEach(normIssue);
  if (!ch) return;
  const list = issues.filter(i => filter === 'all' || (filter === 'done' ? i.stage === 'done' : i.stage !== 'done'))
    .sort((a, b) => (STAGE_RANK[b.stage] - STAGE_RANK[a.stage]) || (a.unit - b.unit));
  const unsent = issues.filter(i => i.unsent).length;
  $('send-info').textContent = unsent ? `まだMacに渡していない変更: ${unsent} 件` : (ch.sentAt ? `最後に渡した: ${new Date(ch.sentAt).toLocaleString('ja-JP')}` : '');
  if (!list.length) { $('issues').innerHTML = `<p class="muted card">${filter === 'done' ? '済みの指摘はありません' : '対応中の指摘はありません。本文を聞いて、気になったら「⚑ 指摘」を押してください。'}</p>`; return; }
  $('issues').innerHTML = list.map(i => {
    const as = (alts.get(i.id) || []).sort((a, b) => (a.created || '').localeCompare(b.created || '') || a.label.localeCompare(b.label, 'ja'));
    const replies = (i.replies || []).filter(r => r.note).map(r => `<div class="reply">Mac: ${esc(r.note)}</div>`).join('');
    const altHtml = as.length ? proposalsHtml(i, as) : '';
    const old = i.audioId && i.audioId !== ch.audioId ? ' ・前の版' : '';
    const res = i.resolution === 'fixed' ? '（Macで反映済み）' : i.resolution?.startsWith('adopt:') ? '（採用した案あり）' : i.resolution === 'closed' ? '（解決にした）' : '';
    return `<div class="issue" data-id="${i.id}" data-st="${i.stage}">
      <div class="head"><span>#${i.unit + 1}・${fmt(ch.units[i.unit]?.t0 ?? i.t0)}${old}</span><span>${STAGE[i.stage]}${i.unsent && i.stage !== 'new' ? '・未送付の変更' : ''}${res}</span></div>
      <div class="txt">${markText(i)}</div>
      <div class="what">${describe(i)}</div>
      <div class="actions" style="margin-top:8px">
        <button data-act="orig">▶ 元の音</button><button data-act="jump">本文で見る</button><button data-act="edit">直す</button>
        ${i.stage === 'done' ? '<button data-act="reopen">対応中に戻す</button>' : '<button data-act="close">解決にする</button>'}
      </div>
      ${replies}${altHtml}
    </div>`;
  }).join('');
}

$('issues').addEventListener('click', async e => {
  const card = e.target.closest('.issue'); if (!card) return;
  const i = issues.find(x => x.id === card.dataset.id); if (!i) return;
  const altEl = e.target.closest('.alt');
  const a = altEl ? (alts.get(i.id) || []).find(x => x.id === altEl.dataset.alt) : null;
  const act = e.target.dataset.act, v = e.target.dataset.v;
  if (act === 'orig') {
    const btn = e.target;
    document.querySelectorAll('.playing-btn').forEach(b => b.classList.remove('playing-btn'));
    btn.classList.add('playing-btn');
    playUnit(i.unit, () => btn.classList.remove('playing-btn'));
  }
  else if (act === 'jump') { showTab('text'); seekTo(ch.units[i.unit].t0 + 0.01); manualScrollAt = 0; setCur(i.unit); scrollToCur(true); updateTime(); }
  else if (act === 'edit') openSheet(i);
  else if (act === 'alt') playAlt(a, e.target);
  else if (act === 'close') { i.stage = 'done'; i.resolution = i.resolution || 'closed'; await touch(i); }
  else if (act === 'reopen') { i.stage = (alts.get(i.id) || []).length ? 'answered' : 'new'; i.resolution = null; i.decision = null; await touch(i); }
  else if (v && a) {
    const cur = i.verdicts[a.id] || {};
    cur.v = cur.v === v ? '' : v; cur.at = new Date().toISOString();
    i.verdicts[a.id] = cur;
    await touch(i);
  } else if (e.target.dataset.choice) {
    const c = e.target.dataset.choice;
    if (i.decision?.choice === c) { i.decision = null; i.stage = 'answered'; i.resolution = null; }
    else {
      i.decision = { choice: c, instruction: c === 'none' ? (i.decision?.instruction || '') : '', at: new Date().toISOString() };
      if (c === 'none') { i.stage = 'answered'; i.resolution = null; }
      else { i.stage = 'done'; i.resolution = 'adopt:' + c; }
    }
    await touch(i);
    if (c === 'none' && i.decision) $('issues').querySelector(`.issue[data-id="${i.id}"] textarea`)?.focus();
  }
});
$('issues').addEventListener('change', async e => {
  const act = e.target.dataset.act;
  if (act === 'instr') {
    const i = issues.find(x => x.id === e.target.closest('.issue').dataset.id);
    if (!i.decision) return;
    i.decision.instruction = e.target.value.trim(); i.decision.at = new Date().toISOString();
    i.unsent = true; i.updated = new Date().toISOString();
    await db.put('issues', i);
    $('send-info').textContent = `まだMacに渡していない変更: ${issues.filter(x => x.unsent).length} 件`;
    return;
  }
  if (act !== 'vnote') return;
  const i = issues.find(x => x.id === e.target.closest('.issue').dataset.id);
  const id = e.target.closest('.alt').dataset.alt;
  i.verdicts = i.verdicts || {};
  i.verdicts[id] = Object.assign(i.verdicts[id] || {}, { note: e.target.value.trim(), at: new Date().toISOString() });
  i.unsent = true; i.updated = new Date().toISOString();
  await db.put('issues', i);
  $('send-info').textContent = `まだMacに渡していない変更: ${issues.filter(x => x.unsent).length} 件`;
});
async function touch(i) { i.unsent = true; i.updated = new Date().toISOString(); await db.put('issues', i); markDots(); renderIssues(); }

$('passed').onchange = async e => { ch.passed = e.target.checked; ch.passedChanged = true; await db.put('chapters', ch); };

// ---------------------------------------------------------------- Macに渡す
$('send').onclick = async () => {
  const name = `指摘_${ch.id}.json`;
  const noInstr = issues.filter(i => i.decision?.choice === 'none' && !i.decision.instruction);
  if (noInstr.length && !confirm(`「全部不採用」で新しい指示が空の指摘が ${noInstr.length} 件あります。このまま渡しますか？`)) return;
  // 渡したあとの段階で書き出す（Macが読む時点では「返事待ち」になっているので）
  const nextStage = i => !i.unsent ? i.stage
    : (i.stage === 'new' || (i.stage === 'answered' && (i.decision?.choice === 'none' || Object.values(i.verdicts || {}).some(v => v.v || v.note)))) ? 'sent' : i.stage;
  const out = {
    format: 'tts-review/feedback', version: 1, exportedAt: new Date().toISOString(),
    chapter: { id: ch.id, title: ch.title, audioId: ch.audioId, passed: !!ch.passed },
    settings: { delay: settings.delay },
    issues: issues.map(i => ({
      id: i.id, fresh: !!i.unsent, stage: nextStage(i), resolution: i.resolution || null,
      unit: i.unit, unitKey: i.unitKey, unitText: i.unitText, unitRead: i.unitRead, audioId: i.audioId,
      t0: ch.units[i.unit]?.t0 ?? i.t0, at: i.at, kind: i.kind, span: i.span,
      reading: i.reading, heard: i.heard, pattern: i.pattern, heardPattern: i.heardPattern, gap: i.gap,
      note: i.note, created: i.created, updated: i.updated,
      verdicts: Object.entries(i.verdicts || {}).filter(([, v]) => v.v || v.note).map(([alt, v]) => ({ alt, verdict: v.v || '', note: v.note || '', at: v.at })),
      decision: i.decision ? { choice: i.decision.choice, instruction: i.decision.instruction || '', at: i.decision.at } : null,
      replies: (i.replies || []).map(r => r.id),
    })),
  };
  const file = new File([JSON.stringify(out, null, 1)], name, { type: 'application/json' });
  let ok = false;
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); ok = true; }
    catch (err) { if (err.name === 'AbortError') return; }
  }
  if (!ok) { const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; a.click(); ok = true; }
  for (const i of issues) {
    if (!i.unsent) continue;
    i.stage = nextStage(i); i.unsent = false;
    await db.put('issues', i);
  }
  ch.sentAt = new Date().toISOString(); await db.put('chapters', ch);
  markDots(); renderIssues();
  toast('「ファイルに保存」→ iCloud Drive の「修正作業」フォルダに保存してください（同じ名前は置き換え）', 6000);
};

// ---------------------------------------------------------------- 講を消す
$('del-ch').onclick = async () => {
  if (!confirm(`「${ch.title}」をこの端末から消しますか？\n音・指摘・代案もすべて消えます（Macの側のファイルは残ります）。`)) return;
  for (const i of issues) { for (const a of alts.get(i.id) || []) await db.del('alts', a.id); await db.del('issues', i.id); }
  await db.del('audio', ch.id); await db.del('chapters', ch.id);
  db.save('pos:' + ch.id, 0);
  goHome(); toast('消しました');
};
window.addEventListener('pagehide', savePos);
document.addEventListener('visibilitychange', () => { if (document.hidden) savePos(); });

// ---------------------------------------------------------------- 起動
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
(async () => {
  const h = decodeURIComponent(location.hash.slice(1));
  if (h && await db.get('chapters', h)) openChapter(h); else renderHome();
})();
