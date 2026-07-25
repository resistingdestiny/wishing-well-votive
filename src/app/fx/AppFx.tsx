"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

export function AppFx() {
  const pathname = usePathname();

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let alive = true;
    let bootCleanup: (() => void) | null = null;

    const boot = () => {
      const timers: ReturnType<typeof setTimeout>[] = [];
      const ease = "cubic-bezier(.2,.7,.3,1)";

      const reveal = (el: HTMLElement, delay: number) => {
        timers.push(
          setTimeout(() => {
            if (!alive) return;
            el.style.opacity = "1";
            el.style.transform = "none";
          }, delay),
        );
      };
      const prep = (el: HTMLElement) => {
        el.style.opacity = "0";
        el.style.transform = "translateY(10px)";
        el.style.transition = `opacity .6s ${ease}, transform .6s ${ease}`;
      };

      const pending = new Map<HTMLElement, () => void>();
      const fire = (el: HTMLElement) => {
        const fn = pending.get(el);
        if (!fn) return;
        pending.delete(el);
        fn();
      };

      const revealEls = Array.from(
        document.querySelectorAll<HTMLElement>("[data-reveal]"),
      );
      revealEls.forEach(prep);
      const revealIo = new IntersectionObserver(
        (ents) =>
          ents.forEach((e) => {
            if (!e.isIntersecting) return;
            revealIo.unobserve(e.target);
            fire(e.target as HTMLElement);
          }),
        { threshold: 0.15 },
      );
      revealEls.forEach((el) => {
        revealIo.observe(el);
        pending.set(el, () => reveal(el, Number(el.dataset.reveal || 0)));
      });

      const groups = Array.from(
        document.querySelectorAll<HTMLElement>("[data-stagger]"),
      );
      const staggerKids: HTMLElement[] = [];
      groups.forEach((g) => {
        const kids = Array.from(g.children) as HTMLElement[];
        kids.forEach((k) => prep(k));
        kids.forEach((k, i) => pending.set(k, () => reveal(k, i * 60)));
        staggerKids.push(...kids);
      });
      const staggerIo = new IntersectionObserver(
        (ents) =>
          ents.forEach((e) => {
            if (!e.isIntersecting) return;
            staggerIo.unobserve(e.target);
            (Array.from(e.target.children) as HTMLElement[]).forEach(fire);
          }),
        { threshold: 0.12 },
      );
      groups.forEach((g) => staggerIo.observe(g));

      const ruleEls = Array.from(
        document.querySelectorAll<HTMLElement>("[data-rule]"),
      );
      const fireRule = (el: HTMLElement) => {
        el.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], {
          duration: 520,
          easing: ease,
          fill: "forwards",
        });
        el.style.transform = "scaleX(1)";
      };
      ruleEls.forEach((el) => {
        el.style.transform = "scaleX(0)";
        el.style.transformOrigin = "left";
      });
      const ruleIo = new IntersectionObserver(
        (ents) =>
          ents.forEach((e) => {
            if (!e.isIntersecting) return;
            ruleIo.unobserve(e.target);
            fire(e.target as HTMLElement);
          }),
        { threshold: 0.9 },
      );
      ruleEls.forEach((el) => {
        ruleIo.observe(el);
        pending.set(el, () => fireRule(el));
      });

      const countEls = Array.from(
        document.querySelectorAll<HTMLElement>("[data-count]"),
      );
      const runCount = (el: HTMLElement) => {
        const target = parseFloat(el.dataset.count || "0");
        const t0 = performance.now();
        const dur = 950;
        const step = (t: number) => {
          if (!alive) return;
          const k = Math.min(1, (t - t0) / dur);
          el.textContent = Math.round(target * (1 - Math.pow(1 - k, 3))).toLocaleString("en-US");
          if (k < 1) requestAnimationFrame(step);
          else el.textContent = target.toLocaleString("en-US");
        };
        requestAnimationFrame(step);
      };
      const countIo = new IntersectionObserver(
        (ents) =>
          ents.forEach((e) => {
            if (!e.isIntersecting) return;
            countIo.unobserve(e.target);
            fire(e.target as HTMLElement);
          }),
        { threshold: 0.6 },
      );
      countEls.forEach((el) => {
        el.textContent = "0";
        countIo.observe(el);
        pending.set(el, () => runCount(el));
      });

      let sweepQueued = false;
      const sweep = () => {
        sweepQueued = false;
        if (!alive || pending.size === 0) return;
        pending.forEach((_, el) => {

          if (el.getBoundingClientRect().top < window.innerHeight * 0.92) fire(el);
        });
      };
      const queueSweep = () => {
        if (sweepQueued) return;
        sweepQueued = true;
        requestAnimationFrame(sweep);
      };
      window.addEventListener("scroll", queueSweep, { passive: true });
      window.addEventListener("resize", queueSweep);

      return () => {
        timers.forEach(clearTimeout);
        revealIo.disconnect();
        staggerIo.disconnect();
        ruleIo.disconnect();
        countIo.disconnect();
        window.removeEventListener("scroll", queueSweep);
        window.removeEventListener("resize", queueSweep);
      };
    };

    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        if (!alive) return;
        bootCleanup = boot();
      });
    });

    return () => {
      alive = false;
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      bootCleanup?.();
    };

  }, [pathname]);

  return null;
}
