// XAI panel — why this outfit, tied to the current context. The reasoning text
// comes from the stylist model (or the local heuristic) per candidate.
export default function ReasoningCard({ reasoning, confidence, context }) {
  if (!reasoning) return null;
  const pct = typeof confidence === 'number' ? Math.round(confidence * 100) : null;
  return (
    <div className="mt-3 rounded-lg border border-white/10 bg-white/5 p-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wide text-white/40">Why this outfit</span>
        {pct !== null && <span className="text-[10px] text-white/40">{pct}% match</span>}
      </div>
      <p className="mt-1 text-sm leading-snug text-white/85">{reasoning}</p>
      {context && (
        <p className="mt-2 text-[11px] text-white/45">
          {[
            typeof context.temperature === 'number' ? `${Math.round(context.temperature)}°C` : null,
            context.weather,
            context.timeOfDay,
            context.season,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
    </div>
  );
}
