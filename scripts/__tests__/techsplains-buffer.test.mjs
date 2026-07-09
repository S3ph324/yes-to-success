import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPostInput } from "../lib/techsplains-buffer.mjs";

test("buildPostInput matches Buffer's verified Facebook-video schema", () => {
  const input = buildPostInput({
    channelId: "chan123",
    videoUrl: "https://f000.backblazeb2.com/file/bucket/2026-07-10T10-00/x.mp4",
    caption: "Codec vs container 🤔",
    dueAt: "2026-07-11T09:00:00.000Z",
  });
  assert.deepEqual(input, {
    channelId: "chan123",
    schedulingType: "automatic",
    mode: "customScheduled",
    dueAt: "2026-07-11T09:00:00.000Z",
    text: "Codec vs container 🤔",
    assets: [{ video: { url: "https://f000.backblazeb2.com/file/bucket/2026-07-10T10-00/x.mp4" } }],
    metadata: { facebook: { type: "reel" } },
  });
});

test("buildPostInput never emits thumbnailUrl (Buffer rejects it on video assets)", () => {
  const input = buildPostInput({ channelId: "c", videoUrl: "https://x/v.mp4", caption: "", dueAt: "d" });
  assert.equal("thumbnailUrl" in input.assets[0].video, false);
});

test("buildPostInput tolerates a missing caption", () => {
  const input = buildPostInput({ channelId: "c", videoUrl: "https://x/v.mp4", dueAt: "d" });
  assert.equal(input.text, "");
});

test("buildPostInput honors an explicit fbType override", () => {
  const input = buildPostInput({ channelId: "c", videoUrl: "https://x/v.mp4", dueAt: "d", fbType: "post" });
  assert.equal(input.metadata.facebook.type, "post");
});
