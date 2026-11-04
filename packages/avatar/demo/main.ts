import {
  AVATAR_EXPRESSIONS,
  AVATAR_SHAPES,
  AVATAR_STATES,
  avatarLook,
  mountAvatar,
  type AvatarHandle,
  type AvatarOptions,
  type AvatarState,
} from "../src/index.js";

// Query options, for screenshots: ?theme=dark|light&reduce=1&seed=...
const params = new URLSearchParams(location.search);
const forceReduce = params.get("reduce") === "1" ? true : undefined;
const $ = (id: string) => document.getElementById(id)!;

function avatar(parent: HTMLElement, options: AvatarOptions, wrap?: (canvas: HTMLCanvasElement) => HTMLElement) {
  const canvas = document.createElement("canvas");
  canvas.style.display = "block";
  parent.append(wrap ? wrap(canvas) : canvas);
  return mountAvatar(canvas, { reducedMotion: forceReduce, ...options });
}
function cell(parent: HTMLElement, label: string, options: AvatarOptions, onClick?: () => void) {
  const el = document.createElement("div");
  el.className = "cell";
  parent.append(el);
  const handle = avatar(el, options);
  el.append(label);
  if (onClick) {
    el.style.cursor = "pointer";
    el.onclick = onClick;
  }
  return handle;
}
function segmented(id: string, values: readonly string[], initial: string, onPick: (v: string) => void) {
  const root = $(id);
  const buttons = values.map((v) => {
    const b = document.createElement("button");
    b.textContent = v;
    b.dataset.v = v;
    b.setAttribute("aria-pressed", String(v === initial));
    root.append(b);
    return b;
  });
  const pick = (v: string) => {
    for (const b of buttons) b.setAttribute("aria-pressed", String(b.dataset.v === v));
    onPick(v);
  };
  for (const b of buttons) b.onclick = () => pick(b.dataset.v!);
  return pick;
}

// Theme
const theme = params.get("theme");
const setTheme = (v: string) => {
  document.documentElement.dataset.theme = v;
  for (const b of $("theme").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.v === v));
};
setTheme(theme ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
for (const b of $("theme").querySelectorAll("button")) (b as HTMLButtonElement).onclick = () => setTheme(b.dataset.v!);

// A simulated speaking level, as a real session's getOutputVolume() would give.
const volume = () => {
  const t = performance.now() / 1000;
  const syllable = Math.max(0, Math.sin(t * 9.1) * Math.sin(t * 2.3 + 1));
  return 0.14 * syllable * (Math.sin(t * 0.7) > -0.6 ? 1 : 0);
};

// Hero
let seed = params.get("seed") ?? "agent-1";
($("seed") as HTMLInputElement).value = seed;
const hero = avatar($("hero").parentElement!, { id: seed, size: 96, animated: true, getVolume: volume }, (c) => {
  $("hero").replaceWith(c);
  return c;
});
const all: Array<{ handle: AvatarHandle; follows: boolean }> = [];
const pickState = segmented("state", AVATAR_STATES, "idle", (v) => hero.update({ state: v as AvatarState }));
for (const e of AVATAR_EXPRESSIONS) {
  const b = document.createElement("button");
  b.className = "chip";
  b.textContent = e;
  b.onclick = () => hero.emote(e);
  $("emote").append(b);
}
$("seed").oninput = (event) => {
  seed = (event.target as HTMLInputElement).value.trim() || "agent-1";
  hero.update({ id: seed });
  for (const a of all) if (a.follows) a.handle.update({ id: seed });
};

// Connecting → listening → speaking → ended, with a running clock for recordings.
let seqTimer = 0;
$("seq").onclick = () => {
  const steps: Array<[AvatarState, number]> = [
    ["connecting", 0],
    ["listening", 2200],
    ["speaking", 4600],
    ["ended", 7800],
  ];
  const start = performance.now();
  for (const [st, at] of steps) setTimeout(() => pickState(st), at);
  cancelAnimationFrame(seqTimer);
  const clock = () => {
    const ms = performance.now() - start;
    const current = [...steps].reverse().find(([, at]) => ms >= at)![0];
    $("seq-time").textContent = `${(ms / 1000).toFixed(2)} s · ${current}`;
    if (ms < 10000) seqTimer = requestAnimationFrame(clock);
  };
  clock();
};

// Sizes: the same seed at each size, alive.
for (const size of [16, 20, 24, 32, 40, 48, 64, 96]) {
  all.push({ handle: cell($("sizes"), `${size} px`, { id: seed, size, animated: true }), follows: true });
}

// One seed per outline, so all 18 show up; the colour comes from the same hash.
const seeds: string[] = [];
for (let i = 0, found = 0; found < AVATAR_SHAPES.length && i < 5000; i++) {
  const look = avatarLook(`agent-${i}`);
  if (!seeds[look.shape]) {
    seeds[look.shape] = `agent-${i}`;
    found++;
  }
}
seeds.forEach((s, i) => cell($("shapes"), AVATAR_SHAPES[i]!, { id: s, size: 56, animated: true }));

// States
for (const st of AVATAR_STATES) {
  all.push({ handle: cell($("states"), st, { id: seed, size: 72, animated: true, state: st, getVolume: volume }), follows: true });
}

// Expressions, replayable
for (const e of AVATAR_EXPRESSIONS) {
  const h: AvatarHandle = cell($("expressions"), e, { id: seed, size: 64, animated: true, expression: e }, () => {
    h.update({ expression: undefined });
    h.emote(e);
    setTimeout(() => h.update({ expression: e }), 1400);
  });
  all.push({ handle: h, follows: true });
}

// Reduced motion side by side
for (const st of AVATAR_STATES) {
  all.push({ handle: cell($("motion-on"), st, { id: seed, size: 48, animated: true, state: st, getVolume: volume }), follows: true });
  const still = document.createElement("div");
  still.className = "cell";
  $("motion-off").append(still);
  all.push({ handle: mountAvatarIn(still, { id: seed, size: 48, animated: true, state: st, reducedMotion: true }), follows: true });
  still.append(st);
}
function mountAvatarIn(parent: HTMLElement, options: AvatarOptions) {
  const canvas = document.createElement("canvas");
  canvas.style.display = "block";
  parent.append(canvas);
  return mountAvatar(canvas, options);
}

// In context: a still list inside a clipped scroller, a menu with the enlarged variant, slot vs enlarged.
const names = ["Front desk", "Order taker", "Flight booking", "Retail support", "Collections", "Clinic reminders", "IT helpdesk", "Hotel concierge", "Survey caller", "Insurance intake"];
names.forEach((name, i) => {
  const item = document.createElement("div");
  item.className = "item";
  $("list").append(item);
  avatar(item, { id: `agent-${i + 10}`, size: i % 2 ? 24 : 40 });
  item.append(name);
});
names.slice(0, 4).forEach((name, i) => {
  const item = document.createElement("div");
  item.className = "item";
  $("menu").append(item);
  avatar(item, { id: `agent-${i + 10}`, size: 24, variant: "enlarged" });
  item.append(name);
});
for (const [id, variant] of [["slot-normal", "slot"], ["slot-enlarged", "enlarged"]] as const) {
  const slot = $(id);
  slot.style.cssText = "display:inline-block;width:40px;height:40px";
  all.push({ handle: avatar(slot, { id: seed, size: 40, variant }), follows: true });
}
