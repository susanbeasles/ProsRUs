import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
const paths=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
const patterns=[/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,/gh[pousr]_[A-Za-z0-9]{30,}/,/AIza[A-Za-z0-9_-]{30,}/];
for(const path of paths){if(path==='scripts/scan-secrets.mjs')continue;const body=readFileSync(path,'utf8');if(patterns.some(pattern=>pattern.test(body)))throw Error(`Possible credential in ${path}`);}
console.log(`Scanned ${paths.length} tracked files for common credential formats. This is not a complete secret detector.`);
