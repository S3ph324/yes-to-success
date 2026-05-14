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
