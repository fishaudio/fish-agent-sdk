// A long list of still avatars, like a conversation list. ?rows=120&size=32&animated=1&theme=dark
// With animated=1, avatars under 32 px blink by swapping images.
import { createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { AgentAvatar } from "../src/react.js";

const params = new URLSearchParams(location.search);
const rows = Number(params.get("rows") ?? 120);
const size = Number(params.get("size") ?? 32);
const animated = params.get("animated") === "1";
// avatars=0: the same list with plain grey circles, as a baseline
const withAvatars = params.get("avatars") !== "0";
if (params.get("theme")) document.documentElement.dataset.theme = params.get("theme")!;
document.getElementById("info")!.textContent = `${rows} rows, ${size} px ${animated ? "animated" : "still"} avatars (hover one to bring it to life)`;

const snippets = [
  "Thanks, I'd like to move my appointment to Thursday afternoon.",
  "Can you check whether my order has shipped yet?",
  "The caller asked about opening hours and parking.",
  "Booked a table for four at 7:30 pm.",
  "Transferred to a human agent after two attempts.",
];
const list = Array.from({ length: rows }, (_, i) =>
  h(
    "div",
    { className: "row", key: i },
    withAvatars
      ? h(AgentAvatar, { agentId: `agent-${i % 40}`, size, animated })
      : h("span", { style: { width: size, height: size, borderRadius: "50%", background: "#ddd", flex: "none" } }),
    h(
      "div",
      { className: "text" },
      h("div", { className: "name" }, `Conversation ${i + 1}`),
      h("div", { className: "snippet" }, snippets[i % snippets.length]),
    ),
    h("time", null, `${(i % 12) + 1}:${String((i * 7) % 60).padStart(2, "0")} pm`),
  ),
);
const root = createRoot(document.getElementById("list")!);
root.render(list);
// Leave and come back, like switching pages in an app: window.remountList()
(window as unknown as { remountList: () => Promise<void> }).remountList = () =>
  new Promise((done) => {
    root.render(null);
    setTimeout(() => {
      root.render(list);
      done();
    }, 100);
  });
