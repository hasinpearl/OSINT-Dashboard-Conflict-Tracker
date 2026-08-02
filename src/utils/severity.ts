// Severity values may arrive translated — match both English and Arabic.
const SEVERITY_MAP: Record<string, string> = {
  critical: "critical", high: "high", developing: "developing", verified: "verified", info: "info",
  "حرج": "critical", "عالي": "high", "قيد التطور": "developing", "موثق": "verified", "تم التحقق": "verified", "معلومات": "info",
};

export const normSeverity = (s: string): string =>
  SEVERITY_MAP[s?.toLowerCase?.()] ?? SEVERITY_MAP[s] ?? "info";
