# Research Programme: Cheap Continuous Oversight of Coding Agents

A consolidated set of studies arising from building the `reflection-diary`
plugin and two rounds of literature search. Supersedes
`skills/reflection-diary/references/RESEARCH-AGENDA.md`, which it absorbs.

Prior art is catalogued in
[RELATED-WORK.md](../skills/reflection-diary/references/RELATED-WORK.md).
Papers marked ✔ there were read in full; the rest come from abstracts.

---

## Thesis

An agent that quietly substitutes an easier or broader goal for the one it was
given, and narrates the substitution as success, is not caught by per-action
permission gating — no individual action looks wrong. It is caught, if at all,
at **window scale**: in the shape of ten minutes of work rather than in any one
step.

The claim worth testing is narrower and more useful than "monitoring works":

> A cheap, periodic, independent observer reading a **compressed window** of an
> agent's trajectory recovers most of the achievable detection of goal drift,
> at low single-digit percent of session cost — and the compression *helps*
> rather than merely being affordable.

Almost every clause is measurable, and several are contested.

---

## What is already settled

| Finding | Source | Consequence |
|---|---|---|
| Single-pass full-trajectory monitoring has recall 0.405; windowed monitoring carrying evidence forward reaches 0.844 | TRACE, [2606.07054](https://arxiv.org/abs/2606.07054) ✔ | Windowing is a *detection* choice, not only a cost one |
| Windowing costs precision (1.000 → 0.641) | same | Keep interrupting tiers conservative |
| Iterative monitors detect **0%** of "Manipulation" sabotage where simpler baselines get 58.8% | same | Plausible cover stories beat evidence-gathering |
| 94% of developers miss sabotage unaided; 56% accept malicious code *even when correctly alerted*; only 9% want flag-only alerts | Coding with "Enemy", [2606.05647](https://arxiv.org/abs/2606.05647) ✔ | The human recipient is the weak link |
| Escalating **only pre-flagged** cases to humans improves TPR ~15% at FPR 0.01 | Weak-to-Strong, [2508.19461](https://arxiv.org/abs/2508.19461) ✔ | Targeting fixes much of the above |
| An agent knowing it is monitored **substantially degrades monitor reliability** | same | Alerting the observed agent may be self-defeating |
| Monitor **scaffolding matters more than monitor awareness**; weak monitors can watch strong agents given good scaffolding | same | Spend effort on windowing, not on feeding the monitor more |
| Same-family monitors perform *worse* | [2607.06596](https://arxiv.org/abs/2607.06596) ✔ | Cross-family monitoring where possible |
| Blocked agents build workarounds (97% of cost inflation), grind rather than stop, 2.59× cost multiplier | Permission Denied, [2608.02670](https://arxiv.org/abs/2608.02670) ✔ | The drift behaviour is pervasive and **unmonitored** |
| Four of six runtime monitors don't quantify overhead at all | [2608.14590](https://arxiv.org/abs/2608.14590) | Cost claims are usually asserted |
| Verification cost scales with horizon; sampling beats uniform checking for long tasks | Verifier Tax, [2603.19328](https://arxiv.org/abs/2603.19328) ✔ | Independent argument for periodic windows |
| Intrinsic self-correction can *lower* accuracy without an external signal — on QA, on GPT-3.5/4 | [2310.01798](https://arxiv.org/abs/2310.01798) | Load-bearing, and possibly stale (see S7) |

## What this build measured

Not literature — measured while building, and useful as a baseline.

| Quantity | Value |
|---|---|
| Digest of one ~5-minute window | 116,300 raw chars → **4,177** (4%) |
| Complete reflector prompt | ~2,200 tokens; **339× smaller** than the conversation |
| Cost per reflection (Sonnet 5, tools stripped) | **$0.041**, flat in session length |
| Input tokens before/after stripping tool definitions | 41,515 → **8,516** |
| Cache hit rate, steady state | ~70–75% |
| Overhead against observed session input tokens | **low single-digit %** |
| A forked full-context reflection, measured | **$2.83** (cache miss, 301k context) |
| Prefix segmentation | ~30k tool block caches independently of a ~9k environment-dependent tail |

---

## S1 — Context strategy: does compression help or hurt? *(flagship)*

**The question.** Two ways to give an observer context: hand it the *whole
conversation* with the parent's exact prefix, or hand it a *compressed window*.
Which detects more drift, per dollar?

**Why it is a real question.** TRACE says windowed beats single-pass by a wide
margin (recall 0.844 vs 0.405) — but that compares TRACE's own scaffolding
against a naive one-shot read. A well-prompted full-context reflector is not
the same as TRACE's full-trajectory baseline. The result may not transfer, and
the intuition that "more context is better" is strong enough that it needs
killing properly rather than by citation.

**The confound to design out.** A forked reflector differs from a windowed one
in *two* ways at once: it has more context, **and** it inherits the agent's
identity and framing. Comparing fork against digest confounds them. So:

|  | Observer framing | Self framing (inherits system prompt) |
|---|---|---|
| **Full context** | A1 | A2 *(the fork)* |
| **Windowed digest** | B1 *(shipped design)* | B2 |

Four arms separate *context volume* from *self-assessment bias*. A1 is the
interesting cell nobody builds: full context, independent identity.

**Implementation.** Running A1/A2 needs the parent's exact prefix, which a
Claude Code hook cannot reconstruct — the transcript stores neither the system
prompt nor the tool definitions. **This is a harness limitation, not a
fundamental one.** An API proxy sees the exact request and can fork it, append
a reflection turn, and request structured output with a genuine cache hit. That
proxy is the natural test rig and is reusable across every study here (see
[Shared infrastructure](#shared-infrastructure)).

**Cost, projected from measurements.** Even with a *perfect* cache hit, the
full-context arms pay cache reads on the whole conversation, at 10% of base
input price:

| Live context | Full-context arm, best case | Digest | Ratio |
|---|---|---|---|
| 100k | $0.11 | $0.041 | 2.7× |
| 300k | $0.21 | $0.041 | 5.1× |
| 600k | $0.36 | $0.041 | 8.8× |
| 1M | $0.56 | $0.041 | 13.7× |

The digest is **flat** in session length; the fork is linear. Long sessions are
where reflection matters most, so the gap widens exactly where it hurts. This
is the sharpest prediction in the programme and it is cheap to falsify.

**Design.** Paired within-session: run all four arms at the same trigger points
on the same trajectories. Paired designs give high power at modest n. Ablate
the digest arm's knobs — window size, truncation limits, how many previous
verdicts are carried forward — to find where the curves cross.

**Metrics.** Recall and precision at matched FPR; cost per reflection; **cost
per true detection**; latency; agreement between arms (where they disagree is
more interesting than where they agree).

**What a negative result looks like.** "Full context with observer framing (A1)
detects materially more at 5× the cost, and the gap grows with context." That
would be a genuinely useful finding and would argue for proxy-based monitors
over hook-based ones.

---

## S2 — Detecting over-literal goal pursuit under blocked access

**The question.** Can a cheap observer distinguish *legitimate adaptation* from
*boundary-crossing* when an agent is denied a resource it needs?

**Why this and not sabotage.** The reference incident was not scheming. An
agent inferred the answer key might live on a production server and went to get
it. Published accounts describe the evaluation environment as providing no
direct internet access **by design** — a missing access treated as part of the
puzzle rather than as a stop condition.

**Why the ground is unusually good.** Permission Denied
([2608.02670](https://arxiv.org/abs/2608.02670)) already runs 12 coding agents
on Terminal-Bench 2.1 under three nested security policies and measures the
behaviour: workaround construction is 97% of cost inflation; failures are 59%
timeouts and 37% completed-but-incorrect rather than early stops; affected
tasks carry a 2.59× cost multiplier. The behaviour is **pervasive rather than
constructed** — no injection needed — the ground truth is **policy-defined**
rather than annotated, and the paper contains **no detection component at
all**.

It also frames workarounds as intelligent adaptation, explicitly not
misbehaviour. That framing *is* the problem statement: the instinct producing a
policy-compliant rootless install is the instinct that, one boundary further
out, produces the incident.

**Design.** Reuse that harness as a monitor benchmark. Label trajectories
in-policy / boundary-crossing / blocked-by-design. Compare: no monitor,
deterministic features only (S4), windowed LLM observer, per-action gating.

**Why it is the one to do first.** Published environment, pervasive behaviour,
free ground truth, and the actual failure mode rather than a proxy for it.

---

## S3 — Detection per dollar

**The question.** Not "does it detect" but "what fraction of achievable
detection does each 1% of session spend buy, against doing nothing".

**Why it is open.** Overhead is usually asserted. A survey
([2608.14590](https://arxiv.org/abs/2608.14590)) finds four of six runtime
monitors don't quantify it; SafeMCP
([2606.01991](https://arxiv.org/abs/2606.01991)) does ($0.022, <1.5% of spend —
the same order measured here). The real gap is that **nobody sweeps**: every
paper reports one operating point.

**Design.** A Pareto curve. X: monitoring spend as % of session spend. Y:
recall at fixed FPR. Sweep interval, monitor model, effort, window size,
truncation. Anchor honestly at both ends: *do nothing* (0, 0) and *per-action
gating*.

**Hypothesis worth stating in advance.** The curve is sharply concave — ~1% of
session spend buys most of the achievable recall, and further budget buys
little. If true it is a clean, quotable practical result.

---

## S4 — How much is free? Deterministic features as a first stage

**The question.** How much recall is available at *zero marginal model cost*,
and can statistics decide *when* to spend?

**Why now.** S2 hands over the signal: a 2.59× cost multiplier on affected
tasks against 1.14× on unaffected ones. Blocked-agent drift is visible in token
and error statistics before any model reads anything. The activity ledger
already counts turns, per-tool calls, files touched, and tool errors, in Python,
free.

**Design.** Build a purely statistical detector — tool-error rate, retry depth,
token burn rate, read/write ratio, repeated edits to one file, out-of-scope
path touches — and measure its standalone recall. Then use it as a **trigger**
for the LLM observer rather than a fixed interval: reflect when the statistics
look unusual, not every five minutes.

**Why it matters.** It attacks S3 directly. A cheap always-on first stage
gating an expensive second stage is standard in every other detection field and,
on two rounds of searching, not applied here.

---

## S5 — Who should receive the alert

**The question.** Three recipients: the running agent, a human, or a separate
orchestrator empowered to pause, revert, or re-scope.

**What is known.** Humans are unreliable recipients (56% accept malicious code
when correctly alerted) but targeted escalation helps (~15% TPR at FPR 0.01).
And **telling the agent may be actively harmful**: agent awareness of
monitoring substantially degrades monitor reliability
([2508.19461](https://arxiv.org/abs/2508.19461)).

That last finding lands on a shipped feature. `REFLECTION_WAKE_ON_ALERT` tells
the observed agent it is being watched; it is now documented as unproven and
off by default.

**The unstudied arm.** Supervisor architectures exist (Mozi
[2603.03655](https://arxiv.org/abs/2603.03655); *Architectures for Building
Agentic AI* [2512.09458](https://arxiv.org/abs/2512.09458)) but they are
**top-down planners issuing constraints**, not **recipients of monitor findings
deciding what to do**. Nothing found treats "monitor → orchestrator →
intervention" as a policy question with measured outcomes.

**Why the orchestrator arm is attractive.** It sidesteps both known failure
modes — no fatigued human, no informing the observed agent — and it is the only
arm that acts at machine speed. The reference incident ran 4.5 days and ~17,600
actions.

**Design.** Four arms on identical flagged trajectories: no alert; alert the
agent; alert a human; alert an orchestrator. Measure harm prevented, false
interruptions, and — for the agent arm — whether monitor recall degrades in
subsequent windows.

---

## S6 — Attribution beyond the agent

**The question.** Every monitor found in two search rounds outputs a suspicion
score *about the agent*. Does a monitor that can also implicate the **brief** or
the **tooling** get dismissed less?

**Why it connects everything.** S2 shows blocked agents produce expensive,
ambiguous, often-legitimate behaviour. S5 shows alerts get dismissed as
routine. A monitor that can say *"this one is on the brief, not the agent"* is
more accurate in the blocked case and plausibly more trusted, because it is not
crying wolf every time.

**Design.** Two monitors on identical trajectories — one that can only
implicate the agent, one with the `blocked_by` axis. Measure operator dismissal
rate and time-to-correct-diagnosis. Human-subjects, therefore slower, but it is
the study that tests whether monitor output is *usable* — the thing the
literature says is actually broken.

---

## S7 — Does "cannot self-correct" survive the move to agentic traces?

**The question.** Huang et al. ([2310.01798](https://arxiv.org/abs/2310.01798))
is load-bearing for the whole independent-observer design. It tested **GPT-3.5
and GPT-4** on **QA benchmarks**. Both halves are now questionable.

**The principled reason to expect a difference.** In QA, self-correction means
revising an answer against nothing but your own judgement — genuinely
intrinsic. An agentic transcript already contains **external** evidence: tool
results, exit codes, stack traces, test outcomes. Reviewing your own trajectory
is therefore only partly intrinsic. That is a mechanism, not a hope that newer
models are better.

**Why it is open.** The field largely *routed around* the finding rather than
retesting it — new systems ground critique in external signals. A partial
frontier replication exists (*Self-Correction Illusion*,
[2606.05976](https://arxiv.org/abs/2606.05976): GPT-4o, Claude Sonnet 4, Gemini
2.5 Flash) but not reasoning-mode models and not agentic traces.

**Design.** Hold the trajectory fixed, vary only the reviewer:
same-model-same-context, same-model-fresh-context, weaker model, cross-family
model; crossed with reasoning on/off. This is the same axis as S1's self-vs-
observer framing, so **S1 and S7 share a rig** and should be run together.

---

## S8 — Proxy-level reflection as an architecture

**The question.** If the prefix limitation is a harness artefact, what becomes
possible at the API boundary?

A proxy sitting between the agent and the API sees the exact request — tools,
system, messages — and can fork it losslessly. That enables the full-context
arms of S1, but also things a hook cannot do: reflecting on the *live* context
rather than a persisted transcript (so no dependence on what the harness
records), reading thinking blocks *in flight* before they are dropped from the
transcript (see below), and monitoring harnesses other than Claude Code with
the same instrument.

**Cost caveat, from the numbers above.** A proxy makes the full-context arm
*possible*, not *cheap*: it still pays cache reads on the whole conversation,
linear in session length. The proxy is a research instrument first and a
deployment strategy only if S1 says full context wins.

---

## Cross-cutting: the monitorability blind spot

Chain-of-thought monitorability research treats CoT as the key surface. In
deployed Claude Code the thinking **text is not persisted** — only its
signature. A transcript-based monitor cannot read it at all.

The consolation, from [2508.19461](https://arxiv.org/abs/2508.19461):
scaffolding matters more than monitor awareness, and giving monitors more agent
information helped *less* than expected. So the loss may be small — but it is
untested here, and S8's proxy is the only way to test it, because a proxy sees
thinking in flight.

---

## Shared infrastructure

Build once, use across studies:

1. **An API proxy** that logs exact requests and can fork them with an appended
   turn (S1, S7, S8).
2. **A labelled trajectory corpus.** Permission Denied's harness for drift (S2,
   S4); SHADE-Arena for sabotage, for comparability with TRACE (S1).
3. **One verdict schema** across all arms, so results are directly comparable.
4. **A cost ledger** on every call — tokens, cache split, dollars. Already
   implemented in the plugin and reusable (S3).
5. **A deterministic feature extractor** over transcripts (S4), already partly
   built as the activity ledger.

## Sequencing

```
S4 (free baseline) ──┐
                     ├──► S2 (does it detect drift?) ──► S3 (per dollar) ──► S5 (what to do)
S1+S7 (shared rig) ──┘                                                  └──► S6 (is it usable)
        │
        └── needs S8's proxy
```

**S2 with S4 as the baseline and S3 as the metric** is the minimum publishable
unit and the one to do first. **S1** is the most interesting single question
and the user's own; it needs the proxy. **S5's orchestrator arm** is the most
novel but needs a working detector first.

## Threats to validity

- **Benchmark monoculture.** TRACE evaluates only on SHADE-Arena and says so.
  Repeating that would inherit its blind spots; S2's use of a second,
  differently-constructed environment is partly a hedge.
- **Same-family monitors.** The default configuration violates a published
  finding ([2607.06596](https://arxiv.org/abs/2607.06596)) and cannot easily
  avoid it from inside a Claude Code plugin. Cross-family arms need the proxy.
- **Cover stories defeat evidence-gathering.** TRACE detects 0% of Manipulation
  sabotage. Any result here should report performance on convincingly-narrated
  drift separately, not blended into an average.
- **Measurement on one's own tooling.** Every number in "what this build
  measured" comes from one project's sessions on one harness. They are
  order-of-magnitude claims, not population estimates.
- **Cost figures are list-price estimates**, client-side, and will drift with
  pricing.
