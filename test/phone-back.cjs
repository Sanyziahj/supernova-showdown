/**
 * Real-pointer phone BACK regressions for SuperNova Showdown.
 * Headless touch emulation, not a physical phone.
 *
 * Usage: node test/phone-back.cjs [url] [artifactDir]
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const URL = process.argv[2] || 'file:///workspace/index.html';
const OUT = process.argv[3] || '/opt/cursor/artifacts';
const ONLY = process.env.ONLY || '';
fs.mkdirSync(OUT, { recursive: true });

const R = [];
const ok = (n, c, d) => {
  R.push((c ? 'PASS ' : 'FAIL ') + n + (d !== undefined ? ' ' + JSON.stringify(d) : ''));
  if (!c) console.error('FAIL', n, d !== undefined ? JSON.stringify(d) : '');
};
const sleep = (p, ms) => p.waitForTimeout(ms);

function pct(sorted, q) {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i];
}

async function boot(browser, width, height) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  const errs = [];
  await page.addInitScript(() => { window.__SN_DEBUG = true; });
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (x) => { if (x.type() === 'error') errs.push(x.text()); });
  await page.goto(URL);
  await page.waitForFunction(() => window.__SN && __SN.G && __SN.G.state === 'title', { timeout: 8000 });
  await sleep(page, 200);
  page.__errs = errs;
  page.__cdp = await ctx.newCDPSession(page);
  return page;
}

async function box(page, sel) {
  const b = await page.locator(sel).first().boundingBox();
  if (!b) throw new Error('missing box ' + sel);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, b };
}

async function tap(page, sel) {
  const { x, y } = await box(page, sel);
  await page.touchscreen.tap(x, y);
}

async function hold(page, sel, ms) {
  const { x, y } = await box(page, sel);
  const cdp = page.__cdp;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
  await sleep(page, ms);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function snap(page) {
  return page.evaluate(() => {
    const P = __SN.P;
    const back = document.querySelector('[data-srml=back]');
    return {
      state: __SN.G.state,
      st: +__SN.G.st.toFixed(3),
      level: __SN.G.level,
      paused: __SN.G.paused,
      rider: __SN.G.rider,
      pstate: P.state,
      attack: !!P.input.attack,
      attackE: !!P.input.attackE,
      x: +P.x.toFixed(2),
      z: +P.z.toFixed(2),
      hp: P.hp,
      lives: P.lives,
      score: P.score,
      prize: !!document.getElementById('prize').hidden,
      back: back ? back.textContent : '',
      atkOn: document.querySelector('[data-b=attack]').classList.contains('on'),
    };
  });
}

async function armAtk(page) {
  await page.evaluate(() => {
    window.__sawAtk = false;
    const P = __SN.P;
    P.state = 'idle';
    P.input.attack = false;
    P.input.attackE = false;
    P.input.jump = false;
    P.input.jumpE = false;
    clearInterval(window.__atkWatch);
    window.__atkWatch = setInterval(() => {
      const Q = __SN.P;
      if (Q.state === 'atk' || Q.input.attack || Q.input.attackE) window.__sawAtk = true;
    }, 8);
  });
}

async function sawAtk(page) {
  return page.evaluate(() => !!window.__sawAtk);
}

async function waitPred(page, pred, n = 30, ms = 50) {
  for (let i = 0; i < n; i++) {
    if (await page.evaluate(pred)) return true;
    await sleep(page, ms);
  }
  return false;
}

function inflate(r, m) {
  return { x: r.x - m, y: r.y - m, width: r.width + m * 2, height: r.height + m * 2 };
}
function overlaps(a, b, pad = 0) {
  return a.x < b.x + b.width - pad && a.x + a.width > b.x + pad && a.y < b.y + b.height - pad && a.y + a.height > b.y + pad;
}
function inside(a, w, h, slop = 0.75) {
  return a.x >= -slop && a.y >= -slop && a.x + a.width <= w + slop && a.y + a.height <= h + slop;
}
function gap(a, b) {
  const dx = Math.max(0, Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width)));
  const dy = Math.max(0, Math.max(b.y - (a.y + a.height), a.y - (b.y + b.height)));
  if (dx === 0 && dy === 0) return 0;
  if (dx === 0) return dy;
  if (dy === 0) return dx;
  return Math.hypot(dx, dy);
}

async function layoutAudit(page, tag, safe) {
  const data = await page.evaluate((safe) => {
    const vis = (el) => {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width > 2 && r.height > 2;
    };
    const pick = (el) => {
      const r = el.getBoundingClientRect();
      return {
        id: el.id || '',
        srml: el.dataset.srml || '',
        b: el.dataset.b || '',
        text: (el.textContent || '').trim().slice(0, 16),
        x: r.x, y: r.y, width: r.width, height: r.height,
      };
    };
    const nodes = [...document.querySelectorAll('#srml-menu .srml-b, #srml-dir .srml-b, #srml-act .srml-b')].filter(vis);
    const canvas = pick(document.querySelector('#game'));
    const helpEl = document.querySelector('#help');
    const help = helpEl && vis(helpEl) ? pick(helpEl) : null;
    return {
      buttons: nodes.map(pick),
      canvas,
      help,
      vw: innerWidth,
      vh: innerHeight,
      scrollW: document.documentElement.scrollWidth,
      scrollH: document.documentElement.scrollHeight,
      coarse: matchMedia('(pointer:coarse)').matches,
      srml: document.documentElement.classList.contains('srml'),
      safe,
    };
  }, safe || null);

  ok(tag + ' coarse phone layer', data.coarse && data.srml, { coarse: data.coarse, srml: data.srml });
  ok(tag + ' no horizontal overflow', data.scrollW <= data.vw + 1, { scrollW: data.scrollW, vw: data.vw });
  const ar = data.canvas.width / data.canvas.height;
  ok(tag + ' canvas keeps 384:216', Math.abs(ar - 384 / 216) < 0.03 && data.canvas.width > 80, { ar, canvas: data.canvas });

  const labels = data.buttons.map((b) => b.text);
  ok(tag + ' BACK START OK ATTACK JUMP SPECIAL labeled',
    labels.includes('BACK') && labels.includes('START') && labels.includes('OK') && labels.includes('ATTACK') && labels.includes('JUMP') && labels.includes('SPECIAL'),
    labels);

  const viewSafe = safe
    ? { x: safe.left, y: safe.top, r: data.vw - safe.right, b: data.vh - safe.bottom }
    : { x: 0, y: 0, r: data.vw, b: data.vh };

  const problems = [];
  for (const btn of data.buttons) {
    const min = Math.min(btn.width, btn.height);
    if (min < 42) problems.push({ kind: 'small', btn, min });
    if (!inside(btn, data.vw, data.vh)) problems.push({ kind: 'clip', btn });
    if (btn.x < viewSafe.x - 0.75 || btn.y < viewSafe.y - 0.75 || btn.x + btn.width > viewSafe.r + 0.75 || btn.y + btn.height > viewSafe.b + 0.75)
      problems.push({ kind: 'safe', btn, viewSafe });
    if (overlaps(btn, data.canvas, 0.5)) problems.push({ kind: 'canvas', btn });
  }
  if (data.help) {
    if (overlaps(data.help, data.canvas, 0.5)) problems.push({ kind: 'help-canvas', help: data.help });
    for (const btn of data.buttons) if (overlaps(data.help, btn, 0.5)) problems.push({ kind: 'help-btn', btn: btn.text });
  }
  for (let i = 0; i < data.buttons.length; i++) {
    for (let j = i + 1; j < data.buttons.length; j++) {
      const g = gap(data.buttons[i], data.buttons[j]);
      if (g < 2) problems.push({ kind: 'gap', a: data.buttons[i].text || data.buttons[i].b, b: data.buttons[j].text || data.buttons[j].b, g: +g.toFixed(2) });
    }
  }
  ok(tag + ' rest targets inside screen, clear gaps, no canvas overlap', problems.length === 0, problems.slice(0, 8));

  // Pressed / hovered glow-grow: hold each control and measure the transformed border box.
  const pressedProblems = [];
  const sels = [
    '[data-srml=back]', '[data-b=start]', '[data-srml=ok]',
    '[data-b=up]', '[data-b=left]', '[data-b=right]', '[data-b=down]',
    '[data-b=attack]', '[data-b=jump]', '[data-b=special]',
  ];
  for (const sel of sels) {
    const cdp = page.__cdp;
    let pt;
    try { pt = await box(page, sel); } catch (e) { pressedProblems.push({ sel, err: String(e.message || e) }); continue; }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pt.x, y: pt.y, id: 1 }] });
    await sleep(page, 40);
    let live;
    try {
    live = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      const canvas = document.querySelector('#game').getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const others = [...document.querySelectorAll('#srml-menu .srml-b, #srml-dir .srml-b, #srml-act .srml-b')]
        .filter((n) => n !== el && getComputedStyle(n).display !== 'none')
        .map((n) => {
          const b = n.getBoundingClientRect();
          return { text: (n.textContent || '').trim().slice(0, 12), x: b.x, y: b.y, width: b.width, height: b.height };
        });
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return {
        on: el.classList.contains('on'),
        scale: getComputedStyle(el).transform,
        x: r.x, y: r.y, width: r.width, height: r.height,
        canvas: { x: canvas.x, y: canvas.y, width: canvas.width, height: canvas.height },
        others,
        hitOk: !!(hit && (hit === el || el.contains(hit))),
        vw: innerWidth, vh: innerHeight,
      };
    }, sel);
    } finally {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
    await sleep(page, 30);
    const rect = live;
    if (!live.on) pressedProblems.push({ sel, kind: 'not-pressed' });
    if (!inside(rect, live.vw, live.vh)) pressedProblems.push({ sel, kind: 'clip', rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, vw: live.vw, vh: live.vh });
    // 4px shadow spread should also stay on screen
    const glow = inflate(rect, 4);
    if (!inside(glow, live.vw, live.vh, 1)) pressedProblems.push({ sel, kind: 'glow-clip', glow });
    if (overlaps(rect, live.canvas, 0.5)) pressedProblems.push({ sel, kind: 'canvas', rect, canvas: live.canvas });
    if (safe) {
      if (rect.x < safe.left - 0.75 || rect.y < safe.top - 0.75 || rect.x + rect.width > live.vw - safe.right + 0.75 || rect.y + rect.height > live.vh - safe.bottom + 0.75)
        pressedProblems.push({ sel, kind: 'safe', rect, safe });
    }
    for (const o of live.others) {
      if (overlaps(rect, o, 0.5)) pressedProblems.push({ sel, kind: 'neighbor', other: o.text });
    }
    if (!live.hitOk) pressedProblems.push({ sel, kind: 'center-miss' });
  }
  ok(tag + ' pressed glow/grow stays inside screen and off the canvas', pressedProblems.length === 0, pressedProblems.slice(0, 6));
  // Real presses can arm Start or Attack. Let that edge flush, then return to the title.
  await sleep(page, 120);
  await page.evaluate(() => {
    const prize = document.getElementById('prize');
    if (prize) prize.hidden = true;
    __SN.G.state = 'title';
    __SN.G.st = 0.4;
    __SN.G.level = 0;
    __SN.G.paused = false;
    __SN.G.rider = 0;
    const P = __SN.P;
    if (P && P.input) {
      P.state = 'idle';
      P.input.left = P.input.right = P.input.up = P.input.down = false;
      P.input.jump = P.input.attack = P.input.special = false;
      P.input.jumpE = P.input.attackE = P.input.specialE = false;
    }
  });
  await sleep(page, 80);
  return data;
}

async function shot(page, name) {
  const file = path.join(OUT, name + '.png');
  await page.screenshot({ path: file });
  return file;
}

async function runPhone(browser, width, height, tag) {
  const page = await boot(browser, width, height);
  const preserve = await page.evaluate(() => ({
    game: window.__SR_GAME,
    poster: String(window.__POSTER_SRC || '').slice(0, 23),
    stamp: typeof window.__SR_STAMP,
    title: document.title,
    backMap: window.__SRML && window.__SRML.back,
    okMap: window.__SRML && window.__SRML.ok,
  }));
  ok(tag + ' canon metadata intact', preserve.game === 'SNS' && preserve.poster === 'data:image/jpeg;base64,' && preserve.stamp === 'object' && preserve.title.indexOf('SuperNova Showdown') >= 0, preserve);
  ok(tag + ' BACK is not mapped to attack', preserve.backMap === 'back' && preserve.okMap === 'start', preserve);

  if (!ONLY || ONLY === 'layout') await layoutAudit(page, tag + ' title', null);

  if (ONLY === 'layout') {
    await shot(page, 'headless_touch_' + tag + '_title');
    ok(tag + ' no page errors', page.__errs.length === 0, page.__errs);
    await page.context().close();
    return;
  }

  // Title selection: D-pad changes rider, BACK does not launch or attack.
  await armAtk(page);
  const rider0 = (await snap(page)).rider;
  await tap(page, '[data-b=right]');
  await sleep(page, 80);
  const afterRight = await snap(page);
  ok(tag + ' d-pad selects next rider', afterRight.rider === (rider0 + 1) % 4 && afterRight.state === 'title', afterRight);
  await tap(page, '[data-b=left]');
  await sleep(page, 80);
  ok(tag + ' d-pad selects previous rider', (await snap(page)).rider === rider0, await snap(page));
  await tap(page, '[data-b=right]');
  await sleep(page, 40);
  const chosen = (await snap(page)).rider;
  await armAtk(page);
  for (let i = 0; i < 5; i++) { await tap(page, '[data-srml=back]'); await sleep(page, 70); }
  await sleep(page, 400);
  let s = await snap(page);
  ok(tag + ' rapid BACK does not launch or attack', s.state === 'title' && s.rider === chosen && !(await sawAtk(page)), s);

  await armAtk(page);
  await hold(page, '[data-srml=back]', 500);
  await sleep(page, 200);
  s = await snap(page);
  ok(tag + ' held BACK does not repeat, launch, or attack', s.state === 'title' && s.rider === chosen && !(await sawAtk(page)), s);

  // Instructions / intro card: BACK returns to title and does not fall through into play.
  await armAtk(page);
  await tap(page, '[data-srml=ok]');
  ok(tag + ' OK opens the intro', await waitPred(page, () => __SN.G.state === 'intro'), await snap(page));
  await armAtk(page);
  await tap(page, '[data-srml=back]');
  await sleep(page, 80);
  s = await snap(page);
  ok(tag + ' BACK returns from intro without attacking', s.state === 'title' && !(await sawAtk(page)), s);
  await sleep(page, 900);
  s = await snap(page);
  ok(tag + ' intro BACK does not enter-then-exit into play', s.state === 'title', s);

  await shot(page, 'headless_touch_' + tag + '_title');

  // Start and reach active level 1.
  await tap(page, '[data-b=start]');
  ok(tag + ' START reaches active play', await waitPred(page, () => __SN.G.state === 'play', 40, 100), await snap(page));
  s = await snap(page);
  ok(tag + ' level 1 is active', s.level === 0 && s.state === 'play' && !s.paused, s);
  await page.evaluate(() => { __SN.god(); __SN.P.state = 'idle'; __SN.P.input.attack = false; __SN.P.input.attackE = false; });
  await sleep(page, 100);
  await shot(page, 'headless_touch_' + tag + '_level1_active');

  // Pause / resume.
  const before = await snap(page);
  await armAtk(page);
  await tap(page, '[data-srml=back]');
  await sleep(page, 120);
  s = await snap(page);
  ok(tag + ' BACK pauses level 1 without attack or progress loss',
    s.paused && s.state === 'play' && s.level === 0 && s.hp === before.hp && s.score === before.score && s.lives === before.lives && s.back === 'RESUME' && !(await sawAtk(page)) && Math.abs(s.x - before.x) < 1,
    { before, s, saw: await sawAtk(page) });
  await sleep(page, 350);
  s = await snap(page);
  ok(tag + ' one BACK tap stays paused', s.paused && s.state === 'play', s);
  await shot(page, 'headless_touch_' + tag + '_level1_paused');

  // A new press resumes, so the hold has to begin as the pause press itself.
  await page.evaluate(() => { __SN.G.paused = false; __SN.P.state = 'idle'; });
  await armAtk(page);
  {
    const pt = await box(page, '[data-srml=back]');
    await page.__cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pt.x, y: pt.y, id: 1 }] });
    await sleep(page, 80);
    const mid = await snap(page);
    await sleep(page, 420);
    const late = await snap(page);
    await page.__cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(page, 120);
    const up = await snap(page);
    ok(tag + ' holding BACK pauses once and release does not resume or attack',
      mid.paused && late.paused && up.paused && up.state === 'play' && !(await sawAtk(page)),
      { mid: mid.paused, late: late.paused, up: up.paused, saw: await sawAtk(page) });
  }

  const frozen = await snap(page);
  await hold(page, '[data-b=right]', 350);
  s = await snap(page);
  ok(tag + ' paused level 1 does not move', s.paused && Math.abs(s.x - frozen.x) < 0.6, { frozen, s });

  await armAtk(page);
  await sleep(page, 80);
  await tap(page, '[data-srml=back]');
  await sleep(page, 150);
  s = await snap(page);
  ok(tag + ' second BACK tap resumes', !s.paused && s.state === 'play' && s.back === 'BACK' && !(await sawAtk(page)), s);

  // START and OK still pause and resume.
  await tap(page, '[data-b=start]');
  await sleep(page, 150);
  ok(tag + ' START pauses', (await snap(page)).paused === true, await snap(page));
  await tap(page, '[data-b=start]');
  await sleep(page, 150);
  ok(tag + ' START resumes', (await snap(page)).paused === false, await snap(page));
  await tap(page, '[data-srml=ok]');
  await sleep(page, 150);
  ok(tag + ' OK pauses', (await snap(page)).paused === true, await snap(page));
  await tap(page, '[data-srml=back]');
  await sleep(page, 120);
  ok(tag + ' BACK resumes after OK pause', (await snap(page)).paused === false, await snap(page));

  // Real movement and attack.
  const x0 = (await snap(page)).x;
  await hold(page, '[data-b=right]', 280);
  const x1 = (await snap(page)).x;
  ok(tag + ' d-pad still moves in level 1', x1 > x0 + 8, { x0, x1 });
  await armAtk(page);
  await hold(page, '[data-b=attack]', 80);
  await sleep(page, 60);
  ok(tag + ' ATTACK still attacks', await sawAtk(page), await snap(page));
  await armAtk(page);
  await hold(page, '[data-b=jump]', 70);
  await sleep(page, 40);
  const jumped = await page.evaluate(() => __SN.P.state === 'air' || __SN.P.h > 0 || window.__sawAtk);
  // jump is not an attack; record air state explicitly
  const air = await page.evaluate(() => ({ state: __SN.P.state, h: __SN.P.h }));
  ok(tag + ' JUMP still jumps', air.state === 'air' || air.h > 0, air);

  // Death: BACK returns to title. A later continue still works from the overlay.
  await page.evaluate(() => {
    const P = __SN.P;
    __SN.G.paused = false;
    __SN.G.state = 'play';
    P.dead = false;
    P.lives = 0;
    P.maxHp = 16;
    P.hp = 0;
    P.h = 0;
    P.state = 'down';
    P.st = 0.05;
  });
  ok(tag + ' defeat opens continue', await waitPred(page, () => __SN.G.state === 'over', 40, 50), await snap(page));
  await sleep(page, 650);
  await armAtk(page);
  await tap(page, '[data-srml=back]');
  await sleep(page, 200);
  s = await snap(page);
  ok(tag + ' BACK cancels continue and returns to title', s.state === 'title' && !(await sawAtk(page)), s);
  await sleep(page, 400);
  ok(tag + ' continue cancel stays on title', (await snap(page)).state === 'title', await snap(page));

  await page.evaluate(() => { __SN.G.state = 'over'; __SN.G.st = 1; __SN.G.cont = 8; __SN.G.paused = false; __SN.P.dead = true; });
  await sleep(page, 80);
  await tap(page, '[data-b=start]');
  await sleep(page, 200);
  s = await snap(page);
  ok(tag + ' START still retries from defeat', s.state === 'play' && !s.paused && __safeLives(s), s);

  // Stage-clear overlay: BACK must not skip ahead or attack. ATTACK still continues.
  await page.evaluate(() => { __SN.G.state = 'clear'; __SN.G.level = 0; __SN.G.st = 2; __SN.G.paused = false; });
  await sleep(page, 80);
  await armAtk(page);
  await tap(page, '[data-srml=back]');
  await sleep(page, 200);
  s = await snap(page);
  ok(tag + ' BACK does not skip a stage clear or attack', s.state === 'clear' && s.level === 0 && !(await sawAtk(page)), s);
  await tap(page, '[data-b=attack]');
  ok(tag + ' ATTACK still leaves stage clear', await waitPred(page, () => __SN.G.level === 1 && (__SN.G.state === 'intro' || __SN.G.state === 'play')), await snap(page));

  // Victory poster: JUMP opens it, BACK closes it, attack does not fire.
  await page.evaluate(() => { __SN.G.state = 'victory'; __SN.G.st = 3; __SN.G.paused = false; document.getElementById('prize').hidden = true; });
  await sleep(page, 80);
  await tap(page, '[data-b=jump]');
  ok(tag + ' JUMP opens the poster', await waitPred(page, () => __SN.G.state === 'poster' && !document.getElementById('prize').hidden), await snap(page));
  const hit = await page.evaluate(() => {
    const el = document.querySelector('[data-srml=back]');
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { top: top && (top.dataset.srml || top.id || top.tagName), back: el.textContent };
  });
  ok(tag + ' BACK stays tappable over the poster', hit.top === 'back', hit);
  await armAtk(page);
  await tap(page, '[data-srml=back]');
  await sleep(page, 200);
  s = await snap(page);
  ok(tag + ' BACK closes the poster without attacking', s.state === 'title' && s.prize === true && !(await sawAtk(page)), s);
  await sleep(page, 400);
  ok(tag + ' poster stays closed after BACK', (await snap(page)).state === 'title' && (await snap(page)).prize === true, await snap(page));

  ok(tag + ' no page errors', page.__errs.length === 0, page.__errs);
  await page.context().close();
}

function __safeLives(s) { return s.lives >= 1; }

async function desktopKeys(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1152, height: 900 }, hasTouch: false, isMobile: false });
  const page = await ctx.newPage();
  const errs = [];
  await page.addInitScript(() => { window.__SN_DEBUG = true; });
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(URL);
  await page.waitForFunction(() => window.__SN && __SN.G.state === 'title');
  await sleep(page, 150);
  const layer = await page.evaluate(() => ({
    srml: document.documentElement.classList.contains('srml'),
    help: document.getElementById('help').textContent,
    backVisible: (() => { const e = document.querySelector('[data-srml=back]'); return !!(e && e.getBoundingClientRect().width > 2); })(),
  }));
  ok('desktop keeps keyboard help and no phone layer', !layer.srml && /Arrows\/WASD/.test(layer.help) && !layer.backVisible, layer);
  await page.keyboard.press('ArrowRight');
  await sleep(page, 60);
  ok('desktop ArrowRight selects a rider', (await page.evaluate(() => __SN.G.rider)) === 1);
  await page.keyboard.press('Enter');
  ok('desktop Enter starts play', await waitPred(page, () => __SN.G.state === 'play', 40, 100));
  await page.evaluate(() => { __SN.god(); __SN.P.state = 'idle'; });
  await page.locator('#game').click();
  const x0 = await page.evaluate(() => __SN.P.x);
  await page.keyboard.down('ArrowRight');
  await sleep(page, 300);
  await page.keyboard.up('ArrowRight');
  const x1 = await page.evaluate(() => __SN.P.x);
  ok('desktop arrows still move', x1 > x0 + 8, { x0, x1 });
  await page.keyboard.press('KeyX');
  await sleep(page, 50);
  ok('desktop X still attacks', await page.evaluate(() => __SN.P.state === 'atk' || __SN.P.input.attackE));
  await page.keyboard.press('KeyP');
  await sleep(page, 80);
  ok('desktop P pauses', await page.evaluate(() => __SN.G.paused === true && __SN.G.state === 'play'));
  await page.keyboard.press('Enter');
  await sleep(page, 80);
  ok('desktop Enter resumes', await page.evaluate(() => __SN.G.paused === false));
  ok('desktop no page errors', errs.length === 0, errs);
  await ctx.close();
}

async function perf(browser) {
  const page = await boot(browser, 390, 844);
  await page.addInitScript(() => {});
  // rAF wrapper must exist before the game loop; re-hook by wrapping the current one is too late
  // if boot already started. Install by evaluating a sampler on the live loop instead.
  await tap(page, '[data-b=start]');
  ok('perf reached play', await waitPred(page, () => __SN.G.state === 'play', 40, 100));
  await page.evaluate(() => { __SN.god(); __SN.warp(180); __SN.G.paused = false; __SN.P.state = 'idle'; });
  await sleep(page, 100);

  const cdp = page.__cdp;
  const sample = () => page.evaluate(() => {
    const t0 = performance.now();
    let s = 1;
    for (let i = 0; i < 800000; i++) s = Math.imul(s ^ i, 1664525) + i | 0;
    return { ms: performance.now() - t0, s };
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const a = await sample();
  const b = await sample();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await sleep(page, 80);
  const c = await sample();
  const d = await sample();
  const base = (a.ms + b.ms) / 2;
  const slow = (c.ms + d.ms) / 2;
  const ratio = slow / base;
  ok('cpu throttle calibrates near 4x', ratio > 2.6 && ratio < 6.5, { base: +base.toFixed(1), slow: +slow.toFixed(1), ratio: +ratio.toFixed(2) });

  await page.evaluate(() => {
    window.__dts = [];
    window.__rafOn = true;
    window.__sawAtk = false;
    const orig = window.__perfRafOrig || window.requestAnimationFrame.bind(window);
    if (!window.__perfWrapped) {
      window.__perfWrapped = true;
      const native = orig;
      const wrap = (cb) => native((t) => {
        if (window.__rafOn) {
          if (window.__lastT) window.__dts.push(t - window.__lastT);
          window.__lastT = t;
        }
        cb(t);
      });
      window.requestAnimationFrame = wrap;
    }
    const watch = () => { if (__SN.P.state === 'atk' || __SN.P.input.attack) window.__sawAtk = true; };
    clearInterval(window.__atkWatch);
    window.__atkWatch = setInterval(watch, 8);
  });

  const right = await box(page, '[data-b=right]');
  const atk = await box(page, '[data-b=attack]');
  const xStart = (await snap(page)).x;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: right.x, y: right.y, id: 1 }] });
  const t0 = Date.now();
  while (Date.now() - t0 < 3200) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: atk.x, y: atk.y, id: 2 }, { x: right.x, y: right.y, id: 1 }],
    });
    await sleep(page, 30);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ x: atk.x, y: atk.y, id: 2 }] });
    await sleep(page, 90);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const result = await page.evaluate(() => {
    window.__rafOn = false;
    const dts = (window.__dts || []).slice(5);
    const P = __SN.P;
    return { dts, state: __SN.G.state, paused: __SN.G.paused, level: __SN.G.level, x: P.x, saw: !!window.__sawAtk, pstate: P.state };
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const dts = result.dts.filter((n) => n > 0 && n < 500);
  const sorted = dts.slice().sort((a, b) => a - b);
  const p95 = pct(sorted, 0.95);
  const over = dts.filter((n) => n > 25).length;
  const overPct = dts.length ? (over / dts.length) * 100 : 100;
  const active = result.state === 'play' && !result.paused && result.level === 0 && result.x > xStart + 8 && result.saw;
  ok('4x active level 1 frames p95<=20ms', active && p95 <= 20, {
    p95: +p95.toFixed(2), n: dts.length, active, x: result.x, xStart, saw: result.saw, state: result.state, paused: result.paused,
  });
  ok('4x active level 1 frames <=5% over 25ms', active && overPct <= 5, { overPct: +overPct.toFixed(2), over, n: dts.length });
  const perfPath = path.join(OUT, 'calibrated_4x_level1_raf.json');
  fs.writeFileSync(perfPath, JSON.stringify({
    label: 'headless touch emulation, not a physical phone',
    throttle: { baseMs: base, slowMs: slow, ratio },
    p95, overPct, frames: dts.length, active,
    dts,
  }, null, 2));
  console.log('PERF', JSON.stringify({ ratio: +ratio.toFixed(2), p95: +p95.toFixed(2), overPct: +overPct.toFixed(2), n: dts.length, active }));
  ok('perf no page errors', page.__errs.length === 0, page.__errs);
  await page.context().close();
}

async function safeArea(browser) {
  // Portrait notch + home indicator, then landscape side inset.
  const cases = [
    { tag: 'portrait safe', w: 390, h: 844, insets: { top: 47, left: 0, bottom: 34, right: 0 } },
    { tag: 'landscape safe', w: 844, h: 390, insets: { top: 0, left: 47, bottom: 21, right: 0 } },
  ];
  for (const c of cases) {
    const page = await boot(browser, c.w, c.h);
    let supported = true;
    try {
      await page.__cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: c.insets });
    } catch (e) {
      supported = false;
      ok(c.tag + ' CDP safe-area override', false, String(e.message || e));
    }
    if (supported) {
      await page.reload();
      await page.waitForFunction(() => window.__SN && __SN.G.state === 'title');
      await sleep(page, 250);
      const env = await page.evaluate(() => {
        const probe = document.createElement('div');
        probe.style.cssText = 'position:fixed;left:0;top:0;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
        document.body.appendChild(probe);
        const s = getComputedStyle(probe);
        const o = { top: s.paddingTop, right: s.paddingRight, bottom: s.paddingBottom, left: s.paddingLeft };
        probe.remove();
        return o;
      });
      ok(c.tag + ' env insets applied', env.top !== '0px' || env.left !== '0px' || env.bottom !== '0px', env);
      await layoutAudit(page, c.tag, c.insets);
    }
    await page.context().close();
  }
}

(async () => {
  const browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    headless: true,
  });
  try {
    if (!ONLY || ONLY === 'layout' || ONLY === 'phone') {
      await runPhone(browser, 390, 844, 'portrait');
      await runPhone(browser, 844, 390, 'landscape');
    }
    if (!ONLY || ONLY === 'safe') await safeArea(browser);
    if (!ONLY || ONLY === 'desk') await desktopKeys(browser);
    if (!ONLY || ONLY === 'perf') await perf(browser);
  } finally {
    await browser.close();
  }
  const pass = R.filter((l) => l.startsWith('PASS')).length;
  const fail = R.filter((l) => l.startsWith('FAIL')).length;
  const summary = R.join('\n') + '\nTOTAL ' + pass + ' passed / ' + fail + ' failed\n';
  fs.writeFileSync(path.join(OUT, 'phone_back_results.txt'), summary);
  console.log(summary);
  if (fail) process.exit(1);
})().catch((e) => {
  console.log(R.join('\n'));
  console.error('CRASH', e);
  try { fs.writeFileSync(path.join(OUT, 'phone_back_results.txt'), R.join('\n') + '\nCRASH ' + e.stack); } catch (_) {}
  process.exit(1);
});
