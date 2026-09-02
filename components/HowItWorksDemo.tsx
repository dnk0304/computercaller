'use client';
/* eslint-disable @next/next/no-css-tags */

/**
 * HowItWorksDemo — the approved unified auto-playing product demo.
 *
 * Ported from the Dennis-approved mockup (ken/PROJECTS/computercaller/
 * homepage-scroll-howitworks, u1 unified-autoplay, final 2026-09-01 build:
 * phone-accept opener, real synced dashboard blurred as the persistent
 * background, and the "live on a real desktop" Demo scene). Dashboard-only
 * scenes, no scroll-hijack — it plays on a timer, pauses on hover/focus and
 * via the Pause button, is keyboard-navigable (Arrow keys on the step rail),
 * announces each step through an aria-live region, and degrades to a static
 * storyboard under prefers-reduced-motion.
 *
 * The vetted markup + CSS + engine ship verbatim inside this one client
 * component so the live page matches the approved artifact exactly; the two
 * embedded screenshots were externalised to /public/demo/ to keep the JS
 * bundle small. Tradeoff: the inner markup is injected as a trusted static
 * string (no user input) rather than hand-rewritten as JSX, which removes any
 * risk of a transcription regression on this SEO-critical page.
 */
import { useEffect, useRef } from 'react';

const DEMO_CSS = `/* ===================== U1 · Unified auto-play dashboard demo ===================== */
.u1{
  --green:#16a34a; --green-d:#15803d; --green-soft:#dcfce7;
  --ink:#0f172a; --ink-2:#334155; --muted:#64748b; --faint:#94a3b8;
  --line:#e2e8f0; --line-2:#eef2f7; --bg:#f8fafc; --card:#ffffff;
  --blue:#2563eb; --shadow:0 22px 60px -24px rgba(15,23,42,.30);
  --radius:18px; --ease:cubic-bezier(.22,.61,.36,1);
}
.u1 *,.u1 *::before,.u1 *::after{box-sizing:border-box}
.u1{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--ink);background:var(--bg);-webkit-font-smoothing:antialiased}

.u1-wrap{max-width:1160px;margin:0 auto;padding:76px 24px 88px}

/* ---- Section header ---- */
.u1-head{text-align:center;max-width:640px;margin:0 auto 40px}
.u1-eyebrow{display:inline-flex;align-items:center;gap:8px;font-size:13px;font-weight:600;letter-spacing:.02em;color:var(--green-d);background:var(--green-soft);padding:6px 13px;border-radius:999px}
.u1-eyebrow .dot{width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 0 3px rgba(22,163,74,.18)}
.u1-head h2{font-size:clamp(26px,3.4vw,38px);line-height:1.12;letter-spacing:-.02em;margin:16px 0 12px;font-weight:800}
.u1-head p{font-size:16.5px;line-height:1.6;color:var(--muted);margin:0}

/* ---- Stage: frame + caption ---- */
.u1-stage{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.72fr);gap:34px;align-items:center}

/* Browser frame */
.u1-frame{position:relative;border-radius:var(--radius);background:var(--card);box-shadow:var(--shadow);border:1px solid var(--line);overflow:hidden}
.u1-bar{display:flex;align-items:center;gap:8px;padding:11px 14px;background:linear-gradient(#fbfcfe,#f4f6fa);border-bottom:1px solid var(--line-2)}
.u1-tl{width:11px;height:11px;border-radius:50%}
.u1-tl.r{background:#ff5f57}.u1-tl.y{background:#febc2e}.u1-tl.g{background:#28c840}
.u1-url{display:flex;align-items:center;gap:7px;margin-left:10px;font-size:12.5px;color:var(--faint);background:#fff;border:1px solid var(--line-2);border-radius:8px;padding:5px 11px;font-weight:500}
.u1-url svg{width:12px;height:12px;color:var(--green)}

/* The persistent real dashboard screenshot */
.u1-screen{position:relative;width:100%;aspect-ratio:1175/812;background:#eef2f7 center/cover no-repeat;background-image:url('/demo/dashboard-bg.webp')}
.u1-screen::after{content:"";position:absolute;inset:0;pointer-events:none;box-shadow:inset 0 0 0 1px rgba(15,23,42,.04)}

/* Dim veil to focus attention on the active action */
.u1-veil{position:absolute;inset:0;background:rgba(248,250,252,.62);backdrop-filter:saturate(.9) blur(.4px);opacity:0;transition:opacity .5s var(--ease);pointer-events:none}
.u1-screen.focus .u1-veil{opacity:1}

/* Highlight ring over a real UI region */
.u1-ring{position:absolute;border-radius:12px;box-shadow:0 0 0 2px var(--green),0 10px 26px -6px rgba(22,163,74,.5);opacity:0;transform:scale(.97);transition:opacity .4s var(--ease),transform .4s var(--ease);pointer-events:none}
.u1-ring::after{content:"";position:absolute;inset:-4px;border-radius:14px;border:2px solid rgba(22,163,74,.35);animation:u1pulse 1.8s var(--ease) infinite}
.u1-ring.on{opacity:1;transform:scale(1)}
@keyframes u1pulse{0%{transform:scale(.96);opacity:.9}70%{transform:scale(1.06);opacity:0}100%{opacity:0}}

/* Layers (one per scene) */
.u1-layer{position:absolute;inset:0;opacity:0;visibility:hidden;transition:opacity .45s var(--ease);pointer-events:none}
.u1-layer.on{opacity:1;visibility:visible}

/* Right conversation pane region (real app: opens the selected thread here) */
.u1-pane{position:absolute;left:56.5%;right:1.6%;top:9%;bottom:1.6%;display:flex;align-items:center;justify-content:center;padding:3% 2.4%}

/* Floating tooltip card that points at a real region */
.u1-tip{position:absolute;background:#fff;border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);padding:13px 15px;max-width:230px;transform:translateY(8px) scale(.98);opacity:0;transition:opacity .4s var(--ease),transform .4s var(--ease)}
.u1-layer.on .u1-tip{opacity:1;transform:translateY(0) scale(1)}
.u1-tip .th{display:flex;align-items:center;gap:8px;font-weight:700;font-size:13.5px}
.u1-tip .th .chk{display:inline-flex;width:19px;height:19px;border-radius:50%;background:var(--green);color:#fff;align-items:center;justify-content:center;flex:none}
.u1-tip .th .chk svg{width:12px;height:12px}
.u1-tip p{margin:6px 0 0;font-size:12.5px;line-height:1.45;color:var(--muted)}

/* Typed number pill over Quick Dial input */
.u1-dial{position:absolute;display:flex;align-items:center;padding:0 9px;background:#fff;border:1.5px solid var(--green);border-radius:9px;font-size:12.5px;font-weight:600;color:var(--ink);letter-spacing:.01em;white-space:nowrap;overflow:hidden;box-shadow:0 6px 18px -8px rgba(22,163,74,.5)}
.u1-dial .caret{display:inline-block;width:2px;height:13px;margin-left:2px;background:var(--green);animation:u1blink 1s steps(2) infinite}
@keyframes u1blink{50%{opacity:0}}
.u1-callbtn{position:absolute;display:flex;align-items:center;justify-content:center;gap:5px;background:var(--green);color:#fff;border-radius:9px;font-weight:600;font-size:11px;box-shadow:0 8px 22px -6px rgba(22,163,74,.6);transform:scale(.96);opacity:.0;transition:opacity .3s var(--ease),transform .3s var(--ease)}
.u1-callbtn svg{width:12px;height:12px}
.u1-callbtn.on{opacity:1;transform:scale(1)}
.u1-callbtn.press{animation:u1press .4s var(--ease)}
@keyframes u1press{40%{transform:scale(.93)}100%{transform:scale(1)}}

/* Call card (active + incoming) shown in the conversation pane */
.u1-call{width:100%;max-width:300px;background:#fff;border:1px solid var(--line);border-radius:18px;box-shadow:var(--shadow);padding:24px 22px;text-align:center}
.u1-call .dir{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--green-d);background:var(--green-soft);padding:5px 11px;border-radius:999px}
.u1-call.ring .dir{color:#b45309;background:#fef3c7}
.u1-call .av{width:66px;height:66px;border-radius:50%;margin:16px auto 0;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:23px;color:#fff;background:linear-gradient(135deg,#22c55e,#0ea5e9)}
.u1-call.ring .av{background:linear-gradient(135deg,#f59e0b,#ef4444);animation:u1shake 1s var(--ease) infinite}
@keyframes u1shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-3px)}75%{transform:translateX(3px)}}
.u1-call .nm{font-weight:700;font-size:18px;margin-top:12px}
.u1-call .no{font-size:12.5px;color:var(--faint);margin-top:3px}
.u1-call .tmr{font-size:13.5px;color:var(--green-d);font-weight:600;margin-top:9px;font-variant-numeric:tabular-nums}
.u1-call .ctrls{display:flex;justify-content:center;gap:14px;margin-top:20px}
.u1-cbtn{width:46px;height:46px;border-radius:50%;border:1px solid var(--line);background:#fff;color:var(--ink-2);display:flex;align-items:center;justify-content:center;cursor:pointer}
.u1-cbtn svg{width:19px;height:19px}
.u1-cbtn.end{background:#ef4444;border-color:#ef4444;color:#fff}
.u1-cbtn.answer{background:var(--green);border-color:var(--green);color:#fff}
.u1-cbtn.active{background:var(--ink);border-color:var(--ink);color:#fff}

/* Message thread inside the conversation pane */
.u1-thread{width:100%;height:100%;display:flex;flex-direction:column;background:#fff;border:1px solid var(--line);border-radius:16px;overflow:hidden;box-shadow:var(--shadow)}
.u1-th-top{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--line-2)}
.u1-th-av{width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;color:#fff;background:linear-gradient(135deg,#6366f1,#8b5cf6)}
.u1-th-top b{font-size:14px;display:block}
.u1-th-top small{font-size:11px;color:var(--faint)}
.u1-th-body{flex:1;padding:14px;display:flex;flex-direction:column;gap:9px;overflow:hidden;justify-content:flex-end}
.u1-bub{max-width:78%;padding:9px 13px;border-radius:15px;font-size:13.5px;line-height:1.4;transform:translateY(8px) scale(.96);opacity:0;animation:u1pop .34s var(--ease) forwards}
@keyframes u1pop{to{transform:none;opacity:1}}
.u1-bub.in{align-self:flex-start;background:var(--line-2);color:var(--ink);border-bottom-left-radius:5px}
.u1-bub.out{align-self:flex-end;background:var(--green);color:#fff;border-bottom-right-radius:5px}
.u1-bub .stat{display:block;font-size:10.5px;opacity:.8;margin-top:3px;text-align:right}
.u1-tmpl{display:flex;flex-wrap:wrap;gap:7px;padding:0 14px 6px}
.u1-tmpl[hidden]{display:none}
.u1-chip{font-size:12px;font-weight:600;color:var(--green-d);background:var(--green-soft);border:1px solid transparent;border-radius:999px;padding:6px 12px;cursor:pointer;transition:.2s var(--ease)}
.u1-chip.sel{background:var(--green);color:#fff;transform:translateY(-2px)}
.u1-compose{display:flex;align-items:center;gap:8px;padding:10px 12px;border-top:1px solid var(--line-2)}
.u1-cinput{flex:1;min-height:34px;border:1px solid var(--line);border-radius:10px;padding:8px 11px;font-size:13px;color:var(--ink);display:flex;align-items:center}
.u1-cinput .caret{display:inline-block;width:2px;height:15px;background:var(--green);margin-left:1px;animation:u1blink 1s steps(2) infinite}
.u1-cinput:empty::before{content:"Type a message…";color:var(--faint)}
.u1-send{width:34px;height:34px;border-radius:10px;background:var(--green);color:#fff;display:flex;align-items:center;justify-content:center;flex:none}
.u1-send svg{width:16px;height:16px}

/* Incoming conversation row landing in the Messages column */
.u1-msgrow{position:absolute;left:32.3%;width:20.4%;background:#fff;border:1px solid var(--green);border-radius:11px;box-shadow:0 12px 26px -10px rgba(22,163,74,.4);padding:9px 10px;transform:translateX(-10px);opacity:0;transition:opacity .4s var(--ease),transform .4s var(--ease)}
.u1-msgrow.on{opacity:1;transform:none}
.u1-msgrow .mr-top{display:flex;align-items:center;gap:6px}
.u1-msgrow .mr-av{width:22px;height:22px;border-radius:50%;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;flex:none}
.u1-msgrow b{font-size:11.5px;white-space:nowrap}
.u1-msgrow .mr-dot{width:7px;height:7px;border-radius:50%;background:var(--green);margin-left:auto}
.u1-msgrow .mr-msg{font-size:10.5px;color:var(--muted);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* Contact search results dropdown */
.u1-results{position:absolute;background:#fff;border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow);overflow:hidden;transform:translateY(-6px);opacity:0;transition:opacity .35s var(--ease),transform .35s var(--ease)}
.u1-results.on{opacity:1;transform:none}
.u1-res{display:flex;align-items:center;gap:9px;padding:9px 12px;border-bottom:1px solid var(--line-2)}
.u1-res:last-child{border-bottom:0}
.u1-res .r-av{width:26px;height:26px;border-radius:50%;color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex:none}
.u1-res b{font-size:12.5px;display:block;white-space:nowrap}
.u1-res small{font-size:10.5px;color:var(--faint);white-space:nowrap}

/* Caption panel */
.u1-cap{padding:4px 6px}
.u1-cap .stepn{font-size:12.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--green-d);display:flex;align-items:center;gap:8px}
.u1-cap .stepn .n{display:inline-flex;width:24px;height:24px;border-radius:7px;background:var(--green-soft);align-items:center;justify-content:center;font-size:12px}
.u1-cap h3{font-size:clamp(20px,2.3vw,25px);line-height:1.2;letter-spacing:-.01em;margin:14px 0 10px;font-weight:800}
.u1-cap p{font-size:15px;line-height:1.6;color:var(--muted);margin:0}
.u1-cap .capfx{transition:opacity .35s var(--ease),transform .35s var(--ease)}
.u1-cap.swap .capfx{opacity:0;transform:translateY(6px)}

/* Steps rail */
.u1-steps{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-top:38px;list-style:none;padding:0}
.u1-step{position:relative;display:inline-flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:var(--muted);background:#fff;border:1px solid var(--line);border-radius:999px;padding:8px 15px 8px 13px;cursor:pointer;overflow:hidden;transition:.25s var(--ease)}
.u1-step .sd{width:8px;height:8px;border-radius:50%;background:var(--line);flex:none;transition:.25s var(--ease)}
.u1-step[aria-current="true"]{color:var(--ink);border-color:var(--green);box-shadow:0 6px 18px -10px rgba(22,163,74,.6)}
.u1-step[aria-current="true"] .sd{background:var(--green)}
.u1-step .fill{position:absolute;left:0;top:0;bottom:0;width:100%;background:rgba(22,163,74,.10);transform-origin:left;transform:scaleX(0)}
.u1-step[aria-current="true"] .fill.run{animation:u1fill linear forwards}
@keyframes u1fill{from{transform:scaleX(0)}to{transform:scaleX(1)}}
.u1-step:focus-visible{outline:2px solid var(--green);outline-offset:2px}

.u1-controls{display:flex;align-items:center;justify-content:center;gap:10px;margin-top:16px;font-size:12.5px;color:var(--faint)}
.u1-pause{display:inline-flex;align-items:center;gap:6px;background:#fff;border:1px solid var(--line);border-radius:999px;padding:6px 13px;font-weight:600;color:var(--ink-2);cursor:pointer}
.u1-pause svg{width:13px;height:13px}
.u1-pause:focus-visible{outline:2px solid var(--green);outline-offset:2px}

/* Preview ribbon */
/* Pairing phone (scene 1 opener) */
.u1-phone{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%) scale(.96);width:27%;max-width:232px;z-index:6;opacity:0;transition:opacity .5s var(--ease),transform .5s var(--ease);pointer-events:none}
.u1-layer.on .u1-phone.show{opacity:1;transform:translate(-50%,-50%) scale(1)}
.u1-phone.gone{opacity:0;transform:translate(-50%,-58%) scale(.94)}
.u1-phone-shell{position:relative;background:#0b1220;border-radius:30px;padding:7px;box-shadow:0 40px 70px -24px rgba(11,18,32,.62)}
.u1-phone-screen{position:relative;background:#f4f6fa;border-radius:24px;overflow:hidden;aspect-ratio:9/17.6;display:flex;flex-direction:column}
.u1-phone-notch{position:absolute;top:7px;left:50%;transform:translateX(-50%);width:32%;height:13px;background:#0b1220;border-radius:0 0 11px 11px;z-index:3}
.u1-phone-status{display:flex;align-items:center;justify-content:space-between;padding:9px 16px 4px;font-size:10px;font-weight:600;color:#0f172a}
.u1-phone-status svg{width:12px;height:12px}
.u1-phone-body{flex:1;display:flex;flex-direction:column;justify-content:center;padding:12px}
.u1-req{background:#fff;border-radius:16px;border:1px solid var(--line);box-shadow:var(--shadow);padding:15px 13px;text-align:center}
.u1-req .rq-ic{width:42px;height:42px;border-radius:12px;background:var(--green-soft);color:var(--green-d);display:grid;place-items:center;margin:0 auto 9px}
.u1-req .rq-ic svg{width:22px;height:22px}
.u1-req h5{margin:0;font-size:13.5px;font-weight:700;color:var(--ink)}
.u1-req .rq-sub{font-size:10.5px;color:var(--muted);margin-top:5px;line-height:1.4}
.u1-req .rq-dev{display:inline-flex;align-items:center;gap:5px;margin-top:9px;font-size:10px;font-weight:600;color:var(--ink-2);background:var(--bg);border:1px solid var(--line);border-radius:999px;padding:4px 9px}
.u1-req .rq-dev svg{width:11px;height:11px;color:var(--muted)}
.u1-req-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}
.u1-pbtn{border:0;border-radius:10px;padding:9px;font-size:12px;font-weight:650;font-family:inherit;cursor:default}
.u1-pbtn.decline{background:var(--bg);color:var(--ink-2);border:1px solid var(--line)}
.u1-pbtn.accept{background:var(--green);color:#fff;position:relative;overflow:hidden}
.u1-pbtn.accept.tap::after{content:"";position:absolute;inset:0;background:radial-gradient(circle,rgba(255,255,255,.55),transparent 60%);animation:u1tap 1s ease-out}
@keyframes u1tap{from{opacity:1;transform:scale(.2)}to{opacity:0;transform:scale(2.6)}}
.u1-pdone{text-align:center;display:flex;flex-direction:column;align-items:center;gap:11px;padding:8px 6px}
.u1-pdone .pd-ic{width:56px;height:56px;border-radius:18px;background:var(--green);color:#fff;display:grid;place-items:center;box-shadow:0 14px 26px -12px rgba(22,163,74,.6);position:relative}
.u1-pdone .pd-ic svg{width:28px;height:28px}
.u1-pdone .pd-ic::after{content:"";position:absolute;inset:-7px;border-radius:24px;border:2px solid rgba(22,163,74,.35);animation:u1ping 1.6s ease-out infinite}
@keyframes u1ping{0%{transform:scale(.92);opacity:.8}100%{transform:scale(1.3);opacity:0}}
.u1-pdone h5{margin:0;font-size:14px;font-weight:700;color:var(--ink)}
.u1-pdone p{margin:0;font-size:11px;color:var(--muted);line-height:1.45}
.u1-layer.on .u1-tip.hold{opacity:0;transform:translateY(8px) scale(.98)}
.u1-layer.on .u1-tip.hold.reveal{opacity:1;transform:translateY(0) scale(1)}
.u1-ribbon{position:absolute;right:12px;bottom:12px;z-index:5;display:inline-flex;align-items:center;gap:7px;background:rgba(15,23,42,.86);color:#fff;font-size:11px;font-weight:700;letter-spacing:.03em;padding:6px 12px;border-radius:999px;backdrop-filter:blur(4px)}
.u1-ribbon .rd{width:7px;height:7px;border-radius:50%;background:#febc2e;box-shadow:0 0 0 3px rgba(254,188,46,.25)}

.u1-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}

/* Reduced-motion static storyboard */
.u1-static{display:none}

/* ============ Fluid mobile & tablet (max-width:900px) ============
   Below the desktop grid, the whole demo scales proportionally instead of
   jumping at fixed breakpoints. Section chrome (headings, caption, rail,
   paddings) scales with the viewport via clamp()+vw; everything INSIDE the
   browser frame scales with the frame itself via container-query units (cqw),
   so the mockup stays correctly proportioned on any phone or tablet — small
   phone, large phone, or tablet — and simply grows smoothly between them.
   Desktop (>=901px) is untouched. */
@media (max-width:900px){
  .u1-wrap{padding:clamp(38px,7vw,56px) clamp(14px,4.5vw,18px) clamp(46px,9vw,64px)}
  .u1-head{margin-bottom:clamp(22px,5vw,40px)}
  .u1-head h2{font-size:clamp(23px,6.2vw,34px)}
  .u1-head p{font-size:clamp(14px,3.7vw,16.5px)}

  .u1-stage{grid-template-columns:1fr;gap:clamp(16px,4vw,24px)}
  .u1-cap{order:2;text-align:center;max-width:520px;margin:0 auto}
  .u1-cap .stepn{justify-content:center}
  .u1-cap h3{font-size:clamp(19px,5vw,25px)}
  .u1-cap p{font-size:clamp(13.5px,3.6vw,15px)}

  /* Frame: fluid width, centered, and a query container for its contents */
  .u1-frame{order:1;width:100%;max-width:clamp(288px,90vw,600px);margin-inline:auto;container-type:inline-size}

  /* --- everything below scales with the frame width (cqw) --- */
  .u1-tip{max-width:52cqw;padding:2.6cqw 3cqw}
  .u1-tip .th{font-size:clamp(11px,3.7cqw,14px);gap:2cqw}
  .u1-tip .th .chk{width:clamp(15px,5cqw,19px);height:clamp(15px,5cqw,19px)}
  .u1-tip p{display:none}

  /* Action pane centered with the dense dashboard column kept at the left */
  .u1-pane{left:22%;right:3%;top:8%;bottom:2%;padding:2%}

  /* Call card */
  .u1-call{max-width:none;padding:clamp(10px,3.4cqw,20px) clamp(10px,3.2cqw,18px)}
  .u1-call .dir{font-size:clamp(8.5px,2.9cqw,11.5px);padding:clamp(3px,1cqw,5px) clamp(7px,2.4cqw,11px)}
  .u1-call .av{width:clamp(38px,12cqw,66px);height:clamp(38px,12cqw,66px);font-size:clamp(15px,4.6cqw,23px);margin-top:clamp(6px,2cqw,16px)}
  .u1-call .nm{font-size:clamp(14px,4.4cqw,18px);margin-top:clamp(5px,1.8cqw,12px)}
  .u1-call .no{font-size:clamp(10px,3.1cqw,12.5px)}
  .u1-call .tmr{font-size:clamp(11px,3.4cqw,13.5px);margin-top:clamp(4px,1.6cqw,9px)}
  .u1-call .ctrls{margin-top:clamp(10px,3.2cqw,20px);gap:clamp(9px,3cqw,14px)}
  .u1-cbtn{width:clamp(34px,10.6cqw,46px);height:clamp(34px,10.6cqw,46px)}
  .u1-cbtn svg{width:clamp(15px,4.2cqw,19px);height:clamp(15px,4.2cqw,19px)}

  /* Dial + call button (moved onto the visible left column) */
  .u1-layer[data-scene="dial"] .u1-dial{left:9.7% !important;width:auto !important;max-width:50% !important;font-size:clamp(10px,3.3cqw,12.5px)}
  .u1-callbtn{left:9.7% !important;width:30% !important;top:19.5% !important;font-size:clamp(9px,3cqw,11px)}

  /* Contact search results + incoming message row */
  .u1-results{left:26% !important;width:48% !important}
  .u1-res b{font-size:clamp(10.5px,3.3cqw,12.5px)}
  .u1-res small{font-size:clamp(9px,2.8cqw,10.5px)}
  .u1-res .r-av{width:clamp(22px,7cqw,26px);height:clamp(22px,7cqw,26px);font-size:clamp(9px,3cqw,11px)}
  .u1-msgrow{left:20% !important;width:44% !important;padding:clamp(7px,2.6cqw,9px) clamp(8px,2.8cqw,10px)}
  .u1-msgrow b{font-size:clamp(10px,3cqw,11.5px)}
  .u1-msgrow .mr-msg{font-size:clamp(9px,2.9cqw,10.5px)}
  .u1-msgrow .mr-av{width:clamp(18px,6cqw,22px);height:clamp(18px,6cqw,22px);font-size:clamp(8px,2.7cqw,10px)}

  /* Message thread */
  .u1-th-av{width:clamp(26px,8.4cqw,34px);height:clamp(26px,8.4cqw,34px);font-size:clamp(10px,3.4cqw,13px)}
  .u1-th-top b{font-size:clamp(11.5px,3.7cqw,14px)}
  .u1-th-top small{font-size:clamp(9px,2.9cqw,11px)}
  .u1-bub{font-size:clamp(11px,3.5cqw,13.5px)}
  .u1-chip{font-size:clamp(10px,3.2cqw,12px);padding:clamp(4px,1.6cqw,6px) clamp(8px,3cqw,12px)}
  .u1-cinput{font-size:clamp(11px,3.5cqw,13px);min-height:clamp(28px,9cqw,34px)}
  .u1-send{width:clamp(28px,9cqw,34px);height:clamp(28px,9cqw,34px)}
  .u1-send svg{width:clamp(13px,4.2cqw,16px);height:clamp(13px,4.2cqw,16px)}

  /* Pairing phone (scene 1) — sized to fit the short, wide frame without
     clipping the CTA, and made a nested container so its own UI scales with it */
  .u1-phone{width:clamp(112px,33cqw,220px);max-width:none}
  .u1-phone-shell{padding:clamp(4px,1.8cqw,7px)}
  .u1-phone-screen{container-type:inline-size}
  .u1-phone-status{padding:clamp(5px,4cqw,9px) clamp(10px,7cqw,16px) 3px;font-size:clamp(8px,4.8cqw,10px)}
  .u1-phone-body{padding:clamp(6px,6cqw,12px)}
  .u1-req{padding:clamp(8px,7cqw,15px) clamp(9px,6cqw,13px)}
  .u1-req .rq-ic{width:clamp(26px,20cqw,42px);height:clamp(26px,20cqw,42px);margin-bottom:clamp(5px,4cqw,9px)}
  .u1-req .rq-ic svg{width:clamp(14px,10.5cqw,22px);height:clamp(14px,10.5cqw,22px)}
  .u1-req h5,.u1-pdone h5{font-size:clamp(10.5px,6.4cqw,14px)}
  .u1-req .rq-sub{font-size:clamp(8.5px,5cqw,10.5px);margin-top:clamp(3px,2.4cqw,5px)}
  .u1-req .rq-dev{font-size:clamp(8px,4.6cqw,10px);margin-top:clamp(6px,4cqw,9px);padding:clamp(3px,1.9cqw,4px) clamp(6px,4.3cqw,9px)}
  .u1-req-actions{margin-top:clamp(8px,5.7cqw,12px);gap:clamp(5px,3.8cqw,8px)}
  .u1-pbtn{padding:clamp(6px,4.3cqw,9px);font-size:clamp(9px,5.7cqw,12px)}
  .u1-pdone{gap:clamp(7px,5cqw,11px);padding:clamp(6px,4cqw,8px)}
  .u1-pdone .pd-ic{width:clamp(40px,26cqw,56px);height:clamp(40px,26cqw,56px)}
  .u1-pdone .pd-ic svg{width:clamp(20px,13cqw,28px);height:clamp(20px,13cqw,28px)}
  .u1-pdone p{font-size:clamp(9px,5.2cqw,11px)}

  /* Ribbon parked in the dead sidebar corner so it never covers a card */
  .u1-ribbon{top:8px;left:8px;right:auto;bottom:auto;font-size:clamp(9px,2.9cqw,11px);padding:5px 9px}

  /* Step rail + controls */
  .u1-steps{gap:clamp(6px,2vw,8px);margin-top:clamp(24px,5vw,38px)}
  .u1-step{font-size:clamp(12px,3.3vw,13px);padding:clamp(6px,2vw,8px) clamp(11px,3vw,15px)}
}

@media (prefers-reduced-motion:reduce){
  .u1-veil,.u1-ring::after,.u1-bub,.u1-call.ring .av,.u1-dial .caret,.u1-cinput .caret,.u1-layer,.u1-tip,.u1-callbtn{animation:none !important;transition:none !important}
  /* Keep the real dashboard visible, frozen on one representative state; drop the interactive rail */
  .u1-stage{grid-template-columns:1fr;max-width:720px;margin:0 auto}
  .u1-cap,.u1-steps,.u1-controls{display:none}
  .u1-static{display:block;margin-top:32px}
}`;

const DEMO_HTML = `
  <div class="u1-wrap">
    <header class="u1-head">
      <span class="u1-eyebrow"><span class="dot"></span>How it works</span>
      <h2 id="u1-title">See it in action</h2>
      <p>Pair your phone once, then run every call and text from one browser dashboard. Here's the whole thing, playing live.</p>
    </header>

    <div class="u1-stage" id="u1Stage">
      <!-- CAPTION -->
      <div class="u1-cap" id="u1Cap" aria-hidden="true">
        <div class="stepn"><span class="n" data-num>01</span><span data-kicker>Connected</span></div>
        <div class="capfx">
          <h3 data-title>Your phone is paired</h3>
          <p data-lead>The green "Connected" badge means your number is linked to this browser — you're ready to call and text.</p>
        </div>
      </div>

      <!-- FRAME -->
      <div class="u1-frame">
        <div class="u1-bar">
          <span class="u1-tl r"></span><span class="u1-tl y"></span><span class="u1-tl g"></span>
          <span class="u1-url"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>computercaller.com/app</span>
        </div>
        <div class="u1-screen" id="u1Screen">
          <div class="u1-veil"></div>

          <!-- highlight rings (reused, repositioned per scene) -->
          <div class="u1-ring" id="u1Ring"></div>

          <!-- SCENE 1 · paired -->
          <div class="u1-layer" data-scene="paired">
            <!-- pairing request phone (opening beat) -->
            <div class="u1-phone" data-phone aria-hidden="true">
              <div class="u1-phone-shell">
                <div class="u1-phone-notch"></div>
                <div class="u1-phone-screen">
                  <div class="u1-phone-status"><span>9:41</span><span><svg viewBox="0 0 24 24" fill="currentColor"><path d="M2 20h3v-6H2v6zm5 0h3V9H7v11zm5 0h3V4h-3v16zm5 0h3v-9h-3v9z"/></svg></span></div>
                  <div class="u1-phone-body" data-phonebody></div>
                </div>
              </div>
            </div>
            <div class="u1-tip hold" data-paired-tip style="left:47%;top:12%">
              <div class="th"><span class="chk"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>Connected</div>
              <p>Pixel 8 · synced just now. Your number is live in the browser.</p>
            </div>
          </div>

          <!-- SCENE 2 · dial -->
          <div class="u1-layer" data-scene="dial">
            <div class="u1-dial" style="left:9.7%;top:15.3%;width:20.3%;height:4.2%" data-dialnum></div>
            <div class="u1-callbtn" style="left:9.7%;top:19.5%;width:19.8%;height:3.4%" data-callbtn>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
              <span data-callbtn-txt>Call</span>
            </div>
          </div>

          <!-- SCENE 3 · active call / SCENE 4 · incoming -->
          <div class="u1-layer" data-scene="active">
            <div class="u1-pane"><div class="u1-call" data-callcard></div></div>
          </div>
          <div class="u1-layer" data-scene="incoming">
            <div class="u1-pane"><div class="u1-call ring" data-inccard></div></div>
          </div>

          <!-- SCENE 5-7 · message thread (shared) -->
          <div class="u1-layer" data-scene="thread">
            <div class="u1-pane" style="padding:2% 1.6%">
              <div class="u1-thread">
                <div class="u1-th-top"><span class="u1-th-av">AK</span><div><b>Anna K.</b><small>+47 •• •• •• ••</small></div></div>
                <div class="u1-th-body" data-thbody></div>
                <div class="u1-tmpl" data-tmpl hidden>
                  <button class="u1-chip" type="button" data-chip>On my way</button>
                  <button class="u1-chip" type="button" data-chip>Call you back</button>
                  <button class="u1-chip" type="button" data-chip>Thanks!</button>
                </div>
                <div class="u1-compose">
                  <div class="u1-cinput" data-compose></div>
                  <span class="u1-send"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></span>
                </div>
              </div>
            </div>
            <!-- incoming conversation row landing in Messages column -->
            <div class="u1-msgrow" style="top:21%" data-msgrow>
              <div class="mr-top"><span class="mr-av">AK</span><b>Anna K.</b><span class="mr-dot"></span></div>
              <div class="mr-msg" data-msgrow-txt>Are we still on for tomorrow?</div>
            </div>
          </div>

          <!-- SCENE 8 · contact search -->
          <div class="u1-layer" data-scene="search">
            <div class="u1-results" style="left:32.3%;top:19%;width:19.4%" data-results>
              <div class="u1-res"><span class="r-av" style="background:linear-gradient(135deg,#6366f1,#8b5cf6)">AK</span><div><b>Anna K.</b><small>+47 •• •• •• ••</small></div></div>
              <div class="u1-res"><span class="r-av" style="background:linear-gradient(135deg,#0ea5e9,#22c55e)">AN</span><div><b>Anders N.</b><small>+47 •• •• •• ••</small></div></div>
            </div>
          </div>

          <div class="u1-layer" data-scene="demo">
            <div class="u1-demo" style="position:absolute;inset:0;background:#0b0e14 center/contain no-repeat;background-image:url('/demo/desktop-demo.webp')"></div>
          </div>

          
        </div>
      </div>
    </div>

    <!-- STEP RAIL -->
    <ol class="u1-steps" id="u1Steps" role="tablist" aria-label="Demo steps"></ol>
    <div class="u1-controls">
      <button class="u1-pause" id="u1Pause" type="button" aria-pressed="false">
        <svg viewBox="0 0 24 24" fill="currentColor" data-pico><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>
        <span data-ptxt>Pause</span>
      </button>
      <span>Playing automatically · hover to pause</span>
    </div>

    <p class="u1-sr" id="u1Live" aria-live="polite"></p>

    <!-- Reduced-motion static storyboard -->
    <div class="u1-static">
      <ol style="max-width:640px;margin:0 auto;padding-left:20px;line-height:1.7;color:var(--ink-2)" id="u1StaticList"></ol>
    </div>
  </div>
`;

/**
 * initDemo — the vetted autoplay engine, ported verbatim from the approved
 * mockup (ken/PROJECTS/computercaller/homepage-scroll-howitworks). It drives
 * the dashboard-only "See it in action" demo: paired → dial → active call →
 * incoming → send SMS → incoming SMS → template reply → contact search → live
 * desktop. Runs inside a scoped root; every timer + listener is torn down by
 * the returned cleanup so React StrictMode / route changes never double-run.
 */
type Step = {
  id: string;
  label: string;
  kicker: string;
  num: string;
  title: string;
  lead: string;
  dur: number;
  region: 'connected' | 'dialinput' | 'search' | null;
  layer: string;
  play: () => void;
};
type Box = { l: number; t: number; w: number; h: number };

function initDemo(root: HTMLElement): () => void {
  const reduce =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ac = new AbortController();
  const opt = { signal: ac.signal };
  const q = (sel: string) => root.querySelector(sel) as HTMLElement | null;

  const screen = q('#u1Screen');
  const ring = q('#u1Ring');
  const cap = q('#u1Cap');
  const live = q('#u1Live');
  const stepsEl = q('#u1Steps');
  const pauseBtn = q('#u1Pause');
  const sl = q('#u1StaticList');
  if (!screen || !ring || !cap || !live || !stepsEl || !pauseBtn || !sl) {
    return () => ac.abort();
  }

  const layers: Record<string, HTMLElement> = {};
  screen.querySelectorAll('.u1-layer').forEach((l) => {
    layers[(l as HTMLElement).dataset.scene as string] = l as HTMLElement;
  });

  const SVG = {
    end: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
    ans: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
  };
  const cbtn = (cls: string, path: string, fill?: string) =>
    '<button class="u1-cbtn ' + cls + '" tabindex="-1" aria-hidden="true"><svg viewBox="0 0 24 24" fill="' + (fill || 'none') + '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg></button>';

  const REGION: Record<string, Box> = {
    connected: { l: 60.2, t: 2.2, w: 26.2, h: 4.6 },
    dialinput: { l: 9.7, t: 15.3, w: 20.3, h: 4.2 },
    search: { l: 32.3, t: 15.8, w: 19.4, h: 3.2 },
  };
  function setRing(r: Box | null) {
    if (!r || !ring) {
      ring?.classList.remove('on');
      return;
    }
    ring.style.left = r.l + '%';
    ring.style.top = r.t + '%';
    ring.style.width = r.w + '%';
    ring.style.height = r.h + '%';
    ring.classList.add('on');
  }

  let timers: number[] = [];
  let current = -1;
  let autoTimer: number | null = null;
  let paused = false;
  const T = (fn: () => void, ms: number) => {
    const id = window.setTimeout(fn, ms);
    timers.push(id);
    return id;
  };
  const I = (fn: () => void, ms: number) => {
    const id = window.setInterval(fn, ms);
    timers.push(id);
    return id;
  };
  function clearTimers() {
    timers.forEach((t) => {
      clearTimeout(t);
      clearInterval(t);
    });
    timers = [];
  }

  function phoneReqHTML() {
    return '<div class="u1-req">' +
      '<div class="rq-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="3"/><path d="M11 18h2"/></svg></div>' +
      '<h5>Pair with this desktop?</h5>' +
      '<div class="rq-sub">A browser wants to connect to your phone.</div>' +
      '<span class="rq-dev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/></svg>Chrome · this computer</span>' +
      '<div class="u1-req-actions"><button class="u1-pbtn decline" type="button" tabindex="-1" aria-hidden="true">Decline</button><button class="u1-pbtn accept" type="button" tabindex="-1" aria-hidden="true" data-accept>Accept</button></div>' +
    '</div>';
  }
  function phoneDoneHTML() {
    return '<div class="u1-pdone">' +
      '<div class="pd-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>' +
      '<h5>Paired</h5><p>Your number is now linked to this browser.</p>' +
    '</div>';
  }
  function playPaired() {
    const layer = layers.paired;
    const phone = layer.querySelector('[data-phone]') as HTMLElement;
    const body = layer.querySelector('[data-phonebody]') as HTMLElement;
    const tip = layer.querySelector('[data-paired-tip]') as HTMLElement;
    ring!.classList.remove('on');
    tip.classList.remove('reveal');
    body.innerHTML = phoneReqHTML();
    phone.classList.remove('gone');
    phone.classList.add('show');
    screen!.classList.add('focus');
    if (reduce) {
      body.innerHTML = phoneDoneHTML();
      screen!.classList.remove('focus');
      tip.classList.add('reveal');
      setRing(REGION.connected);
      return;
    }
    T(() => {
      const a = body.querySelector('[data-accept]');
      if (a) a.classList.add('tap');
    }, 1100);
    T(() => {
      body.innerHTML = phoneDoneHTML();
    }, 2200);
    T(() => {
      phone.classList.remove('show');
      phone.classList.add('gone');
    }, 3400);
    T(() => {
      screen!.classList.remove('focus');
      tip.classList.add('reveal');
      setRing(REGION.connected);
    }, 3900);
  }

  function playDial() {
    setRing(REGION.dialinput);
    const dn = layers.dial.querySelector('[data-dialnum]') as HTMLElement;
    const btn = layers.dial.querySelector('[data-callbtn]') as HTMLElement;
    const btx = layers.dial.querySelector('[data-callbtn-txt]') as HTMLElement;
    const num = '+47 45 88 12 03';
    let i = 0;
    dn.innerHTML = '<span class="caret"></span>';
    btn.classList.remove('on', 'press');
    btx.textContent = 'Call';
    if (reduce) {
      dn.textContent = num;
      btn.classList.add('on');
      return;
    }
    const typer = I(() => {
      i++;
      dn.innerHTML = num.slice(0, i) + '<span class="caret"></span>';
      if (i >= num.length) {
        clearInterval(typer);
        T(() => {
          btn.classList.add('on');
        }, 350);
        T(() => {
          btn.classList.add('press');
          btx.textContent = 'Calling…';
        }, 1500);
      }
    }, 95);
  }

  function callCard(name: string, initials: string, isRing: boolean, dirTxt: string) {
    return '<div class="dir">' + dirTxt + '</div><div class="av">' + initials + '</div>' +
      '<div class="nm">' + name + '</div><div class="no">+47 •• •• •• ••</div>' +
      '<div class="tmr" data-tmr>' + (isRing ? 'Ringing…' : 'Calling…') + '</div>' +
      '<div class="ctrls">' +
        (isRing
          ? cbtn('end', SVG.end, 'currentColor') + cbtn('answer', SVG.ans, 'currentColor')
          : cbtn('', '<path d="M11 5 6 9H2v6h4l5 4V5z"/>') + cbtn('end', SVG.end, 'currentColor') + cbtn('', '<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>')) +
      '</div>';
  }
  function runTimer(el: HTMLElement) {
    let s = 0;
    return I(() => {
      s++;
      const m = ('0' + Math.floor(s / 60)).slice(-2);
      const ss = ('0' + (s % 60)).slice(-2);
      el.textContent = m + ':' + ss;
    }, 1000);
  }

  function playActive() {
    const c = layers.active.querySelector('[data-callcard]') as HTMLElement;
    c.classList.remove('ring');
    c.innerHTML = callCard('Jonas L.', 'JL', false, '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/></svg> Outgoing');
    const tmr = c.querySelector('[data-tmr]') as HTMLElement;
    if (reduce) {
      tmr.textContent = '02:14';
      return;
    }
    tmr.textContent = 'Connecting…';
    T(() => {
      tmr.textContent = '00:00';
      runTimer(tmr);
      const b = c.querySelector('.ctrls .u1-cbtn:last-child');
      if (b) b.classList.add('active');
    }, 1400);
  }

  function playIncoming() {
    const c = layers.incoming.querySelector('[data-inccard]') as HTMLElement;
    c.innerHTML = callCard('Maria S.', 'MS', true, '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="7" y1="7" x2="17" y2="17"/><polyline points="17 7 17 17 7 17"/></svg> Incoming');
    const tmr = c.querySelector('[data-tmr]') as HTMLElement;
    if (reduce) {
      tmr.textContent = 'Ringing…';
      return;
    }
    let on = true;
    const blink = I(() => {
      on = !on;
      tmr.style.opacity = on ? '1' : '.4';
    }, 650);
    T(() => {
      clearInterval(blink);
      tmr.style.opacity = '1';
      tmr.textContent = '00:00';
      c.classList.remove('ring');
      (c.querySelector('.dir') as HTMLElement).innerHTML = 'In call';
      (c.querySelector('.av') as HTMLElement).style.animation = 'none';
      (c.querySelector('.ctrls') as HTMLElement).innerHTML =
        cbtn('', '<path d="M11 5 6 9H2v6h4l5 4V5z"/>') + cbtn('end', SVG.end, 'currentColor') + cbtn('active', '<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>');
      runTimer(tmr);
    }, 2600);
  }

  function threadRefs() {
    const L = layers.thread;
    return {
      body: L.querySelector('[data-thbody]') as HTMLElement,
      comp: L.querySelector('[data-compose]') as HTMLElement,
      tmpl: L.querySelector('[data-tmpl]') as HTMLElement,
      chips: Array.prototype.slice.call(L.querySelectorAll('[data-chip]')) as HTMLElement[],
      row: L.querySelector('[data-msgrow]') as HTMLElement,
    };
  }
  function bub(body: HTMLElement, cls: string, text: string, stat?: string) {
    const b = document.createElement('div');
    b.className = 'u1-bub ' + cls;
    b.innerHTML = text + (stat ? '<span class="stat">' + stat + '</span>' : '');
    body.appendChild(b);
    return b;
  }
  function typeInto(el: HTMLElement, text: string, speed: number, done?: () => void) {
    let i = 0;
    const t = I(() => {
      i++;
      el.innerHTML = text.slice(0, i) + '<span class="caret"></span>';
      if (i >= text.length) {
        clearInterval(t);
        if (done) T(done, 300);
      }
    }, speed);
  }
  function resetThread(seedIncoming: boolean) {
    const r = threadRefs();
    r.body.innerHTML = '';
    r.comp.innerHTML = '';
    r.tmpl.hidden = true;
    r.chips.forEach((c) => c.classList.remove('sel'));
    r.row.classList.remove('on');
    if (seedIncoming) bub(r.body, 'in', 'Are we still on for tomorrow?');
    return r;
  }

  function playSMS() {
    const r = resetThread(true);
    const txt = 'Yes — 10am works. See you then!';
    if (reduce) {
      r.comp.innerHTML = '';
      bub(r.body, 'out', txt, 'Delivered ✓✓');
      return;
    }
    T(() => {
      typeInto(r.comp, txt, 55, () => {
        r.comp.innerHTML = '';
        const b = bub(r.body, 'out', txt, 'Sending…');
        T(() => {
          const s = b.querySelector('.stat');
          if (s) s.textContent = 'Delivered ✓✓';
        }, 1200);
      });
    }, 900);
  }

  function playInSMS() {
    const r = resetThread(false);
    bub(r.body, 'out', 'Yes — 10am works. See you then!', 'Delivered ✓✓');
    if (reduce) {
      r.row.classList.add('on');
      bub(r.body, 'in', 'Perfect — see you at the office ☕');
      return;
    }
    T(() => {
      r.row.classList.add('on');
    }, 700);
    T(() => {
      bub(r.body, 'in', 'Perfect — see you at the office ☕');
    }, 1500);
  }

  function playTemplate() {
    const r = resetThread(false);
    bub(r.body, 'in', 'Running 5 mins late — sorry!');
    r.tmpl.hidden = false;
    if (reduce) {
      r.chips[0].classList.add('sel');
      bub(r.body, 'out', 'On my way!', 'Delivered ✓✓');
      return;
    }
    T(() => {
      r.chips[0].classList.add('sel');
    }, 1200);
    T(() => {
      r.comp.innerHTML = 'On my way!<span class="caret"></span>';
    }, 1900);
    T(() => {
      r.comp.innerHTML = '';
      const b = bub(r.body, 'out', 'On my way!', 'Sending…');
      r.chips[0].classList.remove('sel');
      T(() => {
        const s = b.querySelector('.stat');
        if (s) s.textContent = 'Delivered ✓✓';
      }, 1100);
    }, 2900);
  }

  function playSearch() {
    setRing(REGION.search);
    const res = layers.search.querySelector('[data-results]') as HTMLElement;
    res.classList.remove('on');
    if (reduce) {
      res.classList.add('on');
      return;
    }
    T(() => {
      res.classList.add('on');
    }, 700);
  }

  function playDemo() {
    ring!.classList.remove('on');
  }

  const STEPS: Step[] = [
    { id: 'paired', label: 'Connected', kicker: 'Pair your phone', num: '01', title: 'Approve the pairing on your phone', lead: 'A pairing request lands on your phone — tap Accept and your number is linked to this browser, ready to call and text.', dur: 5200, region: null, layer: 'paired', play: playPaired },
    { id: 'dial', label: 'Dial', kicker: 'Quick Dial', num: '02', title: 'Type a number and call', lead: 'Enter any number in Quick Dial and hit Call — it rings out from your own phone, hands-free.', dur: 4800, region: 'dialinput', layer: 'dial', play: playDial },
    { id: 'active', label: 'On a call', kicker: 'Live call', num: '03', title: 'Take the call at your desk', lead: 'Mute, speaker and hang-up are right on screen. Talk through your headset while your phone stays in your pocket.', dur: 4200, region: null, layer: 'active', play: playActive },
    { id: 'incoming', label: 'Incoming', kicker: 'Incoming call', num: '04', title: 'Answer without reaching', lead: 'A call comes in and lands on your screen — pick it up or decline with a click.', dur: 4200, region: null, layer: 'incoming', play: playIncoming },
    { id: 'sms', label: 'Send text', kicker: 'Send a text', num: '05', title: 'Text from the dashboard', lead: 'Open a thread and type on a real keyboard — the message sends straight from your number.', dur: 5200, region: null, layer: 'thread', play: playSMS },
    { id: 'insms', label: 'New text', kicker: 'Incoming text', num: '06', title: 'Replies land instantly', lead: 'Incoming texts appear the moment they arrive — right inside the same conversation.', dur: 3800, region: null, layer: 'thread', play: playInSMS },
    { id: 'tmpl', label: 'Templates', kicker: 'Quick reply', num: '07', title: 'Reply with a saved template', lead: "Tap a saved reply and it sends in one click — no typing when you're busy.", dur: 4600, region: null, layer: 'thread', play: playTemplate },
    { id: 'search', label: 'Find people', kicker: 'Find a contact', num: '08', title: 'Search your contacts inline', lead: 'Start typing a name and your synced contacts filter instantly — call or text in one step.', dur: 3800, region: 'search', layer: 'search', play: playSearch },
    { id: 'demo', label: 'Demo', kicker: 'On a real desktop', num: '09', title: 'This is it, live on a real desktop', lead: 'ComputerCaller sits in the corner while you work — calls and texts running right alongside your browser tabs and spreadsheets.', dur: 5000, region: null, layer: 'demo', play: playDemo },
  ];

  function setCaption(s: Step) {
    cap!.classList.add('swap');
    T(() => {
      (cap!.querySelector('[data-num]') as HTMLElement).textContent = s.num;
      (cap!.querySelector('[data-kicker]') as HTMLElement).textContent = s.kicker;
      (cap!.querySelector('[data-title]') as HTMLElement).textContent = s.title;
      (cap!.querySelector('[data-lead]') as HTMLElement).textContent = s.lead;
      cap!.classList.remove('swap');
    }, 160);
  }
  function activate(i: number, user: boolean) {
    if (i === current && !user) return;
    clearTimers();
    current = i;
    const s = STEPS[i];
    for (const k in layers) {
      layers[k].classList.toggle('on', layers[k].dataset.scene === s.layer);
    }
    setRing(s.region ? REGION[s.region] : null);
    screen!.classList.toggle('focus', !!s.region);
    setCaption(s);
    Array.prototype.forEach.call(stepsEl!.children, (li: HTMLElement, idx: number) => {
      const btn = li.querySelector('.u1-step') as HTMLElement;
      btn.setAttribute('aria-current', idx === i ? 'true' : 'false');
      const fill = btn.querySelector('.fill') as HTMLElement;
      fill.classList.remove('run');
      void fill.offsetWidth;
      if (idx === i && !reduce && !paused) {
        fill.style.animationDuration = s.dur + 'ms';
        fill.classList.add('run');
      } else {
        fill.style.animationDuration = '0ms';
      }
    });
    live!.textContent = 'Step ' + (i + 1) + ' of ' + STEPS.length + ': ' + s.title;
    s.play();
    scheduleNext();
  }
  function scheduleNext() {
    if (autoTimer) clearTimeout(autoTimer);
    if (reduce || paused) return;
    autoTimer = window.setTimeout(() => {
      activate((current + 1) % STEPS.length, false);
    }, STEPS[current].dur);
  }
  function freezeFill() {
    const li = stepsEl!.children[current] as HTMLElement | undefined;
    const f = li && (li.querySelector('.fill') as HTMLElement | null);
    if (f) {
      const cs = getComputedStyle(f).transform;
      f.style.animation = 'none';
      f.style.transform = cs;
    }
  }
  function setPaused(p: boolean) {
    paused = p;
    pauseBtn!.setAttribute('aria-pressed', p ? 'true' : 'false');
    (pauseBtn!.querySelector('[data-ptxt]') as HTMLElement).textContent = p ? 'Play' : 'Pause';
    (pauseBtn!.querySelector('[data-pico]') as HTMLElement).innerHTML = p
      ? '<polygon points="6 4 20 12 6 20 6 4"/>'
      : '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>';
    if (p) {
      if (autoTimer) clearTimeout(autoTimer);
      freezeFill();
    } else {
      activate(current, true);
    }
  }

  STEPS.forEach((s, i) => {
    const li = document.createElement('li');
    li.innerHTML = '<button class="u1-step" type="button" role="tab" aria-label="Step ' + (i + 1) + ': ' + s.title + '"><span class="fill"></span><span class="sd"></span>' + s.label + '</button>';
    const btn = li.querySelector('button') as HTMLButtonElement;
    btn.addEventListener('click', () => {
      if (paused) setPaused(false);
      activate(i, true);
    }, opt);
    btn.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const ni = (i + (e.key === 'ArrowRight' ? 1 : STEPS.length - 1)) % STEPS.length;
        (stepsEl!.children[ni].querySelector('.u1-step') as HTMLElement).focus();
        if (paused) setPaused(false);
        activate(ni, true);
      }
    }, opt);
    stepsEl!.appendChild(li);
  });

  STEPS.forEach((s) => {
    const li = document.createElement('li');
    li.innerHTML = '<strong>' + s.title + '.</strong> ' + s.lead;
    sl.appendChild(li);
  });

  pauseBtn.addEventListener('click', () => setPaused(!paused), opt);
  let hoverPause = false;
  ['mouseenter', 'focusin'].forEach((ev) => {
    screen.addEventListener(ev, () => {
      if (!paused) {
        hoverPause = true;
        if (autoTimer) clearTimeout(autoTimer);
        freezeFill();
      }
    }, opt);
  });
  ['mouseleave', 'focusout'].forEach((ev) => {
    screen.addEventListener(ev, (e: Event) => {
      const rel = (e as FocusEvent).relatedTarget as Node | null;
      if (hoverPause && !paused && !screen.contains(rel)) {
        hoverPause = false;
        activate(current, true);
      }
    }, opt);
  });

  if (reduce) {
    layers.active.classList.add('on');
    STEPS[2].play();
    cap.setAttribute('aria-hidden', 'true');
  } else {
    activate(0, false);
  }

  return () => {
    clearTimers();
    if (autoTimer) clearTimeout(autoTimer);
    ac.abort();
    stepsEl.innerHTML = '';
    sl.innerHTML = '';
  };
}


export default function HowItWorksDemo() {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    return initDemo(root);
  }, []);

  return (
    <section
      ref={ref}
      id="how-it-works"
      className="u1 border-t border-slate-200 scroll-mt-24"
      aria-labelledby="u1-title"
      aria-roledescription="auto-playing product demonstration"
    >
      <style dangerouslySetInnerHTML={{ __html: DEMO_CSS }} />
      <div dangerouslySetInnerHTML={{ __html: DEMO_HTML }} />
    </section>
  );
}
