// Full virtual try-on render. While the render is in flight the OutfitBoard stays
// visible underneath (this component is an overlay), so the screen is never empty.
import { motion } from 'framer-motion';

export default function VtonView({ renderUrl, loading, fromCache, onReady }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="absolute inset-0 rounded-xl bg-black/70 backdrop-blur-sm flex items-center justify-center"
    >
      {renderUrl ? (
        <div className="relative h-full w-full flex items-center justify-center">
          <img
            src={renderUrl}
            alt="Virtual try-on"
            className="max-h-full max-w-full object-contain rounded-lg"
            onLoad={onReady}
          />
          {fromCache && (
            <span className="absolute top-2 right-2 text-[10px] text-white/50">cached</span>
          )}
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 text-white/80">
          <div className="h-8 w-8 rounded-full border-2 border-white/30 border-t-white animate-spin" />
          <span className="text-sm">{loading ? 'Rendering your outfit…' : 'Preparing render…'}</span>
        </div>
      )}
    </motion.div>
  );
}
