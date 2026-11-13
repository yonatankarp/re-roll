import { PLAYER_ACTOR } from "#sdk";
import {
  type BoardContext,
  animate,
  fast,
  showCaption,
  wait,
} from "./board-context.ts";
import { centreOf, rollDamage, strike, throwD20 } from "./board-dice.ts";
import {
  artFor,
  float,
  layout,
  setArt,
  setHp,
  tokenFor,
} from "./board-tokens.ts";
import type { DndCue } from "./cues.ts";
import { cueSound, setEffectsVolume } from "./sound.ts";

// Plays the cues one at a time: each kind of moment is animated for as long as PACE gives it.

// Milliseconds each kind of moment stays on screen.
const PACE: Record<DndCue["kind"], number> = {
  start: 1100,
  end: 1300,
  turn: 250,
  attack: 1100,
  check: 1300,
  damage: 650,
  heal: 650,
  down: 700,
  status: 550,
  cast: 450,
  move: 450,
  deathSave: 900,
  legendary: 900,
  resist: 900,
  lair: 1100,
};

const FADE: KeyframeAnimationOptions = { duration: 250, easing: "ease-out" };

const DAMAGE_COLORS: Record<string, string> = {
  fire: "#ff7a2f",
  cold: "#7fd3ff",
  lightning: "#ffe14d",
  thunder: "#c9b3ff",
  acid: "#9be35a",
  poison: "#7ccf5b",
  necrotic: "#b88cff",
  radiant: "#fff3a8",
  psychic: "#ff8ad8",
  force: "#a7b8ff",
};

async function showBanner(
  ctx: BoardContext,
  text: string,
  ms: number,
): Promise<void> {
  ctx.banner.textContent = text;
  ctx.banner.classList.add("shown");
  animate(
    ctx,
    ctx.banner,
    [
      { opacity: 0, transform: "translate(-50%, -50%) scale(1.6)" },
      { opacity: 1, transform: "translate(-50%, -50%) scale(1)" },
    ],
    { duration: 300, easing: "ease-out" },
  );
  await wait(ctx, ms);
  ctx.banner.classList.remove("shown");
}

export async function play(ctx: BoardContext, cue: DndCue): Promise<void> {
  // The player's own roll makes its sound when they throw it, not before.
  const ownRoll =
    (cue.kind === "attack" ||
      cue.kind === "check" ||
      cue.kind === "deathSave") &&
    cue.actor === PLAYER_ACTOR;
  if (!fast(ctx) && !ownRoll && ctx.host.sound?.() === true) {
    setEffectsVolume(ctx.host.volume?.() ?? 1);
    cueSound(cue);
  }
  const ms = PACE[cue.kind];
  switch (cue.kind) {
    case "start":
      ctx.grid = cue.grid;
      ctx.fitMap();
      for (const actor of cue.combatants) {
        const token = tokenFor(ctx, {
          ...actor,
          active: false,
          conditions: [],
          status: null,
        });
        token.x = actor.x;
        token.y = actor.y;
        setArt(ctx, token, ctx.latest ? artFor(ctx.latest, actor.id) : null);
      }
      layout(ctx);
      ctx.slot.hidden = false;
      await showBanner(ctx, "Roll for initiative!", ms);
      if (cue.surprised) {
        await showBanner(
          ctx,
          cue.surprised === "party"
            ? "Surprised!"
            : "You catch them by surprise!",
          ms,
        );
      }
      return;
    case "end": {
      ctx.howTo = ctx.howTo === "unseen" ? "unseen" : "done";
      const enemies = [...ctx.tokens.values()].filter(
        (t) => t.side === "enemy",
      );
      const party = [...ctx.tokens.values()].filter((t) => t.side !== "enemy");
      const text = enemies.every((t) => t.hp <= 0)
        ? "Victory!"
        : party.every((t) => t.hp <= 0)
          ? "Defeat"
          : "The fight is over";
      await showBanner(ctx, text, ms);
      return;
    }
    case "move": {
      const token = ctx.tokens.get(cue.actor);
      if (!token) return;
      token.x = cue.x;
      token.y = cue.y;
      layout(ctx);
      await wait(ctx, ms);
      return;
    }
    case "turn":
      for (const [id, token] of ctx.tokens) {
        token.node.classList.toggle("active", id === cue.actor);
      }
      await wait(ctx, ms);
      return;
    case "attack": {
      const attacker = ctx.tokens.get(cue.actor);
      const target = ctx.tokens.get(cue.target);
      if (!attacker || !target) return;
      const mine = cue.actor === PLAYER_ACTOR;
      showCaption(
        ctx,
        `${attacker.name} attacks ${target.name} with ${cue.label}`,
      );
      attacker.node.classList.add("acting");
      target.node.classList.add("targeted");
      const from = centreOf(ctx, attacker.node);
      const to = centreOf(ctx, target.node);
      const die = await throwD20(
        ctx,
        from,
        { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 },
        cue.natural,
        `${cue.label} · AC ${String(cue.ac)}`,
        `${String(cue.total)} vs AC ${String(cue.ac)}: ${cue.hit ? (cue.natural === 20 ? "Critical hit" : "Hit") : "Miss"}`,
        mine,
      );
      await wait(ctx, mine ? 350 : 200);
      await strike(ctx, attacker, target, cue.style);
      float(
        ctx,
        target,
        cue.hit ? (cue.natural === 20 ? "CRIT!" : "HIT") : "MISS",
        cue.hit ? "hit" : "miss",
      );
      if (!cue.hit) {
        animate(
          ctx,
          target.node,
          [
            { transform: "translate(-50%, -50%)" },
            { transform: "translate(calc(-50% + 14px), -50%)" },
            { transform: "translate(-50%, -50%)" },
          ],
          { duration: 260, easing: "ease-out" },
        );
      }
      ctx.pendingDamage =
        cue.hit && cue.damage
          ? { target: cue.target, dice: cue.damage, mine }
          : null;
      await wait(ctx, Math.max(200, ms - 900));
      die.remove();
      attacker.node.classList.remove("acting");
      target.node.classList.remove("targeted");
      showCaption(ctx, "");
      return;
    }
    case "deathSave": {
      const token = ctx.tokens.get(cue.actor);
      if (!token) return;
      const at = centreOf(ctx, token.node);
      const die = await throwD20(
        ctx,
        at,
        { x: at.x, y: at.y - 50 },
        cue.natural,
        "Death save · DC 10",
        `Death save: ${cue.natural >= 10 ? "Success" : "Failed"}`,
        cue.actor === PLAYER_ACTOR,
      );
      await wait(ctx, ms);
      die.remove();
      return;
    }
    case "check": {
      // Outside a fight the check rises over the page and fades away after, rather than pushing it about.
      const alone = ctx.tokens.size === 0;
      ctx.slot.classList.toggle("dnd-overlay", alone);
      ctx.slot.hidden = false;
      ctx.board.classList.add("checking");
      if (alone) animate(ctx, ctx.slot, [{ opacity: 0 }, { opacity: 1 }], FADE);
      const box = ctx.board.getBoundingClientRect();
      const middle = { x: box.width / 2, y: Math.max(110, box.height / 2) };
      const skill = `${cue.label.charAt(0).toUpperCase()}${cue.label.slice(1)}`;
      const die = await throwD20(
        ctx,
        { x: middle.x - 120, y: middle.y + 40 },
        middle,
        cue.natural,
        `${skill} · DC ${String(cue.dc)}`,
        `${skill} ${String(cue.total)} vs DC ${String(cue.dc)}: ${cue.success ? "Success" : "Failed"}`,
        cue.actor === PLAYER_ACTOR,
      );
      die.classList.add("big", cue.success ? "pass" : "fail");
      await wait(ctx, ms - 300);
      if (alone && !fast(ctx)) {
        await ctx.slot
          .animate([{ opacity: 1 }, { opacity: 0 }], FADE)
          .finished.catch(() => undefined);
      }
      die.remove();
      ctx.board.classList.remove("checking");
      ctx.slot.classList.remove("dnd-overlay");
      ctx.slot.hidden = ctx.tokens.size === 0;
      return;
    }
    case "damage": {
      const token = ctx.tokens.get(cue.actor);
      if (!token) return;
      const color = DAMAGE_COLORS[cue.type] ?? "#ff4d4d";
      // The damage dice, rolled where the blow lands, for the attack just shown.
      if (ctx.pendingDamage?.target === cue.actor && !fast(ctx)) {
        void rollDamage(
          ctx,
          centreOf(ctx, token.node),
          ctx.pendingDamage.dice,
          cue.amount,
          cue.critical,
          ctx.pendingDamage.mine,
        );
      }
      ctx.pendingDamage = null;
      token.node.style.setProperty("--flash", color);
      animate(
        ctx,
        token.node,
        [
          { transform: "translate(-50%, -50%)" },
          { transform: "translate(calc(-50% - 6px), -50%) rotate(-4deg)" },
          { transform: "translate(calc(-50% + 6px), -50%) rotate(4deg)" },
          { transform: "translate(-50%, -50%)" },
        ],
        { duration: 300 },
      );
      animate(
        ctx,
        token.disc,
        [
          { boxShadow: `0 0 0 0 ${color}`, filter: "brightness(2)" },
          { boxShadow: `0 0 24px 8px ${color}`, filter: "brightness(1)" },
          { boxShadow: "0 0 0 0 transparent", filter: "brightness(1)" },
        ],
        { duration: 500 },
      );
      float(
        ctx,
        token,
        `-${String(cue.amount)}`,
        cue.critical ? "damage crit" : "damage",
      );
      setHp(token, cue.hp);
      await wait(ctx, ms);
      return;
    }
    case "heal": {
      const token = ctx.tokens.get(cue.actor);
      if (!token) return;
      animate(
        ctx,
        token.disc,
        [
          { boxShadow: "0 0 0 0 #6dff9b" },
          { boxShadow: "0 0 26px 10px #6dff9b" },
          { boxShadow: "0 0 0 0 transparent" },
        ],
        { duration: 600 },
      );
      float(ctx, token, `+${String(cue.amount)}`, "heal");
      setHp(token, cue.hp);
      await wait(ctx, ms);
      return;
    }
    case "down": {
      const token = ctx.tokens.get(cue.actor);
      if (!token) return;
      token.node.classList.add("down");
      float(ctx, token, "Down!", "miss");
      await wait(ctx, ms);
      return;
    }
    case "status": {
      const token = ctx.tokens.get(cue.actor);
      if (!token) return;
      float(ctx, token, cue.text, "status");
      await wait(ctx, ms);
      return;
    }
    case "legendary": {
      const token = ctx.tokens.get(cue.actor);
      if (!token) return;
      showCaption(ctx, `${token.name}: legendary action, ${cue.label}`);
      float(ctx, token, cue.label, "legendary");
      animate(
        ctx,
        token.disc,
        [
          { boxShadow: "0 0 0 0 #ffd36b" },
          { boxShadow: "0 0 26px 10px #ffd36b" },
          { boxShadow: "0 0 0 0 transparent" },
        ],
        { duration: 700 },
      );
      await wait(ctx, ms);
      return;
    }
    case "resist": {
      const token = ctx.tokens.get(cue.actor);
      if (!token) return;
      showCaption(
        ctx,
        `${token.name} shrugs it off: Legendary Resistance (${String(cue.left)} left)`,
      );
      float(
        ctx,
        token,
        `Legendary Resistance (${String(cue.left)} left)`,
        "legendary",
      );
      await wait(ctx, ms);
      return;
    }
    case "lair": {
      animate(
        ctx,
        ctx.board,
        [
          { boxShadow: "inset 0 0 0 0 transparent" },
          { boxShadow: "inset 0 0 90px 30px rgb(150 40 20 / 70%)" },
          { boxShadow: "inset 0 0 0 0 transparent" },
        ],
        { duration: 900 },
      );
      await showBanner(ctx, `Lair action: ${cue.label}`, ms);
      return;
    }
    case "cast": {
      const token = ctx.tokens.get(cue.actor);
      if (!token) return;
      animate(
        ctx,
        token.disc,
        [
          { boxShadow: "0 0 0 0 #b38cff", filter: "hue-rotate(0deg)" },
          { boxShadow: "0 0 30px 12px #b38cff", filter: "hue-rotate(40deg)" },
          { boxShadow: "0 0 0 0 transparent", filter: "hue-rotate(0deg)" },
        ],
        { duration: 500 },
      );
      await wait(ctx, ms);
      return;
    }
  }
}
