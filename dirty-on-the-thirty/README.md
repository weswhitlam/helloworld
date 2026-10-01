# The Dirty on the Thirty

Daily entertainment briefing email for Shannon Murphy (Mojo in the Morning, Channel 95.5). This replaces the n8n workflow "Shannon's Dirty on the Thirty" and runs for free on GitHub Actions.

Every day at about 3:05 AM Eastern it:

1. Reads the RSS feeds from Daily Mail US, Page Six, TMZ and ET Online.
2. Filters Daily Mail down to US show business and lifestyle stories (no politics, crime, etc.), newest 30.
3. Merges everything, tags each story with its source, and removes duplicates.
4. Drops any story already sent in the last 7 days (history is kept in `state/sent-stories.json`).
5. Builds the red/black branded HTML email (plus a plain-text version) and sends it from Gmail.

If one feed is down, the email still goes out with the others. If every feed fails, the run fails and nothing is sent.

## One-time setup

1. **Create a Gmail app password** for wesleywhitlam@gmail.com:
   Google Account > Security > turn on 2-Step Verification > App passwords > create one (name it "Dirty on the Thirty"). Copy the 16-character password.
2. **Add three repository secrets** in GitHub: repo > Settings > Secrets and variables > Actions > New repository secret.
   - `GMAIL_USER`: `wesleywhitlam@gmail.com`
   - `GMAIL_APP_PASSWORD`: the app password from step 1
   - `RECIPIENTS`: comma-separated list, e.g. `wesleywhitlam@gmail.com,shannon.n.murphy@gmail.com,Kaelin@iheartmedia.com,Kepenrose@gmail.com`
3. **Merge this into the default branch** (`main`). GitHub only runs scheduled workflows from the default branch.
4. **Test it**: Actions tab > "Dirty on the Thirty" > Run workflow (leave "force" checked). The email should arrive within a minute or two.
5. **Turn off n8n**: deactivate the workflow there and cancel the subscription.

## Changing things

| What | Where |
| --- | --- |
| Recipients | `RECIPIENTS` secret (no code change) |
| Send time | `SEND_HOUR_ET` in `src/index.js` and the two `cron` lines in `.github/workflows/dirty-on-the-thirty.yml` (UTC times for that hour in EDT and EST) |
| Feeds | `FEEDS` in `src/index.js` |
| Daily Mail keywords | the keyword lists at the top of `src/index.js` |
| Email look | `EMAIL_CSS` and `buildEmail()` in `src/index.js` |

## Running locally

```bash
cd dirty-on-the-thirty
npm ci
npm test          # unit tests
npm run preview   # fetches feeds, writes out/preview.html, sends nothing
```

To really send from your machine, set `GMAIL_USER`, `GMAIL_APP_PASSWORD` and `RECIPIENTS` and run `node src/index.js --force`.

## Notes

- GitHub's scheduled runs can start a few minutes late during busy periods.
- The workflow commits the updated story history after each send. That daily commit also keeps the repository "active", so GitHub does not auto-disable the schedule after 60 days of inactivity.
- Differences from the n8n version: the 7-day "no repeats" history is actually persisted now (the n8n code used `$workflow.staticData`, which did not save between runs), feed text is HTML-escaped so odd characters cannot break the email, and the Daily Mail filter also looks at the story summary, not just the headline.
