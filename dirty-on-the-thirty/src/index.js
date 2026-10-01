#!/usr/bin/env node
// The Dirty on the Thirty: daily entertainment briefing.
// Port of the n8n workflow "Shannon's Dirty on the Thirty":
//   RSS feeds -> Daily Mail filter -> merge + tag source -> dedupe (7 day history)
//   -> HTML/text email -> Gmail.

const fs = require('node:fs');
const path = require('node:path');
const Parser = require('rss-parser');
const nodemailer = require('nodemailer');

const TIME_ZONE = 'America/New_York';
const SEND_HOUR_ET = 3;
const HISTORY_DAYS = 7;
const MAX_DAILY_MAIL_ITEMS = 30;
const MAX_STORIES = 100;

const ROOT = path.resolve(__dirname, '..');
const STATE_FILE = process.env.STATE_FILE || path.join(ROOT, 'state', 'sent-stories.json');
const PREVIEW_FILE = path.join(ROOT, 'out', 'preview.html');

const FEEDS = [
  { source: 'Daily Mail US', url: 'https://www.dailymail.co.uk/ushome/index.rss', filter: filterDailyMail },
  { source: 'Page Six', url: 'https://pagesix.com/feed' },
  { source: 'TMZ', url: 'https://www.tmz.com/rss.xml' },
  { source: 'ET Online', url: 'https://www.etonline.com/news/rss' },
];

// ---------- Keyword lists (from "Filter Daily Mail US Content") ----------

const SHOW_BUSINESS_KEYWORDS = [
  'celebrity', 'celebrities', 'hollywood', 'actor', 'actress', 'singer', 'musician',
  'movie', 'film', 'tv show', 'television', 'reality tv', 'netflix', 'disney',
  'streaming', 'premiere', 'red carpet', 'awards', 'oscar', 'emmy', 'golden globe',
  'kardashian', 'jenner', 'swift', 'beyonce', 'bieber', 'grande', 'lopez',
  'entertainment', 'show business', 'music industry', 'box office',
];

const LIFESTYLE_KEYWORDS = [
  'fashion', 'style', 'beauty', 'makeup', 'skincare', 'diet', 'fitness',
  'wedding', 'engagement', 'relationship', 'dating', 'breakup', 'divorce',
  'pregnancy', 'baby', 'children', 'family', 'lifestyle', 'home', 'decor',
  'travel', 'vacation', 'luxury', 'designer', 'brand', 'social media',
  'instagram', 'tiktok', 'influencer',
];

const EXCLUDE_KEYWORDS = [
  'politics', 'election', 'biden', 'trump', 'congress', 'senate',
  'covid', 'vaccine', 'pandemic', 'war', 'ukraine', 'russia',
  'economy', 'inflation', 'stock market', 'crime', 'murder',
  'shooting', 'police', 'court', 'trial', 'lawsuit',
];

const INCLUDE_KEYWORDS = [...SHOW_BUSINESS_KEYWORDS, ...LIFESTYLE_KEYWORDS];

// ---------- Helpers ----------

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', mdash: '—', ndash: '–', hellip: '…' };

function decodeEntities(text) {
  return String(text || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : match;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? match;
  });
}

function stripTags(html) {
  return decodeEntities(String(html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncate(text, max) {
  return text.length > max ? `${text.substring(0, max)}...` : text;
}

function normalizeTitle(title) {
  return String(title || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

// YYYY-MM-DD for the given instant in Eastern Time.
function etDateKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function etHour(date = new Date()) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hour: 'numeric', hourCycle: 'h23' }).format(date));
}

function byNewest(a, b) {
  return (new Date(b.pubDate).getTime() || 0) - (new Date(a.pubDate).getTime() || 0);
}

// ---------- Pipeline steps ----------

async function fetchFeed(feed, parser) {
  try {
    const parsed = await parser.parseURL(feed.url);
    const items = parsed.items || [];
    console.log(`${feed.source}: fetched ${items.length} items`);
    return items;
  } catch (err) {
    console.warn(`WARNING: ${feed.source} feed failed (${feed.url}): ${err.message}`);
    return [];
  }
}

async function fetchAllFeeds() {
  const parser = new Parser({
    timeout: 30000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DirtyOnTheThirty/1.0; +https://github.com/weswhitlam/helloworld)' },
    customFields: { item: [['media:thumbnail', 'mediaThumbnail'], ['media:content', 'mediaContent'], 'description'] },
  });
  const results = await Promise.all(FEEDS.map(async (feed) => {
    const raw = await fetchFeed(feed, parser);
    const filtered = feed.filter ? feed.filter(raw) : raw;
    return filtered.map((item, i) => normalizeItem(item, feed.source, i));
  }));
  return results.flat();
}

// "Filter Daily Mail US Content": showbiz/lifestyle only, no hard news, newest 30.
function filterDailyMail(items) {
  const kept = items.filter((item) => {
    const text = `${item.title || ''} ${stripTags(item.description || item.contentSnippet || item.content)}`.toLowerCase();
    const relevant = INCLUDE_KEYWORDS.some((k) => text.includes(k));
    const excluded = EXCLUDE_KEYWORDS.some((k) => text.includes(k));
    return relevant && !excluded;
  });
  const limited = kept
    .map((item) => ({ ...item, pubDate: item.pubDate || item.isoDate }))
    .sort(byNewest)
    .slice(0, MAX_DAILY_MAIL_ITEMS);
  console.log(`Daily Mail: ${items.length} total -> ${kept.length} filtered -> ${limited.length} final`);
  return limited;
}

function mediaUrl(media) {
  const first = Array.isArray(media) ? media[0] : media;
  return first?.$?.url || first?.url || '';
}

// "Process & Add Source"
function normalizeItem(item, source, index) {
  const title = decodeEntities(item.title || '').trim() || 'No Title';
  const link = (item.link || '').trim();
  return {
    title,
    link,
    description: stripTags(item.description || item.contentSnippet || item.content || ''),
    pubDate: item.pubDate || item.isoDate || new Date().toISOString(),
    source,
    image: item.enclosure?.url || mediaUrl(item.mediaThumbnail) || mediaUrl(item.mediaContent) || '',
    guid: item.guid || link || `${source}-${index}`,
    normalizedTitle: normalizeTitle(title),
  };
}

// "Remove Duplicates & Historical Check". Returns the fresh stories and the updated history.
function dedupe(items, sentStories = {}, today = etDateKey()) {
  const history = {};
  const cutoff = new Date(`${today}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - HISTORY_DAYS);
  for (const [dateKey, stories] of Object.entries(sentStories)) {
    if (new Date(`${dateKey}T00:00:00Z`) >= cutoff && dateKey !== today) history[dateKey] = stories;
  }

  const previousTitles = new Set();
  const previousLinks = new Set();
  for (const stories of Object.values(history)) {
    for (const story of stories || []) {
      if (story.normalizedTitle) previousTitles.add(story.normalizedTitle);
      if (story.link) previousLinks.add(story.link);
    }
  }

  const seenTitles = new Set();
  const seenLinks = new Set();
  const unique = [];
  let previouslySent = 0;
  let duplicates = 0;

  for (const item of [...items].sort(byNewest)) {
    if (previousTitles.has(item.normalizedTitle) || (item.link && previousLinks.has(item.link))) {
      previouslySent++;
      continue;
    }
    if (seenTitles.has(item.normalizedTitle) || (item.link && seenLinks.has(item.link))) {
      duplicates++;
      continue;
    }
    seenTitles.add(item.normalizedTitle);
    if (item.link) seenLinks.add(item.link);
    unique.push(item);
    if (unique.length >= MAX_STORIES) break;
  }

  history[today] = unique.map(({ normalizedTitle, link, title }) => ({ normalizedTitle, link, title }));

  console.log(`Processed ${items.length} items: skipped ${previouslySent} previously sent, ${duplicates} duplicates; ${unique.length} fresh`);
  return { stories: unique, sentStories: history };
}

// ---------- Email ----------

const EMAIL_CSS = 'body{font-family:Arial,sans-serif;line-height:1.6;color:#333;max-width:800px;margin:0 auto;padding:20px;background-color:#f5f5f5}.header{background:linear-gradient(135deg,#d71921 0%,#000 100%);background-color:#d71921;color:white;padding:30px;text-align:center;border-radius:12px 12px 0 0;margin-bottom:0}.header-logos{display:flex;justify-content:center;align-items:center;gap:25px;margin-bottom:25px;flex-wrap:wrap}.header-logos img{max-height:50px;max-width:200px;object-fit:contain;filter:drop-shadow(0 3px 6px rgba(0,0,0,0.4))}.header h1{margin:0;font-size:2.8em;text-shadow:3px 3px 6px rgba(0,0,0,0.6);font-weight:900}.header p{margin:12px 0 0 0;font-size:1.3em;opacity:0.95}.content{background:white;padding:0;border-radius:0 0 12px 12px;box-shadow:0 6px 20px rgba(0,0,0,0.15)}.summary{background:linear-gradient(135deg,#f8f9fa 0%,#e9ecef 100%);padding:30px;border-bottom:4px solid #d71921;text-align:center}.summary h2{color:#d71921;margin-top:0;font-size:1.8em;font-weight:bold}.source-section{margin-bottom:35px;border-left:6px solid #d71921;background:#f8f9fa;box-shadow:0 3px 10px rgba(0,0,0,0.08)}.source-header{background:linear-gradient(135deg,#d71921 0%,#b01419 100%);background-color:#d71921;color:white;padding:20px 30px;font-size:1.5em;font-weight:bold;margin:0}.story{padding:25px 30px;border-bottom:1px solid #e9ecef;display:flex;gap:20px}.story:last-child{border-bottom:none}.story-image{flex-shrink:0;width:140px;height:105px;border-radius:12px;overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,0.15)}.story-image img{width:100%;height:100%;object-fit:cover}.story-image.no-image{background:linear-gradient(135deg,#d71921 0%,#000 100%);background-color:#d71921;display:flex;align-items:center;justify-content:center;color:white;font-weight:bold;font-size:16px;text-align:center}.story-content{flex:1}.story-title{font-size:1.2em;font-weight:bold;margin-bottom:12px;color:#2c3e50;line-height:1.4}.story-title a{color:#2c3e50;text-decoration:none}.story-title a:hover{color:#d71921;text-decoration:underline}.story-description{font-size:1em;color:#666;margin-bottom:15px;line-height:1.6}.story-meta{font-size:0.9em;color:#888;border-top:1px solid #eee;padding-top:10px}.story-meta a{color:#d71921;font-weight:600;text-decoration:none}.footer{text-align:center;padding:30px;background:linear-gradient(135deg,#2c3e50 0%,#000 100%);background-color:#2c3e50;color:white;border-radius:0 0 12px 12px}@media (max-width:600px){.story{flex-direction:column}.story-image{width:100%;height:200px}}';

const LOGO_URL = 'https://images.squarespace-cdn.com/content/v1/54becebee4b05d09416fe7e4/1739983510553-OMJ9J7WBEQZUTTBO86YO/iHR_secondary_Color.png?format=500w';

function groupBySource(stories) {
  const groups = {};
  for (const story of stories) (groups[story.source] ||= []).push(story);
  return groups;
}

function formatPublished(pubDate) {
  const date = new Date(pubDate);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: TIME_ZONE });
}

// "Generate Enhanced Email Content"
function buildEmail(stories, now = new Date()) {
  const currentDate = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: TIME_ZONE });
  const groups = groupBySource(stories);
  const sourceNames = Object.keys(groups);

  let html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>The Dirty on the Thirty - ${currentDate}</title><style>${EMAIL_CSS}</style></head><body>`
    + `<div class="header"><div class="header-logos"><img src="${LOGO_URL}" alt="iHeart Radio"></div>`
    + `<h1>🎙️ The Dirty on the Thirty</h1><p>Daily Entertainment Briefing for Shannon Murphy<br>Mojo in the Morning Show • Channel 95.5 • iHeart Radio</p><p><strong>${currentDate}</strong></p></div>`
    + `<div class="content"><div class="summary"><p><strong>${stories.length} fresh stories</strong> from ${sourceNames.length} sources</p>`
    + `<p><strong>Sources:</strong> ${escapeHtml(sourceNames.join(' • ')) || 'none'}</p>`
    + `<p style="font-size:0.95em;color:#666;margin-top:15px">✅ All stories verified against previous ${HISTORY_DAYS} days - zero repeats!</p>`
    + `<p style="font-size:0.9em;color:#888;margin-top:10px">📊 Daily Mail content filtered for US show business &amp; lifestyle (max ${MAX_DAILY_MAIL_ITEMS} items)</p></div>`;

  if (stories.length === 0) {
    html += '<div style="padding:40px 30px;text-align:center;color:#666"><p><strong>No fresh stories found today.</strong></p><p>Every story in the feeds was already sent in the past week, or the feeds could not be reached.</p></div>';
  }

  for (const [sourceName, items] of Object.entries(groups)) {
    html += `<div class="source-section"><div class="source-header">${escapeHtml(sourceName)} (${items.length} stories)</div>`;
    for (const story of items) {
      const link = escapeHtml(story.link);
      const image = story.image
        ? `<div class="story-image"><img src="${escapeHtml(story.image)}" alt="Story thumbnail"></div>`
        : '<div class="story-image no-image"><span>📰<br>NEWS</span></div>';
      html += `<div class="story">${image}<div class="story-content">`
        + `<div class="story-title"><a href="${link}" target="_blank">${escapeHtml(story.title)}</a></div>`
        + `<div class="story-description">${escapeHtml(truncate(story.description, 200))}</div>`
        + `<div class="story-meta">📅 ${formatPublished(story.pubDate)} • <a href="${link}" target="_blank">Read Full Story →</a></div>`
        + '</div></div>';
    }
    html += '</div>';
  }

  html += '</div><div class="footer"><p><strong>🎧 Ready for "The Dirty on the Thirty"!</strong></p><p>Compiled automatically for <strong>Shannon Murphy</strong></p><p>Mojo in the Morning Show • Channel 95.5 • iHeart Radio</p></div></body></html>';

  let text = `THE DIRTY ON THE THIRTY - ${currentDate}\nEntertainment Briefing for Shannon Murphy\nMojo in the Morning Show • Channel 95.5 • iHeart Radio\n\n`
    + `SUMMARY: ${stories.length} fresh stories from ${sourceNames.length} sources (no repeats from past ${HISTORY_DAYS} days)\n`
    + `Daily Mail content filtered for US show business & lifestyle (max ${MAX_DAILY_MAIL_ITEMS} items)\n`
    + `Sources: ${sourceNames.join(', ')}\n\n`;
  for (const [sourceName, items] of Object.entries(groups)) {
    text += `=== ${sourceName.toUpperCase()} (${items.length} stories) ===\n\n`;
    items.forEach((story, i) => {
      text += `${i + 1}. ${story.title}\n   ${truncate(story.description, 150)}\n   Published: ${formatPublished(story.pubDate)}\n   Link: ${story.link}\n\n`;
    });
  }
  text += '\n--- End of Briefing ---\nCompiled automatically for radio broadcast use.';

  const subject = `🎙️ The Dirty on the Thirty - ${currentDate} (${stories.length} Fresh Stories)`;
  return { subject, html, text };
}

async function sendEmail({ subject, html, text }) {
  const { GMAIL_USER, GMAIL_APP_PASSWORD, RECIPIENTS } = process.env;
  const missing = ['GMAIL_USER', 'GMAIL_APP_PASSWORD', 'RECIPIENTS'].filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}`);

  const to = RECIPIENTS.split(',').map((s) => s.trim()).filter(Boolean);
  const transport = nodemailer.createTransport({ service: 'gmail', auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD } });
  const info = await transport.sendMail({ from: `"The Dirty on the Thirty" <${GMAIL_USER}>`, to, subject, html, text });
  console.log(`Email sent to ${to.length} recipients (${info.messageId})`);
}

// ---------- State ----------

function loadState() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { lastSentDate: state.lastSentDate || null, sentStories: state.sentStories || {} };
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`WARNING: could not read state file, starting fresh: ${err.message}`);
    return { lastSentDate: null, sentStories: {} };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

// GitHub cron runs in UTC, so the workflow fires at both 07:05 and 08:05 UTC.
// Only the run that lands at or after 3 AM Eastern, and before today's email went out, sends.
function shouldSend(state, now = new Date()) {
  if (etHour(now) < SEND_HOUR_ET) return { send: false, reason: `it is before ${SEND_HOUR_ET} AM Eastern` };
  if (state.lastSentDate === etDateKey(now)) return { send: false, reason: `already sent for ${state.lastSentDate}` };
  return { send: true };
}

// ---------- Main ----------

async function main(argv = process.argv.slice(2)) {
  const dryRun = argv.includes('--dry-run');
  const force = argv.includes('--force') || process.env.FORCE_SEND === 'true';
  const now = new Date();
  const state = loadState();

  if (!force) {
    const decision = shouldSend(state, now);
    if (!decision.send) {
      console.log(`Skipping: ${decision.reason}.`);
      return;
    }
  }

  const items = await fetchAllFeeds();
  const today = etDateKey(now);
  const { stories, sentStories } = dedupe(items, state.sentStories, today);
  const email = buildEmail(stories, now);

  if (dryRun) {
    fs.mkdirSync(path.dirname(PREVIEW_FILE), { recursive: true });
    fs.writeFileSync(PREVIEW_FILE, email.html);
    console.log(`Dry run: subject "${email.subject}"; preview written to ${PREVIEW_FILE}. No email sent, state unchanged.`);
    return;
  }

  if (items.length === 0) throw new Error('All feeds failed; not sending an empty briefing.');

  await sendEmail(email);
  saveState({ lastSentDate: today, sentStories });
  console.log(`State saved to ${STATE_FILE}`);
}

if (require.main === module) {
  // Exit explicitly: lingering feed sockets/timers can otherwise keep the process alive.
  main().then(() => process.exit(0), (err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { main, filterDailyMail, normalizeItem, normalizeTitle, dedupe, buildEmail, shouldSend, etDateKey, etHour, decodeEntities, stripTags };
