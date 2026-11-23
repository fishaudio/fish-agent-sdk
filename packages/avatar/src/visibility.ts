// One IntersectionObserver for every avatar on the page, with a wide margin so
// images are ready before they scroll into view.
type Listener = (visible: boolean) => void;

const listeners = new Map<Element, Listener>();
let observer: IntersectionObserver | null | undefined;

function getObserver() {
  if (observer === undefined) {
    observer =
      typeof IntersectionObserver === "function"
        ? new IntersectionObserver(
            (entries) => {
              for (const e of entries) listeners.get(e.target)?.(e.isIntersecting);
            },
            { rootMargin: "600px" },
          )
        : null;
  }
  return observer;
}

/** Calls `onChange` when `el` comes near or leaves the viewport. Without IntersectionObserver it reports visible at once. */
export function watchVisible(el: Element, onChange: Listener): () => void {
  const io = getObserver();
  if (!io) {
    onChange(true);
    return () => {};
  }
  listeners.set(el, onChange);
  io.observe(el);
  return () => {
    listeners.delete(el);
    io.unobserve(el);
  };
}
