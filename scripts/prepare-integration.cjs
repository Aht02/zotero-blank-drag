// Generate a disposable, project-local Zotero profile and PDF fixture.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
for (const dir of ['.test-profile/extensions', '.test-data', '.test-results']) {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
}
const prefs = {
  'extensions.zotero.useDataDir': true,
  'extensions.zotero.dataDir': path.join(root, '.test-data'),
  'extensions.zotero.firstRun': false,
  'extensions.zotero.firstRun2': false,
  'extensions.zotero.automaticScraperUpdates': false,
  'extensions.zotero.sync.autoSync': false,
  'extensions.zotero.reportTranslationFailure': false,
  'extensions.zotero.httpServer.enabled': false,
  'extensions.zotero.integration.enabled': false,
  'extensions.autoDisableScopes': 0,
  'extensions.enabledScopes': 15,
  'extensions.update.enabled': false,
  'app.update.auto': false,
  'app.update.enabled': false,
  'toolkit.telemetry.enabled': false,
  'datareporting.healthreport.uploadEnabled': false,
  'network.proxy.type': 1,
  'network.proxy.http': '127.0.0.1',
  'network.proxy.http_port': 9,
  'network.proxy.ssl': '127.0.0.1',
  'network.proxy.ssl_port': 9,
  'network.proxy.no_proxies_on': '',
  'blankDrag.testRoot': root
};
fs.writeFileSync(path.join(root, '.test-profile/user.js'), Object.entries(prefs)
  .map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`).join('\n'));
for (const [id, files, base] of [
  ['blank-drag@aht02.github.io', ['manifest.json', 'bootstrap.js', 'content/blank-drag.js'], root],
  ['blank-drag-test@aht02.github.io', ['manifest.json', 'bootstrap.js'], path.join(root, 'tests/harness')]
]) {
  const out = path.join(root, '.test-profile/extensions', id);
  for (const file of files) {
    const target = path.join(out, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(base, file), target);
  }
  // Gecko checks the extension root mtime when deciding to re-read its manifest.
  const now = new Date();
  fs.utimesSync(out, now, now);
}
const stream = 'BT /F1 20 Tf 72 720 Td (Selectable text for drag tests) Tj ET\n';
const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>'
];
let pdf = '%PDF-1.4\n';
const offsets = [0];
objects.forEach((obj, index) => {
  offsets.push(Buffer.byteLength(pdf));
  pdf += `${index + 1} 0 obj\n${obj}\nendobj\n`;
});
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
pdf += offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('');
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
fs.writeFileSync(path.join(root, '.test-results/fixture.pdf'), pdf);
console.log('Prepared isolated profile:', path.join(root, '.test-profile'));
