import { AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig } from "remotion";
import { loadFont } from "@remotion/google-fonts/SpaceGrotesk";
import { loadFont as loadNoto } from "@remotion/google-fonts/NotoSansArabic";

const { fontFamily: monoFont } = loadFont("normal", { weights: ["500", "700"], subsets: ["latin"] });
const { fontFamily: arabicFont } = loadNoto("normal", { weights: ["700"], subsets: ["arabic"] });

export const Scene6CTA = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const scale = interpolate(
    spring({ frame, fps, config: { damping: 15, stiffness: 100 }, delay: 5 }),
    [0, 1], [0.8, 1]
  );
  const opacity = interpolate(frame, [5, 25], [0, 1], { extrapolateRight: "clamp" });

  const lineWidth = interpolate(
    spring({ frame, fps, config: { damping: 200 }, delay: 20 }),
    [0, 1], [0, 400]
  );

  const urlOpacity = interpolate(frame, [30, 45], [0, 1], { extrapolateRight: "clamp" });

  const arabicOpacity = interpolate(frame, [40, 55], [0, 1], { extrapolateRight: "clamp" });

  const glowIntensity = interpolate(Math.sin(frame / 10), [-1, 1], [0.3, 0.7]);

  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
      <div
        style={{
          opacity,
          transform: `scale(${scale})`,
          textAlign: "center",
        }}
      >
        <h2
          style={{
            fontFamily: monoFont,
            fontSize: 64,
            color: "white",
            fontWeight: 700,
            letterSpacing: 4,
            marginBottom: 20,
            textShadow: `0 0 40px rgba(0,179,179,${glowIntensity})`,
          }}
        >
          USIRIS
        </h2>
        <div
          style={{
            width: lineWidth,
            height: 2,
            backgroundColor: "#00B3B3",
            margin: "0 auto 24px",
            boxShadow: "0 0 20px rgba(0,179,179,0.5)",
          }}
        />
        <p
          style={{
            fontFamily: arabicFont,
            fontSize: 28,
            color: "rgba(255,255,255,0.8)",
            opacity: arabicOpacity,
            direction: "rtl",
            marginBottom: 30,
            fontWeight: 700,
          }}
        >
          متاحة للجميع الآن
        </p>
        <p
          style={{
            fontFamily: monoFont,
            fontSize: 22,
            color: "#00B3B3",
            opacity: urlOpacity,
            letterSpacing: 2,
          }}
        >
          usiris.hessa.space
        </p>
      </div>

      <div
        style={{
          position: "absolute",
          bottom: 50,
          fontFamily: monoFont,
          fontSize: 11,
          color: "rgba(255,255,255,0.2)",
          letterSpacing: 3,
        }}
      >
        © 2025 HESSA ALHAMMADI
      </div>
    </AbsoluteFill>
  );
};
