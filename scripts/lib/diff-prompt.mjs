// Pure, brand-parametrized prompt assembly for generate-diff-scripts.mjs.
// Extracted so the brand interpolation (no hardcoded "Techsplains") is unit-tested.
//
// IMPORTANT: the prompt text below is reproduced VERBATIM from the original
// generate-diff-scripts.mjs (pre-extraction, git 5c1ae72) for the techsplains
// client. Only the brand tokens explicitly marked with cfg.* below are
// parametrized. Do NOT "clean up", condense, or re-word any of this text —
// any wording change here changes what Gemini generates for techsplains,
// which must stay byte-identical to the pre-extraction behavior.

export function buildInstructions(cfg, voiceProfile, ledger, { count, topic = "", dyk = 0, general = 0 }) {
  const brief = cfg.brief || null;
  const allowGeneral = !!cfg.contentMix?.allowGeneral;

  const briefBlock = brief
    ? `\n\n## TECH/EDITING TOPIC POOLS (category "editing", "creation", or "tech"):\n` +
      brief.topics.map((t) => `- ${t}`).join("\n") +
      (brief.voiceNotes ? `\n\nVoice notes: ${brief.voiceNotes}` : "")
    : "";

  // Only shown when the brand allows the GENERAL (non-tech) category AND its
  // brief actually has general topics — techsplains has both, tranzzie has
  // allowGeneral:false so this collapses to "".
  const generalBlock = allowGeneral && brief?.generalTopics?.length
    ? `\n\n## GENERAL TOPIC POOLS (category "general" — NOT tech, see below):\n` +
      brief.generalTopics.map((t) => `- ${t}`).join("\n")
    : "";

  // Extra angle hints for the "didyouknow" variant — only present for briefs
  // that declare videoDykTopics (tranzzie). techsplains has no such field, so
  // this collapses to "" and its prompt stays byte-identical.
  const dykTopicBlock = brief?.videoDykTopics?.length
    ? `\n\n## DID-YOU-KNOW / GUIDE ANGLES (use for variant "didyouknow"):\n` +
      brief.videoDykTopics.map((t) => `- ${t}`).join("\n")
    : "";

  const ledgerBlock = ledger.used?.length
    ? `\n\n## ALREADY PUBLISHED — never generate any of these again, and avoid near-duplicates:\n` +
      ledger.used.map((t) => `- ${t}`).join("\n")
    : "";

  const DYK_COUNT = Math.min(count, Math.max(0, dyk | 0));
  const GENERAL_COUNT = allowGeneral ? Math.min(count, Math.max(0, general | 0)) : 0;
  const DIFF_COUNT = count - DYK_COUNT;
  const GENERAL_DIFF = Math.min(GENERAL_COUNT, DIFF_COUNT);
  const GENERAL_DYK = Math.min(DYK_COUNT, GENERAL_COUNT - GENERAL_DIFF);

  const sharedBlocks = `${voiceProfile}${briefBlock}${generalBlock}${dykTopicBlock}${ledgerBlock}

CLARITY & ENGAGEMENT (applies to EVERY sentence, all categories):
- Write like you're telling a friend a fun fact at lunch, never like a manual
  or a textbook. If a sentence sounds like a spec sheet, rewrite it.
- Simple, common words only. A 12-year-old with zero background should get it
  on first listen. Prefer "how long the camera lets light in" over "the
  duration the sensor is exposed to light".
- Each definition should earn a "huh, I didn't know that" — lead with the
  surprising or useful part of the difference, and keep each segment's A and
  B definitions mirrored so the contrast is obvious heard back to back.
- Work ONE vivid, concrete detail into each definition when it is TRUE — a
  number, a place, a "so THAT's why" consequence. "A toad can wait out a
  drought buried in mud for months" beats "A toad lives on land." Never
  invent a detail to sound vivid; accuracy outranks color.
- The HOOK must open a curiosity gap or pick a fight — call the viewer out
  ("You've been saying this wrong your whole life"), start a debate, or
  promise a payoff. NEVER a flat topic announcement ("Let's talk about
  frogs and toads" is banned energy).
- The OUTRO question must be answerable in ONE WORD in the comments — "Team
  frog or team toad?" beats "What do you think about amphibians?" One-word
  answers are what make people actually comment.
- ABSTRACT pairs (feelings, story roles, ideas — e.g. true love vs
  infatuation, protagonist vs hero) are welcome when people genuinely mistake
  one for the other, but every searchQuery/imagePrompt for them must describe
  a CONCRETE photographable human scene ("elderly couple laughing kitchen",
  "person anxiously checking phone at night"), never the abstract word itself.

VARIETY RULES:
- Every video in the batch comes from a DIFFERENT topic pool line.
- Vary the hook style across the batch (callout / question / bold claim).
- No two videos in the batch may share a comparison or fact.

Output ONLY valid JSON.`;

  const generalLine = (n, total) => {
    if (topic) return "";
    return n > 0
      ? `\nExactly ${n} of the ${total} video(s) must be GENERAL (category "general"): everyday fun facts / good-to-know differences with NOTHING to do with tech, editing, or content creation — pick from the GENERAL topic pools (food, animals, body, language, history…). The other ${total - n} come from the tech/editing pools.`
      : `\nEvery video comes from the TECH/EDITING topic pools — do not use the GENERAL pools in this batch.`;
  };
  const topicLine = topic
    ? `\nEVERY video must be about: "${topic}" (use category "general" if that topic isn't tech/editing related).`
    : "\nRotate across the topic pools.";

  const diffInstruction = `${sharedBlocks}

You are generating ${DIFF_COUNT} "difference" video script(s) (variant="difference").${generalLine(GENERAL_DIFF, DIFF_COUNT)}${topicLine}

Each video's segments array contains exactly 2 entries — two RELATED
comparisons from the same topic family, e.g. segments: [ {codec vs container},
{render vs export} ]. Each segment compares its own A/B pair following the
script formula from the profile EXACTLY — the renderer depends on the sentence
structure. In the intro sentences use natural articles ("This is a codec." but
"This is RAM.").`;

  const dykInstruction = `${sharedBlocks}

You are generating ${DYK_COUNT} "didyouknow" video script(s) (variant="didyouknow").${generalLine(GENERAL_DYK, DYK_COUNT)}${topicLine}

Each video has ONE segment: one genuinely surprising true fact.
- hook: MUST literally start with the words "${cfg.dykOpener}" — e.g. "${cfg.dykOpener}
  your phone camera is lying to you?" Max 11 words total.
- The segment's introA = the FACT itself, one punchy sentence, max 16 words.
- The segment's defA = WHY/how it works, one sentence, max 16 words.
- aLabel = short display label for the subject; aSearchQuery + aImagePrompt
  for its single visual. Leave bLabel, introB, defB, bSearchQuery,
  bImagePrompt as empty strings.
- aSearchQuery doubles as a STOCK VIDEO search — prefer a scene with natural
  MOTION in it ("octopus swimming coral reef", "lightning storm night sky",
  "chef kneading dough closeup"), not an object posed on a white background.
- outro: engagement question + "${cfg.outro}"`;

  return { diffInstruction, dykInstruction, DIFF_COUNT, DYK_COUNT, GENERAL_COUNT };
}
