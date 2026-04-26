import { AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig } from "remotion";
import { loadFont } from "@remotion/google-fonts/SpaceGrotesk";
import { loadFont as loadNoto } from "@remotion/google-fonts/NotoSansArabic";

const { fontFamily: monoFont } = loadFont("normal", { weights: ["500", "700"], subsets: ["latin"] });
const { fontFamily: arabicFont } = loadNoto("normal", { weights: ["600", "700"], subsets: ["arabic"] });

export const Scene1Intro = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const lineScale = spring({ frame, fps, config: { damping: 200 }, delay: 5 });
  const lineWidth = interpolate(lineScale, [0, 1], [0, 500]);

  const pulseOpacity = interpolate(Math.sin(frame / 8), [-1, 1], [0.4, 1]);

  const liveOpacity = interpolate(frame, [8, 20], [0, 1], { extrapolateRight: "clamp" });

  const titleOpacity = interpolate(frame, [15, 30], [0, 1], { extrapolateRight: "clamp" });
  const titleY = interpolate(
    spring({ frame, fps, config: { damping: 20, stiffness: 180 }, delay: 15 }),
    [0, 1], [50, 0]
  );

  const arabicOpacity = interpolate(frame, [35, 55], [0, 1], { extrapolateRight: "clamp" });
  const arabicY = interpolate(
    spring({ frame, fps, config: { damping: 20, stiffness: 150 }, delay: 35 }),
    [0, 1], [40, 0]
  );

  const subOpacity = interpolate(frame, [60, 80], [0, 1], { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
      {/* Teal accent line */}
      <div
        style={{
          width: lineWidth,
          height: 2,
          backgroundColor: "#00B3B3",
          marginBottom: 30,
          boxShadow: "0 0 20px rgba(0,179,179,0.5)",
        }}
      />
      {/* Live indicator */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            backgroundColor: "#00B3B3",
            opacity: pulseOpacity,
            boxShadow: "0 0 12px rgba(0,179,179,0.8)",
          }}
        />
        <span
          style={{
            fontFamily: monoFont,
            fontSize: 14,
            color: "#00B3B3",
            letterSpacing: 6,
            textTransform: "uppercase",
            opacity: liveOpacity,
          }}
        >
          BETA LAUNCH
        </span>
      </div>
      {/* Title */}
      <h1
        style={{
          fontFamily: monoFont,
          fontSize: 52,
          fontWeight: 700,
          color: "white",
          opacity: titleOpacity,
          transform: `translateY(${titleY}px)`,
          letterSpacing: 6,
          textAlign: "center",
        }}
      >
        Current Developments Dashboard
      </h1>
      {/* Arabic announcement */}
      <p
        style={{
          fontFamily: arabicFont,
          fontSize: 32,
          color: "rgba(255,255,255,0.85)",
          opacity: arabicOpacity,
          transform: `translateY(${arabicY}px)`,
          marginTop: 24,
          textAlign: "center",
          direction: "rtl",
          lineHeight: 1.6,
          maxWidth: 1200,
          fontWeight: 600,
        }}
      >
        تم إطلاق النسخة التجريبية لمتابعة الأحداث الإقليمية عبر المصادر العلنية
      </p>
      {/* Subtitle */}
      <p
        style={{
          fontFamily: monoFont,
          fontSize: 16,
          color: "rgba(0,179,179,0.7)",
          opacity: subOpacity,
          marginTop: 16,
          letterSpacing: 4,
          textTransform: "uppercase",
        }}
      >
        Iran & Middle East Conflict Tracker
      </p>
    </AbsoluteFill>
  );
};
