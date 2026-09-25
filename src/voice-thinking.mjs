export const thinkingDelay = 3000;
export const thinkingInterval = 5000;

// Each stage covers one interval; the last stage repeats until the answer starts.
const stages = [
  ['Analyzing your request.', 'Let me think about that.', 'Looking into what you asked.', 'Working out what you need.', 'Reading through your request.'],
  ['Taking action now.', 'Getting that started.', 'Working on it.', 'Putting the pieces together.', 'Running the steps now.'],
  ['Checking the results.', 'Reviewing what came back.', 'Making sure this is right.', 'Verifying the details.', 'Looking over the findings.'],
  ['Almost there.', 'Wrapping this up.', 'Just a moment more.', 'Nearly done.', 'Still on it, hang tight.'],
];

export function thinkingLine(stage, previous, random = Math.random) {
  const options = stages[Math.min(stage, stages.length - 1)].filter(line => line !== previous);
  return options[Math.floor(random() * options.length)];
}

// Answers faster than thinkingDelay never show a line. The returned stop reports once whether a line was shown.
export function scheduleThinking(onLine) {
  let line = '';
  let stage = 0;
  let timer = setTimeout(function next() {
    line = thinkingLine(stage++, line);
    onLine(line);
    if (timer) timer = setTimeout(next, thinkingInterval);
  }, thinkingDelay);
  return () => {
    const shown = Boolean(timer && line);
    clearTimeout(timer);
    timer = undefined;
    return shown;
  };
}
