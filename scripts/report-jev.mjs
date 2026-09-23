import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { jevCases, evaluateJev } from './jev-cases.mjs';

const round = value => Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const quantile = (values, fraction) => {
  const sorted = values.filter(Number.isFinite).toSorted((left, right) => left - right);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * fraction;
  return sorted[Math.floor(position)] + (sorted[Math.ceil(position)] - sorted[Math.floor(position)]) * (position % 1);
};
const distribution = values => ({ p50: round(quantile(values, 0.5)), p95: round(quantile(values, 0.95)), mean: round(mean(values)), total: round(values.reduce((sum, value) => sum + (value || 0), 0)) });
function accuracy(rows, predicate) {
  const count = rows.filter(predicate).length;
  if (!rows.length) return { count: 0, total: 0 };
  const proportion = count / rows.length;
  const factor = 1 + 1.96 ** 2 / rows.length;
  const center = (proportion + 1.96 ** 2 / (2 * rows.length)) / factor;
  const interval = 1.96 * Math.sqrt(proportion * (1 - proportion) / rows.length + 1.96 ** 2 / (4 * rows.length ** 2)) / factor;
  return { count, total: rows.length, percent: round(100 * proportion), wilson95: [round(100 * (center - interval)), round(100 * (center + interval))] };
}
const correct = row => row.evaluation.toolCorrect && row.evaluation.routeCorrect;
const passed = row => row.evaluation.passed && row.spokenContract;
const confidence = (row, temperature = 1) => {
  const values = row.decisions[0].scores.map(score => Math.log(score) / temperature);
  const maximum = Math.max(...values);
  const scaled = values.map(value => Math.exp(value - maximum));
  return scaled[row.decisions[0].index] / scaled.reduce((sum, value) => sum + value, 0);
};
function calibration(rows, temperature = 1) {
  if (!rows.length) return null;
  const brier = mean(rows.map(row => (confidence(row, temperature) - Number(correct(row))) ** 2));
  let ece = 0;
  for (let bin = 0; bin < 10; bin++) {
    const members = rows.filter(row => Math.min(9, Math.floor(confidence(row, temperature) * 10)) === bin);
    if (members.length) ece += members.length / rows.length * Math.abs(mean(members.map(row => confidence(row, temperature))) - mean(members.map(row => Number(correct(row)))));
  }
  return { brier: round(brier), ece: round(ece), count: rows.length };
}
function summarize(rows) {
  const accepted = rows.filter(row => row.decisions.some(decision => decision.accepted));
  const eligible = rows.filter(row => ['conversation', 'status', 'control', 'workiq', 'delegation'].includes(row.category));
  const eligibleAccepted = eligible.filter(row => row.decisions.some(decision => decision.accepted));
  const timings = rows.flatMap(row => [...row.rounds.map(item => item.timings), ...row.adapter.filter(item => item.endpoint === '/completion').map(item => item.timings)]).filter(Boolean);
  const sumTiming = key => round(timings.reduce((sum, timing) => sum + (timing[key] || 0), 0));
  const scored = rows.filter(row => row.decisions[0]?.scores && row.decisions[0].accepted);
  const fit = scored.filter(row => createHash('sha256').update(row.name).digest()[0] % 3 === 0);
  const diagnostic = scored.filter(row => !fit.includes(row));
  const temperature = [0.25, 0.5, 1, 2, 4, 8, 16].toSorted((left, right) => (calibration(fit, left)?.brier ?? 1) - (calibration(fit, right)?.brier ?? 1))[0];
  return {
    count: rows.length, workflow: accuracy(rows, passed), toolsAndArguments: accuracy(rows, row => row.evaluation.toolCorrect),
    requestedTools: accuracy(rows.filter(row => jevCases.find(spec => spec.name === row.name).expected.length), row => row.evaluation.toolCorrect),
    acceptedAccuracy: accuracy(accepted, correct), acceptedWorkflow: accuracy(accepted, passed), coveragePercent: round(accepted.length / rows.length * 100),
    eligibleAccuracy: accuracy(eligibleAccepted, correct), eligibleCoveragePercent: round(eligibleAccepted.length / eligible.length * 100), eligibleCount: eligible.length,
    totalMs: distribution(rows.map(row => row.wallMs)), routingMs: distribution(rows.map(row => row.routingMs)),
    firstTextMs: distribution(rows.map(row => row.firstTextMs).filter(Number.isFinite)), firstToolMs: distribution(rows.map(row => row.firstToolMs).filter(Number.isFinite)),
    textStageMs: distribution(rows.map(row => row.rounds.filter(item => item.stage === 'text').reduce((sum, item) => sum + item.wallMs, 0))),
    acceptedTotalMs: distribution(accepted.map(row => row.wallMs)), fallbackTotalMs: distribution(rows.filter(row => row.decisions.some(decision => !decision.accepted)).map(row => row.wallMs)),
    generations: timings.length, promptTokens: sumTiming('prompt_n'), cachedTokens: sumTiming('cache_n'), decodedTokens: sumTiming('predicted_n'), prefillMs: sumTiming('prompt_ms'), decodeMs: sumTiming('predicted_ms'),
    prefillTokensPerSecond: round(sumTiming('prompt_n') / sumTiming('prompt_ms') * 1000), decodeTokensPerSecond: round(sumTiming('predicted_n') / sumTiming('predicted_ms') * 1000),
    draftAcceptance: sumTiming('draft_n') ? { drafted: sumTiming('draft_n'), accepted: sumTiming('draft_n_accepted'), rate: round(sumTiming('draft_n_accepted') / sumTiming('draft_n')) } : null,
    decisionMs: distribution(rows.flatMap(row => row.decisions.map(item => item.wallMs))),
    failures: rows.filter(row => !passed(row)).map(row => ({ name: row.name, evaluation: row.evaluation, spokenContract: row.spokenContract, error: row.error, selected: row.decisions[0]?.name, probability: row.decisions[0]?.probability })),
    categories: Object.fromEntries([...new Set(rows.map(row => row.category))].map(category => {
      const group = rows.filter(row => row.category === category);
      return [category, { workflow: accuracy(group, passed), tools: accuracy(group, row => row.evaluation.toolCorrect), totalMs: distribution(group.map(row => row.wallMs)), routingMs: distribution(group.map(row => row.routingMs)) }];
    })),
    calibrationScope: 'Accepted scored choices only; rejected/shadow choices lack independently evaluated candidate outcomes. Threshold sweeps cannot recover unexecuted choices.',
    calibration: calibration(scored),
    diagnosticTemperatureFit: { note: 'Post-hoc synthetic diagnostic, NOT independent held-out calibration or a shipping policy.', temperature, fitCount: fit.length, diagnosticRaw: calibration(diagnostic), diagnosticScaled: calibration(diagnostic, temperature) },
    riskCoverage: [0, 0.8, 0.9, 0.95, 0.98, 0.99, 0.995, 0.999].map(threshold => {
      const selected = scored.filter(row => confidence(row) >= threshold);
      return { threshold, coveragePercent: round(100 * selected.length / rows.length), accuracy: accuracy(selected, correct) };
    }),
  };
}

const files = process.argv.slice(2);
if (!files.length) throw new Error('Usage: node scripts/report-jev.mjs artifacts/jev-final-gemma.jsonl [...]');
const reports = files.map(file => {
  const bytes = readFileSync(file);
  const records = bytes.toString().trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const rows = records.filter(row => row.kind === 'llm-turn' && row.evaluation).map(row => ({ ...row, evaluation: evaluateJev(jevCases.find(spec => spec.name === row.name), row) }));
  const modes = [...new Set(rows.map(row => row.router))];
  const baseline = rows.filter(row => row.router === 'off');
  return { file, sha256: createHash('sha256').update(bytes).digest('hex'), model: records.find(row => row.kind === 'llm-model'), corpus: records.find(row => row.kind === 'jev-corpus'),
    modes: Object.fromEntries(modes.map(mode => [mode, summarize(rows.filter(row => row.router === mode))])),
    paired: Object.fromEntries(modes.filter(mode => mode !== 'off').map(mode => {
      const pairs = rows.filter(row => row.router === mode).map(row => ({ candidate: row, baseline: baseline.find(item => item.name === row.name && item.repeat === row.repeat) })).filter(pair => pair.baseline);
      const bothCorrect = pairs.filter(pair => passed(pair.candidate) && passed(pair.baseline));
      return [mode, { pairs: pairs.length, medianTurnSpeedup: round(quantile(pairs.map(pair => pair.baseline.wallMs / pair.candidate.wallMs), 0.5)), medianRoutingSpeedup: round(quantile(pairs.map(pair => pair.baseline.routingMs / pair.candidate.routingMs), 0.5)), bothCorrectPairs: bothCorrect.length, bothCorrectMedianTurnSpeedup: round(quantile(bothCorrect.map(pair => pair.baseline.wallMs / pair.candidate.wallMs), 0.5)) }];
    })),
  };
});
console.log(JSON.stringify(reports, null, 2));