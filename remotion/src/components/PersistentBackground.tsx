import { AbsoluteFill, useCurrentFrame, interpolate } from "remotion";

export const PersistentBackground = () => {
  const frame = useCurrentFrame();
  const drift = interpolate(frame, [0, 300], [0, 40]);
  
  return (
    <AbsoluteFill style={{ backgroundColor: "#0f1729" }}>
      {/* Subtle grid pattern */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage: `
            linear-gradient(rgba(0,179,179,0.03) 1px, transparent 1px),
            linear-gradient(90deg, rgba(0,179,179,0.03) 1px, transparent 1px)
          `,
          backgroundSize: "60px 60px",
          transform: `translateY(${drift}px)`,
        }}
      />
      {/* Radial glow */}
      <div
        style={{
          position: "absolute",
          width: 800,
          height: 800,
          borderRadius: "50%",
          background: "radial-gradient(circle, rgba(0,179,179,0.08) 0%, transparent 70%)",
          top: "20%",
          left: "60%",
          transform: `translate(-50%, -50%) translate(${Math.sin(frame / 40) * 30}px, ${Math.cos(frame / 50) * 20}px)`,
        }}
      />
    </AbsoluteFill>
  );
};
