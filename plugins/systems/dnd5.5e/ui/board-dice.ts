import { setEffectsVolume, diceSound } from "./sound.ts";
import {
  type BoardContext,
  type Token,
  el,
  fast,
  still,
  wait,
} from "./board-context.ts";

// The dice thrown across the board, and the blows and shots that follow an attack.

// A d20 drawn flat: an outline, its top face and the edges that meet there.
const D20 = `<svg viewBox="0 0 100 100" aria-hidden="true"><polygon class="d20-body" points="50,3 93,27 93,73 50,97 7,73 7,27"/><polygon class="d20-face" points="50,22 76,66 24,66"/><path class="d20-edge" d="M50,3 50,22 M93,27 76,66 M93,73 76,66 M50,97 50,66 M7,73 24,66 M7,27 24,66 M50,22 93,27 M50,22 7,27 M24,66 50,97 76,66"/></svg>`;

function waitForThrow(ctx: BoardContext, prompt: HTMLElement): Promise<void> {
  return fast(ctx)
    ? Promise.resolve()
    : new Promise((resolve) => {
        prompt.classList.add("waiting");
        ctx.board.classList.add("awaiting");
        ctx.throwNow = () => {
          ctx.throwNow = null;
          prompt.classList.remove("waiting");
          ctx.board.classList.remove("awaiting");
          if (ctx.host.sound?.() === true) {
            setEffectsVolume(ctx.host.volume?.() ?? 1);
            diceSound();
          }
          resolve();
        };
      });
}

// Where a token's centre is, in the board's own pixels.
export function centreOf(
  ctx: BoardContext,
  node: HTMLElement,
): { x: number; y: number } {
  const box = ctx.board.getBoundingClientRect();
  const at = node.getBoundingClientRect();
  return {
    x: at.left - box.left + at.width / 2,
    y: at.top - box.top + at.height / 2,
  };
}

// A d20 tumbles from one point to another and lands on the roll. Yours waits for you to throw it.
export async function throwD20(
  ctx: BoardContext,
  start: { x: number; y: number },
  to: { x: number; y: number },
  natural: number,
  before: string, // what it's for, such as "Perception · DC 12"
  note: string,
  mine: boolean,
): Promise<HTMLElement> {
  let from = start;
  const die = el("div", mine ? "dnd-throw mine" : "dnd-throw");
  die.innerHTML = D20;
  const face = el("span", "dnd-throw-number", "20");
  const label = el(
    "small",
    "dnd-throw-note",
    mine ? `${before}: click or press Return` : "",
  );
  die.append(face, label);
  ctx.board.append(die);
  const place = (point: { x: number; y: number }): void => {
    die.style.left = `${String(point.x)}px`;
    die.style.top = `${String(point.y)}px`;
  };
  if (mine && !fast(ctx)) {
    const box = ctx.board.getBoundingClientRect();
    from = { x: box.width / 2, y: box.height / 2 };
    place(from);
    await waitForThrow(ctx, die);
    label.textContent = "";
  }
  place(to);
  if (!still(ctx)) {
    const dx = from.x - to.x;
    const dy = from.y - to.y;
    const at = (x: number, y: number, turn: number, size: number): string =>
      `translate(calc(-50% + ${String(x)}px), calc(-50% + ${String(y)}px)) rotate(${String(turn)}deg) scale(${String(size)})`;
    const tumble = die.animate(
      [
        { transform: at(dx, dy, 0, 1.3) },
        { transform: at(dx * 0.45, dy * 0.45 - 60, 400, 1.15), offset: 0.45 },
        { transform: at(dx * 0.12, dy * 0.12, 640, 1), offset: 0.8 },
        { transform: at(0, -14, 700, 1), offset: 0.9 },
        { transform: at(0, 0, 720, 1) },
      ],
      { duration: mine ? 1100 : 750, easing: "cubic-bezier(.3,.7,.4,1)" },
    );
    for (let tick = 0; tick < (mine ? 14 : 8) && !fast(ctx); tick += 1) {
      face.textContent = String(1 + Math.floor(Math.random() * 20));
      await wait(ctx, mine ? 70 : 80);
    }
    await tumble.finished.catch(() => undefined);
  }
  face.textContent = String(natural);
  label.textContent = note;
  die.classList.toggle("crit", natural === 20);
  die.classList.toggle("fumble", natural === 1);
  return die;
}

// A swing at the target, a shot flying to it, or a spell streaking to it.
export async function strike(
  ctx: BoardContext,
  attacker: Token,
  target: Token,
  style: "melee" | "ranged" | "spell",
): Promise<void> {
  if (still(ctx)) return;
  const from = centreOf(ctx, attacker.node);
  const to = centreOf(ctx, target.node);
  if (style === "melee") {
    const dx = (to.x - from.x) * 0.45;
    const dy = (to.y - from.y) * 0.45;
    attacker.node.animate(
      [
        { transform: "translate(-50%, -50%)" },
        {
          transform: `translate(calc(-50% + ${String(dx)}px), calc(-50% + ${String(dy)}px)) scale(1.12)`,
        },
        { transform: "translate(-50%, -50%)" },
      ],
      { duration: 380, easing: "ease-in-out" },
    );
    await wait(ctx, 170);
    const slash = el("div", "dnd-slash");
    slash.style.left = `${String(to.x)}px`;
    slash.style.top = `${String(to.y)}px`;
    ctx.board.append(slash);
    await slash
      .animate(
        [
          {
            transform: "translate(-50%, -50%) rotate(-70deg) scale(0.6)",
            opacity: 0,
          },
          {
            transform: "translate(-50%, -50%) rotate(10deg) scale(1.1)",
            opacity: 1,
            offset: 0.5,
          },
          {
            transform: "translate(-50%, -50%) rotate(40deg) scale(1.2)",
            opacity: 0,
          },
        ],
        { duration: 320, easing: "ease-out" },
      )
      .finished.catch(() => undefined);
    slash.remove();
    return;
  }
  const shot = el("div", style === "spell" ? "dnd-bolt" : "dnd-arrow");
  const angle = (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
  shot.style.left = `${String(from.x)}px`;
  shot.style.top = `${String(from.y)}px`;
  ctx.board.append(shot);
  await shot
    .animate(
      [
        { transform: `translate(-50%, -50%) rotate(${String(angle)}deg)` },
        {
          transform: `translate(calc(-50% + ${String(to.x - from.x)}px), calc(-50% + ${String(to.y - from.y)}px)) rotate(${String(angle)}deg)`,
        },
      ],
      { duration: style === "spell" ? 420 : 300, easing: "ease-in" },
    )
    .finished.catch(() => undefined);
  shot.remove();
}
