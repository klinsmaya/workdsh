import { SrtBackend } from '../dist/backend.js';
const capability = await new SrtBackend().probe();
console.log(JSON.stringify({ task: 'D06', observedAt: new Date().toISOString(), node: process.version, architecture: process.arch, srt: '0.0.78', dsh: '0.1.7-rc.2', capability, acceptance: 'Supporting capability evidence only; formal desktop AT cases remain NOT_RUN/BLOCKED.' }, null, 2));
process.exitCode = capability.state === 'full' ? 0 : 2;
