// ==UserScript==
// @name         Threads 檢舉＋封鎖小幫手
// @namespace    threads-report-block
// @version      0.2.0
// @description  在 Threads 個人主頁一鍵走完「檢舉＋封鎖」選單；內建名單佇列，J 跳下一個。每次只處理目前這一個帳號。
// @downloadURL  https://github.com/davidberger1210/threads-report-block/raw/main/threads-report-block.user.js
// @updateURL    https://github.com/davidberger1210/threads-report-block/raw/main/threads-report-block.user.js
// @match        https://www.threads.com/*
// @match        https://www.threads.net/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const REASONS = [
    '這是機器人程式或假帳號',
    '這是垃圾訊息',
    '仇恨言論或象徵符號',
    '霸凌或騷擾',
    '詐騙或詐欺',
  ];
  const COOLDOWN_MS = 8000;

  // ---------- 狀態（存在 Tampermonkey，不離開你的電腦） ----------
  const load = () => GM_getValue('state', { queue: [], idx: 0, done: {}, reason: REASONS[0], stepMode: true, lastAction: 0 });
  const save = (s) => GM_setValue('state', s);
  let state = load();

  // 一行一個帳號：「https://www.threads.com/@xxx 理由」或「@xxx 理由」
  function parseList(text) {
    const seen = new Set();
    const out = [];
    for (const line of text.split('\n')) {
      // 一行可能擠了好幾個帳號；只有一個時，後面的文字才當理由
      let ms = [...line.matchAll(/@([A-Za-z0-9._]+)/g)];
      // 沒有 @ 的純帳號名（一行一個，後面可接理由）也收
      if (!ms.length && !line.includes('://')) { const b = line.match(/^\s*([A-Za-z0-9._]+)/); if (b) ms = [{ 1: b[1], index: b.index, 0: b[0] }]; }
      for (const m of ms) {
        const handle = m[1].replace(/\.+$/, '');
        if (!handle || seen.has(handle)) continue;
        seen.add(handle);
        const note = ms.length === 1 ? line.slice(m.index + m[0].length).replace(/^\/?\S*/, '').trim() : '';
        out.push({ handle, note });
      }
    }
    return out;
  }

  // 貼文頁：只抓「內文裡貼出來的 threads.com/@xxx 連結」，不抓頭像、作者名、留言者名
  function grabFromPost() {
    const author = (location.pathname.match(/^\/@([A-Za-z0-9._]+)\/post\//) || [])[1];
    const text = [...document.querySelectorAll('a[href]')]
      .filter((a) => !panel.contains(a) && /threads\.(com|net)\/@/.test(a.innerText))
      .map((a) => { try { return decodeURIComponent(a.href); } catch { return a.href; } })
      .map((h) => (h.match(/threads\.(?:com|net)\/@([A-Za-z0-9._]+)/) || [])[1])
      .filter((h) => h && h !== author)
      .map((h) => '@' + h)
      .join('\n');
    return parseList(text);
  }

  const currentHandle = () => {
    const m = location.pathname.match(/^\/@([A-Za-z0-9._]+)\/?$/);
    return m ? m[1] : null;
  };

  // ---------- DOM 小工具 ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (e) => e && e.offsetParent !== null;

  function findByText(text, selector = '[role="button"],[role="menuitem"],button,[role="link"]') {
    const hits = [...document.querySelectorAll(selector)].filter((e) => visible(e) && e.innerText.trim() === text);
    if (hits.length) return hits[hits.length - 1];
    // 退一步：找文字剛好相等的葉節點，再往上找可點的元素
    const leaf = [...document.querySelectorAll('span,div')].filter(
      (e) => visible(e) && e.children.length === 0 && e.textContent.trim() === text
    ).pop();
    return leaf ? leaf.closest('[role="button"],[role="menuitem"],button,[tabindex]') || leaf : null;
  }

  async function waitFor(fn, timeout = 5000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const r = fn();
      if (r) return r;
      await sleep(200);
    }
    return null;
  }

  async function step(label, el) {
    if (!el) throw new Error(`找不到「${label}」`);
    if (state.stepMode && !confirm(`逐步模式：下一步要點「${label}」，確定？`)) throw new Error('你取消了');
    el.click();
    await sleep(900);
  }

  // 頁面上有很多顆 ⋯：頂端列一顆、頭像旁一顆、每篇貼文各一顆。
  // 頭像旁那顆 = 「N 位粉絲」同一行右邊那排圖示（IG、鈴鐺、⋯）裡最右邊那顆。
  // 不靠 aria-label 認，只靠位置，頂端列那顆跟粉絲數不同行會被排除。
  async function openProfileMenu() {
    // 錨點＝「N 位粉絲」那一行（IG、鈴鐺、⋯ 跟它同一行）。
    // 不用「追蹤」按鈕當錨點：按鈕文字會變（追蹤／追蹤對方／追蹤中），左側欄也有個「追蹤中」會認錯。
    const row = [...document.querySelectorAll('span,div')].find(
      // 最內層那個含「位粉絲」的元素（數字本身包在子 span 裡，所以不能要求沒有子元素）
      (e) => visible(e) && /位粉絲/.test(e.textContent) && ![...e.children].some((c) => /位粉絲/.test(c.textContent)) && !panel.contains(e)
    );
    if (!row) throw new Error('找不到「N 位粉絲」那一行，沒辦法定位頭像旁的 ⋯（請先捲回主頁最上面）');
    const rr = row.getBoundingClientRect();
    const mid = (rr.top + rr.bottom) / 2;
    const btns = [...document.querySelectorAll('[role="button"]')]
      .filter((b) => {
        if (!visible(b) || !b.querySelector('svg') || panel.contains(b)) return false;
        const r = b.getBoundingClientRect();
        return r.top <= mid + 4 && r.bottom >= mid - 4 && r.left > rr.right;
      })
      .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right);
    if (!btns.length) throw new Error('找不到頭像旁的 ⋯（請先捲回主頁最上面）');
    btns[0].click();
    const ok = await waitFor(() => findByText('檢舉', '[role="menuitem"]') || findByText('封鎖', '[role="menuitem"]'), 3000);
    if (ok) return true;
    const items = [...document.querySelectorAll('[role="menuitem"]')].filter(visible).map((e) => e.innerText.trim()).join('、');
    throw new Error(`點了頭像旁的 ⋯，但選單裡沒有「檢舉/封鎖」。看到的是：${items || '（沒有選單）'}`);
  }

  async function doReport(reason) {
    await openProfileMenu();
    await step('檢舉', findByText('檢舉', '[role="menuitem"]'));
    await step('檢舉個人檔案', await waitFor(() => findByText('檢舉個人檔案')));
    await step('內容不應該顯示在 Threads 上', await waitFor(() => findByText('該帳號發佈的內容不應該顯示在 Threads 上。') || findByText('該帳號發佈的內容不應該顯示在 Threads 上')));
    // 點下理由就直接送出檢舉，沒有另外的提交頁
    await step(`${reason}（點下去就會送出檢舉）`, await waitFor(() => findByText(reason)));
    // 成功頁：「謝謝你的意見回饋」＋「完成」
    const ok = await waitFor(() => findByText('謝謝你的意見回饋', 'span,div,h1,h2'), 5000);
    if (!ok) throw new Error('沒看到「謝謝你的意見回饋」，檢舉可能沒送出，已停下（沒有封鎖）。請看一下畫面。');
    const done = await waitFor(() => findByText('完成', '[role="button"],button'), 2000);
    if (done) done.click();
    else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(800);
  }

  async function doBlock() {
    if (findByText('解除封鎖', '[role="button"]')) return '已經封鎖過';
    await openProfileMenu();
    await step('封鎖（選單）', findByText('封鎖', '[role="menuitem"]'));
    await step('封鎖（確認視窗）', await waitFor(() => findByText('封鎖', '[role="button"],button')));
    return '已封鎖';
  }

  // ---------- 面板 ----------
  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:99999;width:280px;background:#1e1e1e;color:#eee;border:1px solid #444;border-radius:10px;padding:10px;font:13px/1.5 system-ui;box-shadow:0 4px 16px #0008';
  document.body.appendChild(panel);
  // 在面板裡打字／貼上時，不讓 Threads 的快捷鍵攔走
  for (const ev of ['keydown', 'keyup', 'keypress', 'paste', 'input']) panel.addEventListener(ev, (e) => { if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) e.stopPropagation(); });

  let busy = false;
  function msg(t) { const m = panel.querySelector('#trb-msg'); if (m) m.textContent = t; }

  function render() {
    const h = currentHandle();
    const total = state.queue.length;
    const item = state.queue.find((q) => q.handle === h);
    const doneCount = Object.keys(state.done).length;
    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center"><b>檢舉＋封鎖</b>
        <span style="cursor:pointer;opacity:.6" id="trb-min">－</span></div>
      <div id="trb-body">
        <div style="opacity:.8">佇列 ${total} 個 · 已處理 ${doneCount}</div>
        ${h ? `<div style="margin:6px 0">目前：<b>@${h}</b>${state.done[h] ? `（${state.done[h]}）` : ''}<br>
          理由：${item ? (item.note || '<span style="color:#f90">未查證</span>') : '<span style="opacity:.6">不在佇列</span>'}</div>` : `<div style="margin:6px 0;opacity:.7">打開某個帳號的主頁才能操作</div>
          ${/\/post\//.test(location.pathname) ? '<button id="trb-grab" style="width:100%;margin-bottom:6px">抓這篇貼文裡列的帳號</button>' : ''}`}
        <select id="trb-reason" style="width:100%;margin-bottom:6px">${REASONS.map((r) => `<option ${r === state.reason ? 'selected' : ''}>${r}</option>`).join('')}</select>
        <div style="display:flex;gap:6px">
          <button id="trb-rb" ${h ? '' : 'disabled'} style="flex:1">檢舉＋封鎖</button>
          <button id="trb-b" ${h ? '' : 'disabled'}>只封鎖</button>
          <button id="trb-next" title="快捷鍵 J">下一個 J</button>
        </div>
        <label style="display:block;margin-top:6px"><input type="checkbox" id="trb-step" ${state.stepMode ? 'checked' : ''}> 逐步模式（每點一步先問）</label>
        <div id="trb-msg" style="margin-top:6px;color:#9cf;min-height:1em"></div>
        <details style="margin-top:6px"><summary>貼名單</summary>
          <textarea id="trb-list" rows="5" style="width:100%" placeholder="一行一個：&#10;https://www.threads.com/@xxx 理由"></textarea>
          <button id="trb-load">載入（自動去重）</button> <button id="trb-clear">清空進度</button>
        </details>
      </div>`;
    panel.querySelector('#trb-min').onclick = () => { const b = panel.querySelector('#trb-body'); b.style.display = b.style.display === 'none' ? '' : 'none'; };
    panel.querySelector('#trb-reason').onchange = (e) => { state.reason = e.target.value; save(state); };
    panel.querySelector('#trb-step').onchange = (e) => { state.stepMode = e.target.checked; save(state); };
    panel.querySelector('#trb-rb').onclick = () => run(true);
    panel.querySelector('#trb-b').onclick = () => run(false);
    panel.querySelector('#trb-next').onclick = next;
    const grab = panel.querySelector('#trb-grab');
    if (grab) grab.onclick = () => {
      const added = grabFromPost().filter((q) => !state.queue.some((x) => x.handle === q.handle));
      state.queue.push(...added); save(state); render();
      msg(`從這頁抓到並新增 ${added.length} 個（重複的已略過）。只抓得到畫面上已展開的留言。`);
    };
    panel.querySelector('#trb-load').onclick = () => {
      // 文字框被 Threads 擋掉貼上時，改用瀏覽器原生的輸入框
      let text = panel.querySelector('#trb-list').value;
      if (!parseList(text).length) text = prompt('把名單貼在這裡（一行一個，或全部擠在一行也可以）：') || '';
      const added = parseList(text).filter((q) => !state.queue.some((x) => x.handle === q.handle));
      state.queue.push(...added); save(state); render(); msg(`新增 ${added.length} 個（重複的已略過）`);
    };
    panel.querySelector('#trb-clear').onclick = () => {
      if (confirm('清空佇列和已處理紀錄？')) { state = { ...state, queue: [], idx: 0, done: {} }; save(state); render(); }
    };
  }

  async function run(withReport) {
    const h = currentHandle();
    if (busy || !h) return;
    const wait = state.lastAction + COOLDOWN_MS - Date.now();
    if (wait > 0) { msg(`冷卻中，${Math.ceil(wait / 1000)} 秒後再按`); return; }
    busy = true;
    try {
      if (withReport) { msg('檢舉中…'); await doReport(state.reason); }
      msg('封鎖中…');
      const r = await doBlock();
      state.done[h] = withReport ? `已檢舉（${state.reason}）＋${r}` : r;
      state.lastAction = Date.now();
      save(state); render();
      // 做完自動跳下一個主頁，你看一眼再決定要不要按
      if (state.queue.some((q) => !state.done[q.handle])) { msg('完成，1.5 秒後跳下一個…'); await sleep(1500); next(); }
      else msg('完成');
    } catch (e) {
      msg(e.message);
    } finally {
      busy = false;
    }
  }

  function next() {
    const h = currentHandle();
    // 這個帳號早就封鎖過（畫面上是「解除封鎖」）就記成已處理，不然會一直跳回來
    if (h && !state.done[h] && findByText('解除封鎖', '[role="button"]')) { state.done[h] = '已經封鎖過'; save(state); }
    // 從目前這個的下一個開始往後找，不再每次從頭找
    const i = state.queue.findIndex((q) => q.handle === h);
    const order = [...state.queue.slice(i + 1), ...state.queue.slice(0, i + 1)];
    const todo = order.find((q) => !state.done[q.handle] && q.handle !== h);
    if (!todo) { msg('佇列已全部處理完'); return; }
    location.href = `/@${todo.handle}`;
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'j' && e.key !== 'J') return;
    const t = e.target;
    if (t && (t.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(t.tagName))) return;
    next();
  });

  // Threads 是單頁應用，換頁不會重新載入；網址變了就重畫面板
  let lastPath = location.pathname;
  let skipping = false;
  setInterval(() => {
    if (location.pathname !== lastPath) { lastPath = location.pathname; skipping = false; state = load(); render(); }
    // 帳號已刪除或被停權時，Threads 會顯示「這個頁面真的走丟了」：記成已處理，1.5 秒後自動跳下一個
    const h = currentHandle();
    if (!h || skipping || busy || state.done[h] || !document.body.innerText.includes('頁面真的走丟了')) return;
    skipping = true;
    state.done[h] = '帳號不存在';
    save(state); render();
    msg('這個帳號已不存在，1.5 秒後跳下一個…');
    setTimeout(next, 1500);
  }, 500);
  render();
})();
