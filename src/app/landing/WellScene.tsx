"use client";

import { useEffect, useRef } from "react";
import styles from "./landing.module.css";

const NS = "http://www.w3.org/2000/svg";

const CAPTIONS = [
  "a wish enters — a story and resources; suppliers keep the pool topped up",
  "model providers ship a release — every dormant wish re-tests itself",
  "one passes — it wakes; a builder-made agent executes from the shared pool",
  "the story decides what returns — you, the pool, and its suppliers all get paid",
];

export function WellScene() {
  const svgRef = useRef<SVGSVGElement>(null);
  const partRef = useRef<SVGGElement>(null);
  const glowRef = useRef<SVGEllipseElement>(null);
  const goldGlowRef = useRef<SVGEllipseElement>(null);
  const testRef = useRef<SVGGElement>(null);
  const doneRef = useRef<SVGGElement>(null);
  const capRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const svg = svgRef.current;
    const partG = partRef.current;
    const capEl = capRef.current;
    if (!svg || !partG) return;

    partG.replaceChildren();

    const animate = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const yous = Array.from(svg.querySelectorAll<SVGPathElement>("[data-you]"));
    const builders = Array.from(svg.querySelectorAll<SVGPathElement>("[data-builder]"));
    const execs = Array.from(svg.querySelectorAll<SVGPathElement>("[data-exec]"));
    const golds = Array.from(svg.querySelectorAll<SVGPathElement>("[data-gold]"));
    const models = Array.from(svg.querySelectorAll<SVGPathElement>("[data-model]"));

    interface Bead {
      path: SVGPathElement;
      el: SVGCircleElement;
      t: number;
      spd: number;
      ph: number;
      L: number;
    }
    const beads: Bead[] = [];
    const addBead = (path: SVGPathElement, color: string, ph: number) => {
      const c = document.createElementNS(NS, "circle");
      c.setAttribute("r", "2.8");
      c.setAttribute("fill", color);
      partG.appendChild(c);
      beads.push({
        path,
        el: c,
        t: Math.random(),
        spd: 0.13 + Math.random() * 0.09,
        ph,
        L: path.getTotalLength(),
      });
    };
    yous.forEach((p) => {
      addBead(p, "#5B6CF0", 0);
      addBead(p, "#8EA0FF", 0);
      addBead(p, "#5B6CF0", 0);
    });
    builders.forEach((p) => {
      addBead(p, "#38BDF8", 2);
      addBead(p, "#7DD3FC", 2);
    });
    models.forEach((p) => {
      addBead(p, "#8EA0FF", 1);
      addBead(p, "#5B6CF0", 1);
    });
    execs.forEach((p) => {
      addBead(p, "#38BDF8", 2);
      addBead(p, "#5B6CF0", 2);
    });
    golds.forEach((p) => {
      for (let k = 0; k < 3; k++) addBead(p, "#D8A72B", 3);
    });

    let phase = 0;
    let phaseT = 0;
    let capSeq = 0;
    const setCap = (txt: string) => {
      if (!capEl) return;
      const seq = ++capSeq;
      capEl
        .animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: "forwards" })
        .finished.then(() => {
          if (seq !== capSeq) return;
          capEl.textContent = txt;
          capEl.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 400, fill: "forwards" });
        })
        .catch(() => {});
    };
    const applyPhase = () => {
      yous.forEach((p) => p.setAttribute("stroke-opacity", phase === 0 ? ".75" : ".22"));
      builders.forEach((p) => p.setAttribute("stroke-opacity", phase === 2 ? ".75" : ".22"));
      models.forEach((p) => p.setAttribute("stroke-opacity", phase === 1 ? ".75" : ".22"));
      execs.forEach((p) => p.setAttribute("stroke-opacity", phase === 2 ? ".75" : ".22"));
      golds.forEach((p) => p.setAttribute("stroke-opacity", phase === 3 ? ".5" : "0"));
      if (glowRef.current) glowRef.current.style.opacity = phase === 1 ? ".4" : ".16";
      if (goldGlowRef.current) goldGlowRef.current.style.opacity = phase === 2 ? ".75" : ".35";
      if (doneRef.current) doneRef.current.style.opacity = phase === 3 ? "1" : ".55";
      if (testRef.current && phase === 1 && animate) {
        testRef.current.animate(
          [
            { transform: "scale(1)", opacity: 0.9 },
            { transform: "scale(1.26)", opacity: 0 },
          ],
          { duration: 1400, iterations: 2, easing: "ease-out" },
        );
      }
    };
    const placeBeads = () =>
      beads.forEach((b) => {
        const pt = b.path.getPointAtLength((b.t % 1) * b.L);
        b.el.setAttribute("cx", pt.x.toFixed(1));
        b.el.setAttribute("cy", pt.y.toFixed(1));
      });

    if (capEl) capEl.textContent = CAPTIONS[0];
    applyPhase();
    placeBeads();
    beads.forEach((b) => b.el.setAttribute("opacity", b.ph === 3 ? "0" : ".6"));
    if (!animate) return;

    let netAlive = false;
    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      if (!netAlive) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      beads.forEach((b) => {
        const active = b.ph === phase || (b.ph === 0 && phase === 1);
        if (b.ph === 3 && phase !== 3) {
          b.el.setAttribute("opacity", "0");
          return;
        }
        b.t += b.spd * dt * (active ? 3 : 1.4);
        const pt = b.path.getPointAtLength((b.t % 1) * b.L);
        b.el.setAttribute("cx", pt.x.toFixed(1));
        b.el.setAttribute("cy", pt.y.toFixed(1));
        b.el.setAttribute("opacity", active ? ".95" : ".28");
        b.el.setAttribute("r", active ? "3.1" : "2.3");
      });
      phaseT += dt;
      if (phaseT > 3.6) {
        phaseT = 0;
        phase = (phase + 1) % 4;
        setCap(CAPTIONS[phase]);
        applyPhase();
      }
      raf = requestAnimationFrame(frame);
    };
    const start = () => {
      if (raf) return;
      netAlive = true;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      netAlive = false;
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    };
    const io = new IntersectionObserver(
      (es) => es.forEach((e) => (e.isIntersecting ? start() : stop())),
      { threshold: 0.05 },
    );
    io.observe(svg);
    start();

    return () => {
      stop();
      io.disconnect();
      capSeq++;
    };
  }, []);

  return (
    <>
      <div className={styles.wellWrap}>
        <div className={styles.wellBox}>
          <svg
            ref={svgRef}
            className={styles.netSvg}
            viewBox="0 0 760 640"
            preserveAspectRatio="xMidYMid meet"
            aria-hidden="true"
          >
            <defs>
              <linearGradient id="lqFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#5B6CF0" stopOpacity=".1" />
                <stop offset="1" stopColor="#5B6CF0" stopOpacity=".3" />
              </linearGradient>
              <filter id="lqBlur" x="-80%" y="-80%" width="260%" height="260%">
                <feGaussianBlur stdDeviation="10" />
              </filter>
              <filter id="lqSoft" x="-60%" y="-60%" width="220%" height="220%">
                <feGaussianBlur stdDeviation="4" />
              </filter>
              <clipPath id="lqMouth">
                <ellipse cx="380" cy="270" rx="108" ry="22" />
              </clipPath>
              <radialGradient id="lqShaft" cx="50%" cy="50%" r="65%">
                <stop offset="0" stopColor="#1E2452" stopOpacity=".5" />
                <stop offset=".6" stopColor="#3A46A8" stopOpacity=".25" />
                <stop offset="1" stopColor="#5B6CF0" stopOpacity=".1" />
              </radialGradient>
            </defs>

            {}
            <text x="36" y="200" fontFamily="JetBrains Mono" fontSize="9.5" fill="#8A90A2">
              acts today? it starts. too early? it waits.
            </text>
            <text x="566" y="166" fontFamily="JetBrains Mono" fontSize="9.5" fill="#8A90A2">
              every open wish is a bounty
            </text>

            {}
            <g fill="none" strokeLinecap="round">
              <path data-you d="M232,133 C300,150 330,200 348,254" stroke="#5B6CF0" strokeOpacity=".3" strokeWidth="1.5" />
              <path data-you d="M180,435 C235,400 258,305 338,258" stroke="#5B6CF0" strokeOpacity=".3" strokeWidth="1.4" />
              <path data-builder d="M558,133 C490,158 438,206 414,252" stroke="#38BDF8" strokeOpacity=".3" strokeWidth="1.4" />
              <path data-model d="M380,90 C380,140 380,195 380,238" stroke="#8EA0FF" strokeOpacity=".3" strokeWidth="1.4" strokeDasharray="2 5" />
              <path data-exec d="M368,276 C470,306 520,330 600,330" stroke="#38BDF8" strokeOpacity=".3" strokeWidth="1.5" />
              <path data-gold d="M602,346 C520,536 240,536 116,152" stroke="#D8A72B" strokeOpacity="0" strokeWidth="1.3" strokeDasharray="3 6" />
              <path data-gold d="M602,330 C530,244 474,222 424,250" stroke="#D8A72B" strokeOpacity="0" strokeWidth="1.3" strokeDasharray="3 6" />
              <path data-gold d="M330,290 C250,330 200,380 110,420" stroke="#D8A72B" strokeOpacity="0" strokeWidth="1.3" strokeDasharray="3 6" />
              <path data-gold d="M652,346 C650,356 648,365 646,375" stroke="#D8A72B" strokeOpacity="0" strokeWidth="1.3" strokeDasharray="3 6" />
            </g>

            {}
            <ellipse ref={glowRef} cx="380" cy="330" rx="175" ry="130" fill="#5B6CF0" opacity=".16" filter="url(#lqBlur)" style={{ transition: "opacity .8s ease" }} />
            <ellipse cx="380" cy="436" rx="150" ry="15" fill="rgba(31,42,90,.16)" filter="url(#lqBlur)" />
            <ellipse cx="380" cy="402" rx="140" ry="27" fill="rgba(255,255,255,.28)" stroke="rgba(255,255,255,.75)" strokeWidth="1" />
            <path d="M250,270 L250,400 A130,26 0 0 0 510,400 L510,270" fill="rgba(255,255,255,.34)" stroke="rgba(255,255,255,.92)" strokeWidth="1.6" />
            <path d="M252,338 A130,26 0 0 0 508,338" fill="none" stroke="rgba(255,255,255,.5)" strokeWidth="1" />
            <path d="M254,372 A130,26 0 0 0 506,372" fill="none" stroke="rgba(255,255,255,.45)" strokeWidth="1" />
            <line x1="300" y1="300" x2="300" y2="414" stroke="rgba(255,255,255,.5)" strokeWidth="1" />
            <line x1="340" y1="304" x2="340" y2="422" stroke="rgba(255,255,255,.5)" strokeWidth="1" />
            <line x1="380" y1="306" x2="380" y2="425" stroke="rgba(255,255,255,.5)" strokeWidth="1" />
            <line x1="420" y1="304" x2="420" y2="422" stroke="rgba(255,255,255,.5)" strokeWidth="1" />
            <line x1="460" y1="300" x2="460" y2="414" stroke="rgba(255,255,255,.5)" strokeWidth="1" />
            <line x1="320" y1="302" x2="320" y2="418" stroke="rgba(91,108,240,.14)" strokeWidth="6" />
            <line x1="440" y1="302" x2="440" y2="418" stroke="rgba(91,108,240,.14)" strokeWidth="6" />
            <ellipse cx="380" cy="270" rx="132" ry="30" fill="rgba(255,255,255,.6)" stroke="rgba(255,255,255,.95)" strokeWidth="2" />
            <g ref={testRef} style={{ transformBox: "fill-box", transformOrigin: "center", opacity: 0 }}>
              <ellipse cx="380" cy="270" rx="132" ry="30" fill="none" stroke="#5B6CF0" strokeWidth="2" strokeOpacity=".55" />
            </g>
            <ellipse cx="380" cy="270" rx="108" ry="22" fill="url(#lqShaft)" stroke="rgba(255,255,255,.8)" strokeWidth="1.2" />
            <ellipse cx="380" cy="270" rx="78" ry="15" fill="none" stroke="rgba(27,32,48,.14)" strokeWidth="1" />
            <ellipse cx="380" cy="270" rx="48" ry="9" fill="none" stroke="rgba(27,32,48,.18)" strokeWidth="1" />

            {}
            <g clipPath="url(#lqMouth)">
              <g className={styles.lqBob} style={{ animationDelay: "-1.4s" }}>
                <ellipse ref={goldGlowRef} cx="352" cy="270" rx="24" ry="16" fill="#F5C542" opacity=".35" filter="url(#lqSoft)" style={{ transition: "opacity .8s ease" }} />
                <polygon points="352,250 369,260 352,270 335,260" fill="#FFF3D6" stroke="rgba(255,255,255,.9)" strokeWidth=".8" />
                <polygon points="352,270 369,260 369,278 352,288" fill="rgba(224,162,26,.62)" stroke="rgba(255,255,255,.85)" strokeWidth=".8" />
                <polygon points="352,270 335,260 335,278 352,288" fill="rgba(245,197,66,.42)" stroke="rgba(255,255,255,.85)" strokeWidth=".8" />
              </g>
              <g className={styles.lqBob} style={{ animationDelay: "-3s" }}>
                <polygon points="418,245 431,252 418,259 405,252" fill="rgba(255,255,255,.95)" stroke="rgba(255,255,255,.9)" strokeWidth=".7" />
                <polygon points="418,259 431,252 431,265 418,272" fill="rgba(91,108,240,.5)" stroke="rgba(255,255,255,.85)" strokeWidth=".7" />
                <polygon points="418,259 405,252 405,265 418,272" fill="rgba(122,138,255,.3)" stroke="rgba(255,255,255,.85)" strokeWidth=".7" />
              </g>
              <g className={styles.lqBob} style={{ animationDelay: "-.8s" }}>
                <polygon points="388,272 400,278 388,284 376,278" fill="rgba(255,255,255,.95)" stroke="rgba(255,255,255,.9)" strokeWidth=".7" />
                <polygon points="388,284 400,278 400,290 388,296" fill="rgba(56,189,248,.45)" stroke="rgba(255,255,255,.85)" strokeWidth=".7" />
                <polygon points="388,284 376,278 376,290 388,296" fill="rgba(125,211,252,.3)" stroke="rgba(255,255,255,.85)" strokeWidth=".7" />
              </g>
              <g className={styles.lqBob} style={{ animationDelay: "-2.1s" }}>
                <polygon points="335,273 344,278 335,283 326,278" fill="rgba(255,255,255,.95)" stroke="rgba(255,255,255,.9)" strokeWidth=".7" />
                <polygon points="335,283 344,278 344,287 335,292" fill="rgba(91,108,240,.45)" stroke="rgba(255,255,255,.85)" strokeWidth=".7" />
                <polygon points="335,283 326,278 326,287 335,292" fill="rgba(122,138,255,.28)" stroke="rgba(255,255,255,.85)" strokeWidth=".7" />
              </g>
              <g className={styles.lqBob} style={{ animationDelay: "-5.2s" }}>
                <polygon points="440,268 448,272 440,276 432,272" fill="rgba(255,255,255,.95)" stroke="rgba(255,255,255,.9)" strokeWidth=".7" />
                <polygon points="440,276 448,272 448,281 440,285" fill="rgba(56,189,248,.4)" stroke="rgba(255,255,255,.85)" strokeWidth=".7" />
                <polygon points="440,276 432,272 432,281 440,285" fill="rgba(125,211,252,.26)" stroke="rgba(255,255,255,.85)" strokeWidth=".7" />
              </g>
            </g>

            {}
            <rect x="284" y="296" width="18" height="118" rx="9" fill="rgba(255,255,255,.45)" filter="url(#lqSoft)" opacity=".6" transform="rotate(2 293 355)" />
            <g style={{ filter: "drop-shadow(0 4px 10px rgba(31,42,90,.14))" }}>
              <rect x="349" y="300" width="62" height="21" rx="10.5" fill="rgba(255,255,255,.78)" stroke="rgba(255,255,255,.9)" />
              <text x="380" y="314.5" textAnchor="middle" fontFamily="JetBrains Mono" fontSize="10.5" fontWeight="600" fill="#5B6CF0">
                votive
              </text>
            </g>
            <g>
              <rect x="256" y="349" width="248" height="17" rx="8.5" fill="rgba(255,255,255,.72)" />
              <text x="380" y="361" textAnchor="middle" fontFamily="JetBrains Mono" fontSize="9.5" fontWeight="600" fill="#4A5266">
                shared pool — capital · compute · api keys
              </text>
            </g>
            <g>
              <rect x="298" y="371" width="164" height="17" rx="8.5" fill="rgba(255,255,255,.6)" />
              <text x="380" y="383" textAnchor="middle" fontFamily="JetBrains Mono" fontSize="9.5" fontWeight="600" fill="#5B6478">
                idle assets → 1inch Aqua
              </text>
            </g>
            <text x="380" y="482" textAnchor="middle" fontFamily="JetBrains Mono" fontSize="10" fill="#8A90A2">
              the well — every wish its own tiny organisation
            </text>

            {}
            <g style={{ filter: "drop-shadow(0 6px 14px rgba(31,42,90,.16))" }}>
              <g>
                <rect x="36" y="118" width="196" height="30" rx="15" fill="rgba(255,255,255,.6)" stroke="rgba(255,255,255,.9)" />
                <circle cx="52" cy="133" r="3.5" fill="none" stroke="#5B6CF0" strokeWidth="1.5" />
                <text x="64" y="137" fontFamily="Space Grotesk" fontSize="12.5" fontWeight="600" fill="#1B2030">
                  you — story + resources
                </text>
              </g>
              <g>
                <rect x="558" y="118" width="172" height="30" rx="15" fill="rgba(255,255,255,.6)" stroke="rgba(255,255,255,.9)" />
                <circle cx="574" cy="133" r="3.5" fill="#38BDF8" />
                <text x="586" y="137" fontFamily="Space Grotesk" fontSize="12.5" fontWeight="600" fill="#1B2030">
                  builders ship agents
                </text>
              </g>
              <g>
                <rect x="602" y="315" width="150" height="30" rx="15" fill="rgba(255,255,255,.6)" stroke="rgba(255,255,255,.9)" />
                <circle cx="618" cy="330" r="3.5" fill="#F5C542" stroke="#B8860B" strokeWidth="1" />
                <text x="630" y="334" fontFamily="Space Grotesk" fontSize="12.5" fontWeight="600" fill="#1B2030">
                  0047 executes
                </text>
              </g>
              <g ref={doneRef} style={{ opacity: 0.55, transition: "opacity .8s ease" }}>
                <rect x="602" y="376" width="86" height="26" rx="13" fill="rgba(255,255,255,.55)" stroke="rgba(255,255,255,.85)" />
                <text x="645" y="393" textAnchor="middle" fontFamily="JetBrains Mono" fontSize="10.5" fontWeight="600" fill="#2E7D5B">
                  ✓ done
                </text>
              </g>
              <g>
                <rect x="300" y="36" width="160" height="30" rx="15" fill="rgba(255,255,255,.6)" stroke="rgba(255,255,255,.9)" />
                <circle cx="316" cy="51" r="3.5" fill="#8EA0FF" />
                <text x="328" y="55" fontFamily="Space Grotesk" fontSize="12.5" fontWeight="600" fill="#1B2030">
                  model providers
                </text>
              </g>
              <text x="380" y="82" textAnchor="middle" fontFamily="JetBrains Mono" fontSize="9.5" fill="#8A90A2">
                atlas · vega · nyx — every major release
              </text>
              <g>
                <rect x="30" y="420" width="150" height="30" rx="15" fill="rgba(255,255,255,.6)" stroke="rgba(255,255,255,.9)" />
                <circle cx="46" cy="435" r="3.5" fill="none" stroke="#5B6CF0" strokeWidth="1.5" />
                <text x="58" y="439" fontFamily="Space Grotesk" fontSize="12.5" fontWeight="600" fill="#1B2030">
                  pool suppliers
                </text>
              </g>
              <text x="30" y="470" fontFamily="JetBrains Mono" fontSize="9.5" fill="#8A90A2">
                supply the pool · rewarded
              </text>
              <g>
                <rect x="36" y="158" width="132" height="22" rx="11" fill="rgba(255,255,255,.55)" stroke="rgba(255,255,255,.85)" />
                <text x="102" y="173" textAnchor="middle" fontFamily="JetBrains Mono" fontSize="9.5" fontWeight="600" fill="#5B6478">
                  World ID · identity
                </text>
              </g>
              <g>
                <rect x="602" y="414" width="140" height="22" rx="11" fill="rgba(255,255,255,.55)" stroke="rgba(255,255,255,.85)" />
                <text x="672" y="429" textAnchor="middle" fontFamily="JetBrains Mono" fontSize="9.5" fontWeight="600" fill="#5B6478">
                  Hedera · payments
                </text>
              </g>
            </g>
            <g ref={partRef} />
          </svg>
        </div>
      </div>
      <div className={styles.netCaption} ref={capRef} data-reveal>
        a wish enters — a story and resources; suppliers keep the pool topped up
      </div>
    </>
  );
}
