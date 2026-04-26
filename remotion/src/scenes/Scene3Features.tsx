import { AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig } from "remotion";
import { loadFont } from "@remotion/google-fonts/SpaceGrotesk";
import { loadFont as loadNoto } from "@remotion/google-fonts/NotoSansArabic";

const { fontFamily: monoFont } = loadFont("normal", { weights: ["500"], subsets: ["latin"] });
const { fontFamily: arabicFont } = loadNoto("normal", { weights: ["500", "600"], subsets: ["arabic"] });

const features = [
  { icon: "✅", text: "مصممة باللغتين العربية والإنجليزية" },
  { icon: "✅", text: "قسم خاص لآراء أكبر المحللين الإعلاميين" },
  { icon: "✅", text: "خريطة تظهر أهم التحركات العسكرية وتايملاين لتتبع التطورات" },
];

const FeatureRow = ({ icon, text, delay }: { icon: string; text: string; delay: number }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const progress = spring({ frame, fps, config: { damping: 18, stiffness: 200 }, delay });
  const x = interpolate(progress, [0, 1], [-80, 0]);
  const opacity = interpolate(progress, [0, 1], [0, 1]);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 20,
        opacity,
        transform: `translateX(${x}px)`,
        padding: "18px 28px",
        borderRight: "3px solid #00B3B3",
        background: "linear-gradient(270deg, rgba(0,179,179,0.08), transparent)",
        direction: "rtl",
      }}
    >
      <span style={{ fontSize: 28, flexShrink: 0 }}>{icon}</span>
      <span
        style={{
          fontFamily: arabicFont,
          fontSize: 24,
          color: "white",
          fontWeight: 600,
          lineHeight: 1.5,
        }}
      >
        {text}
      </span>
    </div>
  );
};

export const Scene3Features = () => {
  const frame = useCurrentFrame();
  const titleOpacity = interpolate(frame, [0, 15], [0, 1], { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        paddingLeft: 160,
        paddingRight: 160,
      }}
    >
      <div
        style={{
          fontFamily: monoFont,
          fontSize: 13,
          color: "#00B3B3",
          letterSpacing: 6,
          textTransform: "uppercase",
          marginBottom: 40,
          opacity: titleOpacity,
          textAlign: "right",
        }}
      >
        Core Features — الميزات الأساسية
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        {features.map((f, i) => (
          <FeatureRow key={i} icon={f.icon} text={f.text} delay={i * 10 + 10} />
        ))}
      </div>
    </AbsoluteFill>
  );
};
