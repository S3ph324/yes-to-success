# Screencast Script — App Review Demo

A ~2 minute screencast showing the app using `pages_manage_posts`.
Record on your Mac with **QuickTime Player → File → New Screen Recording**,
or **Cmd+Shift+5 → Record Selected Portion**. Export as MP4.

Voiceover is optional — you can record silently and rely on on-screen
actions to tell the story. If you do narrate, keep it factual and brief.

---

## What to record

The screencast should show ONE complete flow: a member of the John Calub
content team logging into the internal dashboard, reviewing a generated
quote-card, approving it, and publishing it to the John Calub Facebook
page.

---

## Step-by-step recording plan

### Scene 1 — The internal dashboard (≈ 20 seconds)

1. Start recording.
2. Open the dashboard URL (`http://localhost:8787` for the demo, or your
   deployed URL once live).
3. Show the **Generate** page briefly. (Optional voiceover: "This is the
   John Calub team's internal content dashboard. Only authorized members
   of John Calub Training International have access.")
4. Click into the **Gallery** page.

### Scene 2 — Review and approve a card (≈ 30 seconds)

5. Show one quote-card in the gallery — image + Tagalog/English caption.
6. Hover or click into it briefly to show the caption text reads as
   on-brand John Calub motivational content.
7. Click the green **Approve** button on the card.
   (Voiceover: "After reviewing the content, the team member approves it
   for publishing.")

### Scene 3 — Schedule the post via pages_manage_posts (≈ 40 seconds)

8. Navigate to the **Queue** page.
9. The approved card now appears in the pending queue.
10. Show the "Start scheduling from" datetime picker — pick a time later
    today.
11. Click **Schedule Approved**.
12. (Voiceover: "The dashboard uses the pages_manage_posts permission to
    schedule the post on the John Calub page using Facebook's native
    scheduling.")
13. Wait for the confirmation toast: "✅ Scheduled 1 cards".
14. Show the card now displays the **⏰ Scheduled** badge with the
    scheduled time.

### Scene 4 — Verify on Facebook (≈ 30 seconds)

15. Open Facebook's page management in another tab → John Calub page →
    **Posts** → **Scheduled posts** tab.
16. Show the scheduled post appearing in Facebook's UI with the same
    image and caption.
17. (Voiceover: "Facebook now owns the scheduled post and will publish
    it at the scheduled time. No further action is needed from the
    team.")
18. Stop recording.

---

## What NOT to include

- Don't show the access token in plain text — blur it if it appears
  on screen during the FB-explorer/settings views.
- Don't show personal data of any external Facebook user.
- Don't show any content that hasn't been approved by the John Calub
  team.

---

## Tips

- Keep cursor movements deliberate and slow — reviewers watch this in
  real time.
- If you make a mistake, just keep going. Don't restart.
- If you redo, trim with QuickTime → Edit → Trim before exporting.
- File size: keep under 100 MB if possible. Compress with HandBrake
  if larger.

---

## After recording

1. Save the MP4 somewhere accessible (Downloads is fine).
2. In Meta's App Review submission form, upload it as the demo video
   for both `pages_manage_posts` and `pages_read_engagement`
   (you can reuse the same video).
3. Submit.
