import { AlertTriangle, Inbox, WifiOff } from "lucide-react";
import { useLanguage } from "@/i18n/LanguageContext";
import { useSourceStatus, type SourceStatusEntry } from "@/hooks/useSourceStatus";

// An empty panel must never look identical to a broken one. Every panel routes
// its no-rows case through here, and the wording is decided by the real reason:
// the request failed, the collectors never ran, a source is unreachable, or the
// store is genuinely quiet.

//TUNE: Control the (failing sources listed). Failing source names named in an empty state before the rest are counted.
const MAX_NAMED_SOURCES = 3;

type Kind = "error" | "empty";

interface Props {
  kind: Kind;
  /** Panel-specific line for the genuinely-empty case. */
  emptyMessage?: string;
  /** Message shown when the request itself failed. */
  errorMessage?: string;
  /** Limit the source diagnostic to one collector, "rss" or "telegram". */
  scope?: "rss" | "telegram";
}

function sourceLabel(entry: SourceStatusEntry): string {
  return entry.label?.trim() || entry.id;
}

export const PanelEmptyState = ({ kind, emptyMessage, errorMessage, scope }: Props) => {
  const { t } = useLanguage();
  const { data, isError: statusUnavailable } = useSourceStatus();

  const scoped = scope
    ? (data?.sources ?? []).filter((s) => s.source === scope)
    : (data?.sources ?? []);
  const failing = scoped.filter((s) => !s.ok);
  const stale = scoped.filter((s) => s.ok && s.stale);

  // The panel request failed. That is the panel's own state and it outranks
  // whatever the collectors are doing.
  if (kind === "error") {
    return (
      <Shell icon={<WifiOff className="h-5 w-5" />} tone="critical">
        <Headline>{errorMessage ?? t("state.panelOffline")}</Headline>
        <Detail>{t("state.panelOfflineHint")}</Detail>
      </Shell>
    );
  }

  // No rows. Say which of the four reasons it is, in order of what the operator
  // has to fix first.
  if (statusUnavailable) {
    return (
      <Shell icon={<AlertTriangle className="h-5 w-5" />} tone="warning">
        <Headline>{t("state.statusUnknown")}</Headline>
        <Detail>{t("state.statusUnknownHint")}</Detail>
      </Shell>
    );
  }

  if (data && !data.workers_reported) {
    return (
      <Shell icon={<AlertTriangle className="h-5 w-5" />} tone="warning">
        <Headline>{t("state.collectorsNeverRan")}</Headline>
        <Detail>{t("state.collectorsNeverRanHint")}</Detail>
      </Shell>
    );
  }

  if (scoped.length > 0 && failing.length === scoped.length) {
    return (
      <Shell icon={<WifiOff className="h-5 w-5" />} tone="critical">
        <Headline>{t("state.allSourcesDown")}</Headline>
        <Detail>{describe(failing)}</Detail>
      </Shell>
    );
  }

  return (
    <Shell icon={<Inbox className="h-5 w-5" />} tone="muted">
      <Headline>{emptyMessage ?? t("state.noDataYet")}</Headline>
      <Detail>{t("state.noDataYetHint")}</Detail>
      {failing.length > 0 && (
        <Detail tone="warning">
          {t("state.someSourcesDown")} {describe(failing)}
        </Detail>
      )}
      {failing.length === 0 && stale.length > 0 && (
        <Detail tone="warning">
          {t("state.sourcesStale")} {describe(stale)}
        </Detail>
      )}
    </Shell>
  );
};

function describe(entries: SourceStatusEntry[]): string {
  const named = entries.slice(0, MAX_NAMED_SOURCES).map(sourceLabel);
  const rest = entries.length - named.length;
  const list = named.join(", ");
  return rest > 0 ? `${list} +${rest}` : list;
}

const TONE_CLASS: Record<string, string> = {
  critical: "text-severity-critical",
  warning: "text-severity-high",
  muted: "text-muted-foreground",
};

const Shell = ({
  icon,
  tone,
  children,
}: {
  icon: React.ReactNode;
  tone: keyof typeof TONE_CLASS;
  children: React.ReactNode;
}) => (
  <div className="flex flex-col items-center justify-center gap-1.5 px-4 py-8 text-center">
    <span className={TONE_CLASS[tone]}>{icon}</span>
    {children}
  </div>
);

const Headline = ({ children }: { children: React.ReactNode }) => (
  <p className="text-xs font-mono font-bold uppercase tracking-wider">{children}</p>
);

const Detail = ({
  children,
  tone = "muted",
}: {
  children: React.ReactNode;
  tone?: keyof typeof TONE_CLASS;
}) => (
  <p className={`text-[10px] font-mono max-w-xs leading-relaxed ${TONE_CLASS[tone]}`}>
    {children}
  </p>
);
