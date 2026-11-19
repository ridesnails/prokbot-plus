import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readVersions, render } from './homepage-versions.mjs';

const middle = '<!-- client-badges:end -->\r\n<p>unrelated edit</p>\r\n<!-- client-versions:start -->';
const fixture = `<p>before</p>\n<!-- client-badges:start -->\n${middle}\n<!-- client-versions:end -->\n<p>after</p>\n`;
const copy = {
  zh: { official: 'Windows 官方', input: 'Windows 补丁接受', unsupported: '此补丁不支持',
    accepted: (pin, older) => older.length ? `${pin} x64（推荐）、${older.join('、')}` : `${pin} x64`,
    needs: (pin, older) => older.length ? `**${pin}**（推荐）；用不了再用 ${older.join('、')}` : pin },
  en: { official: 'Windows official', input: 'Windows patch accepts', unsupported: 'not supported by this patch',
    accepted: (pin, older) => older.length ? `${pin} x64 (recommended), ${older.join(', ')}` : `${pin} x64`,
    needs: (pin, older) => older.length ? `**${pin}** (recommended); ${older.join(', ')} if it does not work` : pin },
};

// Keep the cases independent of the rolling snapshot and build pins.
async function fixtureData() {
  const data = await readVersions();
  data.win = { ...data.win, version: '1.1.0', archive: { ...data.win.archive, sha256: 'a'.repeat(64) } };
  data.winFallback = [{ ...data.win, version: '0.71.2', archive: { ...data.win.archive, sha256: 'b'.repeat(64) } }];
  data.snap = { ...data.snap, windows: { ...data.snap.windows, version: '1.1.0', observedArchiveSha256: 'a'.repeat(64) } };
  return data;
}

function assertWindows(page, lang, observed, data, note = '') {
  const lines = page.split('<!-- client-badges:start -->')[1].split('<!-- client-badges:end -->')[0].trim().split('\n');
  const { official, input, accepted, needs } = copy[lang], older = data.winFallback.map(item => item.version);
  const expected = [[official, `${observed} x64${note ? ` (${note})` : ''}`], [input, accepted(data.win.version, older)]];
  for (const [i, [label, value]] of expected.entries()) {
    const img = /<a href="#client-versions"><img alt="([^"]+)" src="(https:\/\/img\.shields\.io\/badge\/[^"]+)">/.exec(lines[i]);
    assert.ok(img, `missing ${label} badge at position ${i + 1}`);
    assert.equal(img[1], `${label} ${value}`);
    assert.equal(decodeURIComponent(new URL(img[2]).pathname).replace(/-[\da-f]{6}$/i, ''), `/badge/${label}-${value}`);
  }
  const tableNote = note ? (lang === 'zh' ? `（${note}）` : ` (${note})`) : '';
  const row = page.split('\n').find(line => line.startsWith('| Windows x64 |'));
  assert.equal(row, `| Windows x64 | [${observed}](https://api2.cursor.sh/updates/api/download/stable/win32-x64-user/sand)${tableNote} | ${needs(data.win.version, older)} |`);
}

test('the official installer of the recommended or a fallback release shows no warning', async () => {
  const data = await fixtureData();
  for (const lang of Object.keys(copy)) assertWindows(render(fixture,lang,data), lang, '1.1.0', data);
  data.snap.windows = { ...data.snap.windows, version: '0.71.2', observedArchiveSha256: 'b'.repeat(64) };
  for (const lang of Object.keys(copy)) assertWindows(render(fixture,lang,data), lang, '0.71.2', data);
});

test('a newer release, a repack or a fingerprint mismatch is marked unsupported', async () => {
  const data = await fixtureData();
  const cases = [{ version: '1.2.0' }, { observedArchiveSha256: '0'.repeat(64) }, { observedArchiveSha256: undefined },
    { version: '0.71.2' } /* the recommended release's bytes under the fallback's number */];
  for (const change of cases) {
    const changed = { ...data, snap: { ...data.snap, windows: { ...data.snap.windows, ...change } } };
    for (const [lang, { unsupported }] of Object.entries(copy))
      assertWindows(render(fixture,lang,changed), lang, changed.snap.windows.version, changed, unsupported);
  }
});

test('without a fallback the patch shows a single accepted Windows release', async () => {
  const data = await fixtureData();
  data.winFallback = []; data.androidFallback = [];
  for (const lang of Object.keys(copy)) {
    const page = render(fixture,lang,data);
    assertWindows(page, lang, '1.1.0', data);
    assert.ok(!page.split('\n').some(line => /^\| (Windows|Android)/.test(line) && line.includes('0.71.2')));
  }
});

test('Android names its interface release and fallback; Mac notes a newer official release', async () => {
  const data = await fixtureData();
  data.android = { ...data.android, desktopVersion: '1.1.0' }; data.androidFallback = ['0.71.2'];
  data.mac = { ...data.mac, version: '0.71.2' }; data.snap.mac = { ...data.snap.mac, version: '1.1.0' };
  const zh = render(fixture,'zh',data), en = render(fixture,'en',data);
  assert.ok(zh.includes('界面取自 Windows **1.1.0** 安装包（推荐；用不了再用 0.71.2）'));
  assert.ok(en.includes('interface taken from the Windows **1.1.0** installer (recommended; 0.71.2 if it does not work)'));
  assert.ok(zh.includes('| 网页版（浏览器，非官方） | 不用安装 | 界面取自 Windows **1.1.0** 安装包（推荐；用不了再用 0.71.2），生成后上传到你的 Host |'));
  assert.ok(en.includes('| Web client (browser, unofficial) | Nothing to install | Interface taken from the Windows **1.1.0** installer ' +
    '(recommended; 0.71.2 if it does not work), built once and uploaded to your Host |'));
  assert.ok(zh.includes('| 0.71.2（尚未适配 1.1.0；未在 Mac 真机上测试） |'));
  assert.ok(en.includes('| 0.71.2 (not yet adapted to 1.1.0; not tested on a Mac) |'));
  data.snap.mac.version = '0.71.2';
  assert.ok(render(fixture,'en',data).includes('| 0.71.2 (not tested on a Mac) |'));
});

test('vendor observation does not promote supported client, shell, or cloud inputs', async () => {
  const data = await fixtureData();
  const newer = structuredClone(data); newer.snap.windows.version = '99.2.1'; newer.android.shell.versionName = '2.7.0';
  for (const lang of ['zh','en']) {
    const rendered = render(fixture,lang,newer);
    assertWindows(rendered, lang, '99.2.1', data, copy[lang].unsupported);
    assert.ok(rendered.includes(`**2.7.0**`)); assert.ok(rendered.includes(`Windows **${data.android.desktopVersion}**`));
    assert.ok(rendered.includes(data.host)); assert.ok(rendered.includes(data.box));
    assert.equal(render(rendered,lang,newer),rendered);
    assert.ok(rendered.includes(middle));
    assert.ok(rendered.startsWith('<p>before</p>')); assert.ok(rendered.endsWith('<p>after</p>\n'));
  }
});

test('missing and duplicate markers fail closed without replacing prose', async () => {
  const data = await readVersions();
  for (const bad of [fixture.replace('<!-- client-badges:start -->',''),fixture+fixture])
    assert.throws(()=>render(bad,'zh',data), /missing or duplicate/);
});

test('both public READMEs exactly match their own version matrix', async () => {
  const data = await readVersions();
  for (const [file,lang] of [['README.md','zh'],['README.en.md','en']]) {
    const text=await readFile(new URL(`../${file}`,import.meta.url),'utf8');
    assert.equal(render(text,lang,data),text,`${file}: run node ci/homepage-versions.mjs --write`);
  }
});
