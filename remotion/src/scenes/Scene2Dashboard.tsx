import { AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig, Img, staticFile } from "remotion";
import { loadFont } from "@remotion/google-fonts/SpaceGrotesk";

const { fontFamily: monoFont } = loadFont("normal", { weights: ["500"], subsets: ["latin"] });

export const Scene2Dashboard = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Dashboard image scales up and slides in
  const imgScale = interpolate(
    spring({ frame, fps, config: { damping: 30, stiffness: 120 } }),
    [0, 1], [1.15, 1]
  );
  const imgOpacity = interpolate(frame, [0, 20], [0, 1], { extrapolateRight: "clamp" });

  // Slow pan effect
  const panX = interpolate(frame, [0, 110], [0, -30]);
  const panY = interpolate(frame, [0, 110], [10, -10]);

  // Scan line effect
  const scanY = interpolate(frame, [20, 80], [-100, 1200], { extrapolateRight: "clamp" });
  const scanOpacity = interpolate(frame, [20, 25, 75, 80], [0, 0.6, 0.6, 0], { extrapolateRight: "clamp" });

  // Corner brackets appear
  const bracketOpacity = interpolate(frame, [15, 30], [0, 1], { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
      {/* Dashboard screenshot with frame */}
      <div
        style={{
          position: "relative",
          width: 1600,
          height: 900,
          overflow: "hidden",
          borderRadius: 8,
          border: "1px solid rgba(0,179,179,0.3)",
          boxShadow: "0 0 60px rgba(0,179,179,0.15), 0 20px 60px rgba(0,0,0,0.5)",
          opacity: imgOpacity,
        }}
      >
        <Img
          src={staticFile("images/dashboard.png")}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            transform: `scale(${imgScale}) translate(${panX}px, ${panY}px)`,
          }}
        />
        {/* Scan line */}
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: scanY,
            height: 2,
            background: "linear-gradient(90deg, transparent, rgba(0,179,179,0.8), transparent)",
            opacity: scanOpacity,
            boxShadow: "0 0 30px rgba(0,179,179,0.5)",
          }}
        />
        {/* Corner brackets */}
        {[
          { top: 0, left: 0, borderTop: "2px solid #00B3B3", borderLeft: "2px solid #00B3B3" },
          { top: 0, right: 0, borderTop: "2px solid #00B3B3", borderRight: "2px solid #00B3B3" },
          { bottom: 0, left: 0, borderBottom: "2px solid #00B3B3", borderLeft: "2px solid #00B3B3" },
          { bottom: 0, right: 0, borderBottom: "2px solid #00B3B3", borderRight: "2px solid #00B3B3" },
        ].map((style, i) => (
          <div
            key={i}
            style={{
              position: "absolute",
              width: 30,
              height: 30,
              opacity: bracketOpacity,
              ...style,
            }}
          />
        ))}
      </div>

      {/* Label */}
      <div
        style={{
          position: "absolute",
          bottom: 60,
          fontFamily: monoFont,
          fontSize: 13,
          color: "rgba(0,179,179,0.7)",
          letterSpacing: 4,
          textTransform: "uppercase",
          opacity: interpolate(frame, [40, 55], [0, 1], { extrapolateRight: "clamp" }),
        }}
      >
        Real-Time Intelligence Dashboard
      </div>
    </AbsoluteFill>
  );
};
