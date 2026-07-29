import "./index.css";
import { Composition } from "remotion";
import { HelloWorld, myCompSchema } from "./HelloWorld";
import { Logo, myCompSchema2 } from "./HelloWorld/Logo";
import {
  QuoteCard,
  quoteCardSchema,
  calcMetaQuoteCard,
} from "./QuoteCard/QuoteCard";
import {
  ImageQuoteCard,
  imageQuoteCardSchema,
  calcMetaImageQuoteCard,
} from "./QuoteCard/ImageQuoteCard";
import {
  BoldQuoteCard,
  boldQuoteCardSchema,
  calcMetaBoldQuoteCard,
} from "./QuoteCard/BoldQuoteCard";
import {
  JurieQuoteCard,
  jurieQuoteCardSchema,
  calcMetaJurieQuoteCard,
} from "./QuoteCard/JurieQuoteCard";
import {
  ProductShowcaseCard,
  productShowcaseCardSchema,
  calcMetaProductShowcaseCard,
} from "./QuoteCard/ProductShowcaseCard";
import {
  ShopListingCard,
  shopListingCardSchema,
  calcMetaShopListingCard,
} from "./QuoteCard/ShopListingCard";
import {
  FeatureInfographicCard,
  featureInfographicCardSchema,
  calcMetaFeatureInfographicCard,
} from "./QuoteCard/FeatureInfographicCard";
import {
  BrandCard,
  brandCardSchema,
  calcMetaBrandCard,
} from "./QuoteCard/BrandCard";
import {
  AdviceCard,
  adviceCardSchema,
  calcMetaAdviceCard,
} from "./QuoteCard/AdviceCard";
import {
  TweetCard,
  tweetCardSchema,
  calcMetaTweetCard,
} from "./QuoteCard/TweetCard";
import {
  PhotoTweetCard,
  photoTweetCardSchema,
  calcMetaPhotoTweetCard,
} from "./QuoteCard/PhotoTweetCard";
import {
  QuotePortraitCard,
  quotePortraitCardSchema,
  calcMetaQuotePortraitCard,
} from "./QuoteCard/QuotePortraitCard";
import { AppIcon, appIconSchema } from "./AppIcon/AppIcon";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="QuoteCard"
        component={QuoteCard}
        durationInFrames={90}
        fps={30}
        width={1080}
        height={1350}
        schema={quoteCardSchema}
        calculateMetadata={calcMetaQuoteCard}
        defaultProps={{
          quote: "Love is the most powerful money magnet in the world!",
          signoff: "— John Calub",
          subtitle: "Philippines' #1 Success Coach",
          theme: "money" as const,
          aspectRatio: "4:5" as const,
          logoSrc: "yes-to-success-logo.png",
          brandPrimary: "#C8001E",
          brandDeep: "#3A0008",
          brandAccent: "#FFE17A",
          brandAccentDeep: "#C9952B",
          url: "JOHNCALUBTRAINING.COM",
        }}
      />

      <Composition
        id="ImageQuoteCard"
        component={ImageQuoteCard}
        durationInFrames={90}
        fps={30}
        width={1080}
        height={1350}
        schema={imageQuoteCardSchema}
        calculateMetadata={calcMetaImageQuoteCard}
        defaultProps={{
          quote:
            "Stop chasing money. Become the kind of person money chases.",
          signoff: "— John Calub",
          subtitle: "Philippines' #1 Success Coach",
          bgSrc: "",
          aspectRatio: "4:5" as const,
          logoSrc: "yes-to-success-logo.png",
          brandAccent: "#FFE17A",
          brandAccentDeep: "#C9952B",
          url: "JOHNCALUBTRAINING.COM",
        }}
      />

      <Composition
        id="BoldQuoteCard"
        component={BoldQuoteCard}
        durationInFrames={90}
        fps={30}
        width={1080}
        height={1350}
        schema={boldQuoteCardSchema}
        calculateMetadata={calcMetaBoldQuoteCard}
        defaultProps={{
          quote: "Your bank account is the report card of your mindset.",
          keyword: "MINDSET",
          signoff: "— John Calub",
          subtitle: "Philippines' #1 Success Coach",
          aspectRatio: "4:5" as const,
          logoSrc: "yes-to-success-logo.png",
          brandPrimary: "#0F0F12",
          brandAccent: "#FFE17A",
          brandAccentDeep: "#C9952B",
          brandRed: "#C8001E",
          url: "JOHNCALUBTRAINING.COM",
        }}
      />

      <Composition
        id="JurieQuoteCard"
        component={JurieQuoteCard}
        durationInFrames={90}
        fps={30}
        width={1080}
        height={1350}
        schema={jurieQuoteCardSchema}
        calculateMetadata={calcMetaJurieQuoteCard}
        defaultProps={{
          topLines: [[{ t: "NAG-OPEN", s: "w" as const }, { t: "KA", s: "w" as const }, { t: "NGA…", s: "w" as const }]],
          bottomLines: [
            [
              { t: "PERO", s: "rb" as const },
              { t: "SINO", s: "w" as const },
              { t: "BANG", s: "w" as const },
              { t: "MAY", s: "w" as const },
              { t: "ALAM", s: "g" as const },
              { t: "NA", s: "w" as const },
              { t: "OPEN", s: "r" as const },
              { t: "KA?", s: "w" as const },
            ],
          ],
          quote: "Nag-open ka nga… pero sino bang may alam na open ka?",
          keyword: "ALAM",
          ctaComment: "MENTOR",
          ctaTail: "LEARN HOW",
          bgSrc: "",
          aspectRatio: "4:5" as const,
          brandGold: "#F5C13B",
          brandGoldLight: "#FFE27A",
          brandGoldDeep: "#C7902A",
          brandRed: "#E11522",
          headlineFont: "",
        }}
      />

      <Composition
        id="ProductShowcaseCard"
        component={ProductShowcaseCard}
        durationInFrames={90}
        fps={30}
        width={1080}
        height={1350}
        schema={productShowcaseCardSchema}
        calculateMetadata={calcMetaProductShowcaseCard}
        defaultProps={{
          productLine: "Aria Round — Tortoise",
          tagline: "Your everyday pair, elevated.",
          ctaTag: "SHOP NOW",
          headline: "",
          layout: "bottom" as const,
          stylePreset: "",
          busyTop: 0.75,
          busyBottom: 0.75,
          promoTag: "",
          bgSrc: "",
          aspectRatio: "4:5" as const,
          brandGold: "#F5C13B",
          brandRed: "#E11522",
          logoSrc: "",
          logoPosition: "top-right" as const,
          logoSize: 0.085,
        }}
      />

      <Composition
        id="ShopListingCard"
        component={ShopListingCard}
        durationInFrames={60}
        fps={30}
        width={1080}
        height={1080}
        schema={shopListingCardSchema}
        calculateMetadata={calcMetaShopListingCard}
        defaultProps={{
          photoSrc: "",
          cardType: "hero" as const,
          specs: [],
          productName: "",
          colorLabel: "",
          materialLabel: "",
          featureLine: "",
          brandName: "Tranzzie Eyeglasses",
          establishedTag: "SINCE 2019",
          pills: ["Premium Build", "Fashion Forward", "Everyday Comfort"],
          logoSrc: "",
          logoDarkSrc: "",
          brandGold: "#F4B400",
          brandRed: "#E11522",
          aspectRatio: "1:1" as const,
        }}
      />

      <Composition
        id="FeatureInfographicCard"
        component={FeatureInfographicCard}
        durationInFrames={60}
        fps={30}
        width={1080}
        height={1080}
        schema={featureInfographicCardSchema}
        calculateMetadata={calcMetaFeatureInfographicCard}
        defaultProps={{
          photoSrc: "",
          specs: [],
          productName: "",
          claimLine: "",
          brandName: "Tranzzie Eyeglasses",
          logoSrc: "",
          brandGold: "#F4B400",
          focusX: 0.46,
          focusY: 0.4,
          aspectRatio: "1:1" as const,
        }}
      />

      <Composition
        id="BrandCard"
        component={BrandCard}
        durationInFrames={60}
        fps={30}
        width={1080}
        height={1350}
        schema={brandCardSchema}
        calculateMetadata={calcMetaBrandCard}
        defaultProps={{
          photoSrc: "",
          tagline: "See clearly. Live boldly.",
          productName: "",
          logoSrc: "",
          showLogo: true,
          layout: "minimal" as const,
          layoutSpec: null,
          brandGold: "#F4B400",
          brandName: "Tranzzie Eyeglasses",
          establishedTag: "SINCE 2019",
          aspectRatio: "4:5" as const,
        }}
      />

      <Composition
        id="AdviceCard"
        component={AdviceCard}
        durationInFrames={90}
        fps={30}
        width={1080}
        height={1350}
        schema={adviceCardSchema}
        calculateMetadata={calcMetaAdviceCard}
        defaultProps={{
          handle: "@learnwithjurie",
          avatarSrc: "",
          hook: "Hindi mo kailangan mag-overtime para kumita.",
          lines: [
            "I-automate ang paulit-ulit na gawain.",
            "Gamitin ang AI para sa drafts at replies.",
            "Mag-focus sa trabahong tao lang ang kaya.",
          ],
          payoff: "Trabahong tama, hindi trabahong dami.",
          seriesLabel: "Working Smart",
          dayNumber: 12,
          url: "learnwithjurie.it.com",
          theme: "dark" as const,
          brandGold: "#F5C13B",
          brandRed: "#E11522",
          aspectRatio: "4:5" as const,
        }}
      />

      <Composition
        id="TweetCard"
        component={TweetCard}
        durationInFrames={90}
        fps={30}
        width={1080}
        height={1350}
        schema={tweetCardSchema}
        calculateMetadata={calcMetaTweetCard}
        defaultProps={{
          displayName: "Jurie",
          handle: "@learnwithjurie",
          avatarSrc: "",
          verified: true,
          body: "Ang AI hindi pamalit sa'yo. Pamalit siya sa trabahong nakakapagod na ginagawa mo gabi-gabi. Gamitin mo, para may oras ka na rin.",
          timestamp: "9:41 AM · Jun 17, 2026",
          replies: "",
          reposts: "",
          likes: "",
          cardTheme: "light" as const,
          backdrop: "clean" as const,
          brandGold: "#F5C13B",
          brandRed: "#E11522",
          aspectRatio: "4:5" as const,
        }}
      />

      <Composition
        id="PhotoTweetCard"
        component={PhotoTweetCard}
        durationInFrames={90}
        fps={30}
        width={1080}
        height={1350}
        schema={photoTweetCardSchema}
        calculateMetadata={calcMetaPhotoTweetCard}
        defaultProps={{
          bgSrc: "",
          displayName: "Jurie Cata Villarde",
          handle: "@learnwithjurie",
          avatarSrc: "",
          verified: true,
          body: "Minsan ang tunay na kahirapan ay yung hindi marunong tumanggap ng correction.",
          accent: "correction",
          brandGold: "#F5C13B",
          brandRed: "#E11522",
          aspectRatio: "4:5" as const,
        }}
      />

      <Composition
        id="QuotePortraitCard"
        component={QuotePortraitCard}
        durationInFrames={90}
        fps={30}
        width={1080}
        height={1350}
        schema={quotePortraitCardSchema}
        calculateMetadata={calcMetaQuotePortraitCard}
        defaultProps={{
          bgSrc: "",
          body: "Gawin mo na. Kasi pagdating ng panahon, mas masakit ang sana kaysa sa pagod.",
          accent: "sana",
          handle: "@learnwithjurie",
          logoSrc: "",
          brandGold: "#F5C13B",
          aspectRatio: "4:5" as const,
        }}
      />

      <Composition
        id="AppIcon"
        component={AppIcon}
        durationInFrames={1}
        fps={1}
        width={1024}
        height={1024}
        schema={appIconSchema}
        defaultProps={{
          logoSrc: "yes-to-success-logo.png",
          brandPrimary: "#C8001E",
          brandDeep: "#3A0008",
          brandAccent: "#FFE17A",
          brandAccentDeep: "#C9952B",
        }}
      />

      <Composition
        id="HelloWorld"
        component={HelloWorld}
        durationInFrames={150}
        fps={30}
        width={1920}
        height={1080}
        schema={myCompSchema}
        defaultProps={{
          titleText: "Welcome to Remotion",
          titleColor: "#000000",
          logoColor1: "#91EAE4",
          logoColor2: "#86A8E7",
        }}
      />

      <Composition
        id="OnlyLogo"
        component={Logo}
        durationInFrames={150}
        fps={30}
        width={1920}
        height={1080}
        schema={myCompSchema2}
        defaultProps={{
          logoColor1: "#91dAE2" as const,
          logoColor2: "#86A8E7" as const,
        }}
      />
    </>
  );
};
