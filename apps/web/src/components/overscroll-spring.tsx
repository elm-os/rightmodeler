"use client";

import { useEffect, useRef, useState } from "react";
import { DiaGradient } from "@/components/dia-gradient";
import { usePrefersReducedMotion } from "@/components/use-prefers-reduced-motion";

const DESKTOP_BREAKPOINT = "(min-width: 640px)";
const TRAVEL_FRACTION = 0.62; // of the viewport height
const TRAVEL_MAX = 620; // px
const GAIN = 1.5; // px of target per px of pull, before rubber-band resistance
const PULL = { k: 210, c: 30 }; // ζ ≈ 1.04: hugs the finger, no wobble
const RELEASE = { k: 220, c: 30 }; // ζ ≈ 1.0: eases home instead of slamming

export function OverscrollSpring() {
  const reduce = usePrefersReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    const media = window.matchMedia(DESKTOP_BREAKPOINT);
    const sync = () => setEnabled(media.matches);

    sync();
    media.addEventListener("change", sync);

    return () => {
      media.removeEventListener("change", sync);
    };
  }, []);

  useEffect(() => {
    if (reduce || !enabled) return;
    const el = ref.current;
    if (!el) return;
    const content = document.querySelector<HTMLElement>(
      "[data-overscroll-content]",
    );

    let reveal = 0; // px, the spring position
    let target = 0;
    let vel = 0;
    let pulling = false;
    let spring = RELEASE;
    let rafId = 0;
    let lastT = 0;
    let idle: ReturnType<typeof setTimeout> | null = null;

    // Cache scroll metrics + the reveal ceiling — reading layout per wheel/touch event risks a flush.
    let maxY = 0;
    let travel = 0; // max reveal (px)
    const measure = () => {
      maxY = document.documentElement.scrollHeight - window.innerHeight;
      travel = Math.min(
        TRAVEL_MAX,
        Math.round(window.innerHeight * TRAVEL_FRACTION),
      );
      el.style.height = `${travel}px`;
    };
    measure();
    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(measure)
        : null;
    ro?.observe(document.body);
    window.addEventListener("resize", measure, { passive: true });

    const atBottom = () => maxY > 0 && window.scrollY >= maxY - 2;

    const render = () => {
      if (travel <= 0) return;
      const r = Math.max(0, Math.min(reveal, travel));
      el.style.transform = `scale3d(1, ${r / travel}, 1)`;
      el.style.opacity = String(Math.min(1, r / (travel * 0.3)));
      if (content) content.style.transform = `translate3d(0, ${-r}px, 0)`;
    };

    const tick = (now: number) => {
      if (!lastT) lastT = now;
      let dt = (now - lastT) / 1000;
      lastT = now;
      if (dt > 0.05) dt = 0.05; // ignore huge gaps (tab was hidden)
      // Fixed sub-steps → frame-rate-independent physics (same feel at 60 / 120 / 144 Hz).
      let acc = dt;
      const h = 1 / 240;
      while (acc > 0) {
        const step = Math.min(h, acc);
        const a = spring.k * (target - reveal) - spring.c * vel;
        vel += a * step;
        reveal += vel * step;
        acc -= step;
      }
      render();
      if (Math.abs(vel) < 1.5 && Math.abs(target - reveal) < 0.4) {
        reveal = target;
        vel = 0;
        render();
        el.style.willChange = "auto";
        if (content) {
          content.style.willChange = "auto";
          if (target === 0) content.style.transform = ""; // fully home — drop the layer
        }
        lastT = 0;
        rafId = 0;
        return;
      }
      rafId = requestAnimationFrame(tick);
    };
    const ensureTick = () => {
      if (!rafId) {
        el.style.willChange = "transform, opacity";
        if (content) content.style.willChange = "transform";
        lastT = 0;
        rafId = requestAnimationFrame(tick);
      }
    };

    const release = () => {
      pulling = false;
      target = 0;
      spring = RELEASE;
      ensureTick();
    };

    const pull = (delta: number) => {
      if (delta <= 0 || travel <= 0 || !atBottom()) return;
      if (!pulling) {
        target = Math.max(0, reveal); // resume from what's on screen — never restart from 0
        pulling = true;
      }
      const resist = 1 - Math.min(1, target / travel); // rubber-band: resistance grows toward the ceiling
      target = Math.min(travel, target + delta * GAIN * resist);
      spring = PULL;
      ensureTick();
      if (idle) clearTimeout(idle);
      idle = setTimeout(release, 120); // "stopped pulling" → snap back
    };

    const onWheel = (e: WheelEvent) => {
      // Normalize wheel units to px — Firefox + physical mice report line/page deltas, not pixels.
      let dy = e.deltaY;
      if (e.deltaMode === 1)
        dy *= 16; // DOM_DELTA_LINE → px
      else if (e.deltaMode === 2) dy *= window.innerHeight; // DOM_DELTA_PAGE → px
      pull(dy);
    };

    let touchY = 0;
    let touching = false;
    const onTouchStart = (e: TouchEvent) => {
      touchY = e.touches[0]?.clientY ?? 0;
      touching = true;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!touching) return;
      const y = e.touches[0]?.clientY ?? touchY;
      pull(touchY - y); // finger up = scroll down = positive
      touchY = y;
    };
    const onTouchEnd = () => {
      touching = false;
      if (idle) clearTimeout(idle);
      release();
    };

    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    render();

    return () => {
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("resize", measure);
      ro?.disconnect();
      if (rafId) cancelAnimationFrame(rafId);
      if (idle) clearTimeout(idle);
      el.style.willChange = "";
      el.style.transform = "scale3d(1, 0, 1)";
      el.style.opacity = "0";
      if (content) {
        content.style.transform = ""; // leave the page clean if we tore down mid-stretch
        content.style.willChange = "";
      }
    };
  }, [enabled, reduce]);

  if (!enabled) return null;

  // Rendered collapsed, then measured after mount, so the spring stays hydration-safe.
  return (
    <div
      ref={ref}
      aria-hidden
      className="pointer-events-none fixed inset-x-0 bottom-0 -z-10 overflow-hidden"
      style={{
        height: 0,
        transformOrigin: "bottom",
        transform: "scale3d(1, 0, 1)",
        opacity: 0,
      }}
    >
      <div className="h-full w-full">
        <DiaGradient rise={false} />
      </div>
    </div>
  );
}
