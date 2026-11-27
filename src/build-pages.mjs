import path from 'node:path';
import { PROGRAM_DIR } from './paths.mjs';
import { buildGitHubPagesSite } from './mobile-export.mjs';

const docsDir = path.join(PROGRAM_DIR, 'docs');
const result = buildGitHubPagesSite(docsDir);
console.log(`[PASS] GitHub Pages 静态站已构建: ${result.indexPath} (${result.bytes} bytes)`);
