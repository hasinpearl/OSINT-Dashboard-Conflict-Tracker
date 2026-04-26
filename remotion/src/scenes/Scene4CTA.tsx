import { AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig } from "remotion";
import { loadFont } from "@remotion/google-fonts/SpaceGrotesk";
import { loadFont as loadOutfit } from "@remotion/google-fonts/Outfit";

const { fontFamily: monoFont } = loadFont("normal", { weights: ["500"], subsets: ["latin"] });
const { fontFamily: sansFont } = loadOutfit("normal", { weights: ["700"], subsets: ["latin"] });

export const Scene4CTA = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const scale = interpolate(
    spring({ frame, fps, config: { damping: 15, stiffness: 100 }, delay: 5 }),
    [0, 1], [0.8, 1]
  );
  const opacity = interpolate(frame, [5, 25], [0, 1], { extrapolateRight: "clamp" });

  const urlOpacity = interpolate(frame, [30, 45], [0, 1], { extrapolateRight: "clamp" });

  const lineWidth = interpolate(
    spring({ frame, fps, config: { damping: 200 }, delay: 20 }),
    [0, 1], [0, 300]
  );

  // Subtle breathing glow
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
            fontFamily: sansFont,
            fontSize: 56,
            color: "white",
            fontWeight: 700,
            letterSpacing: 2,
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
            fontFamily: monoFont,
            fontSize: 16,
            color: "rgba(255,255,255,0.5)",
            letterSpacing: 4,
            textTransform: "uppercase",
            marginBottom: 40,
          }}
        >
          Autonomous Intelligence Platform
        </p>
        <p
          style={{
            fontFamily: monoFont,
            fontSize: 20,
            color: "#00B3B3",
            opacity: urlOpacity,
            letterSpacing: 2,
          }}
        >
          usiris.hessa.space
        </p>
      </div>

      {/* Footer line */}
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
        © 2026 HESSA ALHAMMADI
      </div>
    </AbsoluteFill>
  );
};
