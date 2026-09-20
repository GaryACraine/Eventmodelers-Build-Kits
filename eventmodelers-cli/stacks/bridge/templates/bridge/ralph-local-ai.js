#!/usr/bin/env node
// Bridge loop using a local AI model as the executor. Same caveats as
// build-kit's ralph-local-ai.js — lib/local-ai-agent.js is shared as-is (see
// useShared in cli.js), unmodified for bridge.
// Backend is selected by dialect, not by a separate runner: Ollama (native
// /api/chat) or any OpenAI-compatible server (vLLM, LM Studio, llama.cpp, TGI).
//
// Usage: node ralph-local-ai.js [project_dir]
//        LOCAL_AI_TARGET=ollama node ralph-local-ai.js          # run `ollama serve` first
//        LOCAL_AI_TARGET=vllm  node ralph-local-ai.js
//        LOCAL_AI_URL=http://gpu-box:8000/v1 LOCAL_AI_MODEL=Qwen/Qwen3-8B node ralph-local-ai.js
import { startRalph } from './lib/ralph.js';
import { spawn } from 'child_process';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const kitDir = dirname(fileURLToPath(import.meta.url));
const projectDir = process.argv[2] ? resolve(process.argv[2]) : resolve(kitDir, '..');


function runLocalAi() {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [join(kitDir, 'lib', 'local-ai-agent.js')], {
      cwd: projectDir,
      stdio: 'inherit',
      env: process.env,
    });
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`local-ai-agent exited ${code}`))));
    proc.on('error', reject);
  });
}

startRalph({
  kitDir,
  projectDir,
  onTask: runLocalAi,
  // onPlannedSlice omitted — local-ai-agent manages its own task queue
  agentType: 'BRIDGE',
  queueAllStatuses: true,
}).catch((err) => {
  console.error('[ralph] Fatal:', err);
  process.exit(1);
});
