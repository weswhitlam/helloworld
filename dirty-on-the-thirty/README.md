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

## Reliable 3 AM start (cron-job.org)

GitHub's own schedule is best effort: on 2026-10-02 it skipped one trigger and started the other almost 7 hours late. So a free external timer, [cron-job.org](https://cron-job.org), starts the workflow at exactly 3:05 AM Eastern. GitHub's schedule stays as a backup. The script sends at most one email per Eastern day, so extra triggers are harmless.

**1. GitHub token** (github.com > Settings > Developer settings > Personal access tokens > Fine-grained tokens > Generate new token)
- Name: `cron-job.org Dirty on the Thirty`. Expiration: the longest offered. Put a reminder in your calendar a week before it expires.
- Repository access: Only select repositories > `Dirty_on_the_30`.
- Permissions > Repository permissions > **Actions: Read and write**. Nothing else.
- Copy the token (starts with `github_pat_`). It is shown once.

**2. cron-job.org job** (free account) > Create cronjob
- Title: `Dirty on the Thirty`
- URL: `https://api.github.com/repos/weswhitlam/Dirty_on_the_30/actions/workflows/dirty-on-the-thirty.yml/dispatches`
- Execution schedule: every day at 03:05, time zone `America/New_York`
- Advanced > Request method: `POST`
- Advanced > Headers:
  - `Authorization`: `Bearer github_pat_...` (your token)
  - `Accept`: `application/vnd.github+json`
  - `X-GitHub-Api-Version`: `2022-11-28`
  - `Content-Type`: `application/json`
- Advanced > Request body: `{"ref":"main","inputs":{"force":"false"}}`
- Notifications: email on failure (for example, when the token expires).
- Save, then **Test run**. A `204` or `200` response means GitHub accepted it, and a new run appears in the Actions tab. `force` is `false`, so a test on a day that already sent does not send again.

**Renewing the token:** generate a new one with the same settings and paste it into the `Authorization` header in cron-job.org.

## Changing things

| What | Where |
| --- | --- |
| Recipients | `RECIPIENTS` secret (no code change) |
| Send time | the cron-job.org schedule, `SEND_HOUR_ET` in `src/index.js`, and the two backup `cron` lines in `.github/workflows/dirty-on-the-thirty.yml` (UTC times for that hour in EDT and EST) |
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

- GitHub's scheduled runs are best effort and can start hours late or be skipped, which is why cron-job.org does the real 3:05 AM start.
- The workflow commits the updated story history after each send. That daily commit also keeps the repository "active", so GitHub does not auto-disable the schedule after 60 days of inactivity.
- Differences from the n8n version: the 7-day "no repeats" history is actually persisted now (the n8n code used `$workflow.staticData`, which did not save between runs), feed text is HTML-escaped so odd characters cannot break the email, and the Daily Mail filter also looks at the story summary, not just the headline.
