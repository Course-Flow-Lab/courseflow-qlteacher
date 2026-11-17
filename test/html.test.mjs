import test from 'node:test';
import assert from 'node:assert/strict';
import { answerList, decodeEntities, htmlImages, htmlToText } from '../src/html.mjs';

test('rich text is converted to public-question text', () => {
  const html = '<p>第一行&nbsp;内容</p><p>第二行 &amp; <strong>重点</strong></p><script>bad()</script>';
  assert.equal(htmlToText(html), '第一行 内容\n第二行 & 重点');
});

test('entities and answer lists are normalized', () => {
  assert.equal(decodeEntities('&#65;&#x42;&lt;'), 'AB<');
  assert.deepEqual(answerList('a, b,c'), ['a', 'b', 'c']);
  assert.deepEqual(answerList(['x', '', 'y']), ['x', 'y']);
});

test('question images are resolved and restricted to platform hosts', () => {
  const html = [
    '<img src="/b/image-1.png">',
    '<img src="//downloadres.qlteacher.com/b/image-2.png">',
    '<img src="https://cdn.example.com/image-3.png">',
    '<img src="data:image/png;base64,AAAA">',
  ].join('');
  const images = htmlImages(html, host => host === 'qlteacher.com' || host.endsWith('.qlteacher.com'));
  assert.deepEqual(images, [
    'https://downloadres.qlteacher.com/b/image-1.png',
    'https://downloadres.qlteacher.com/b/image-2.png',
  ]);
});
