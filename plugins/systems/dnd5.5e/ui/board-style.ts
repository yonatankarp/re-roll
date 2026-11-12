// The board's look, kept apart from its behaviour.

let styled = false;

// A constructed sheet rather than a <style> element, which the desktop app's content policy blocks.
export function injectStyle(): void {
  if (styled) return;
  styled = true;
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(BOARD_CSS);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}

const BOARD_CSS = `
.dnd-board {
  position: relative;
  background: #1a1712;
  margin: 12px 0;
  border: 1px solid var(--line);
  border-radius: 12px;
  overflow: hidden;
  user-select: none;
}
.dnd-field {
  position: relative;
  height: clamp(260px, 42vw, 380px);
  background-color: #2a2620;
  background-image: radial-gradient(circle at 50% 50%, #3d3528, #1a1712);
  background-size: cover;
  background-position: center;
}
.dnd-field::before {
  content: "";
  position: absolute;
  inset: 0;
  background:
    linear-gradient(rgb(0 0 0 / 35%), rgb(0 0 0 / 55%)),
    repeating-linear-gradient(0deg, transparent 0 39px, rgb(255 255 255 / 4%) 39px 40px),
    repeating-linear-gradient(90deg, transparent 0 39px, rgb(255 255 255 / 4%) 39px 40px);
}
.dnd-token {
  --disc: 64px;
  position: absolute;
  transform: translate(-50%, -50%);
  width: var(--disc);
  height: var(--disc);
  transition: left 0.4s ease, top 0.4s ease, filter 0.4s, opacity 0.4s;
  color: #f4efe4;
  font-family: var(--font-ui, system-ui), sans-serif;
  text-shadow: 0 1px 2px #000;
}
.dnd-disc {
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  border-radius: 50%;
  overflow: hidden;
  border: 3px solid #4f8fd6;
  /* With no picture, the token looks like a painted wooden counter with the creature's initials. */
  background:
    radial-gradient(circle at 35% 28%, rgb(255 255 255 / 25%), transparent 45%),
    repeating-radial-gradient(circle at 50% 50%, rgb(0 0 0 / 0%) 0 3px, rgb(0 0 0 / 7%) 3px 4px),
    radial-gradient(circle at 50% 60%, #45628a, #1c2638);
  font-family: var(--font-title, Georgia), serif;
  font-size: 1.5rem;
  letter-spacing: 0.02em;
  box-shadow:
    inset 0 0 0 2px rgb(255 255 255 / 12%),
    0 4px 10px rgb(0 0 0 / 60%);
}
.dnd-token[data-side="enemy"] .dnd-disc {
  border-color: #c9473b;
  background:
    radial-gradient(circle at 35% 28%, rgb(255 255 255 / 22%), transparent 45%),
    repeating-radial-gradient(circle at 50% 50%, rgb(0 0 0 / 0%) 0 3px, rgb(0 0 0 / 7%) 3px 4px),
    radial-gradient(circle at 50% 60%, #8a4a3f, #33150f);
}
.dnd-disc { position: relative; }
.dnd-disc img.framed {
  position: absolute;
  max-width: none;
  height: auto;
  object-fit: fill;
}
/* A book's battle map shows as printed: no darkening and no second grid over its own. */
.dnd-field.gridded.mapped::before { background: rgb(0 0 0 / 8%); }
/* With no picture, a parchment battle mat ruled in ink, and no darkening. */
.dnd-board:has(> .plain) { background: #e9dcbc; }
.dnd-field.plain {
  background: radial-gradient(circle at 50% 45%, #f1e6c9, #e9dcbc 60%, #dccb9f);
}
.dnd-field.plain::before { background: none; }
.dnd-field.gridded.plain::before {
  background:
    linear-gradient(to right, rgb(60 40 10 / 18%) 1px, transparent 1px) 0 0 / calc(100% / var(--cols)) 100%,
    linear-gradient(to bottom, rgb(60 40 10 / 18%) 1px, transparent 1px) 0 0 / 100% calc(100% / var(--rows));
}
.dnd-disc img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: top;
}
.dnd-token.active .dnd-disc {
  border-color: #ffd36b;
  box-shadow: 0 0 0 3px rgb(255 211 107 / 35%), 0 0 22px 4px rgb(255 211 107 / 55%);
}
.dnd-token.active::after {
  content: "";
  position: absolute;
  inset: -6px;
  border-radius: 50%;
  border: 2px solid rgb(255 211 107 / 70%);
  animation: dnd-pulse 1.4s ease-in-out infinite;
  pointer-events: none;
  z-index: -1;
}
@keyframes dnd-pulse { 50% { opacity: 0.3; } }
.dnd-token.down { filter: grayscale(1) brightness(0.6); opacity: 0.7; }
.dnd-token.is-hidden { opacity: 0.55; }
.dnd-token.is-dodging .dnd-disc { outline: 2px dashed rgb(207 227 255 / 85%); outline-offset: 3px; }
.dnd-token[data-marks]:not([data-marks=""])::before {
  content: attr(data-marks);
  position: absolute;
  left: 50%;
  top: -14px;
  transform: translateX(-50%);
  padding: 0 5px;
  border-radius: 6px;
  background: rgb(40 28 18 / 85%);
  color: #f4efe4;
  font-size: 0.6rem;
  line-height: 1.3;
  white-space: nowrap;
  text-transform: capitalize;
  pointer-events: none;
  z-index: 2;
}
.dnd-token.down .dnd-disc { transform: rotate(-80deg) scale(0.85); transition: transform 0.4s; }
/* HP as a ring round the disc, emptying clockwise from the top. */
.dnd-ring {
  --hp-color: #4cc96a;
  position: absolute;
  inset: -4px;
  border-radius: 50%;
  background: conic-gradient(var(--hp-color) calc(var(--hp, 1) * 1turn), rgb(0 0 0 / 55%) 0);
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 4px), #000 calc(100% - 3.5px));
  mask: radial-gradient(farthest-side, transparent calc(100% - 4px), #000 calc(100% - 3.5px));
  pointer-events: none;
}
.dnd-token[data-level="mid"] .dnd-ring { --hp-color: #e3b341; }
.dnd-token[data-level="low"] .dnd-ring { --hp-color: #e0533f; }
.dnd-token.down .dnd-ring { opacity: 0; }
/* The name, HP and conditions, on hover or under the keyboard cursor. */
.dnd-tip {
  position: absolute;
  left: 50%;
  bottom: calc(100% + 8px);
  transform: translateX(-50%);
  padding: 3px 10px;
  border-radius: 6px;
  background: rgb(15 10 6 / 88%);
  border: 1px solid #c9ad6a;
  color: #f4e7c8;
  font: 0.8rem/1.3 var(--font-ui, system-ui), sans-serif;
  white-space: nowrap;
  text-shadow: none;
  opacity: 0;
  transition: opacity 0.15s;
  pointer-events: none;
  z-index: 8;
}
.dnd-board:not(.playing) .dnd-token:hover .dnd-tip,
.dnd-board:focus-visible:not(.playing) .dnd-token.cursor .dnd-tip { opacity: 1; }
.dnd-token.high .dnd-tip { bottom: auto; top: calc(100% + 8px); }
.dnd-token.west .dnd-tip { left: 0; transform: none; }
.dnd-token.east .dnd-tip { left: auto; right: 0; transform: none; }
.dnd-token:hover, .dnd-token.cursor { z-index: 7; }
.dnd-float {
  position: absolute;
  top: -6px;
  left: 50%;
  transform: translate(-50%, 0);
  font: 800 1.3rem/1 var(--font-ui, system-ui), sans-serif;
  white-space: nowrap;
  pointer-events: none;
  text-shadow: 0 2px 4px #000, 0 0 8px #000;
  z-index: 3;
}
.dnd-float.damage { color: #ff5a4d; }
.dnd-float.damage.crit { color: #ffd84d; font-size: 1.8rem; }
.dnd-float.heal { color: #6dff9b; }
.dnd-float.hit { color: #ffd36b; font-size: 1rem; }
.dnd-float.miss { color: #d8d4cc; font-size: 1rem; }
.dnd-float.status { color: #c9b3ff; font-size: 0.9rem; text-transform: capitalize; }
.dnd-float.legendary {
  padding: 2px 10px;
  border: 1px solid #ffd36b;
  border-radius: 6px;
  background: rgb(60 20 10 / 85%);
  color: #ffd36b;
  font: 700 0.95rem/1.2 var(--font-title, Georgia), serif;
}
.dnd-die {
  position: absolute;
  bottom: 100%;
  left: 50%;
  transform: translate(-50%, 0);
  display: flex;
  flex-direction: column;
  align-items: center;
  z-index: 4;
  pointer-events: none;
}
.dnd-die span {
  display: grid;
  place-items: center;
  width: 40px;
  height: 44px;
  clip-path: polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%);
  background: linear-gradient(160deg, #f1e3c4, #b99a62);
  color: #2a1d0b;
  font: 800 1.05rem/1 var(--font-ui, system-ui), sans-serif;
  text-shadow: none;
}
.dnd-die small {
  margin-top: 2px;
  padding: 0 6px;
  border-radius: 4px;
  background: rgb(0 0 0 / 65%);
  font-size: 0.65rem;
  white-space: nowrap;
}
.dnd-die.crit span { background: linear-gradient(160deg, #fff4b0, #e0a521); box-shadow: 0 0 18px #ffd84d; }
.dnd-die.fumble span { background: linear-gradient(160deg, #e9a0a0, #8c2a2a); color: #fff; }
.dnd-die.big {
  top: 50%;
  bottom: auto;
  transform: translate(-50%, -50%);
}
.dnd-die.big span { width: 96px; height: 106px; font-size: 2.4rem; }
.dnd-die.big small { font-size: 0.85rem; margin-top: 8px; color: #f4efe4; }
.dnd-die.big.pass small { background: #2c6b3a; }
.dnd-die.big.fail small { background: #8c2a2a; }
.dnd-board.checking .dnd-field { min-height: 220px; }
.dnd-banner {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  padding: 10px 28px;
  border-radius: 10px;
  background: rgb(10 8 6 / 80%);
  border: 1px solid #ffd36b;
  color: #ffd36b;
  font: 700 1.6rem/1.2 var(--font-title, Georgia), serif;
  letter-spacing: 0.03em;
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
  z-index: 5;
}
.dnd-banner.shown { opacity: 1; }
.dnd-hint {
  position: absolute;
  right: 8px;
  bottom: 6px;
  font: 0.8rem var(--font-ui, system-ui), sans-serif;
  color: rgb(255 255 255 / 80%);
  text-shadow: 0 1px 2px #000;
  opacity: 0;
  transition: opacity 0.3s;
}
.dnd-board.playing .dnd-hint { opacity: 1; }
.dnd-field.plain ~ .dnd-hint { color: rgb(60 40 10 / 85%); text-shadow: none; }
.dnd-board.awaiting .dnd-hint { opacity: 0; }
.dnd-board.playing { cursor: pointer; }
.dnd-field.gridded {
  height: auto;
  /* As wide as fits while the map and what the page keeps beside or below it share one screen; its squares
     stay square. A length, not a share, because the frame sizes itself to the map. */
  width: calc(max(280px, 100dvh - var(--map-reserve, 400px)) * var(--cols) / var(--rows));
  max-width: 100%;
  margin: 0 auto;
}
/* The frame fits the grid, so no dark bands run beside a narrow map. */
.dnd-board:has(> .gridded) { width: fit-content; max-width: 100%; margin-inline: auto; }
.dnd-field.gridded::before {
  background:
    linear-gradient(rgb(0 0 0 / 30%), rgb(0 0 0 / 45%)),
    linear-gradient(to right, rgb(255 255 255 / 9%) 1px, transparent 1px) 0 0 / calc(100% / var(--cols)) 100%,
    linear-gradient(to bottom, rgb(255 255 255 / 9%) 1px, transparent 1px) 0 0 / 100% calc(100% / var(--rows));
}
.gridded .dnd-token { --disc: max(32px, calc(var(--sq, 48px) * 0.78)); }
.gridded .dnd-disc { font-size: calc(var(--sq, 48px) * 0.3); border-width: 2px; }
.dnd-cells { position: absolute; inset: 0; }
.dnd-cell {
  position: absolute;
  width: calc(100% / var(--cols));
  height: calc(100% / var(--rows));
  box-sizing: border-box;
  background: rgb(255 211 107 / 16%);
  border: 1px solid rgb(255 211 107 / 35%);
  cursor: pointer;
}
.dnd-cell:hover, .dnd-cell.hover { background: rgb(255 211 107 / 45%); }
.dnd-cell.soft {
  background: rgb(255 211 107 / 12%);
  border: 1px solid rgb(255 211 107 / 30%);
}
/* A square that gives a foe an Opportunity Attack is striped red, readable without telling colours apart. */
.dnd-cell.risky {
  background: repeating-linear-gradient(45deg, rgb(224 83 63 / 38%) 0 3px, transparent 3px 8px);
  border-color: rgb(224 83 63 / 50%);
}
.dnd-cell.risky:hover, .dnd-cell.risky.hover { background-color: rgb(224 83 63 / 30%); }
/* On parchment, gold vanishes, so the squares are inked in brown. */
.plain .dnd-cell { background: rgb(150 100 20 / 22%); border-color: rgb(110 70 10 / 55%); }
.plain .dnd-cell.soft { background: rgb(150 100 20 / 12%); border-color: rgb(110 70 10 / 35%); }
.plain .dnd-cell:hover, .plain .dnd-cell.hover { background: rgb(150 100 20 / 38%); }
.plain .dnd-cell.risky {
  background: repeating-linear-gradient(45deg, rgb(170 40 20 / 40%) 0 3px, transparent 3px 8px);
  border-color: rgb(150 35 15 / 55%);
}
.plain .dnd-cell.risky:hover, .plain .dnd-cell.risky.hover { background-color: rgb(170 40 20 / 22%); }
.plain .dnd-route polyline { stroke: #7a4a08; }
.plain .dnd-route.risky polyline { stroke: #a8261a; }
.dnd-route {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  overflow: visible;
}
.dnd-route polyline {
  fill: none;
  stroke: #ffd36b;
  stroke-width: 3;
  stroke-dasharray: 6 5;
  stroke-linecap: round;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
}
.dnd-route.risky polyline { stroke: #ff6a55; }
.dnd-blast { position: absolute; inset: 0; pointer-events: none; }
.dnd-ground { position: absolute; inset: 0; pointer-events: none; }
.dnd-ground[data-light="dim"] { background: rgb(8 10 30 / 22%); }
.dnd-ground[data-light="dark"] { background: rgb(4 4 14 / 48%); }
.dnd-ground-square {
  position: absolute;
  width: calc(100% / var(--cols));
  height: calc(100% / var(--rows));
  box-sizing: border-box;
}
.dnd-ground-square.difficult {
  background: repeating-linear-gradient(-45deg, rgb(240 222 180 / 26%) 0 2px, transparent 2px 7px);
}
/* Cover is ringed in cream with a dark edge, so it reads on light and dark art alike. */
.dnd-ground-square.half {
  box-shadow: inset 0 0 0 2px rgb(255 240 205 / 55%), inset 0 0 0 3px rgb(30 18 6 / 30%);
  border-radius: 4px;
}
.dnd-ground-square.threeQuarters {
  box-shadow: inset 0 0 0 3px rgb(255 240 205 / 70%), inset 0 0 0 4px rgb(30 18 6 / 35%);
  background: rgb(255 240 205 / 12%);
  border-radius: 4px;
}
.dnd-ground-square.dim { background: rgb(8 10 30 / 26%); }
.dnd-ground-square.dark { background: rgb(4 4 14 / 55%); }
.plain .dnd-ground-square.difficult {
  background: repeating-linear-gradient(-45deg, rgb(110 70 10 / 28%) 0 2px, transparent 2px 7px);
}
.plain .dnd-ground-square.half { box-shadow: inset 0 0 0 2px rgb(110 70 10 / 35%); }
.plain .dnd-ground-square.threeQuarters { box-shadow: inset 0 0 0 3px rgb(110 70 10 / 50%); }
.dnd-route-cost {
  position: absolute;
  transform: translate(-50%, -110%);
  padding: 1px 7px;
  border-radius: 5px;
  background: rgb(15 10 6 / 85%);
  border: 1px solid #c9ad6a;
  color: #f4e7c8;
  font: 600 0.75rem/1.3 var(--font-ui, system-ui), sans-serif;
  white-space: nowrap;
  pointer-events: none;
  z-index: 6;
}
/* A shield with the cover a foe has against the player, on hover while picking a target. */
.dnd-shield {
  position: absolute;
  right: -6px;
  top: -6px;
  min-width: 22px;
  padding: 3px 3px 5px;
  box-sizing: border-box;
  background: #3b5f8a;
  border: 1.5px solid #e8d7a8;
  border-radius: 4px 4px 50% 50% / 4px 4px 60% 60%;
  color: #fff;
  font: 800 0.68rem/1 var(--font-ui, system-ui), sans-serif;
  text-align: center;
  opacity: 0;
  transition: opacity 0.15s;
  pointer-events: none;
  z-index: 8;
}
.dnd-shield[hidden] { display: none; }
.dnd-board:not(.playing) .dnd-token:hover .dnd-shield,
.dnd-board:focus-visible:not(.playing) .dnd-token.cursor .dnd-shield { opacity: 1; }
.dnd-caption {
  position: absolute;
  left: 50%;
  top: 12px;
  transform: translateX(-50%);
  max-width: 90%;
  padding: 6px 16px;
  border-radius: 999px;
  background: rgb(15 10 6 / 82%);
  border: 1px solid #c9ad6a;
  color: #f4e7c8;
  font: 1rem var(--font-head, Georgia), serif;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  opacity: 0;
  transition: opacity 0.2s;
  pointer-events: none;
  z-index: 6;
}
.dnd-caption.shown { opacity: 1; }
.dnd-token.acting .dnd-disc { box-shadow: 0 0 0 3px #ffd36b, 0 0 24px 6px rgb(255 211 107 / 70%); }
.dnd-token.targeted .dnd-disc { box-shadow: 0 0 0 3px #ff6a55, 0 0 22px 6px rgb(255 106 85 / 60%); }
.dnd-throw {
  position: absolute;
  z-index: 7;
  width: 64px;
  height: 64px;
  transform: translate(-50%, -50%);
  pointer-events: none;
  filter: drop-shadow(0 6px 8px rgb(0 0 0 / 55%));
}
.dnd-throw.mine { width: 96px; height: 96px; pointer-events: auto; cursor: pointer; }
.dnd-throw svg { position: absolute; inset: 0; width: 100%; height: 100%; }
.dnd-throw .d20-body { fill: #b3261e; stroke: #5c0f0a; stroke-width: 3; }
.dnd-throw .d20-face { fill: #d6412f; }
.dnd-throw .d20-edge { fill: none; stroke: rgb(255 220 200 / 45%); stroke-width: 2; }
.dnd-throw.crit .d20-body { fill: #d9a12a; stroke: #6b4a08; }
.dnd-throw.crit .d20-face { fill: #f2c24b; }
.dnd-throw.fumble .d20-body { fill: #3a3a3a; stroke: #111; }
.dnd-throw.fumble .d20-face { fill: #555; }
.dnd-throw-number {
  position: absolute;
  left: 50%;
  top: 54%;
  transform: translate(-50%, -50%);
  color: #fff8e8;
  font: 700 1.3rem/1 var(--font-ui, system-ui), sans-serif;
  text-shadow: 0 1px 2px #000;
}
.dnd-throw.mine .dnd-throw-number { font-size: 1.9rem; }
.dnd-throw-note {
  position: absolute;
  left: 50%;
  top: 100%;
  transform: translateX(-50%);
  margin-top: 4px;
  padding: 2px 10px;
  border-radius: 999px;
  background: rgb(15 10 6 / 82%);
  color: #f4e7c8;
  font: 0.85rem var(--font-head, Georgia), serif;
  white-space: nowrap;
}
.dnd-throw-note:empty { display: none; }
.dnd-throw.waiting { animation: dnd-beckon 1s ease-in-out infinite; }
@keyframes dnd-beckon { 50% { transform: translate(-50%, -50%) scale(1.08) rotate(-6deg); } }
.dnd-throw.big.pass .dnd-throw-note { background: #2c5e3a; }
.dnd-throw.big.fail .dnd-throw-note { background: #8c2a2a; }
.dnd-slash {
  position: absolute;
  z-index: 6;
  width: 70px;
  height: 70px;
  border-radius: 50%;
  border-top: 5px solid #fff4d6;
  border-right: 3px solid rgb(255 244 214 / 50%);
  filter: drop-shadow(0 0 6px #ffd36b);
  pointer-events: none;
}
.dnd-arrow {
  position: absolute;
  z-index: 6;
  width: 34px;
  height: 3px;
  background: linear-gradient(to right, #6b4a2b 0 80%, #d8d8d8 80%);
  pointer-events: none;
}
.dnd-arrow::after {
  content: "";
  position: absolute;
  right: -6px;
  top: -4px;
  border-left: 8px solid #d8d8d8;
  border-top: 5px solid transparent;
  border-bottom: 5px solid transparent;
}
.dnd-bolt {
  position: absolute;
  z-index: 6;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: radial-gradient(circle, #fff 0 25%, #c9a6ff 45%, rgb(140 90 255 / 0%) 70%);
  box-shadow: 0 0 18px 8px rgb(170 120 255 / 60%);
  pointer-events: none;
}
.dnd-damage-dice {
  position: absolute;
  z-index: 7;
  padding: 3px 10px;
  border-radius: 6px;
  background: #fdf1dc;
  border: 2px solid #b3261e;
  color: #58180d;
  font: 700 0.95rem var(--font-ui, system-ui), sans-serif;
  white-space: nowrap;
  pointer-events: none;
  box-shadow: 0 4px 10px rgb(0 0 0 / 40%);
}

.dnd-blast-square {
  position: absolute;
  width: calc(100% / var(--cols));
  height: calc(100% / var(--rows));
  background: rgb(255 140 60 / 38%);
  box-shadow: inset 0 0 0 1px rgb(255 190 120 / 55%);
}
.dnd-cursor {
  position: absolute;
  display: none;
  width: calc(100% / var(--cols));
  height: calc(100% / var(--rows));
  box-sizing: border-box;
  border: 3px solid #fff;
  border-radius: 4px;
  box-shadow: 0 0 0 2px #000;
  pointer-events: none;
  z-index: 5;
}
.dnd-board:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.dnd-board:focus-visible .gridded .dnd-cursor { display: block; }
.dnd-board.playing .dnd-cursor { display: none !important; }
.dnd-said {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.dnd-reach {
  position: absolute;
  box-sizing: border-box;
  background: rgb(224 83 63 / 14%);
  border: 2px dashed rgb(224 83 63 / 60%);
  border-radius: 6px;
  pointer-events: none;
}
.dnd-token.dragging {
  z-index: 7;
  pointer-events: none;
  transition: none;
  filter: drop-shadow(0 8px 12px rgb(0 0 0 / 60%));
}
.dnd-board:not(.playing) .dnd-token[data-id="player"] { cursor: grab; touch-action: none; }
.dnd-board:not(.playing) .dnd-token { cursor: pointer; }
.dnd-pickbar {
  position: absolute;
  left: 50%;
  bottom: 12px;
  transform: translateX(-50%);
  z-index: 6;
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: calc(100% - 32px);
  padding: 6px 8px 6px 14px;
  border: 1px solid #c9ad6a;
  border-radius: 999px;
  background: rgb(15 10 6 / 85%);
  color: #f4e7c8;
  font: 0.9rem var(--font-ui, system-ui), sans-serif;
}
.dnd-pickbar[hidden] { display: none; }
.dnd-pickbar span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dnd-pickbar button { min-height: 32px; padding: 4px 12px; white-space: nowrap; }
.dnd-token.picked .dnd-disc { box-shadow: 0 0 0 3px #ffd36b, 0 0 18px 4px rgb(255 211 107 / 65%); }
.dnd-token[data-count]::after {
  content: "×" attr(data-count);
  position: absolute;
  right: -6px;
  top: -6px;
  padding: 0 5px;
  border-radius: 999px;
  background: #ffd36b;
  color: #2a1a06;
  font: bold 0.75rem var(--font-ui, system-ui), sans-serif;
}
.dnd-token.caught .dnd-disc { box-shadow: 0 0 0 3px #ff8c3c, 0 0 20px 6px rgb(255 140 60 / 60%); }
.dnd-menu {
  position: absolute;
  z-index: 6;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 200px;
  max-height: 60%;
  overflow: auto;
  padding: 4px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  box-shadow: 0 8px 24px rgb(0 0 0 / 45%);
}
.dnd-menu button {
  min-height: 32px;
  padding: 4px 10px;
  text-align: left;
  font: 0.85rem var(--font-ui, system-ui), sans-serif;
}
/* A check outside a fight rises over the page, rather than pushing the page about. */
.dnd-overlay {
  position: fixed;
  inset: 0;
  z-index: 20;
  display: grid;
  place-items: center;
  padding: 16px;
  background: rgb(20 12 4 / 45%);
  animation: none !important;
}
.dnd-overlay .dnd-board { width: min(460px, 100%); margin: 0; }
@media (max-width: 520px) {
  .dnd-token { --disc: 48px; }
  .dnd-disc { font-size: 1rem; }
}
`;
