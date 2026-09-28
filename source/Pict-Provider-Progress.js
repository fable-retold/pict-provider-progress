const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libOperationProgressCore = require('./Operation-Progress-Core.js');

/**
 * PictProvider-Progress
 *
 * The Pict-side of unified progress reporting: a thin Fable service-provider around the dependency-free
 * Operation-Progress-Core. It holds the latest operation STATE(s), projects them into display models (per-phase +
 * whole-op percent/ETA) through the core, and can POLL an operations endpoint on a self-stopping timer so a view just
 * subscribes to updates instead of hand-rolling fetch/poll/projection.
 *
 * The endpoint is expected to return the unified envelope { Operations: [ <operation state> ] }. Polling stops on its
 * own once every operation is in a terminal state (nothing left to watch), and restarts on the next startPolling call.
 *
 * Consumers that only need the math can use the core directly:
 *   const OperationProgressCore = require('pict-provider-progress').OperationProgressCore;
 */
const _ProviderConfiguration =
{
	ProviderIdentifier: 'PictProviderProgress',
	// Default polling cadence (ms) when a caller does not pass one.
	PollIntervalMS: 1000
};

const _TERMINAL = { Succeeded: true, Partial: true, Failed: true, Canceled: true };

class PictProviderProgress extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		let tmpOptions = Object.assign({}, _ProviderConfiguration, pOptions);
		super(pFable, tmpOptions, pServiceHash);

		this.serviceType = 'PictProviderProgress';

		this.core = new libOperationProgressCore(this.options);

		// Latest raw operation state keyed by IDOperation / GUIDOperation / Key.
		this.operations = {};

		this._pollTimer = null;
		this._polling = false;
	}

	formatDuration(pMilliseconds) { return this.core.formatDuration(pMilliseconds); }

	// Project one raw operation state into its display model.
	project(pState, pNow) { return this.core.project(pState, pNow); }

	// Project every held operation state, newest activity first is the caller's concern; returns display models.
	projectAll(pNow)
	{
		let tmpNow = (typeof pNow === 'number') ? pNow : Date.now();
		return Object.keys(this.operations).map((pKey) => this.core.project(this.operations[pKey], tmpNow));
	}

	_keyOf(pState, pIndex)
	{
		if (pState && (pState.IDOperation || pState.IDOperation === 0)) { return 'id:' + pState.IDOperation; }
		if (pState && pState.GUIDOperation) { return 'guid:' + pState.GUIDOperation; }
		if (pState && pState.Key) { return 'key:' + pState.Key; }
		return 'idx:' + pIndex;
	}

	setOperation(pKey, pState) { this.operations[pKey] = pState; return this; }

	setOperations(pList)
	{
		let tmpList = Array.isArray(pList) ? pList : [];
		this.operations = {};
		tmpList.forEach((pState, pIndex) => { this.operations[this._keyOf(pState, pIndex)] = pState; });
		return this;
	}

	// True when every held operation is terminal (nothing worth polling for).
	allTerminal()
	{
		let tmpKeys = Object.keys(this.operations);
		if (!tmpKeys.length) { return false; }
		return tmpKeys.every((pKey) => _TERMINAL[(this.operations[pKey] || {}).Status]);
	}

	// Poll pURL (returns { Operations: [state] }) every pIntervalMS; calls fOnUpdate(displayModels[]) each tick.
	// Stops on its own once all operations are terminal. Requires a global fetch (browser / Node 18+).
	startPolling(pURL, pIntervalMS, fOnUpdate)
	{
		let tmpSelf = this;
		let tmpInterval = (typeof pIntervalMS === 'number' && pIntervalMS > 0) ? pIntervalMS : this.options.PollIntervalMS;
		if (typeof fetch !== 'function')
		{
			this.fable.log.warn('PictProviderProgress: no global fetch available; cannot poll ' + pURL + '.');
			return false;
		}
		this.stopPolling();
		this._polling = true;
		let fTick = () =>
		{
			fetch(pURL, { credentials: 'include', headers: { Accept: 'application/json' } })
				.then((pResponse) => (pResponse.ok ? pResponse.json() : null))
				.then((pData) =>
				{
					if (!tmpSelf._polling) { return; }
					let tmpOps = (pData && Array.isArray(pData.Operations)) ? pData.Operations : [];
					tmpSelf.setOperations(tmpOps);
					let tmpModels = tmpSelf.projectAll();
					if (typeof fOnUpdate === 'function') { try { fOnUpdate(tmpModels); } catch (pError) { /* the view's problem, not the poller's */ } }
					if (tmpSelf.allTerminal()) { tmpSelf.stopPolling(); }
				})
				.catch(() => { /* transient fetch error: keep polling */ });
		};
		fTick();
		this._pollTimer = setInterval(fTick, tmpInterval);
		return true;
	}

	stopPolling()
	{
		this._polling = false;
		if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
		return this;
	}
}

module.exports = PictProviderProgress;
module.exports.default_configuration = _ProviderConfiguration;
module.exports.OperationProgressCore = libOperationProgressCore;
