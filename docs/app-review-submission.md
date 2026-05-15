# App Review Submission — John Calub Content Bot

Materials to paste into Meta's App Review form tomorrow once the
"Request advanced access" button activates.

---

## Permissions to request

- `pages_manage_posts` (primary — required for publishing content)
- `pages_read_engagement` (for displaying engagement metrics on previously
  published posts to the page admin)

`pages_show_list` is at Standard Access and does not require App Review.

---

## App Verification — basic info

**App name:** John Calub Content Bot

**App icon:** 1024×1024 PNG of the "Yes to Success" gold/red logo

**Privacy policy URL:** https://s3ph324.github.io/yes-to-success/privacy.html

**Terms of service URL:** https://s3ph324.github.io/yes-to-success/terms.html

**Data deletion URL:** https://s3ph324.github.io/yes-to-success/data-deletion.html

**App category:** Business and pages

**Business use:** Yes — connected to John Calub's Business Manager

---

## How will your app use `pages_manage_posts`?

**Paste this into the "How will your app use this permission" field:**

> John Calub Content Bot is an internal content automation tool operated
> exclusively by the content team of John Calub Training International,
> Philippines. The app is used by the team to schedule motivational
> quote-card posts and short videos onto the official John Calub Facebook
> page (https://facebook.com/JohnCalubTraining, page ID 118533838163379),
> where John Calub is a verified administrator.
>
> The team produces 10–30 brand-consistent posts per week. Each post
> consists of a graphic image (motivational quote rendered in the brand's
> red/gold visual style) and an accompanying caption written in the John
> Calub voice (Tagalog/English mix, motivational content focused on
> personal development, mindset, and prosperity coaching for the Filipino
> audience).
>
> The app uses `pages_manage_posts` exclusively to publish these
> pre-approved posts on behalf of John Calub. Every post goes through a
> human review and approval workflow within the team's private internal
> dashboard before publishing. Once approved, the team uses Facebook's
> native `scheduled_publish_time` feature to schedule the post at a
> specific future time during the page's audience peak hours (morning,
> lunch, evening Manila time). Facebook's own scheduling system handles
> the actual delivery from Meta's servers.
>
> The app does not publish to any other Facebook page, does not collect
> data from page followers, and is not made available to anyone outside
> the John Calub Training International team. It is not a multi-tenant
> service or a publicly installable application.

---

## How will your app use `pages_read_engagement`?

**Paste this into the "How will your app use this permission" field:**

> The John Calub content team uses `pages_read_engagement` to display
> aggregate engagement metrics (likes, comments count, reach) for posts
> previously published by the app, shown inside the team's internal
> dashboard alongside each scheduled or posted card.
>
> This is used to inform editorial decisions — for example, identifying
> which content themes (trading, manifestation, biohacking) drive the
> most engagement, so the team can shift the topical mix for upcoming
> batches. The data is not shared externally and is not used for
> advertising or targeting purposes.

---

## Demo video (screencast) — submission instructions

Meta requires a video showing the permission in action. Specifications:

- Length: 1–3 minutes (Meta's stated max is "short and focused")
- Format: MP4
- Resolution: at least 1280×720
- Audio: not required, but a brief voiceover or on-screen captions help
  reviewers
- Upload directly into Meta's submission form

### Screencast script

Use the included `screencast-script.md` for the recording walkthrough.

---

## Submission checklist

Before clicking Submit in App Review, verify:

- [ ] Privacy policy URL loads publicly: open in incognito
- [ ] Terms URL loads publicly
- [ ] Data deletion URL loads publicly
- [ ] App icon set in App Settings → Basic (1024×1024 PNG)
- [ ] App's display name set in App Settings → Basic ("John Calub Content Bot")
- [ ] Business verification status: connected to Business Manager (already done)
- [ ] Demo video uploaded (under 3 minutes)
- [ ] Permissions checked: `pages_manage_posts` + `pages_read_engagement`
- [ ] Use case write-ups pasted from above
- [ ] One successful test API call has been made (we did this today via
  Post Now)

Then click **Submit for review**.

---

## Expected timeline

- Submission day → 24 hours: Meta confirms receipt
- 1–7 days: Meta reviewer assesses the demo + materials
- Typical for "Manage Page posts" with clear business use case: **2–4 days**
- Outcome: Approved (Advanced Access granted) or Requires Changes (with
  specific feedback to address and re-submit)

After approval, every future post the app publishes is visible to the
general public, not just admins.
