import { start } from './start.mjs';

const checkOnly = process.argv.includes('--check') || process.argv.includes('-check') || process.argv.includes('check');
await start({ isLocal: true, isCheck: checkOnly });
