# Pict Provider: Progress

> **[Read the Pict-Provider-Progress Documentation](https://fable-retold.github.io/pict-provider-progress/)** — quickstart, the unified data format, and the ETA model.

A standardized interface for **operation progress, event logging, and outcome reporting** across the Retold
ecosystem. Any long-running, multi-phase operation — a data fold, an ingest, a batch of renditions, a download run —
describes itself in one **unified data format**, and this provider turns that state into a display model a UI can render
directly: per-phase percent and ETA, and a whole-operation *step X of N* rollup with an aggregate ETA.

Built on the [Fable](https://github.com/fable-retold/fable) `Operation` / `ProgressTracker` primitive, whose phased
operations and per-tracker `EstimatedCompletionTime` are the underlying shape this module presents to applications.

[MIT License](LICENSE)

---

## Features

- **One unified format** — an operation is a set of ordered phases; each phase carries a total, a processed count
  (`Completed + Failed + Skipped`), and start/finish timestamps. Progress, events, and the terminal outcome all travel
  in the same envelope, so every operation reports the same way.
- **Per-phase ETA** — `remaining / observed-rate`, with an honest `Estimating` flag while a phase is pending, just
  started, or has an unknown total.
- **Whole-operation rollup** — *step X of N*, a phase-weighted overall percent, and an aggregate ETA that sums the
  phases it can estimate and flags when later phases have no basis yet (an honest "at least this long", never a
  fabricated total).
- **Big-count-safe** — counts read as `Number` (safe past any real operation size) and accepted as numeric strings, so
  a caller can carry 85,000,000 or billions through `Decimal`/`Text` columns without precision surprises.
- **Dependency-free core** — `Operation-Progress-Core` is pure and clock-injected (`project(state, pNow)`); no Fable,
  no DOM. Trivially testable and reusable server- or client-side.
- **Self-stopping poller** — the Pict provider polls a `{ Operations: [...] }` endpoint on a timer that stops on its own
  once every operation is terminal, so a view just subscribes to updates.

## Usage

```javascript
// The dependency-free core (server or client, no Fable required):
const OperationProgressCore = require('pict-provider-progress').OperationProgressCore;
const core = new OperationProgressCore();

const model = core.project(
{
    Key: 'messages.fold', Label: 'Fold MatchBookPro', Status: 'Running',
    Phases:
    [
        { Index: 1, Label: 'Snapshot',    Unit: 'files',       StartedAt: t0, FinishedAt: t0 + 10000, Total: 1,      Completed: 1 },
        { Index: 2, Label: 'Attachments', Unit: 'attachments', StartedAt: t0 + 10000,                  Total: 20000,  Completed: 5000 },
        { Index: 3, Label: 'Parse',       Unit: 'messages',                                            Total: 180000 }
    ]
});
// model.StepText === 'Step 2 of 3'
// model.Phases[1].CountText === '5,000 / 20,000 attachments', .EtaText === '5m 0s'
// model.Overall.Percent ~ 41.7, .EtaText === '5m 0s', .Estimating === true
```

```javascript
// The Pict provider (register through the service-provider pattern) polls and normalizes for a view:
const provider = _Pict.addProvider('Progress', require('pict-provider-progress').default_configuration, require('pict-provider-progress'));
provider.startPolling('/1.0/Operations', 1000, (pDisplayModels) => { /* repaint */ });
```

## The display model

`project(state)` returns `{ Key, Label, Status, PhaseCount, CurrentPhaseIndex, StepText, Phases[], Overall, Outcome }`.
Each phase adds `RunState, Percent, RatePerSec, EtaSeconds, EtaText, Estimating, CountText`; `Overall` adds
`Percent, EtaSeconds, EtaText, Estimating, ElapsedText`. Durations are pre-formatted compactly (`5h 2m`, `2m 5s`, `45s`).

## Status

Early. The core and its ETA math are unit-tested; the provider poller and the companion view are the surface a host
application drives. Designed to unify existing per-operation records rather than replace them.

## License

MIT
