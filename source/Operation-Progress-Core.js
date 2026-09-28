/**
 * Operation-Progress-Core: the dependency-free heart of unified progress reporting.
 *
 * It turns a phased-operation STATE (the Fable Operation / ProgressTracker shape -- an operation made of ordered phases,
 * each with a total + processed count + start/finish timestamps) into a DISPLAY MODEL a UI can render directly: per-phase
 * percent + rate + ETA, and a whole-operation "step X of N" rollup with an aggregate ETA. Pure functions only (no Fable,
 * no DOM, no clock of its own -- the caller passes `pNow`), so it is trivially testable and reusable server- or client-side.
 *
 * Counts are read with Number (safe past any real operation size -- 85M, billions, all < 2^53), and accepted as numbers
 * OR numeric strings so a caller can carry big counts as strings (Decimal/Text columns) without precision surprises here.
 * Timestamps are accepted as epoch-ms numbers OR ISO strings.
 *
 * A phase's PROCESSED work = Completed + Failed + Skipped (a failed/skipped item is still done with), so percent + ETA
 * reflect remaining work honestly. ETA per phase = remaining / observed-rate. The whole-operation ETA sums the ETAs of
 * the not-yet-finished phases it can estimate (the running phase) and flags `Estimating` when later phases have no basis
 * yet -- an honest "at least this long", never a fabricated total.
 */

const _STATUSES = { Pending: true, Running: true, Paused: true, Succeeded: true, Partial: true, Failed: true, Canceled: true };

class OperationProgressCore
{
	constructor(pOptions)
	{
		this.options = pOptions || {};
	}

	// ------------------------------------------------------------------------------------------------------------
	// Coercion helpers
	// ------------------------------------------------------------------------------------------------------------

	_num(pValue)
	{
		let tmpNumber = (typeof pValue === 'number') ? pValue : Number(pValue);
		if (!Number.isFinite(tmpNumber) || tmpNumber < 0) { return 0; }
		return tmpNumber;
	}

	// Epoch ms from a number or ISO string; null when absent/invalid/non-positive.
	_ms(pValue)
	{
		if (pValue === null || pValue === undefined || pValue === '' || pValue === false) { return null; }
		let tmpMs = (typeof pValue === 'number') ? pValue : Date.parse(pValue);
		if (!Number.isFinite(tmpMs) || tmpMs <= 0) { return null; }
		return tmpMs;
	}

	// Compact human duration: 3d 4h, 5h 2m, 2m 3s, 45s, 0s; -1/unknown -> 'unknown'.
	formatDuration(pMs)
	{
		if (pMs === null || pMs === undefined || !Number.isFinite(pMs) || pMs < 0) { return 'unknown'; }
		let tmpSeconds = Math.round(pMs / 1000);
		if (tmpSeconds <= 0) { return '0s'; }
		let tmpDays = Math.floor(tmpSeconds / 86400);
		let tmpHours = Math.floor((tmpSeconds % 86400) / 3600);
		let tmpMinutes = Math.floor((tmpSeconds % 3600) / 60);
		let tmpSecs = tmpSeconds % 60;
		let tmpParts = [];
		if (tmpDays > 0) { tmpParts.push(tmpDays + 'd', tmpHours + 'h'); }
		else if (tmpHours > 0) { tmpParts.push(tmpHours + 'h', tmpMinutes + 'm'); }
		else if (tmpMinutes > 0) { tmpParts.push(tmpMinutes + 'm', tmpSecs + 's'); }
		else { tmpParts.push(tmpSecs + 's'); }
		return tmpParts.join(' ');
	}

	// ------------------------------------------------------------------------------------------------------------
	// Projection
	// ------------------------------------------------------------------------------------------------------------

	// Project one phase's raw state into its display model. pNow = current epoch ms.
	projectPhase(pPhase, pNow)
	{
		let tmpPhase = pPhase || {};
		let tmpStarted = this._ms(tmpPhase.StartedAt);
		let tmpFinished = this._ms(tmpPhase.FinishedAt);
		let tmpCompleted = this._num(tmpPhase.Completed);
		let tmpFailed = this._num(tmpPhase.Failed);
		let tmpSkipped = this._num(tmpPhase.Skipped);
		let tmpProcessed = tmpCompleted + tmpFailed + tmpSkipped;
		let tmpTotal = this._num(tmpPhase.Total);
		let tmpKnownTotal = tmpTotal > 0 && !tmpPhase.EstimatedTotal;
		let tmpRunState = tmpFinished ? 'done' : (tmpStarted ? 'running' : 'pending');

		let tmpElapsedMs = tmpStarted ? Math.max(0, (tmpFinished || pNow) - tmpStarted) : 0;
		let tmpRatePerSec = (tmpProcessed > 0 && tmpElapsedMs > 0) ? (tmpProcessed / (tmpElapsedMs / 1000)) : 0;
		let tmpRemaining = (tmpTotal > 0) ? Math.max(0, tmpTotal - tmpProcessed) : null;
		let tmpPercent = (tmpTotal > 0) ? Math.min(100, (tmpProcessed / tmpTotal) * 100) : null;

		// ETA: done -> 0; running with a known total + rate -> remaining/rate; otherwise unknown (-1).
		let tmpEtaSeconds = -1;
		if (tmpFinished) { tmpEtaSeconds = 0; }
		else if (tmpStarted && tmpRatePerSec > 0 && tmpRemaining !== null) { tmpEtaSeconds = tmpRemaining / tmpRatePerSec; }
		// Not done, but we don't yet have a reliable ETA (pending, just-started, or unknown total).
		let tmpEstimating = (tmpRunState !== 'done') && (tmpEtaSeconds < 0);

		return {
			Index: (typeof tmpPhase.Index === 'number') ? tmpPhase.Index : null,
			Label: tmpPhase.Label || 'Phase',
			Unit: tmpPhase.Unit || 'operations',
			Status: _STATUSES[tmpPhase.Status] ? tmpPhase.Status : (tmpFinished ? 'Succeeded' : (tmpStarted ? 'Running' : 'Pending')),
			RunState: tmpRunState,
			Completed: tmpCompleted,
			Processed: tmpProcessed,
			Failed: tmpFailed,
			Skipped: tmpSkipped,
			Total: tmpTotal,
			KnownTotal: tmpKnownTotal,
			Percent: (tmpPercent === null) ? null : Math.round(tmpPercent * 10) / 10,
			RatePerSec: Math.round(tmpRatePerSec * 100) / 100,
			ElapsedMs: tmpElapsedMs,
			ElapsedText: this.formatDuration(tmpElapsedMs),
			EtaSeconds: (tmpEtaSeconds < 0) ? -1 : Math.round(tmpEtaSeconds),
			EtaText: (tmpEtaSeconds < 0) ? 'unknown' : this.formatDuration(tmpEtaSeconds * 1000),
			Estimating: tmpEstimating,
			// A ready-to-render count line: "300,000 / 85,000,000 messages" (or "300,000 messages" when total unknown).
			CountText: tmpKnownTotal
				? (tmpProcessed.toLocaleString() + ' / ' + tmpTotal.toLocaleString() + ' ' + (tmpPhase.Unit || 'operations'))
				: (tmpProcessed.toLocaleString() + ' ' + (tmpPhase.Unit || 'operations'))
		};
	}

	// Project a whole operation state into the display model (phases + overall rollup). pNow defaults to Date.now().
	project(pState, pNow)
	{
		let tmpState = pState || {};
		let tmpNow = (typeof pNow === 'number') ? pNow : Date.now();
		let tmpRawPhases = Array.isArray(tmpState.Phases) ? tmpState.Phases : [];
		let tmpPhases = tmpRawPhases.map((pPhase, pIndex) =>
		{
			let tmpProjected = this.projectPhase(pPhase, tmpNow);
			if (tmpProjected.Index === null) { tmpProjected.Index = pIndex + 1; }
			return tmpProjected;
		});

		let tmpPhaseCount = tmpPhases.length;
		let tmpFinishedCount = tmpPhases.filter((pPhase) => pPhase.RunState === 'done').length;
		// The current phase is the running one, else the last that finished, else the first.
		let tmpRunning = tmpPhases.find((pPhase) => pPhase.RunState === 'running');
		let tmpCurrentIndex = tmpRunning ? tmpRunning.Index : (tmpFinishedCount > 0 ? tmpFinishedCount : (tmpPhaseCount > 0 ? 1 : 0));

		// Whole-op ETA: sum the ETAs of the not-finished phases we CAN estimate; flag Estimating when any can't yet.
		let tmpEtaSeconds = 0;
		let tmpEstimating = false;
		let tmpAnyKnown = false;
		tmpPhases.forEach((pPhase) =>
		{
			if (pPhase.RunState === 'done') { return; }
			if (pPhase.EtaSeconds >= 0) { tmpEtaSeconds += pPhase.EtaSeconds; tmpAnyKnown = true; }
			else { tmpEstimating = true; }
		});
		if (!tmpAnyKnown && tmpEstimating) { tmpEtaSeconds = -1; }

		// Phase-weighted overall percent: finished phases + the current phase's fraction, each phase equal weight.
		let tmpOverallPercent = null;
		if (tmpPhaseCount > 0)
		{
			let tmpFraction = tmpFinishedCount;
			if (tmpRunning && tmpRunning.Percent !== null) { tmpFraction += (tmpRunning.Percent / 100); }
			tmpOverallPercent = Math.min(100, Math.round((tmpFraction / tmpPhaseCount) * 1000) / 10);
		}

		let tmpOpStarted = this._ms(tmpState.StartedAt) || (tmpPhases.length ? this._ms(tmpRawPhases[0].StartedAt) : null);
		let tmpOpFinished = this._ms(tmpState.FinishedAt);
		let tmpElapsedMs = tmpOpStarted ? Math.max(0, (tmpOpFinished || tmpNow) - tmpOpStarted) : 0;

		return {
			Key: tmpState.Key || null,
			Label: tmpState.Label || 'Operation',
			Status: _STATUSES[tmpState.Status] ? tmpState.Status : (tmpOpFinished ? 'Succeeded' : (tmpOpStarted ? 'Running' : 'Pending')),
			PhaseCount: tmpPhaseCount,
			CurrentPhaseIndex: tmpCurrentIndex,
			StepText: tmpPhaseCount > 0 ? ('Step ' + tmpCurrentIndex + ' of ' + tmpPhaseCount) : 'No steps',
			Phases: tmpPhases,
			Overall:
			{
				Percent: tmpOverallPercent,
				EtaSeconds: (tmpEtaSeconds < 0) ? -1 : Math.round(tmpEtaSeconds),
				EtaText: (tmpEtaSeconds < 0) ? 'unknown' : this.formatDuration(tmpEtaSeconds * 1000),
				Estimating: tmpEstimating,
				ElapsedMs: tmpElapsedMs,
				ElapsedText: this.formatDuration(tmpElapsedMs)
			},
			Outcome: tmpState.Outcome || null
		};
	}
}

module.exports = OperationProgressCore;
