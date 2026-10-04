import { useEffect, useState, type RefObject } from "react";

type Listener = (entry: IntersectionObserverEntry) => void;
const observers = new Map<
  string,
  {
    observer: IntersectionObserver;
    listeners: Map<Element, Set<Listener>>;
  }
>();

// Reveals share the same viewport options. One observer can watch all of them,
// including multiple subscriptions to the same element (live visibility + once).
function observe(el: Element, rootMargin: string, listener: Listener) {
  let group = observers.get(rootMargin);
  if (!group) {
    const listeners = new Map<Element, Set<Listener>>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          listeners.get(entry.target)?.forEach((notify) => notify(entry));
        }
      },
      { rootMargin },
    );
    group = { observer, listeners };
    observers.set(rootMargin, group);
  }
  const { observer, listeners } = group;
  let callbacks = listeners.get(el);
  if (!callbacks) {
    callbacks = new Set();
    listeners.set(el, callbacks);
  } else {
    // A later subscriber also needs the observer's initial visibility entry.
    observer.unobserve(el);
  }
  callbacks.add(listener);
  observer.observe(el);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    callbacks.delete(listener);
    if (callbacks.size === 0) {
      observer.unobserve(el);
      listeners.delete(el);
    }
    if (listeners.size === 0) {
      observer.disconnect();
      if (observers.get(rootMargin) === group) observers.delete(rootMargin);
    }
  };
}

export function useInView(
  ref: RefObject<Element | null>,
  { rootMargin, once = false }: { rootMargin?: string; once?: boolean } = {},
): boolean {
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Without the observer, showing the content beats hiding it forever.
    if (typeof IntersectionObserver === "undefined") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setInView(true);
      return;
    }
    const stop = observe(el, rootMargin ?? "0px", (entry) => {
      if (entry.isIntersecting) {
        setInView(true);
        if (once) stop();
      } else if (!once) {
        setInView(false);
      }
    });
    return stop;
  }, [ref, rootMargin, once]);

  return inView;
}
