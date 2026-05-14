export type BrandPreset = {
  id: string;
  name: string;
  logoSrc: string;
  brandPrimary: string;
  brandDeep: string;
  brandAccent: string;
  brandAccentDeep: string;
  url: string;
  signoff: string;
  subtitle: string;
};

export type Brief = {
  id: string;
  name: string;
  topics: string[];
  voiceNotes: string;
  bannedPhrases: string[];
  activeCampaigns: string;
};

export type Character = {
  id: string;
  name: string;
  role: string;
  tags: string[];
  photos: string[];
  enabled: boolean;
};

export type Variant = "classic" | "image" | "bold";
export type Aspect = "1:1" | "4:5" | "9:16";

export type QuoteEntry = {
  quote: string;
  caption: string;
  theme: string;
  variant: Variant;
  aspectRatio: Aspect;
  bgPrompt?: string;
  keyword?: string;
  bgPath?: string;
};

export type BatchCard = QuoteEntry & {
  file: string;
  index: number;
  approved?: boolean;
  rejected?: boolean;
  scheduled?: boolean;
  posted?: boolean;
  failed?: boolean;
  scheduledAt?: string;
  postedAt?: string;
  fbPostId?: string;
  fbUrl?: string;
};

export type Batch = {
  stamp: string;
  cards: BatchCard[];
  count: number;
  brandPresetId?: string;
  briefId?: string;
};
