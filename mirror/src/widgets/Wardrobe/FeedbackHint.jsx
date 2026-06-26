// Thumbs up / down feedback targets (no emoji — inline SVG icons). These are
// real buttons so the mirror's existing pinch-to-click activates them; the
// gesture hints below describe the hands-free alternatives.
function ThumbUp() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 10v10M7 10l3.5-7a1.5 1.5 0 0 1 2.8 1L12 9h5a2 2 0 0 1 2 2.3l-1 6A2 2 0 0 1 16 19H7" />
    </svg>
  );
}
function ThumbDown() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6 rotate-180" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 10v10M7 10l3.5-7a1.5 1.5 0 0 1 2.8 1L12 9h5a2 2 0 0 1 2 2.3l-1 6A2 2 0 0 1 16 19H7" />
    </svg>
  );
}

export default function FeedbackHint({ onUp, onDown }) {
  return (
    <div className="mt-3 flex flex-col items-center gap-2">
      <span className="text-[11px] text-white/50">Do you like this outfit?</span>
      <div className="flex gap-4">
        <button
          type="button"
          onClick={onUp}
          aria-label="Like this outfit"
          className="flex items-center gap-2 rounded-lg border border-emerald-300/30 bg-emerald-400/10 px-4 py-2 text-emerald-200 hover:bg-emerald-400/20"
        >
          <ThumbUp />
          <span className="text-sm">Like</span>
        </button>
        <button
          type="button"
          onClick={onDown}
          aria-label="Dislike this outfit"
          className="flex items-center gap-2 rounded-lg border border-rose-300/30 bg-rose-400/10 px-4 py-2 text-rose-200 hover:bg-rose-400/20"
        >
          <ThumbDown />
          <span className="text-sm">Not for me</span>
        </button>
      </div>
    </div>
  );
}
