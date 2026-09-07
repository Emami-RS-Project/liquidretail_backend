'use strict';
// Tiny leaf — no config, no models. bootRecoveryService and titler.js share
// this so the settled-outcome list cannot drift (F12). Lives here rather
// than in videoQcRetryService.js because that file requires src/config.js
// (WORKER_ID) which exits unless ADGEN_ROLE is set; bootRecoveryService
// must stay loadable from harnesses that never boot a role.

// 'error' is INTENTIONALLY ABSENT. Today's E5 path (outcome:'error' +
// status:'rendering' + a predictionId) must NOT take the generic
// draft+title completion write — that overlap is owned by the QC-retry
// sweep (peek + Slack alert; a human completes). Including 'error' here
// would re-open that hole.
const QC_RETRY_SETTLED_OUTCOMES = Object.freeze(['passed', 'failed', 'skipped']);

function qcRetryGenericSweepExclusion() {
  return {
    $or: [
      { videoQcRetry: null },
      { 'videoQcRetry.outcome': { $in: [...QC_RETRY_SETTLED_OUTCOMES] } }
    ]
  };
}

module.exports = {
  QC_RETRY_SETTLED_OUTCOMES,
  qcRetryGenericSweepExclusion
};
