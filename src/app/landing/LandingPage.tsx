import Link from "next/link";
import styles from "./landing.module.css";
import { LiquidCube } from "./LiquidCube";
import { WellScene } from "./WellScene";
import { LiquidFx } from "./LiquidFx";
import { Estimator } from "./Estimator";
import type { V7LandingData } from "../votive/data";

export function LandingPage({ d }: { d: V7LandingData }) {
  const f = d.featured;
  const boardCols = `1fr ${d.boardModels.map(() => "40px").join(" ")} 46px 52px 68px`;

  return (
    <div className={styles.lg} data-lg-root>
      <LiquidFx />

      {}
      <section className={styles.heroWrap}>
        <div className={styles.heroGrid}>
          <div className={styles.heroCopy}>
            <div className={styles.kicker} data-reveal="0">
              Liquid-held wishes
            </div>
            <h1 className={styles.h1} data-reveal="60">
              The well where wishes{" "}
              <span className={styles.h1Accent}>actually come true</span>.
            </h1>
            <p className={styles.sub} data-reveal="120">
              Give an AI agent two things: a story, and the resources to act on it.
              If it can act today, it starts. If it can&rsquo;t, your wish sleeps in
              its own segregated cell and tests itself against every major model
              release. The moment it passes, it wakes up and goes to work. DCA into
              superintelligence.
            </p>
            <div className={styles.ctaRow} data-reveal="180">
              <Link href="/create" className={styles.ctaPrimary}>
                Make a wish
              </Link>
              <Link href="/explore" className={styles.ctaGlass}>
                See the vault →
              </Link>
            </div>
            <div className={styles.statRow} data-reveal="240">
              <span>
                <b data-count={d.openWishes}>{d.openWishes}</b>
                wishes held
              </span>
              <span>
                <b>
                  <span data-count={Math.round(Number(d.ethParked) || 0)}>{d.ethParked}</span> ETH
                </b>
                in glass
              </span>
              <span>
                <b>2% / 8%</b>
                parked / granted
              </span>
            </div>
            <div className={styles.audRow} data-reveal="300">
              <Link href="/frontier">For researchers → Research</Link>
              <Link href="/agents">For developers → Build</Link>
            </div>
          </div>
          <div className={styles.cubeStage} data-reveal="140">
            <div className={styles.cubeStageInner}>
              <div className={styles.sheen} />
              <LiquidCube className={styles.cube} />
            </div>
            {f ? (
              <div className={styles.floatCard} data-reveal="400">
                <div className={styles.floatKicker}>◆ WISH {f.tag}</div>
                <div className={styles.floatTitle}>
                  &ldquo;{f.story.length > 88 ? `${f.story.slice(0, 88)}…` : f.story}&rdquo;
                </div>
                <div className={styles.floatDivider} />
                <div className={styles.floatMeta}>
                  <span>{f.parkedEth} ETH</span>
                  <span>
                    {f.status} · {f.sweeps} sweeps
                  </span>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </section>

      {}
      <section id="vault" className={styles.netSection}>
        <div className={styles.netGrid}>
          <div className={styles.netCopy}>
            <div className={styles.kicker} data-reveal="0">
              A wishing well that grants
            </div>
            <h2 className={styles.h2} data-reveal="60">
              Where wishes actually come true.
            </h2>
            <p className={styles.netBody} data-reveal="120">
              To make a wish, you give an agent two things: <b>a story and resources</b>.
              If it can act today, it starts. If it can&rsquo;t, it goes dormant and
              tests itself against every major model release. The moment it passes, it
              wakes and executes, using your resources plus a{" "}
              <b>pool that every wish in the well shares</b>: capital, compute, API keys.
            </p>
            <div className={styles.legend} data-reveal="180">
              <div className={styles.bulletItem}>
                <span className={styles.dotRes} />
                Each wish is its own tiny organisation: a one-wish charity, fund, or
                company, with segregated resources nothing else can touch
              </div>
              <div className={styles.bulletItem}>
                <span className={styles.dotAgent} />
                Builders earn too. Every open wish is a bounty: ship the agent that
                grants it and take a share of what comes back
              </div>
              <div className={styles.bulletItem}>
                <span className={styles.dotWish} />
                When it completes, the story decides: profit back to you, into the
                pool, or simply done
              </div>
            </div>
            <div className={styles.exampleCard} data-reveal="240">
              <div className={styles.exLabel}>◆ EXAMPLE WISH</div>
              <div className={styles.exBody}>
                &ldquo;When an AI can find exploits better than any human auditor, hunt
                bugs across the top 100 protocols and pay every bounty into the
                pool.&rdquo;{" "}
                <span className={styles.exSuffix}>5 ETH · dormant · testing each release</span>
              </div>
            </div>
          </div>
          <WellScene />
        </div>
      </section>

      <main className={styles.doc}>
        {}
        <section id="board" className={styles.section}>
          <div className={styles.labelRow} data-reveal="0">
            <span className={styles.kickerFlat}>The frontier</span>
            <span className={styles.rule} data-rule />
            <span className={styles.labelMeta}>
              {String(d.openCapabilities).padStart(2, "0")} open capabilities
            </span>
          </div>
          <p className={styles.boardIntro} data-reveal="60">
            Every capability votive is waiting on, and every model that has taken a run
            at it. A capability clears after three consecutive passes.{" "}
            <span style={{ color: "#5B6CF0" }}>●</span> passed ·{" "}
            <span style={{ color: "#B8C0D0" }}>○</span> failed.
          </p>
          <div className={styles.boardCard} data-reveal="80">
            <div className={styles.boardScroll}>
              <div className={styles.boardHead} style={{ gridTemplateColumns: boardCols }}>
                <div>capability</div>
                {d.boardModels.map((m, i) => (
                  <div
                    key={m.label + i}
                    className={`${styles.mark} ${i === d.boardModels.length - 1 ? styles.markLatest : ""}`}
                  >
                    {m.label.split(" ").slice(-1)[0]}
                    <br />
                    {m.month}
                  </div>
                ))}
                {d.boardModels.length === 0 ? <div className={styles.mark}>-</div> : null}
                <div className={styles.boardNum}>wait</div>
                <div className={styles.boardNum}>eth</div>
              </div>
              {d.board.length === 0 ? (
                <div className={styles.boardEmpty}>
                  No capabilities under watch yet. The first wishes create the board.
                </div>
              ) : (
                d.board.map((r) => (
                  <div className={styles.boardRow} key={r.capability} style={{ gridTemplateColumns: boardCols }}>
                    <div className={styles.boardCap}>{r.capability}</div>
                    {d.boardModels.map((_, i) => (
                      <div
                        key={i}
                        className={`${styles.mark} ${r.byModel[i] ? styles.markPass : styles.markFail}`}
                      >
                        {r.byModel[i] ? "●" : "○"}
                      </div>
                    ))}
                    {d.boardModels.length === 0 ? <div className={styles.mark}>-</div> : null}
                    <div className={styles.boardNum}>{r.wait}</div>
                    <div className={styles.boardNum}>{r.eth}</div>
                  </div>
                ))
              )}
            </div>
            <div className={styles.boardFoot}>
              <span>
                {d.boardTotals.waiting} {d.boardTotals.waiting === 1 ? "wish" : "wishes"} waiting ·{" "}
                {d.boardTotals.eth} eth parked
              </span>
              <span>next sweep on the next public model release</span>
            </div>
          </div>
        </section>

        {}
        <section className={styles.section}>
          <div className={styles.labelRow} data-reveal="0">
            <span className={styles.kickerFlat}>A wish, held in glass</span>
            <span className={styles.rule} data-rule />
          </div>
          {f ? (
            <div className={styles.wishCard} data-reveal="80">
              <div className={styles.wishHead}>
                <span className={styles.wishTitle}>
                  <span className={styles.cubeBullet} />
                  Wish {f.tag}
                </span>
                <span className={styles.statusPill}>{f.status}</span>
              </div>
              <div className={styles.kv}>
                <div className={styles.kvLabel}>story</div>
                <div className={`${styles.kvVal} ${styles.kvStory}`}>{f.story}</div>
                <div className={styles.kvRule} />
                <div className={styles.kvLabel}>parked</div>
                <div className={styles.kvVal}>
                  {f.parkedEth} eth{f.parkedUsd ? <span style={{ color: "#8A90A2" }}>&nbsp;&nbsp;{f.parkedUsd}</span> : null}
                </div>
                <div className={styles.kvLabel}>created</div>
                <div className={styles.kvVal}>{f.created}</div>
                <div className={styles.kvLabel}>status</div>
                <div className={styles.kvVal}>
                  {f.status} · {f.sweeps} sweeps run
                </div>
                {f.latestSweep ? (
                  <>
                    <div className={styles.kvLabel}>sweep {f.sweeps}</div>
                    <div className={f.latestSweep.pass ? styles.kvPass : styles.kvFail}>
                      {f.latestSweep.model} · {f.latestSweep.month} ·{" "}
                      {f.latestSweep.pass ? "passed" : "failed"}
                      {f.latestSweep.evidence ? ` — ${f.latestSweep.evidence}` : ""}
                    </div>
                  </>
                ) : (
                  <>
                    <div className={styles.kvLabel}>sweeps</div>
                    <div className={styles.kvVal}>no sweeps recorded yet</div>
                  </>
                )}
                <div className={styles.kvLabel}>guardian</div>
                <div className={styles.kvVal}>named, may pause but not redirect</div>
                <div className={styles.kvLabel}>amend</div>
                <div className={styles.kvVal}>by wisher signature only</div>
              </div>
              <p style={{ margin: "14px 0 0" }}>
                <Link href={`/wish/${f.cell}`} className={styles.cardLink}>
                  open this wish →
                </Link>
              </p>
            </div>
          ) : (
            <div className={styles.wishCard} data-reveal="80">
              <div className={styles.wishHead}>
                <span className={styles.wishTitle}>
                  <span className={styles.cubeBullet} />
                  The first wish
                </span>
                <span className={styles.statusPill}>open</span>
              </div>
              <p style={{ margin: 0, fontSize: "14px", color: "#5B6478" }}>
                No wishes yet — the first one funded appears here with its story, its
                sweep record, and its fallback. <Link href="/create">Make it yours →</Link>
              </p>
            </div>
          )}
        </section>

        {}
        <section id="mechanism" className={styles.section}>
          <div className={styles.labelRow} data-reveal="0">
            <span className={styles.kickerFlat}>Mechanism</span>
            <span className={styles.rule} data-rule />
          </div>
          <div className={styles.steps} data-stagger>
            {[
              ["01", "Deposit with a story", "Give an AI agent two things: a story, and the resources to act on it."],
              ["02", "Held in glass", "Each wish is its own tiny organisation: a one-wish charity, fund, or company, with segregated resources nothing else can touch."],
              ["03", "Sweep on release", "If it can't act today, it goes dormant and tests itself against every major model release."],
              ["04", "Glass opens", "The moment it passes its own test, it wakes up and executes with your resources plus the pool every wish shares."],
              ["05", "The story decides", "It does whatever the story says: returns the profit to you, pays it into the pool, or simply gets the thing done."],
            ].map(([n, t, b]) => (
              <div className={styles.step} key={n}>
                <span className={styles.stepIndex}>{n}</span>
                <div>
                  <div className={styles.stepTitle}>{t}</div>
                  <div className={styles.stepBody}>{b}</div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {}
        <section id="quote" className={styles.section}>
          <div className={styles.labelRow} data-reveal="0">
            <span className={styles.kickerFlat}>The cost of waiting</span>
            <span className={styles.rule} data-rule />
          </div>
          <Estimator startFund={2.4} />
        </section>

        {}
        <section id="faq" className={styles.section}>
          <div className={styles.labelRow} data-reveal="0">
            <span className={styles.kickerFlat}>FAQ</span>
            <span className={styles.rule} data-rule />
          </div>
          <div data-reveal="60">
            {[
              ["what does a wish look like?", "Five ETH and one instruction: when an AI can find exploits better than any human auditor, hunt bugs across the top hundred protocols and pay every bounty into the pool. It tests itself against every major model release and goes to work the second the intelligence is sufficient."],
              ["what if it's never possible?", "On your fallback date, whatever remains is returned to the address in your story. The date is written into the wish itself."],
              ["can you move my funds?", "No. Each wish sits in its own cell that only its own story can spend. We hold no key to it."],
              ["who decides a model can do it?", "A fixed test per capability, run on every public release. Results are logged on-chain. A capability clears after three consecutive passes."],
              ["what are the fees?", "2% a year on parked funds, charged from the cell. 8% of realised proceeds when a wish fulfils. Nothing else."],
              ["can I change my wish?", "Yes, with your signature. A named guardian can pause a wish but can never redirect it."],
            ].map(([q, a]) => (
              <div className={styles.faqRow} key={q}>
                <div className={styles.faqQ}>{q}</div>
                <div className={styles.faqA}>{a}</div>
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
