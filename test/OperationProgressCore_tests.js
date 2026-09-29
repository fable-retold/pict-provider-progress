/**
 * Operation-Progress-Core: the dependency-free progress/ETA math. Pure + clock-injected (pNow), so every assertion is
 * deterministic. Covers duration formatting, per-phase projection (pending / running / done, known + unknown totals,
 * big counts), and the whole-operation rollup (step X of N, phase-weighted percent, aggregate ETA + Estimating).
 */

const Chai = require('chai');
const Expect = Chai.expect;

const OperationProgressCore = require('../source/Operation-Progress-Core.js');

const T0 = 1_700_000_000_000;   // a fixed epoch-ms base
const SEC = 1000;

suite('pict-provider-progress: Operation-Progress-Core', () =>
{
	let _core;
	setup(() => { _core = new OperationProgressCore(); });

	suite('formatDuration', () =>
	{
		test('formats compactly, top two units', () =>
		{
			Expect(_core.formatDuration(0)).to.equal('0s');
			Expect(_core.formatDuration(45 * SEC)).to.equal('45s');
			Expect(_core.formatDuration(125 * SEC)).to.equal('2m 5s');
			Expect(_core.formatDuration(5 * 3600 * SEC + 2 * 60 * SEC)).to.equal('5h 2m');
			Expect(_core.formatDuration(3 * 86400 * SEC + 4 * 3600 * SEC)).to.equal('3d 4h');
		});
		test('negative / non-finite -> unknown', () =>
		{
			Expect(_core.formatDuration(-1)).to.equal('unknown');
			Expect(_core.formatDuration(null)).to.equal('unknown');
			Expect(_core.formatDuration(NaN)).to.equal('unknown');
		});
	});

	suite('projectPhase', () =>
	{
		test('running phase with a known total computes percent, rate, and ETA', () =>
		{
			// started 100s ago, 5,000 of 20,000 done -> 50/s -> 15,000 left -> 300s ETA.
			let tmpPhase = { Index: 2, Label: 'Attachments', Unit: 'attachments', StartedAt: T0, Total: 20000, Completed: 5000 };
			let tmpModel = _core.projectPhase(tmpPhase, T0 + 100 * SEC);
			Expect(tmpModel.RunState).to.equal('running');
			Expect(tmpModel.Percent).to.equal(25);
			Expect(tmpModel.RatePerSec).to.equal(50);
			Expect(tmpModel.EtaSeconds).to.equal(300);
			Expect(tmpModel.EtaText).to.equal('5m 0s');
			Expect(tmpModel.Estimating).to.equal(false);
			Expect(tmpModel.CountText).to.equal('5,000 / 20,000 attachments');
		});

		test('pending phase: no ETA, estimating, percent 0/known', () =>
		{
			let tmpModel = _core.projectPhase({ Label: 'Parse', Unit: 'messages', Total: 180000 }, T0);
			Expect(tmpModel.RunState).to.equal('pending');
			Expect(tmpModel.EtaSeconds).to.equal(-1);
			Expect(tmpModel.EtaText).to.equal('unknown');
			Expect(tmpModel.Estimating).to.equal(true);
			Expect(tmpModel.Percent).to.equal(0);
		});

		test('running phase with unknown total is estimating with no ETA', () =>
		{
			let tmpModel = _core.projectPhase({ Label: 'Walk', StartedAt: T0, Completed: 1234 }, T0 + 10 * SEC);
			Expect(tmpModel.RunState).to.equal('running');
			Expect(tmpModel.Percent).to.equal(null);
			Expect(tmpModel.EtaSeconds).to.equal(-1);
			Expect(tmpModel.Estimating).to.equal(true);
			Expect(tmpModel.CountText).to.equal('1,234 operations');
		});

		test('done phase: 100%, ETA 0, not estimating, elapsed from finish', () =>
		{
			let tmpModel = _core.projectPhase({ Label: 'Snapshot', Unit: 'files', StartedAt: T0, FinishedAt: T0 + 10 * SEC, Total: 1, Completed: 1 }, T0 + 999 * SEC);
			Expect(tmpModel.RunState).to.equal('done');
			Expect(tmpModel.Percent).to.equal(100);
			Expect(tmpModel.EtaSeconds).to.equal(0);
			Expect(tmpModel.Estimating).to.equal(false);
			Expect(tmpModel.ElapsedMs).to.equal(10 * SEC);   // finish - start, not now - start
		});

		test('processed = completed + failed + skipped; big counts survive', () =>
		{
			let tmpModel = _core.projectPhase({ StartedAt: T0, Total: '85000000', Completed: '40000000', Failed: '5000000' }, T0 + 100 * SEC);
			Expect(tmpModel.Processed).to.equal(45000000);
			Expect(tmpModel.Percent).to.be.closeTo(52.9, 0.1);
			Expect(tmpModel.CountText).to.equal('45,000,000 / 85,000,000 operations');
		});

		test('numeric-string counts + ISO timestamps are accepted', () =>
		{
			let tmpModel = _core.projectPhase({ StartedAt: new Date(T0).toISOString(), Total: '100', Completed: '50' }, T0 + 50 * SEC);
			Expect(tmpModel.Percent).to.equal(50);
			Expect(tmpModel.RatePerSec).to.equal(1);
			Expect(tmpModel.EtaSeconds).to.equal(50);
		});
	});

	suite('project (whole operation)', () =>
	{
		function scenario()
		{
			return {
				Key: 'messages.fold', Label: 'Fold MatchBookPro', Status: 'Running', StartedAt: T0,
				Phases:
				[
					{ Index: 1, Label: 'Snapshot', Unit: 'files', StartedAt: T0, FinishedAt: T0 + 10 * SEC, Total: 1, Completed: 1 },
					{ Index: 2, Label: 'Attachments', Unit: 'attachments', StartedAt: T0 + 10 * SEC, Total: 20000, Completed: 5000 },
					{ Index: 3, Label: 'Parse', Unit: 'messages', Total: 180000 }
				]
			};
		}

		test('step X of N + phase-weighted overall percent', () =>
		{
			let tmpModel = _core.project(scenario(), T0 + 110 * SEC);
			Expect(tmpModel.PhaseCount).to.equal(3);
			Expect(tmpModel.CurrentPhaseIndex).to.equal(2);
			Expect(tmpModel.StepText).to.equal('Step 2 of 3');
			// 1 finished + 0.25 of the current, over 3 phases -> ~41.7%
			Expect(tmpModel.Overall.Percent).to.be.closeTo(41.7, 0.2);
		});

		test('aggregate ETA sums estimable phases and flags Estimating for the rest', () =>
		{
			let tmpModel = _core.project(scenario(), T0 + 110 * SEC);
			// running phase #2: 5000/20000 over 100s -> 50/s -> 300s ETA. Phase #3 pending -> unknown -> Estimating.
			Expect(tmpModel.Overall.EtaSeconds).to.equal(300);
			Expect(tmpModel.Overall.EtaText).to.equal('5m 0s');
			Expect(tmpModel.Overall.Estimating).to.equal(true);
		});

		test('all phases done -> 100%, ETA 0, not estimating', () =>
		{
			let tmpState = scenario();
			tmpState.Phases.forEach((pPhase) => { pPhase.FinishedAt = T0 + 200 * SEC; pPhase.StartedAt = pPhase.StartedAt || T0; pPhase.Completed = pPhase.Total; });
			tmpState.Status = 'Succeeded';
			let tmpModel = _core.project(tmpState, T0 + 300 * SEC);
			Expect(tmpModel.Overall.Percent).to.equal(100);
			Expect(tmpModel.Overall.EtaSeconds).to.equal(0);
			Expect(tmpModel.Overall.Estimating).to.equal(false);
			Expect(tmpModel.CurrentPhaseIndex).to.equal(3);
		});

		test('empty operation is safe', () =>
		{
			let tmpModel = _core.project({}, T0);
			Expect(tmpModel.PhaseCount).to.equal(0);
			Expect(tmpModel.StepText).to.equal('No steps');
			Expect(tmpModel.Overall.Percent).to.equal(null);
		});
	});

	suite('estimated totals (no phantom bar)', () =>
	{
		test('a running phase flagged EstimatedTotal shows no percent/ETA even when Total > 0', () =>
		{
			// A phase that started before its real total is known: Total may be a placeholder (e.g. Fable coerces <1 to
			// 100). It must render as CountText + rate while Estimating -- never a hard percent driven by the estimate.
			let tmpPhase = { Index: 1, Label: 'Import', Unit: 'items', StartedAt: T0, Total: 100, Completed: 30, EstimatedTotal: true };
			let tmpModel = _core.projectPhase(tmpPhase, T0 + 10 * SEC);
			Expect(tmpModel.KnownTotal).to.equal(false);
			Expect(tmpModel.Percent).to.equal(null);
			Expect(tmpModel.EtaSeconds).to.equal(-1);
			Expect(tmpModel.EtaText).to.equal('unknown');
			Expect(tmpModel.Estimating).to.equal(true);
			Expect(tmpModel.CountText).to.equal('30 items');   // no "/ total" while estimating
			Expect(tmpModel.RatePerSec).to.equal(3);            // rate still renders (30 over 10s)
		});

		test('once the total is firmed up (EstimatedTotal cleared) the same counts yield a real percent + ETA', () =>
		{
			let tmpPhase = { Index: 1, Label: 'Import', Unit: 'items', StartedAt: T0, Total: 300, Completed: 30, EstimatedTotal: false };
			let tmpModel = _core.projectPhase(tmpPhase, T0 + 10 * SEC);
			Expect(tmpModel.KnownTotal).to.equal(true);
			Expect(tmpModel.Percent).to.equal(10);
			Expect(tmpModel.CountText).to.equal('30 / 300 items');
			// 30 over 10s -> 3/s; 270 remaining -> 90s.
			Expect(tmpModel.EtaSeconds).to.equal(90);
			Expect(tmpModel.Estimating).to.equal(false);
		});
	});
});
