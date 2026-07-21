// Progress routes — pollable OperationRun surface for long-running work.
//
// Transport is polling (1.5–2s — matches every existing poller in the
// app and survives any proxy). Mounted at /api/progress behind
// requireAuth (Bearer + req.advertiserId, tenantFilter convention).
//
//   GET  /api/progress/active?brandId=
//   GET  /api/progress/:runId
//   POST /api/progress/:runId/cancel

const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

const OperationRun = require('../models/OperationRun');
const { tenantFilter } = require('../middleware/tenantHelpers');
const { isCancellableKind, STALE_HEARTBEAT_MS } = require('../services/progressService');

// Recently-ended runs stay visible so the UI can show a final state
// after the last poll that still saw "running".
const RECENT_ENDED_MS = 5 * 60 * 1000;

// Annotate running/cancelling rows whose heartbeat is stale so the UI
// can render "stalled" without waiting for the reaper.
function withDisplayStatus(run) {
  if (!run) return run;
  const out = { ...run };
  const live = out.status === 'running' || out.status === 'cancelling';
  const hb = out.heartbeatAt ? new Date(out.heartbeatAt).getTime() : 0;
  out.displayStatus = live && hb && Date.now() - hb > STALE_HEARTBEAT_MS ? 'stalled' : out.status;
  return out;
}

// GET /api/progress/active?brandId=
// Running/cancelling for the tenant, plus anything that ended in the
// last ~5 minutes. Cap 50, newest first.
router.get('/active', async (req, res) => {
  try {
    const filter = tenantFilter(req, {
      $or: [
        { status: { $in: ['running', 'cancelling'] } },
        { endedAt: { $gt: new Date(Date.now() - RECENT_ENDED_MS) } }
      ]
    });
    if (req.query.brandId && mongoose.isValidObjectId(req.query.brandId)) {
      filter.brandId = req.query.brandId;
    }

    const runs = await OperationRun.find(filter)
      .sort({ startedAt: -1 })
      .limit(50)
      .lean();

    res.json({ runs: runs.map(withDisplayStatus) });
  } catch (err) {
    console.error('[progress] GET /active', err.message);
    res.status(err.status || 500).json({ error: err.message || 'Failed to list progress' });
  }
});

// GET /api/progress/:runId
// 404 on missing OR tenant mismatch (never 403 — tenant convention).
router.get('/:runId', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.runId)) {
      return res.status(404).json({ error: 'Run not found' });
    }
    const run = await OperationRun.findOne(tenantFilter(req, { _id: req.params.runId })).lean();
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json({ run: withDisplayStatus(run) });
  } catch (err) {
    console.error('[progress] GET /:runId', err.message);
    res.status(err.status || 500).json({ error: err.message || 'Failed to load run' });
  }
});

// POST /api/progress/:runId/cancel
// Sets cancelRequested + status→cancelling. Cooperative — the worker
// observes it at its next handle.checkpoint(). Idempotent for terminal
// rows (returns the current doc).
router.post('/:runId/cancel', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.runId)) {
      return res.status(404).json({ error: 'Run not found' });
    }
    const run = await OperationRun.findOne(tenantFilter(req, { _id: req.params.runId }));
    if (!run) return res.status(404).json({ error: 'Run not found' });

    if (!isCancellableKind(run.kind) && !run.cancellable) {
      return res.status(400).json({ error: 'Run kind is not cancellable' });
    }

    // Already finished — nothing to do; return the current doc.
    if (['succeeded', 'failed', 'cancelled'].includes(run.status)) {
      return res.json({ run: withDisplayStatus(run.toObject()) });
    }

    const now = new Date();
    run.cancelRequested = true;
    run.status = 'cancelling';
    run.updatedAt = now;
    run.heartbeatAt = now;
    await run.save();

    res.json({ run: withDisplayStatus(run.toObject()) });
  } catch (err) {
    console.error('[progress] POST /:runId/cancel', err.message);
    res.status(err.status || 500).json({ error: err.message || 'Failed to cancel run' });
  }
});

module.exports = router;
