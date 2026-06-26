// 2D flat-lay of the chosen outfit: top centered, bottom below, with
// outerwear/footwear/accessories in a sidebar (they are not composited into the
// VTON render). Framer Motion animates candidate changes.
import { motion } from 'framer-motion';

const SIDEBAR_CATEGORIES = ['outerwear', 'footwear', 'accessory'];

function ItemTile({ item, label, size = 'h-28' }) {
  if (!item) {
    return (
      <div className={`${size} w-full rounded-lg border border-white/15 bg-white/5 flex items-center justify-center`}>
        <span className="text-xs text-white/40">{label}</span>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-1">
      <div className={`${size} w-full rounded-lg bg-white/10 overflow-hidden flex items-center justify-center`}>
        {item.thumbnailUrl ? (
          <img src={item.thumbnailUrl} alt={item.subcategory || item.category} className="h-full object-contain" />
        ) : (
          <span className="text-xs text-white/40">{label}</span>
        )}
      </div>
      <span className="text-[11px] text-white/60 capitalize">{item.subcategory || item.category}</span>
    </div>
  );
}

export default function OutfitBoard({ candidate, itemsById, index, total }) {
  const items = (candidate?.itemIds || []).map((id) => itemsById[id]).filter(Boolean);
  const top = items.find((i) => i.category === 'top');
  const bottom = items.find((i) => i.category === 'bottom');
  const extras = items.filter((i) => SIDEBAR_CATEGORIES.includes(i.category));

  return (
    <motion.div
      key={index}
      initial={{ opacity: 0, x: 24 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -24 }}
      transition={{ duration: 0.25 }}
      className="flex gap-4"
    >
      <div className="flex-1 flex flex-col items-center gap-3">
        <ItemTile item={top} label="Top" />
        <ItemTile item={bottom} label="Bottom" />
        {total > 1 && (
          <div className="text-[11px] text-white/40">
            Outfit {index + 1} of {total}
          </div>
        )}
      </div>

      {extras.length > 0 && (
        <div className="w-24 flex flex-col gap-2">
          <span className="text-[10px] uppercase tracking-wide text-white/40">Also</span>
          {extras.map((item) => (
            <ItemTile key={item.id} item={item} label={item.category} size="h-16" />
          ))}
        </div>
      )}
    </motion.div>
  );
}
