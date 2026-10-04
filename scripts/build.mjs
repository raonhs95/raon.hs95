// Builds the single-file app from src/app.html and the prompt package in prompts/.
//
//   node scripts/build.mjs
//
// Writes two files:
//   dist/artifact.html  page content only (title, style, markup, scripts) — publish this as a claude.ai Artifact
//   dist/index.html     the same page wrapped in a full HTML document — open locally or host anywhere
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const data = {
  'd-system': read('prompts/1_시스템프롬프트.md'),
  'd-reference': read('prompts/3_교육과정_참조표.md'),
  'd-sample': read('src/sample-output.md'),
};

for (const [id, text] of Object.entries(data)) {
  if (!text.trim()) throw new Error(`${id} is empty`);
}
if (!data['d-reference'].includes('## 7.')) {
  throw new Error("3_교육과정_참조표.md must keep its '## 7. 학교 성취기준' section; the app fills it with the school's standards");
}

// JSON inside <script type="application/json">; escaping "<" keeps "</script>" in the text from closing the tag.
const blocks = Object.entries(data)
  .map(([id, text]) => `<script type="application/json" id="${id}">${JSON.stringify(text).replace(/</g, '\\u003c')}</script>`)
  .join('\n');

const template = read('src/app.html');
if (!template.includes('<!--DATA-->')) throw new Error('src/app.html is missing the <!--DATA--> marker');
const content = template.replace('<!--DATA-->', blocks);

const full = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
</head>
<body>
${content}
</body>
</html>
`;

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist/artifact.html'), content);
writeFileSync(join(root, 'dist/index.html'), full);
console.log(`dist/artifact.html ${Buffer.byteLength(content)} bytes`);
console.log(`dist/index.html    ${Buffer.byteLength(full)} bytes`);
