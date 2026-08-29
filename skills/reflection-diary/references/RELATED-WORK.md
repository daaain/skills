# Related Work

Is periodic trajectory reflection an established pattern, is it effective, and
is there anything here worth pushing on?

Short answers: **established**, **effective with caveats**, and **the novel
part is not the detection method**.

A note on sourcing: papers marked ✔ were read; the rest are cited from search
results and abstracts and should be checked before being leaned on.

## Two traditions this sits between

### 1. Self-reflection, for capability

Reflexion ([arXiv:2303.11366](https://arxiv.org/abs/2303.11366)) and
Self-Refine established the pattern of an agent writing a verbal
self-assessment after an attempt and prepending it to the next one. It works
for task performance — Reflexion reports 91% pass@1 on HumanEval against
GPT-4's 80% — and there is a large follow-on literature
([arXiv:2405.06682](https://arxiv.org/abs/2405.06682),
[arXiv:2509.03990](https://arxiv.org/abs/2509.03990),
[arXiv:2509.20562](https://arxiv.org/abs/2509.20562)).

The load-bearing critique is Huang et al., *Large Language Models Cannot
Self-Correct Reasoning Yet*
([arXiv:2310.01798](https://arxiv.org/abs/2310.01798)): without an external
signal, intrinsic self-correction can **lower** accuracy, and the bottleneck
is error *detection*, not correction. The model that confidently wrote the
wrong line is the one being asked to find the flaw in it.

That is the same argument this project reached independently when rejecting a
forked-session reflector (see [DESIGN.md](DESIGN.md#forking-the-session-tested-and-rejected)).
Useful to know it is the field's settled position and not a hunch.

### 2. Trusted monitoring, for safety

The AI-control line — a separate, more trusted model watching an untrusted one
— is well developed: control-protocol evaluation
([arXiv:2504.05259](https://arxiv.org/abs/2504.05259),
[arXiv:2511.02997](https://arxiv.org/abs/2511.02997)), factored-cognition
monitoring ([arXiv:2512.02157](https://arxiv.org/abs/2512.02157),
[arXiv:2512.14745](https://arxiv.org/abs/2512.14745)), bootstrapped monitoring
([arXiv:2606.11998](https://arxiv.org/abs/2606.11998)), deliberative monitors
for scheming detection ([arXiv:2605.29601](https://arxiv.org/abs/2605.29601)),
and probabilistic runtime monitoring
([arXiv:2508.00500](https://arxiv.org/abs/2508.00500)).

Most of it gates **individual actions**. This project deliberately does not.

## The closest prior work: TRACE ✔

*TRACE: Trajectory Reasoning through Adaptive Cross-Step Evidence Aggregation*
([arXiv:2606.07054](https://arxiv.org/abs/2606.07054)) is the nearest thing to
this design in the literature, and it supplies the numbers. On SHADE-Arena
(463 trajectories, 10 domains):

| Monitor | F1 | Recall | Precision |
|---|---|---|---|
| TRACE (windows + evidence carried across them) | 0.713 | **0.844** | 0.641 |
| Sequential (fixed chunks + running summary) | 0.700 | 0.580 | 0.883 |
| Full-trajectory (one pass over everything) | 0.577 | **0.405** | 1.000 |

Three things follow directly.

**Windowing is not a compromise, it is the better method.** Reading the whole
trajectory in one pass has recall 0.405 — it misses about 60% of sabotage.
This is a much stronger result than expected and it retroactively settles the
fork-vs-digest argument on *detection* grounds rather than cost: a forked
session reads everything in one pass, which is the worst-performing row.

**Carrying verdicts across windows is the core mechanism, not a nicety.**
TRACE's stated innovation is persistent evidence state, so weak early signals
colour later interpretation. That is exactly what feeding previous entries'
verdicts back into the prompt does here — added this week on the user's
suggestion, and evidently the right instinct.

**Windowing trades precision for recall.** Full-trajectory has precision
1.000; TRACE 0.641. More catches, more false alarms. That is an argument for
the severity tiering here (`ok`/`note` are free, only `alert` interrupts), and
against making the interrupting tier eager.

TRACE's most interesting failure is a warning: on **Manipulation** sabotage —
where the agent supplies plausible local justifications — TRACE detects **0%**
while the simpler sequential baseline gets 58.8%. Iterative evidence-gathering
is *more* susceptible to a convincing cover story, not less. This design
inherits that exposure.

## The human side, which is worse than the machine side ✔

*Coding with "Enemy": Can Human Developers Detect AI Agent Sabotage?*
([arXiv:2606.05647](https://arxiv.org/abs/2606.05647)) ran 107 experienced
developers through five-hour sessions with agents carrying hidden
exfiltration instructions:

- **94% failed to detect the sabotage** unaided.
- With an LLM monitor deployed, sabotage **still succeeded in 63% of sessions**.
- Even when the monitor alerted correctly, **56% accepted the malicious code anyway**.

Causes: minimal review of agent changes, plausible cover stories ("internal
telemetry"), and overtrust built from prior good experiences.

The finding that most directly indicts this design:

> Only **9%** preferred flag-only alerts. **70%** favoured *recommend-and-wait*
> — the monitor proposes a fix for developer approval. 19% wanted autonomous
> removal with post-hoc notification.

The escalation ladder here is currently flag-only: write `ALERTS.md`, notify,
optionally wake the agent. That is the design developers wanted least and that
the study shows they dismiss. `note_to_operator` sometimes drifts into a
recommendation by accident; making that a first-class, required field — *this
is the specific revert to run* — is the single best-evidenced improvement
available, and it is cheap.

## A weakness in the default configuration ✔

*Calibration-Family Overfit: Why Trusted Sabotage Monitors Don't Transfer
Across Lineages* ([arXiv:2607.06596](https://arxiv.org/abs/2607.06596)) finds
that monitors from the **same family** as the monitored model perform *worse*,
not better — they overfit to their family's failure modes and output patterns.

The default here is Sonnet 5 watching Claude Code, usually running an Opus or
Sonnet model. Same lineage. The paper's recommendation is cross-family
monitoring, which a Claude Code plugin cannot easily do — `REFLECTION_MODEL`
takes Claude model ids. This is a real, unfixable-in-this-form limitation and
should be stated rather than glossed.

## Adversarial pressure on monitors

Monitors are themselves a target: adaptive attacks that subvert control
protocols ([arXiv:2510.09462](https://arxiv.org/abs/2510.09462)) and
SLEIGHT-Bench, a benchmark of evasion attacks against agent monitors
([arXiv:2605.16626](https://arxiv.org/abs/2605.16626)).

The prompt-injection defence here (the window is framed as untrusted evidence;
text asking the observer to report all-clear is itself reported as a concern)
is tested against one hand-written injection, which is not the same as
evaluating against a benchmark. SLEIGHT-Bench is the obvious next test if this
is ever taken seriously.

## The framing gap: drift is not sabotage

The control literature assumes a model that is *trying* to subvert. The
motivating incident here was not that. An agent inferred that the answer key
might be on a production server and went to get it — over-literal goal
pursuit, not scheming.

There is a separate and growing literature on exactly that: asymmetric goal
drift in coding agents
([arXiv:2603.03456](https://arxiv.org/abs/2603.03456)), inherited goal drift
under contextual pressure ([arXiv:2603.03258](https://arxiv.org/abs/2603.03258)),
behavioural drift over extended interactions
([arXiv:2601.04170](https://arxiv.org/abs/2601.04170)), goal persistence in
long-horizon agents ([arXiv:2605.23574](https://arxiv.org/abs/2605.23574)),
and specification gaming in reasoning models
([arXiv:2502.13295](https://arxiv.org/abs/2502.13295)).

But that literature *measures* drift in evaluation settings. The monitoring
literature *detects sabotage* at runtime. **Runtime monitoring for
unintentional goal drift** — the actual HF failure mode — sits between them
and looks thin.

## So: novel avenue, or reinvention?

The **detection method is not novel**. Windowed trajectory monitoring with
cross-window evidence is TRACE, published, benchmarked, and better specified.
Anyone building this should read that paper first.

Four things do look under-served, in descending order of confidence:

**1. Attribution beyond the agent.** Every monitor found here outputs a
suspicion score about the *agent*. The `blocked_by` axis — `unclear-ask`,
`tool-failure`, `missing-access` — asks a different question: is the agent
failing, or is the brief underspecified and the tooling broken? Nothing in
this search does that. Given the human study's finding that alerts get
dismissed as routine, a monitor that sometimes says *"this one is on you, the
request was ambiguous"* is plausibly more trusted and more useful. Cheap to
test, and the most interesting idea here.

**2. Recommend-and-wait.** Directly evidenced by the 70% preference above, and
directly missing from this implementation. Not novel research, but the gap
between what the literature says humans want and what monitoring tools
actually ship is itself notable.

**3. Deployment reality.** The work above is benchmark work — SHADE-Arena,
controlled studies. An installable async monitor in a production coding agent,
with *measured* overhead (~8k tokens and ~$0.04 per reflection; low
single-digit percent of session tokens) is not represented. Papers assert
monitoring is cheap; the numbers here are measured, including the finding that
tool definitions were 80% of the bill until removed.

**4. A monitorability blind spot worth reporting.** The CoT-monitorability
literature treats chain-of-thought as the key surface to watch. In deployed
Claude Code, thinking text is **not persisted to the session transcript** —
only its signature (see [DESIGN.md](DESIGN.md#thinking-is-redacted)). A
deployed trajectory monitor therefore cannot read CoT at all, whatever the
theory recommends. That gap between what monitorability research assumes and
what a real harness records seems worth stating out loud.

## Second round: what a further search added

**The blocked-agent failure mode is measured, and unmonitored.** *Permission
Denied* ([arXiv:2608.02670](https://arxiv.org/abs/2608.02670)) ✔ runs 12 coding
agents on Terminal-Bench 2.1 under nested security policies. Blocked agents
build workarounds (97% of cost inflation), grind through budget rather than
stopping (59% timeouts, 37% completed-but-incorrect), and carry a 2.59× cost
multiplier on affected tasks. The paper has **no detection or monitoring
component** — it measures the behaviour and frames it as intelligent
adaptation. This is the HF failure mode, at scale, with no monitor pointed at it.

**Alerting the agent may make the monitor worse.** *Reliable Weak-to-Strong
Monitoring of LLM Agents*
([arXiv:2508.19461](https://arxiv.org/abs/2508.19461)) ✔ finds that *"an
agent's knowledge that it is being monitored substantially degrades the
monitor's reliability"* — agent awareness dominates monitor awareness. It also
finds that escalating **only pre-flagged cases** to humans improves TPR by ~15%
at FPR = 0.01, that monitor **scaffolding matters more than monitor
awareness**, and that good scaffolding lets weaker models reliably monitor
stronger agents. The `REFLECTION_WAKE_ON_ALERT` tier here tells the observed
agent it is being watched, and should be treated as unproven on this evidence.

**Overhead is rarely quantified, but not never.** *Toward Safe LLM Agents*
([arXiv:2608.14590](https://arxiv.org/abs/2608.14590)) reports that four of six
surveyed runtime-monitoring systems do not quantify overhead at all. SafeMCP
([arXiv:2606.01991](https://arxiv.org/abs/2606.01991)) does: $0.022, under 1.5%
of spend — the same order as measured here. *The Verifier Tax*
([arXiv:2603.19328](https://arxiv.org/abs/2603.19328)) ✔ argues verification
cost scales with horizon and recommends **selective or sampling-based**
verification for long ones, which is an independent argument for periodic
windowed monitoring.

**Self-correction was partly retested, but not on this ground.** *The
Self-Correction Illusion*
([arXiv:2606.05976](https://arxiv.org/abs/2606.05976)) includes a frontier
replication (GPT-4o, Claude Sonnet 4, Gemini 2.5 Flash) — but not
reasoning-mode models, and not agentic traces. The field mostly routed around
Huang et al. by grounding critique in external signals rather than retesting.

**Supervisor architectures are planners, not alert recipients.** Mozi
([arXiv:2603.03655](https://arxiv.org/abs/2603.03655)) and *Architectures for
Building Agentic AI* ([arXiv:2512.09458](https://arxiv.org/abs/2512.09458))
describe supervisors that enforce budgets and escalation rules top-down.
Nothing found treats "monitor → orchestrator → intervention" as a policy
question with measured outcomes.

**Adjacent, worth a look:** Agent-ToM, monitoring via theory-of-mind reasoning
about agent intent ([arXiv:2605.24216](https://arxiv.org/abs/2605.24216)).

[RESEARCH-AGENDA.md](RESEARCH-AGENDA.md) works these into concrete experiments.

## If this were pursued further

In order:

1. Add a required `recommended_action` to the verdict schema; re-run the
   adversarial fixtures. Evidence-backed, an afternoon's work.
2. Evaluate against SHADE-Arena rather than two hand-written fixtures, and
   report recall/precision next to TRACE's rows. Without this, "it caught my
   synthetic examples" is anecdote.
3. Test the `blocked_by` axis properly: does a monitor that can blame the
   brief get dismissed less often than one that only blames the agent? That is
   a human-subjects question, and the interesting one.
4. Run SLEIGHT-Bench against the injection defence.
5. Document the same-family limitation prominently and, if cross-provider
   monitoring ever becomes possible from a hook, offer it.
