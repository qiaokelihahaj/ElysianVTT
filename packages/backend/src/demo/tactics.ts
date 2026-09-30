import { runDemo } from './index.js';

void runDemo('tactics').catch(error => {
    console.error(`Spatial tactics demo failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
});
