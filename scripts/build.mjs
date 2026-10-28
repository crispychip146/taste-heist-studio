import { cp, mkdir, rm } from 'node:fs/promises';
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await cp('public', 'dist', { recursive: true });
await cp('shared', 'dist/shared', { recursive: true });
console.log('Built dist/: frontend assets only. Live research and crew play require the Node server.');
