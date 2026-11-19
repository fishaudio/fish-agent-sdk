import { mountAvatar, type AvatarState } from "../src/index.js";

const $ = (id: string) => document.getElementById(id)!;
const canvas = () => document.createElement("canvas");

const hero = mountAvatar($("hero") as HTMLCanvasElement, { id: "Beau", size: 180 });
const others: Array<ReturnType<typeof mountAvatar>> = [];

const names = ["Beau", "Maya", "Luca", "Iris", "Noah", "Ava", "Theo", "Nora"];
for (const name of names) {
  const item = document.createElement("div");
  item.className = "item";
  const c = canvas();
  item.append(c, name);
  item.onclick = () => select(name);
  $("list").append(item);
  others.push(mountAvatar(c, { id: name, size: 40 }));
}
for (const size of [64, 48, 32, 24]) {
  const item = document.createElement("div");
  item.className = "size";
  const c = canvas();
  item.append(c, `${size} px`);
  $("sizes").append(item);
  others.push(mountAvatar(c, { id: "Beau", size }));
}
for (let i = 1; i <= 24; i++) {
  const c = canvas();
  c.title = `agent-${i}`;
  c.onclick = () => select(`agent-${i}`);
  $("grid").append(c);
  others.push(mountAvatar(c, { id: `agent-${i}`, size: 56 }));
}

function select(id: string) {
  ($("agent-id") as HTMLInputElement).value = id;
  hero.update({ id });
}
function group(id: string, onPick: (button: HTMLButtonElement) => void) {
  const buttons = [...$(id).querySelectorAll("button")];
  for (const button of buttons) {
    button.onclick = () => {
      for (const b of buttons) b.setAttribute("aria-pressed", String(b === button));
      onPick(button);
    };
  }
}

$("agent-id").oninput = (event) => hero.update({ id: (event.target as HTMLInputElement).value.trim() || "Beau" });
group("motion", (b) => {
  const animated = b.dataset.animated === "true";
  hero.update({ animated });
  for (const other of others) other.update({ animated });
});
group("state", (b) => hero.update({ state: b.dataset.state as AvatarState }));
