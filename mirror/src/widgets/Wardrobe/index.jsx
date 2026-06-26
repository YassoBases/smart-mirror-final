// Wardrobe widget shell. Owns the session state machine (useWardrobeSession),
// wires the hands-free gestures (gestureMap), and renders the right view per
// state. On-screen buttons are real <button>s so the mirror's existing
// pinch-to-click drives next/try-on/feedback; the open-palm/fist/swipe gestures
// are the hands-free alternatives.
import { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

import { useWardrobeSession, STATES } from './useWardrobeSession';
import { createGestureRecognizer } from './gestureMap';
import OutfitBoard from './OutfitBoard';
import GeneratedBoard from './GeneratedBoard';
import VtonView from './VtonView';
import ReasoningCard from './ReasoningCard';
import FeedbackHint from './FeedbackHint';

const OCCASIONS = ['any', 'casual', 'smart casual', 'business', 'formal', 'sport', 'party'];

export default function WardrobeWidget() {
  const { state, current, index, candidates, itemsById, context, renderUrl, fromCache, error, occasion, mode, actions } =
    useWardrobeSession();
  const isGenerated = mode === 'generated';

  // Bind hands-free gestures to actions; only active gestures fire per state.
  useEffect(() => {
    const unsub = createGestureRecognizer({
      enabled: () => true,
      onInvoke: () => {
        if (state === STATES.IDLE) actions.invoke();
      },
      onNext: () => {
        if (state === STATES.BOARD) actions.nextOutfit();
      },
      onDismiss: () => {
        if (state !== STATES.IDLE) actions.dismiss();
      },
    });
    return unsub;
  }, [state, actions]);

  const showBoard = [STATES.BOARD, STATES.RENDERING, STATES.VTON, STATES.FEEDBACK].includes(state);
  const showVton = [STATES.RENDERING, STATES.VTON, STATES.FEEDBACK].includes(state);

  return (
    <div className="relative w-full h-full rounded-xl bg-black/40 backdrop-blur-sm text-white p-4 flex flex-col select-none">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium tracking-wide">Wardrobe</h2>
        {state !== STATES.IDLE && (
          <button
            type="button"
            onClick={actions.dismiss}
            className="text-xs text-white/50 hover:text-white/80"
          >
            Close
          </button>
        )}
      </div>

      <div className="relative flex-1 mt-3">
        {state === STATES.IDLE && (
          <div className="h-full flex flex-col items-center justify-center gap-3 text-center">
            <p className="text-sm text-white/70">Pick an occasion, then style from your closet or generate a new look.</p>
            <div className="flex flex-wrap items-center justify-center gap-1.5 max-w-[18rem]">
              {OCCASIONS.map((o) => (
                <button
                  key={o}
                  type="button"
                  onClick={() => actions.setOccasion(o)}
                  className={`rounded-full px-2.5 py-1 text-[11px] border ${
                    occasion === o
                      ? 'border-white/60 bg-white/20 text-white'
                      : 'border-white/15 bg-white/5 text-white/60 hover:bg-white/10'
                  }`}
                >
                  {o}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                onClick={actions.invoke}
                className="rounded-lg border border-white/20 bg-white/10 px-4 py-2 text-sm hover:bg-white/20"
              >
                From my closet
              </button>
              <button
                type="button"
                onClick={actions.generate}
                className="rounded-lg border border-fuchsia-300/30 bg-fuchsia-400/10 px-4 py-2 text-sm text-fuchsia-100 hover:bg-fuchsia-400/20"
              >
                Generate new outfit
              </button>
            </div>
            <p className="text-[11px] text-white/40">Or hold an open palm to the mirror</p>
            {error && <p className="text-[11px] text-rose-300/80">{error}</p>}
          </div>
        )}

        {state === STATES.LOADING && (
          <div className="h-full flex flex-col items-center justify-center gap-3 text-white/80">
            <div className="h-8 w-8 rounded-full border-2 border-white/30 border-t-white animate-spin" />
            <span className="text-sm">Choosing an outfit…</span>
          </div>
        )}

        {showBoard && current && (
          <div className="h-full flex flex-col overflow-y-auto">
            <AnimatePresence mode="wait">
              {isGenerated ? (
                <GeneratedBoard
                  key={index}
                  candidate={current}
                  index={index}
                  total={candidates.length}
                />
              ) : (
                <OutfitBoard
                  key={index}
                  candidate={current}
                  itemsById={itemsById}
                  index={index}
                  total={candidates.length}
                />
              )}
            </AnimatePresence>

            <ReasoningCard
              reasoning={current.reasoning}
              confidence={current.confidence}
              context={context}
            />

            {state === STATES.BOARD && (
              <div className="mt-auto pt-3 flex gap-2">
                <button
                  type="button"
                  onClick={actions.nextOutfit}
                  disabled={candidates.length < 2}
                  className="flex-1 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/15 disabled:opacity-40"
                >
                  Next
                </button>
                {isGenerated ? (
                  <>
                    <button
                      type="button"
                      onClick={actions.feedbackDown}
                      className="rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/15"
                    >
                      👎
                    </button>
                    <button
                      type="button"
                      onClick={actions.feedbackUp}
                      className="rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/15"
                    >
                      👍
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={actions.renderVton}
                    className="flex-1 rounded-lg border border-sky-300/30 bg-sky-400/10 px-3 py-2 text-sm text-sky-100 hover:bg-sky-400/20"
                  >
                    Try it on
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        <AnimatePresence>
          {showVton && (
            <VtonView
              renderUrl={renderUrl}
              fromCache={fromCache}
              loading={state === STATES.RENDERING}
              onReady={actions.markVtonReady}
            />
          )}
        </AnimatePresence>

        {/* Feedback targets sit above the VTON overlay so pinch-click reaches them. */}
        {state === STATES.FEEDBACK && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="absolute bottom-2 left-0 right-0 z-10"
          >
            <FeedbackHint onUp={actions.feedbackUp} onDown={actions.feedbackDown} />
          </motion.div>
        )}
      </div>
    </div>
  );
}
