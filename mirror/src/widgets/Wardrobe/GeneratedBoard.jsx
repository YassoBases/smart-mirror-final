// Board for GENERATED outfit ideas (not from the closet). Each item carries its
// own AI image (imageUrl) + description; falls back to a labelled placeholder
// when image generation is unavailable.
import { motion } from 'framer-motion';

function GenTile({ item }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="h-28 w-full rounded-lg bg-white/10 overflow-hidden flex items-center justify-center">
        {item.imageUrl ? (
          <img
            src={item.imageUrl}
            alt={item.description || item.category}
            className="h-full object-contain"
          />
        ) : (
          <span className="text-[11px] text-white/40 capitalize px-1 text-center">
            {item.subcategory || item.category}
          </span>
        )}
      </div>
      <span className="text-[11px] text-white/60 text-center line-clamp-2">
        {item.description || item.subcategory || item.category}
      </span>
    </div>
  );
}

export default function GeneratedBoard({ candidate, index, total }) {
  const items = candidate?.items || [];
  return (
    <motion.div
      key={index}
      initial={{ opacity: 0, x: 24 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -24 }}
      transition={{ duration: 0.25 }}
      className="flex flex-col gap-2"
    >
      <div className="grid grid-cols-2 gap-3">
        {items.map((item, i) => (
          <GenTile key={i} item={item} />
        ))}
      </div>
      {total > 1 && (
        <div className="text-[11px] text-white/40 text-center">
          Idea {index + 1} of {total}
        </div>
      )}
    </motion.div>
  );
}
