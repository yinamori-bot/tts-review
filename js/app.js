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
    // 同じ文の指摘をまとめた案: it.issue（代表）に案を入れ、ほかの指摘は「代表の案でまとめて判断」にする
    const group = (it.issues || []).filter(x => x !== i.id);
    if (group.length) {
      i.group = [i.id, ...group];
      for (const gid of group) {
        const g = await db.get('issues', gid); if (!g) continue;
        g.groupOf = i.id; g.replies = g.replies || [];
        if (!g.replies.some(r => r.id === it.id)) g.replies.push({ id: it.id, at: d.created, note: '', status: 'group' });
        if (g.stage !== 'done' || it.status !== 'fixed') g.stage = it.status === 'fixed' ? 'done' : 'answered';
        if (it.status === 'fixed') g.resolution = g.resolution || 'fixed';
        g.updated = new Date().toISOString();
        await db.put('issues', g);
      }
    }
    i.replies = i.replies || [];
    // 前に取り込んだ返事は何もしない（全部まとめて選び直しても、判断や段階が戻らないように）
    if (it.id && i.replies.some(r => r.id === it.id)) continue;
    i.replies.push({ id: it.id || uid(), at: d.created, note: it.note || '', status: it.status || 'alts', skipped: it.skipped || [] });
    for (const a of it.alts || []) {
      if (await db.get('alts', a.id)) continue;
      const blob = await (await fetch(`data:${a.mime || 'audio/mp4'};base64,${a.data}`)).blob();
      const rec = { id: a.id, issue: i.id, label: a.label || '代案', note: a.note || '', dur: a.dur || 0, blob, created: d.created };
      // 一括の確認: 同じ語を直した、別の文の音（unit がその文）
      if (it.status === 'batch' && a.unit != null) Object.assign(rec, { batch: true, unit: a.unit, unitText: a.unitText || '' });
      await db.put('alts', rec);
      na++;
    }
    if (it.status !== 'batch' && (it.alts || []).length && i.decision?.choice === 'none') {
      (i.pastDecisions = i.pastDecisions || []).push(i.decision); i.decision = null;
    }
    if (it.status === 'fixed') { i.stage = 'done'; i.resolution = i.resolution || 'fixed'; }
    else if (it.status === 'batch') i.stage = 'answered';      // 採用済みの指摘でも、一括の確認を待つ
    else if (i.stage !== 'done') i.stage = 'answered';
    i.updated = new Date().toISOString();
    await db.put('issues', i); n++;
  }
  return n ? `返事を入れました: 指摘 ${n} 件・代案 ${na} 本` : 'この返事はもう取り込んであります';
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
  $('back').hidden = true; $('tabs').hidden = true; $('filter').hidden = true;
  $('v-home').hidden = false; $('v-chapter').hidden = true;
  $('player').hidden = true; document.body.classList.remove('has-player', 'tab-issues');
  history.replaceState(null, '', location.pathname);
  renderHome();
}
$('back').onclick = goHome;

function showTab(t) {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  $('v-text').hidden = t !== 'text'; $('v-issues').hidden = t !== 'issues';
  $('filter').hidden = t !== 'issues';      // 指摘前・対応中・済み・すべて は上の帯に出し、一覧を下へ送っても消えない
  document.body.classList.toggle('tab-issues', t === 'issues');  // 指摘画面では再生バーと印・指摘の送りを隠す
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
  $('mark-n').textContent = marks.size;
  $('nav-mark').hidden = !marks.size;
  $('mark-count').textContent = marks.size ? `(${marks.size})` : '';
  if (filter === 'marked' && ch) renderIssues();
}
function unmark(k) { if (marks.delete(k)) saveMarks(); }
// 本文の「前・次」: 左の印（●）と右のポッチ（指摘のある文）を、いまの文から前後へたどる（端まで行ったら反対の端へ）
function step(ks, d) {
  if (!ks.length) return;
  ks = [...ks].sort((a, b) => a - b);
  const k = d > 0 ? (ks.find(x => x > curIdx) ?? ks[0]) : ([...ks].reverse().find(x => x < curIdx) ?? ks[ks.length - 1]);
  jumpTo(k);
}
const issueUnits = () => [...new Set(issues.map(i => i.unit))];
$('nav-mark').onclick = e => { const d = +e.target.closest('button')?.dataset.d; if (d) step([...marks], d); };
$('nav-iss').onclick = e => { const d = +e.target.closest('button')?.dataset.d; if (d) step(issueUnits(), d); };
function jumpTo(k) {
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
  const n = issueUnits().length;
  $('iss-n').textContent = n; $('nav-iss').hidden = !n;
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
  draft = Object.assign({ id: null, kind: '', span: null, reading: '', heard: '', pattern: '', heardPattern: '', gap: '', note: '', allSame: false, baseAlt: '', baseIssue: '', baseLabel: '' }, structuredClone(base));
  anchor = -1;
  $('s-title').textContent = draft.id ? '指摘を直す' : '指摘';
  $('s-delete').hidden = !draft.id;
  $('s-reading').value = draft.reading; $('s-heard').value = draft.heard;
  $('s-note').value = draft.note;
  $('s-allsame').checked = !!draft.allSame;
  $('s-at').textContent = draft.at != null ? `再生位置 ${fmt(draft.at)}` : '';
  $('s-base').hidden = !draft.baseAlt;
  $('s-base-lbl').textContent = draft.baseAlt ? `土台: ${draft.baseLabel}。この案の音を聞いて、おかしい所を指摘してください（直した所はそのまま残すよう作ります）` : '';
  renderSheetUnit(); renderKind(); renderPat(); renderHPat();
  $('sheet').hidden = false; $('sheet-bg').hidden = false;
  $('sheet').querySelector('.sheet-body').scrollTop = 0;
}
function closeSheet() { $('sheet').hidden = true; $('sheet-bg').hidden = true; draft = null; audio.pause(); stopSeg(); }

function renderSheetUnit() {
  const u = ch.units[draft.unit];
  $('s-unit-no').textContent = `${draft.unit + 1}/${ch.units.length}・${fmt(u.t0)}`;
  const chars = [...u.display];
  const s = draft.span;
  const others = issuesOn(draft.unit).filter(i => i.id !== draft.id && i.span).map(i => i.span);
  $('s-chars').innerHTML = chars.map((c, k) => {
    const cls = [];
    if (s && k >= s.s && k <= s.e) cls.push('sel');
    if (others.some(o => k >= o.s && k <= o.e)) cls.push('other');
    if (anchor === k) cls.push('anchor');
    return `<span data-c="${k}" class="${cls.join(' ')}">${esc(c)}</span>`;
  }).join('');
  $('s-read').textContent = u.read !== u.display ? `合成器に渡した字: ${u.read}` : '';
  $('s-prev').disabled = draft.unit <= 0; $('s-next').disabled = draft.unit >= ch.units.length - 1;
  // 同じ文にもう指摘があれば、新しく作らずにそれを直せるようにする
  const same = issuesOn(draft.unit).filter(i => i.id !== draft.id);
  const box = $('s-existing');
  box.hidden = !same.length && !draft.id;
  box.innerHTML = (same.length ? `<div class="small">この文のほかの指摘（赤い下線の所）。直すならタップ。${draft.id ? '' : '別の箇所なら、このまま語を選んで保存すれば新しい指摘になります。'}</div>` : '')
    + same.map(i => `<button data-edit="${i.id}" class="small-btn">${describe(i).replace(/<br>.*/, '')}（${new Date(i.updated || i.created).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}）を直す</button>`).join('')
    + (draft.id ? '<button data-new="1" class="small-btn">＋ この文に新しい指摘</button>' : '');
}
function issuesOn(k) { return issues.filter(i => i.chapter === ch.id && i.unit === k).sort((a, b) => (b.updated || '').localeCompare(a.updated || '')); }
$('s-existing').addEventListener('click', e => {
  if (e.target.closest('[data-new]')) { openSheet({ unit: draft.unit, at: draft.at }); return; }
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
$('s-hear').onclick = () => draft.baseAlt ? playBase($('s-hear')) : playUnit(draft.unit);
function playBase(btn) { const a = [...alts.values()].flat().find(x => x.id === draft?.baseAlt); if (a) playAlt(a, btn); }
$('s-base-play').onclick = () => playBase($('s-base-play'));

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
// いまの聞こえ方も同じ U/D ボタンで入れる（前は文字入力だった）
function renderHPat() { const h = draft.heardPattern; $('s-hpat').textContent = h ? h.split('').join(' ') + `（${h.replace(/[^UD]/g, '').length}字）` : '（未入力）'; }
$('hp-u').onclick = () => { draft.heardPattern += 'U'; renderHPat(); };
$('hp-d').onclick = () => { draft.heardPattern += 'D'; renderHPat(); };
$('hp-bs').onclick = () => { draft.heardPattern = draft.heardPattern.slice(0, -1); renderHPat(); };
$('hp-clr').onclick = () => { draft.heardPattern = ''; renderHPat(); };

$('s-cancel').onclick = closeSheet;
$('sheet-bg').onclick = closeSheet;
let saving = false;
// more: 保存したあと、同じ文の新しい指摘をすぐ開く（1文に何箇所も指摘するとき）
async function saveDraft(more) {
  if (saving || !draft) return;
  draft.reading = $('s-reading').value.trim(); draft.heard = $('s-heard').value.trim();
  draft.note = $('s-note').value.trim();
  draft.allSame = $('s-allsame').checked;
  if (draft.allSame && !draft.span) { toast('「同じ語もまとめて」には、語の最初と最後の字を選んでください'); return; }
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
    gap: draft.kind === '間' ? draft.gap : '', note: draft.note, allSame: !!draft.allSame, updated: now, unsent: true,
    baseAlt: draft.baseAlt || '', baseIssue: draft.baseIssue || '', baseLabel: draft.baseLabel || '',
  });
  if (!old) i.audioId = ch.audioId;
  if (old && old.stage === 'sent') i.stage = 'new';
  await db.put('issues', i);
  if (!old) issues.push(i);
  unmark(i.unit);
  if (more) {
    const at = draft.at;
    markDots(); renderIssues();
    openSheet({ unit: i.unit, at });
    toast(`${old ? '直しました' : '保存しました'}。同じ文の別の箇所を選んでください`);
    return;
  }
  closeSheet(); markDots(); renderIssues();
  toast(old ? '直しました' : filter === 'marked' && !$('v-issues').hidden ? '指摘を保存しました。「対応中」に移りました' : '指摘を保存しました（「指摘」タブ → Macに渡す）');
  } finally { saving = false; }
}
$('s-save').onclick = () => saveDraft(false);
$('s-more').onclick = () => saveDraft(true);
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
  if (i.baseAlt) out.push(`<span class="muted small">土台: ${esc(i.baseLabel || i.baseAlt)}</span>`);
  if (i.allSame) out.push('<span class="tag">この講の同じ語もまとめて</span>');
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
// まとめた案の、語ごとの評価（良い・だめ）。i.spots[案のid][指摘のid] = 'ok' | 'ng'
const groupOf = i => (i.group || [i.id]).map(id => issues.find(x => x.id === id)).filter(Boolean);
function spotsHtml(i, a) {
  const grp = groupOf(i); if (grp.length < 2) return '';
  const sp = (i.spots || {})[a.id] || {};
  return `<div class="spots">${grp.map(g => `<div class="spot"><span>「${esc(g.span?.text || g.kind)}」</span>
    <button data-spot="${g.id}" data-sv="ok" class="${sp[g.id] === 'ok' ? 'on ok' : ''}">良い</button><button data-spot="${g.id}" data-sv="ng" class="${sp[g.id] === 'ng' ? 'on ng' : ''}">だめ</button></div>`).join('')}</div>`;
}
function proposalsHtml(i, as) {
  const d = i.decision || {};
  // 返事ごと（何回目の案か）に見出しを付ける。最終判断は各案の行の「これにする」で選ぶ
  // （前は下に「案1にする」を並べていたが、回をまたぐと同じ名前が並び、別の回の案1を選んでしまった）
  const rounds = [...new Set(as.map(a => a.created || ''))];
  let prev = null;
  const rows = as.map(a => {
    const v = i.verdicts[a.id] || {};
    const r = a.created || '';
    const hdr = rounds.length > 1 && r !== prev ? `<div class="round">${rounds.indexOf(r) + 1}回目の案${rounds.indexOf(r) === rounds.length - 1 ? '（最新）' : ''}</div>` : '';
    prev = r;
    return `${hdr}<div class="alt" data-alt="${a.id}">
      <div class="arow"><button class="pbtn" data-act="alt">▶</button>
        <div><div class="lbl">${esc(a.label)}</div>${a.note ? `<div class="muted small">${esc(a.note)}</div>` : ''}</div></div>
      <div class="verdicts">${RATE.map(([k, t]) => `<button data-v="${k}" class="${v.v === k ? 'on' : ''}">${t}</button>`).join('')}</div>
      ${spotsHtml(i, a)}
      <input data-act="vnote" placeholder="この案へのコメント" value="${esc(v.note || '')}">
      <div class="choices"><button data-choice="${a.id}" class="${d.choice === a.id ? 'on' : ''}">${d.choice === a.id ? '★ この案に決めた' : 'この案にする'}</button></div>
      <button data-act="onbase" class="small-btn">この案の音で、ほかの所を指摘</button>
    </div>`;
  }).join('');
  const chosen = as.find(a => a.id === d.choice);
  const roundOf = a => rounds.length > 1 ? `${rounds.indexOf(a.created || '') + 1}回目の` : '';
  const choices = `<div class="muted small" style="flex:1 1 100%">${chosen ? `決めた案: ${esc(roundOf(chosen) + chosen.label)}` : d.choice === 'none' ? '' : 'まだ決めていません。採る案の「この案にする」を押すか、'}</div>`
    + `<button data-choice="none" class="none ${d.choice === 'none' ? 'on' : ''}">全部不採用</button>`;
  const past = (i.pastDecisions || []).filter(p => p.instruction).map(p => `<div class="muted small">前に出した指示: ${esc(p.instruction)}</div>`).join('');
  const grp = groupOf(i);
  return `<div class="props">
    <div class="props-h">${grp.length > 1 ? `この文の指摘 ${grp.length} 件（${grp.map(g => esc(g.span?.text || g.kind)).join('・')}）をまとめた案 ${as.length} 案` : `提案 ${as.length} 案`}</div>
    ${grp.length > 1 ? '<p class="muted small">案ごとに、指摘した語それぞれが「良い」か「だめ」かも押してください。</p>' : ''}
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

// 一括の確認: 講の中の同じ語を同じ直し方で直した文を並べ、○（これで良い）／×（だめ）を付けてもらう
const skippedOf = i => (i.replies || []).flatMap(r => r.skipped || []);
// 同じ文に案が複数あるとき（作り直しを重ねたときなど）は、文を1回だけ出して案をその下に並べる
function batchGroups(bat) {
  const m = new Map();
  for (const a of bat) { if (!m.has(a.unit)) m.set(a.unit, []); m.get(a.unit).push(a); }
  return [...m.entries()].sort((x, y) => x[0] - y[0]);
}
// その文の判断が済んだか: ○ の案がある、または全部の案に × が付いた
const unitDone = (i, as) => as.some(a => i.verdicts[a.id]?.v === 'good') || as.every(a => i.verdicts[a.id]?.v === 'reject');
function batchHtml(i, bat) {
  const groups = batchGroups(bat);
  const rated = groups.filter(([, as]) => unitDone(i, as)).length;
  const multi = groups.some(([, as]) => as.length > 1);
  const rows = groups.map(([k, as]) => {
    const u = ch.units[k];
    const cands = as.map((a, n) => {
      const v = i.verdicts[a.id] || {};
      return `<div class="balt" data-alt="${a.id}">
        ${as.length > 1 || a.note ? `<div class="small muted">${as.length > 1 ? `案${n + 1}` : ''}${as.length > 1 && a.note ? '・' : ''}${esc(a.note || '')}</div>` : ''}
        <div class="arow"><button class="pbtn" data-act="alt" title="直した音">新</button>
          <div class="verdicts" style="flex:1;margin-top:0">${[['good', '○ これで良い'], ['reject', '× だめ']].map(([kk, t]) => `<button data-v="${kk}" class="${v.v === kk ? 'on' : ''}">${t}</button>`).join('')}</div></div>
        ${v.v === 'reject' ? `<input data-act="vnote" placeholder="どこがだめか（任意）" value="${esc(v.note || '')}">` : ''}
        <button data-act="onbase" class="small-btn">この音で、ほかの所を指摘</button>
      </div>`;
    }).join('');
    return `<div class="alt bunit">
      <div class="small muted">#${k + 1}・${fmt(u?.t0 ?? 0)}${as.length > 1 ? `・案 ${as.length} つ（良いものを1つ ○）` : ''}</div>
      <div class="arow"><button class="pbtn" data-act="borig" data-k="${k}" title="元の音">元</button><div class="btxt" style="flex:1">${esc(as[0].unitText || u?.display || '')}</div></div>
      ${cands}
    </div>`;
  }).join('');
  const sk = skippedOf(i).map(x => `<li>#${x.unit + 1} ${esc(x.text || ch.units[x.unit]?.display || '')}<span class="muted">（${esc(x.reason || '')}）</span></li>`).join('');
  return `<div class="props batch">
    <div class="props-h">一括の確認 ${groups.length} 文（${rated}/${groups.length} 済み）</div>
    <p class="muted small">同じ語を同じ直し方で直した文です。「元」と「新」を聞き比べ、だめなものだけ × を。</p>
    ${groups.length ? `<button data-act="ballgood" class="small-btn">まだ付けていない文を全部 ○ にする${multi ? '（案が複数ある文は除く）' : ''}</button>` : ''}
    ${rows}
    ${sk ? `<div class="muted small" style="margin-top:8px">触っていない文:</div><ul class="skipped small">${sk}</ul>` : ''}
  </div>`;
}

function renderIssues() {
  issues.forEach(normIssue);
  if (!ch) return;
  if (filter === 'marked') { renderMarked(); return; }
  // まとめた案の仲間（groupOf）は別のカードにせず、代表のカードの中に一行で出す
  const isMember = i => i.groupOf && i.groupOf !== i.id && issues.some(x => x.id === i.groupOf);
  const list = issues.filter(i => !isMember(i) && (filter === 'all' || (filter === 'done' ? i.stage === 'done' : i.stage !== 'done')))
    .sort((a, b) => (STAGE_RANK[b.stage] - STAGE_RANK[a.stage]) || (a.unit - b.unit));
  const unsent = issues.filter(i => i.unsent).length;
  $('send-info').textContent = unsent ? `まだMacに渡していない変更: ${unsent} 件` : (ch.sentAt ? `最後に渡した: ${new Date(ch.sentAt).toLocaleString('ja-JP')}` : '');
  if (!list.length) { $('issues').innerHTML = `<p class="muted card">${filter === 'done' ? '済みの指摘はありません' : '対応中の指摘はありません。本文を聞いて、気になったら「⚑ 指摘」を押してください。'}</p>`; return; }
  $('issues').innerHTML = list.map(i => {
    const as = (alts.get(i.id) || []).sort((a, b) => (a.created || '').localeCompare(b.created || '') || a.label.localeCompare(b.label, 'ja'));
    const replies = (i.replies || []).filter(r => r.note).map(r => `<div class="reply">Mac: ${esc(r.note)}</div>`).join('');
    const own = as.filter(a => !a.batch), bat = as.filter(a => a.batch).sort((a, b) => a.unit - b.unit);
    const lead = i.groupOf && issues.find(x => x.id === i.groupOf);
    const altHtml = lead ? `<div class="reply">この文の指摘は、#${lead.unit + 1}「${esc(lead.span?.text || lead.kind)}」のカードの案でまとめて判断します。 <button data-act="golead" data-lead="${lead.id}" class="small-btn">まとめた案へ</button></div>`
      : (own.length ? proposalsHtml(i, own) : '') + (bat.length || skippedOf(i).length ? batchHtml(i, bat) : '');
    const old = i.audioId && i.audioId !== ch.audioId ? ' ・前の版' : '';
    const res = i.resolution === 'fixed' ? '（Macで反映済み）' : i.resolution?.startsWith('adopt:') ? '（採用した案あり）' : i.resolution === 'closed' ? '（解決にした）' : '';
    return `<div class="issue" data-id="${i.id}" data-st="${i.stage}">
      <div class="head"><span>#${i.unit + 1}・${fmt(ch.units[i.unit]?.t0 ?? i.t0)}${old}</span><span>${STAGE[i.stage]}${i.unsent && i.stage !== 'new' ? '・未送付の変更' : ''}${res}</span></div>
      <div class="txt">${markText(i)}</div>
      <div class="what">${describe(i)}</div>
      ${groupOf(i).filter(g => g.id !== i.id).map(g => `<div class="member"><span class="muted small">この案でまとめて判断：</span>${describe(g)} <button data-act="medit" data-mid="${g.id}" class="small-btn">直す</button></div>`).join('')}
      <div class="actions" style="margin-top:8px">
        <button data-act="orig">▶ 元の音</button><button data-act="jump">本文で見る</button><button data-act="edit">直す</button><button data-act="add">同じ文に足す</button>
        ${i.stage === 'done' ? '<button data-act="reopen">対応中に戻す</button>' : '<button data-act="close">解決にする</button>'}
      </div>
      ${replies}${altHtml}
    </div>`;
  }).join('');
}

// 指摘前: 左の印を付けた文の一覧。「⚑ 指摘」で入力し、保存すると印が消えて「対応中」に移る。
function renderMarked() {
  const ks = [...marks].sort((a, b) => a - b);
  if (!ks.length) { $('issues').innerHTML = '<p class="muted card">印の付いた文はありません。本文の左端の丸をタップすると印が付き、ここに並びます。</p>'; return; }
  $('issues').innerHTML = ks.map(k => {
    const u = ch.units[k];
    const has = issuesOn(k).length ? '<span>この文にはもう指摘があります</span>' : '<span></span>';
    return `<div class="issue mcard" data-k="${k}">
      <div class="head"><span>#${k + 1}・${fmt(u.t0)}</span>${has}</div>
      <div class="txt">${esc(u.display)}</div>
      <div class="actions" style="margin-top:8px">
        <button data-act="flag" class="flag-sm">⚑ 指摘</button><button data-act="orig">▶ この文を聞く</button><button data-act="jump">本文で見る</button><button data-act="unmark">印を消す</button>
      </div>
    </div>`;
  }).join('');
}

$('issues').addEventListener('click', async e => {
  const mc = e.target.closest('.mcard');
  if (mc) {
    const k = +mc.dataset.k, act = e.target.dataset.act;
    if (act === 'flag') { audio.pause(); stopSeg(); altAudio.pause(); openSheet({ unit: k, at: ch.units[k].t0 }); }
    else if (act === 'orig') {
      const btn = e.target;
      document.querySelectorAll('.playing-btn').forEach(b => b.classList.remove('playing-btn'));
      btn.classList.add('playing-btn');
      playUnit(k, () => btn.classList.remove('playing-btn'));
    }
    else if (act === 'jump') { showTab('text'); seekTo(ch.units[k].t0 + 0.01); manualScrollAt = 0; setCur(k); scrollToCur(true); updateTime(); }
    else if (act === 'unmark') unmark(k);
    return;
  }
  const card = e.target.closest('.issue'); if (!card) return;
  const i = issues.find(x => x.id === card.dataset.id); if (!i) return;
  const altEl = e.target.closest('[data-alt]');
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
  else if (act === 'medit') { const m = issues.find(x => x.id === e.target.dataset.mid); if (m) openSheet(m); }
  else if (act === 'add') openSheet({ unit: i.unit, at: ch.units[i.unit]?.t0 ?? i.t0 });
  else if (act === 'alt') playAlt(a, e.target);
  // 直した所は良いが、ほかの語（多くは直した語のすぐ後ろ）がおかしい案: その案を土台にして指摘する。
  // 講に入れて組み直すのを待たずに、次の直しを頼める（Mac は土台の案の字から作り、両方を満たす取りを探す）
  else if (act === 'onbase' && a) {
    const k = a.unit ?? i.unit;
    openSheet({ unit: k, at: ch.units[k]?.t0 ?? i.t0, baseAlt: a.id, baseIssue: i.id, baseLabel: a.label + (a.batch ? '（一括の確認）' : '') });
  }
  else if (act === 'golead') { const el = $('issues').querySelector(`.issue[data-id="${e.target.dataset.lead}"]`); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); else toast('「すべて」で探してください'); }
  else if (e.target.dataset.spot && a) {
    i.spots = i.spots || {}; const sp = i.spots[a.id] = i.spots[a.id] || {};
    const g = e.target.dataset.spot, sv = e.target.dataset.sv;
    sp[g] = sp[g] === sv ? '' : sv;
    await touch(i);
  }
  else if (act === 'borig') {
    const btn = e.target; altAudio.pause();
    document.querySelectorAll('.playing-btn').forEach(b => b.classList.remove('playing-btn'));
    btn.classList.add('playing-btn');
    playUnit(+btn.dataset.k, () => btn.classList.remove('playing-btn'));
  }
  else if (act === 'ballgood') {
    const now = new Date().toISOString();
    // 案が1つだけで、まだ何も付けていない文だけ ○ にする（案が複数ある文は、どれが良いか選んでもらう）
    for (const [, as] of batchGroups((alts.get(i.id) || []).filter(x => x.batch)))
      if (as.length === 1 && !i.verdicts[as[0].id]?.v) i.verdicts[as[0].id] = Object.assign(i.verdicts[as[0].id] || {}, { v: 'good', at: now });
    await touch(i);
  }
  else if (act === 'close') { i.stage = 'done'; i.resolution = i.resolution || 'closed'; await touch(i); }
  else if (act === 'reopen') { i.stage = (alts.get(i.id) || []).length ? 'answered' : 'new'; i.resolution = null; i.decision = null; await touch(i); }
  else if (v && a) {
    const cur = i.verdicts[a.id] || {};
    cur.v = cur.v === v ? '' : v; cur.at = new Date().toISOString();
    i.verdicts[a.id] = cur;
    // 一括の確認で同じ文に案が複数あるときは、○ は1つだけ（ほかの ○ を外す）
    if (a.batch && cur.v === 'good') for (const b of (alts.get(i.id) || [])) if (b.batch && b.unit === a.unit && b.id !== a.id && i.verdicts[b.id]?.v === 'good') i.verdicts[b.id].v = '';
    await touch(i);
  } else if (e.target.dataset.choice) {
    const c = e.target.dataset.choice;
    if (i.decision?.choice === c) { i.decision = null; i.stage = 'answered'; i.resolution = null; }
    else {
      i.decision = { choice: c, instruction: c === 'none' ? (i.decision?.instruction || '') : '', at: new Date().toISOString() };
      if (c === 'none') { i.stage = 'answered'; i.resolution = null; }
      else { i.stage = 'done'; i.resolution = 'adopt:' + c; }
    }
    // まとめた案なら、同じ文のほかの指摘も同じ判断にする
    for (const g of groupOf(i)) {
      if (g.id === i.id) continue;
      g.decision = i.decision ? { ...i.decision, via: i.id } : null; g.stage = i.stage; g.resolution = i.resolution;
      g.unsent = true; g.updated = new Date().toISOString(); await db.put('issues', g);
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
  const id = e.target.closest('[data-alt]').dataset.alt;
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
      note: i.note, allSame: !!i.allSame, created: i.created, updated: i.updated,
      ...(i.baseAlt ? { baseAlt: i.baseAlt, baseIssue: i.baseIssue } : {}),
      verdicts: [...new Set([...Object.keys(i.verdicts || {}), ...Object.keys(i.spots || {})])]
        .map(alt => ({ alt, v: (i.verdicts || {})[alt] || {}, sp: Object.fromEntries(Object.entries((i.spots || {})[alt] || {}).filter(([, x]) => x)) }))
        .filter(({ v, sp }) => v.v || v.note || Object.keys(sp).length)
        .map(({ alt, v, sp }) => ({ alt, verdict: v.v || '', note: v.note || '', at: v.at, ...(Object.keys(sp).length ? { spots: sp } : {}) })),
      group: i.group || null, groupOf: i.groupOf || null,
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
