const { generateKeyPairSync, sign } = require('node:crypto');
const { createServer } = require('node:http');
const { zipSync, strToU8 } = require('fflate');
const repositories = { Launcher: ['SpectrumQT/XXMI-Launcher', 'XXMI-Launcher-Portable-v', 'Signature Extra'], ZZMI: ['leotorrez/ZZMI-Package', 'ZZMI-PACKAGE-v', 'Signature'], EFMI: ['SpectrumQT/EFMI-Package', 'EFMI-PACKAGE-v', 'Signature'], XXMI: ['SpectrumQT/XXMI-Libs-Package', 'XXMI-PACKAGE-v', 'Signature'] };
async function createFixtureServer(options = {}) {
  const keys = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const signature = bytes => sign('sha256', bytes, keys.privateKey).toString('base64');
  const contents = { '3dmloader.dll': strToU8('signed-loader fixture'), 'd3d11.dll': strToU8('signed-d3d11 fixture'), 'd3dcompiler_47.dll': strToU8('signed-compiler fixture') };
  const manifest = { version: '1.2.2', signatures: Object.fromEntries(Object.entries(contents).map(([name, data]) => [name, signature(data)])) };
  const responses = new Map();
  const versions = { Launcher: '2.4.6', ZZMI: '1.5.0', EFMI: '1.4.8', XXMI: '1.2.2' };
  const sources = {};
  for (const [id, [repo, prefix, heading]] of Object.entries(repositories)) {
    const version = versions[id]; const name = `${prefix}${version}.zip`;
    const files = id === 'Launcher' ? { 'Resources/Bin/XXMI Launcher.exe': strToU8('fixture exe; never execute'), 'Resources/Bin/python313.dll': strToU8('python-fixture'), 'Themes/Default/example.txt': strToU8('theme-fixture') } : id === 'XXMI' ? contents : {
      'd3dx.ini': strToU8(`[Loader]\nloader=XXMI Launcher.exe\n[Include]\ninclude=Core\\${id}\\main.ini\ninclude_recursive=Mods ; preserve comment\nexclude_recursive=DISABLED*\n[Other]\nkeep = yes\n`),
      [`Core/${id}/main.ini`]: strToU8(`[Constants]\nglobal $version = ${version}\n`),
      'Core/auto_update.xcmd': strToU8('[PreInstall]\ndelete=Core/old.txt\n[PostInstall]\ndelete=ShaderFixes/obsolete.txt\n[PreLaunch]\ndelete=Core/stay.txt\n'),
      'ShaderFixes/obsolete.txt': strToU8('must be removed by postinstall'), 'Core/stay.txt': strToU8('do not execute PreLaunch'),
    };
    const archive = Buffer.from(zipSync(files));
    const officialAsset = `https://github.com/${repo}/releases/download/v${version}/${name}`;
    const assets = [{ name, browser_download_url: officialAsset, size: archive.length }];
    responses.set(new URL(officialAsset).pathname, { body: options.badSignature && id === 'ZZMI' ? Buffer.from(zipSync({ ...files, 'tampered.txt': strToU8('extra') })) : archive });
    if (id === 'XXMI') {
      const url = `https://github.com/${repo}/releases/download/v${version}/Manifest.json`;
      assets.push({ name: 'Manifest.json', browser_download_url: url, size: 600 });
      responses.set(new URL(url).pathname, { body: Buffer.from(JSON.stringify(manifest)) });
    }
    responses.set(`/repos/${repo}/releases/latest`, { body: Buffer.from(JSON.stringify({ tag_name: `v${version}`, assets, body: `## ${heading}\n- ${signature(archive)}` })), json: true });
    sources[id] = { id, repo, prefix, signatureHeading: heading, publicKey };
  }
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    const data = responses.get(request.url);
    if (options.offline || !data) { response.writeHead(options.offline ? 503 : 404); response.end('fixture error'); return; }
    response.writeHead(200, { 'Content-Type': data.json ? 'application/json' : 'application/octet-stream', 'Content-Length': data.body.length }); response.end(data.body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { publicKey, sources, url, fetch: (official, options) => fetch(url + new URL(official).pathname, options), requestCount: () => requests, close: () => new Promise(resolve => server.close(resolve)) };
}
module.exports = { createFixtureServer };
