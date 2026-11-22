// A long list of still avatars, like a conversation list. ?rows=120&size=32&theme=dark
import { createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { AgentAvatar } from "../src/react.js";

const params = new URLSearchParams(location.search);
const rows = Number(params.get("rows") ?? 120);
const size = Number(params.get("size") ?? 32);
if (params.get("theme")) document.documentElement.dataset.theme = params.get("theme")!;
document.getElementById("info")!.textContent = `${rows} rows, ${size} px still avatars (hover one to bring it to life)`;

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
    h(AgentAvatar, { agentId: `agent-${i % 40}`, size }),
    h(
      "div",
      { className: "text" },
      h("div", { className: "name" }, `Conversation ${i + 1}`),
      h("div", { className: "snippet" }, snippets[i % snippets.length]),
    ),
    h("time", null, `${(i % 12) + 1}:${String((i * 7) % 60).padStart(2, "0")} pm`),
  ),
);
createRoot(document.getElementById("list")!).render(list);
