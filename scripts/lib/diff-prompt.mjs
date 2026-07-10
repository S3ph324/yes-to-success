// Pure, brand-parametrized prompt assembly for generate-diff-scripts.mjs.
// Extracted so the brand interpolation (no hardcoded "Techsplains") is unit-tested.

export function buildInstructions(cfg, voiceProfile, ledger, { count, topic = "", dyk = 0, general = 0 }) {
  const brief = cfg.brief || {};
  const allowGeneral = !!cfg.contentMix?.allowGeneral;

  const briefBlock = brief.topics?.length
    ? `\n\n## TOPIC POOLS (category "editing", "creation", "tech", or eyewear):\n` +
      brief.topics.map((t) => `- ${t}`).join("\n") +
      (brief.voiceNotes ? `\n\nVoice notes: ${brief.voiceNotes}` : "")
    : "";

  const generalBlock = allowGeneral && brief.generalTopics?.length
    ? `\n\n## GENERAL TOPIC POOLS (category "general" — NOT tech):\n` +
      brief.generalTopics.map((t) => `- ${t}`).join("\n")
    : "";

  const ledgerBlock = ledger.used?.length
    ? `\n\n## ALREADY PUBLISHED — never generate any of these again, avoid near-duplicates:\n` +
      ledger.used.map((t) => `- ${t}`).join("\n")
    : "";

  const DYK_COUNT = Math.min(count, Math.max(0, dyk | 0));
  const GENERAL_COUNT = allowGeneral ? Math.min(count, Math.max(0, general | 0)) : 0;
  const DIFF_COUNT = count - DYK_COUNT;
  const GENERAL_DIFF = Math.min(GENERAL_COUNT, DIFF_COUNT);
  const GENERAL_DYK = Math.min(DYK_COUNT, GENERAL_COUNT - GENERAL_DIFF);

  const sharedBlocks = `${voiceProfile}${briefBlock}${generalBlock}${ledgerBlock}

CLARITY & ENGAGEMENT (applies to EVERY sentence):
- Write like you're telling a friend a fun fact, never like a manual or textbook.
- Simple, common words only. Someone with zero background should get it on first listen.
- Each definition should earn a "huh, I didn't know that" — lead with the surprising/useful part, keep A and B mirrored.
- The HOOK must open a curiosity gap or pick a friendly fight, never a flat topic announcement.
- The OUTRO question must be answerable in ONE WORD in the comments.
${allowGeneral ? `- ABSTRACT pairs are welcome when people genuinely mistake one for the other, but every searchQuery/imagePrompt must describe a CONCRETE photographable scene.\n` : ""}
VARIETY RULES:
- Every video comes from a DIFFERENT topic pool line.
- Vary the hook style across the batch.
- No two videos may share a comparison or fact.

Output ONLY valid JSON.`;

  const generalLine = (n, total) => {
    if (topic) return "";
    if (!allowGeneral) return `\nEvery video comes from the TOPIC POOLS — do not use the GENERAL pools in this batch.`;
    return n > 0
      ? `\nExactly ${n} of the ${total} video(s) must be GENERAL (category "general"): everyday fun facts with NOTHING to do with tech. The other ${total - n} come from the topic pools.`
      : `\nEvery video comes from the TOPIC POOLS — do not use the GENERAL pools in this batch.`;
  };
  const topicLine = topic
    ? `\nEVERY video must be about: "${topic}"${allowGeneral ? ` (use category "general" if that topic isn't tech/editing related)` : ""}.`
    : "\nRotate across the topic pools.";

  const diffInstruction = `${sharedBlocks}

You are generating ${DIFF_COUNT} "difference" video script(s) for ${cfg.brandName} (variant="difference").${generalLine(GENERAL_DIFF, DIFF_COUNT)}${topicLine}

Each video's segments array contains exactly 2 entries — two RELATED comparisons from the same topic family. Each segment compares its own A/B pair following the script formula from the profile EXACTLY — the renderer depends on the sentence structure. Use natural articles in the intro sentences.`;

  const dykInstruction = `${sharedBlocks}

You are generating ${DYK_COUNT} "didyouknow" video script(s) for ${cfg.brandName} (variant="didyouknow").${generalLine(GENERAL_DYK, DYK_COUNT)}${topicLine}

Each video has ONE segment: one genuinely surprising true fact.
- hook: MUST literally start with the words "${cfg.dykOpener}" — max 11 words total.
- The segment's introA = the FACT itself, one punchy sentence, max 16 words.
- The segment's defA = WHY/how it works, one sentence, max 16 words.
- aLabel = short display label; aSearchQuery + aImagePrompt for its single visual.
  Leave bLabel, introB, defB, bSearchQuery, bImagePrompt as empty strings.
- aSearchQuery doubles as a STOCK VIDEO search — prefer a scene with natural MOTION.
- outro: engagement question + "${cfg.outro}"`;

  return { diffInstruction, dykInstruction, DIFF_COUNT, DYK_COUNT, GENERAL_COUNT };
}
