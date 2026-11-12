import { type BoardContext, el } from "./board-context.ts";
import { MAX_ZOOM, nextZoom } from "./board-math.ts";

// Zoom and pan for a battle map too big for its frame. The frame keeps its fitted size and the map
// grows inside it, scrolling to pan, so every position the board reads from the page stays right.
// Control or Command with the wheel zooms, as does a trackpad pinch where the browser sends it as one,
// as Chromium does; WebKit's own gesture events aren't handled.
export function wireZoom(ctx: BoardContext, view: HTMLElement): HTMLElement {
  let zoom = 1;
  let fitted = 0; // the map's width at zoom 1
  const button = (
    text: string,
    label: string,
    keys: string,
  ): HTMLButtonElement => {
    const node = el("button", "", text) as HTMLButtonElement;
    node.type = "button";
    node.setAttribute("aria-label", label);
    node.setAttribute("aria-keyshortcuts", keys);
    node.title = `${label} (${keys})`;
    return node;
  };
  const zoomOut = button("−", "Zoom out", "-");
  const zoomIn = button("+", "Zoom in", "+");
  const fit = button("Fit", "Fit the map", "0");
  const bar = el("div", "dnd-zoom");
  bar.append(zoomOut, zoomIn, fit);

  // `at` is the point, in the frame's pixels, that stays put, such as under the pointer.
  const apply = (next: number, at?: { x: number; y: number }): void => {
    if (!ctx.grid && next > 1) return;
    if (zoom === 1) fitted = ctx.field.clientWidth;
    const ratio = next / zoom;
    const point = at ?? { x: view.clientWidth / 2, y: view.clientHeight / 2 };
    zoom = next;
    if (zoom === 1 || !ctx.grid) {
      zoom = 1;
      view.style.width = view.style.height = "";
      ctx.field.style.width = ctx.field.style.maxWidth = "";
      ctx.board.classList.remove("zoomed");
    } else {
      view.style.width = `${String(fitted)}px`;
      view.style.height = `${String((fitted * ctx.grid.height) / ctx.grid.width)}px`;
      ctx.field.style.width = `${String(fitted * zoom)}px`;
      ctx.field.style.maxWidth = "none";
      ctx.board.classList.add("zoomed"); // first, since only a zoomed view scrolls
      view.scrollLeft = (view.scrollLeft + point.x) * ratio - point.x;
      view.scrollTop = (view.scrollTop + point.y) * ratio - point.y;
    }
    zoomOut.disabled = zoom <= 1;
    zoomIn.disabled = zoom >= MAX_ZOOM;
  };
  ctx.fitMap = () => {
    apply(1);
  };
  apply(1);

  zoomOut.addEventListener("click", () => {
    apply(nextZoom(zoom, -1));
  });
  zoomIn.addEventListener("click", () => {
    apply(nextZoom(zoom, 1));
  });
  fit.addEventListener("click", () => {
    apply(1);
  });
  view.addEventListener(
    "wheel",
    (event) => {
      if (!(event.ctrlKey || event.metaKey) || !ctx.grid) return;
      event.preventDefault();
      const box = view.getBoundingClientRect();
      apply(nextZoom(zoom, -event.deltaY / 100), {
        x: event.clientX - box.left,
        y: event.clientY - box.top,
      });
    },
    { passive: false },
  );
  ctx.board.addEventListener("keydown", (event) => {
    if (event.target !== ctx.board || event.metaKey || event.ctrlKey) return;
    const steps = { "+": 1, "=": 1, "-": -1 }[event.key];
    if (steps === undefined && event.key !== "0") return;
    event.preventDefault();
    apply(steps === undefined ? 1 : nextZoom(zoom, steps));
  });
  // A new window size makes the fitted size stale, so the map fits again.
  let width = 0;
  new ResizeObserver(() => {
    if (ctx.slot.clientWidth !== width && zoom > 1) apply(1);
    width = ctx.slot.clientWidth;
  }).observe(ctx.slot);
  return bar;
}
