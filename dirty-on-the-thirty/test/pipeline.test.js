const test = require('node:test');
const assert = require('node:assert/strict');
const { filterDailyMail, normalizeItem, dedupe, buildEmail, shouldSend, etDateKey } = require('../src/index.js');

test('send guard fires exactly once a day at 3 AM Eastern across DST', () => {
  const empty = { lastSentDate: null, sentStories: {} };
  // Winter (EST, UTC-5): 07:05 UTC is 2:05 AM, 08:05 UTC is 3:05 AM.
  assert.equal(shouldSend(empty, new Date('2026-01-15T07:05:00Z')).send, false);
  assert.equal(shouldSend(empty, new Date('2026-01-15T08:05:00Z')).send, true);
  // Summer (EDT, UTC-4): 07:05 UTC is 3:05 AM, so the 08:05 run must be skipped.
  assert.equal(shouldSend(empty, new Date('2026-07-15T07:05:00Z')).send, true);
  const sent = { lastSentDate: etDateKey(new Date('2026-07-15T07:05:00Z')), sentStories: {} };
  assert.equal(shouldSend(sent, new Date('2026-07-15T08:05:00Z')).send, false);
});

test('Daily Mail filter keeps showbiz and drops hard news', () => {
  const items = [
    { title: 'Kardashian stuns on red carpet', pubDate: 'Wed, 01 Oct 2026 01:00:00 GMT' },
    { title: 'Celebrity attends trial over lawsuit', pubDate: 'Wed, 01 Oct 2026 02:00:00 GMT' },
    { title: 'Stock prices fall', pubDate: 'Wed, 01 Oct 2026 03:00:00 GMT' },
  ];
  const kept = filterDailyMail(items);
  assert.deepEqual(kept.map((i) => i.title), ['Kardashian stuns on red carpet']);
});

test('dedupe removes duplicates and stories sent in the last 7 days', () => {
  const items = [
    normalizeItem({ title: 'Story A', link: 'https://x/a', pubDate: 'Wed, 01 Oct 2026 01:00:00 GMT' }, 'TMZ', 0),
    normalizeItem({ title: 'Story A!', link: 'https://y/a', pubDate: 'Wed, 01 Oct 2026 00:00:00 GMT' }, 'Page Six', 1),
    normalizeItem({ title: 'Story B', link: 'https://x/b', pubDate: 'Wed, 01 Oct 2026 02:00:00 GMT' }, 'TMZ', 2),
    normalizeItem({ title: 'Story C', link: 'https://x/c', pubDate: 'Wed, 01 Oct 2026 03:00:00 GMT' }, 'TMZ', 3),
  ];
  const history = {
    '2026-09-28': [{ normalizedTitle: 'story b', link: 'https://x/b', title: 'Story B' }],
    '2026-09-01': [{ normalizedTitle: 'story c', link: 'https://x/c', title: 'Story C' }],
  };
  const { stories, sentStories } = dedupe(items, history, '2026-10-01');
  assert.deepEqual(stories.map((s) => s.title), ['Story C', 'Story A']);
  assert.deepEqual(Object.keys(sentStories).sort(), ['2026-09-28', '2026-10-01']);

  const second = dedupe(items, sentStories, '2026-10-02');
  assert.equal(second.stories.length, 0);
});

test('email escapes feed HTML and decodes entities', () => {
  const story = normalizeItem({
    title: 'Ben &amp; Jen&#8217;s <b>big</b> news',
    link: 'https://pagesix.com/x?a=1&b=2',
    description: '<p>Inside the &quot;wedding&quot;</p>',
    pubDate: 'Wed, 01 Oct 2026 01:00:00 GMT',
  }, 'Page Six', 0);
  const { subject, html, text } = buildEmail([story], new Date('2026-10-01T07:05:00Z'));
  assert.match(subject, /\(1 Fresh Stories\)$/);
  assert.match(html, /Ben &amp; Jen’s &lt;b&gt;big&lt;\/b&gt; news/);
  assert.match(html, /href="https:\/\/pagesix.com\/x\?a=1&amp;b=2"/);
  assert.match(text, /Inside the "wedding"/);
});
