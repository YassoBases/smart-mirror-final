import { useState, useEffect, useRef, useCallback } from 'react';

// ── On-screen keyboard ────────────────────────────────────────────────────────
// Appears automatically whenever a text <input>/<textarea> gains focus (e.g. when
// the gesture cursor pinch-clicks one). Keys are real <button>s, so the same
// pinch-to-click handler that drives the rest of the UI types into the field.
//
// Typing goes through the native value setter + a bubbling 'input' event so React-
// controlled inputs update correctly. Keys preventDefault on mousedown and the
// gesture click() never moves DOM focus, so the target field stays focused while
// typing.

const ROWS_LETTERS = [
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
  ['z', 'x', 'c', 'v', 'b', 'n', 'm'],
];

const ROWS_SYMBOLS = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['@', '#', '$', '&', '*', '-', '+', '(', ')'],
  ['!', '"', "'", ':', ';', '/', '?'],
];

const NON_TEXT_INPUT_TYPES = new Set([
  'checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'file', 'color', 'image', 'hidden',
]);

function isEditable(el) {
  if (!el || !el.tagName) return false;
  if (el.tagName === 'TEXTAREA') return !el.disabled && !el.readOnly;
  if (el.tagName === 'INPUT') {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    return !NON_TEXT_INPUT_TYPES.has(type) && !el.disabled && !el.readOnly;
  }
  return false;
}

// Set value via the native prototype setter so React's onChange still fires.
function nativeSetValue(el, value) {
  const proto = el.tagName === 'TEXTAREA'
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function getCaret(el) {
  try { return [el.selectionStart, el.selectionEnd]; }
  catch { return [el.value.length, el.value.length]; } // number/email/etc. don't expose selection
}
function setCaret(el, pos) {
  try { el.setSelectionRange(pos, pos); } catch { /* unsupported input type */ }
}

export default function VirtualKeyboard() {
  const [open, setOpen] = useState(false);
  const [shift, setShift] = useState(false);
  const [symbols, setSymbols] = useState(false);
  const [revealTick, setRevealTick] = useState(0);
  const targetRef = useRef(null);
  const kbRef = useRef(null);

  useEffect(() => {
    const onFocusIn = (e) => {
      if (isEditable(e.target)) {
        targetRef.current = e.target;
        setOpen(true);
        setRevealTick((t) => t + 1);
      }
    };
    const onFocusOut = () => {
      // Defer so we can read where focus actually landed.
      setTimeout(() => {
        const a = document.activeElement;
        if (isEditable(a)) { targetRef.current = a; return; }       // moved to another field
        if (a && a.closest && a.closest('[data-vk]')) return;       // tapped a key — keep open
        setOpen(false);
      }, 150);
    };
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
    };
  }, []);

  // When the keyboard opens (or the focused field changes), scroll so the input
  // sits comfortably above the keyboard. Uses a small delay so the keyboard DOM
  // is fully painted before we measure its position.
  useEffect(() => {
    if (!open) return undefined;
    const el = targetRef.current;
    if (!el) return undefined;
    const t = setTimeout(() => {
      const kb = kbRef.current;
      const kbTop = kb ? kb.getBoundingClientRect().top : window.innerHeight * 0.6;
      const rect = el.getBoundingClientRect();
      const gap = 32; // keep the input this far above the keyboard top
      if (rect.bottom > kbTop - gap || rect.top < 0) {
        const scrollAmount = rect.bottom - (kbTop - gap);
        try {
          window.scrollBy({ top: scrollAmount, behavior: 'smooth' });
        } catch {
          window.scrollBy(0, scrollAmount);
        }
      }
    }, 150);
    return () => clearTimeout(t);
  }, [open, revealTick]);

  const refocus = useCallback(() => {
    const el = targetRef.current;
    if (el && document.activeElement !== el) {
      try { el.focus({ preventScroll: true }); } catch { /* ignore */ }
    }
  }, []);

  const insert = useCallback((text) => {
    const el = targetRef.current;
    if (!el) return;
    refocus();
    const [s, e] = getCaret(el);
    const v = el.value;
    nativeSetValue(el, v.slice(0, s) + text + v.slice(e));
    setCaret(el, s + text.length);
    if (shift) setShift(false);
  }, [shift, refocus]);

  const backspace = useCallback(() => {
    const el = targetRef.current;
    if (!el) return;
    refocus();
    const [s, e] = getCaret(el);
    const v = el.value;
    if (s !== e) { nativeSetValue(el, v.slice(0, s) + v.slice(e)); setCaret(el, s); }
    else if (s > 0) { nativeSetValue(el, v.slice(0, s - 1) + v.slice(s)); setCaret(el, s - 1); }
  }, [refocus]);

  const submit = useCallback(() => {
    const el = targetRef.current;
    if (!el) return;
    if (el.tagName === 'TEXTAREA') { insert('\n'); return; }
    refocus();
    ['keydown', 'keyup'].forEach((type) =>
      el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true })));
    if (el.form && typeof el.form.requestSubmit === 'function') {
      try { el.form.requestSubmit(); } catch { /* ignore */ }
    }
    setOpen(false);
  }, [insert, refocus]);

  const close = useCallback(() => {
    const el = targetRef.current;
    setOpen(false);
    if (el) { try { el.blur(); } catch { /* ignore */ } }
  }, []);

  if (!open) return null;

  const rows = symbols ? ROWS_SYMBOLS : ROWS_LETTERS;
  const keepFocus = (e) => e.preventDefault(); // mousedown must not steal focus from the field

  const makeKey = (label, onTap, { grow = 1, accent = false, key } = {}) => (
    <button
      key={key ?? label}
      type="button"
      data-vk-key
      onMouseDown={keepFocus}
      onClick={onTap}
      style={{ flexGrow: grow, flexBasis: 0 }}
      className={`mx-[3px] h-12 min-w-[2.1rem] rounded-lg text-base font-medium select-none transition-colors
        ${accent ? 'bg-white/[0.14] text-white/90' : 'bg-white/[0.07] text-white/80'}
        hover:bg-white/20 active:bg-white/30`}
    >
      {label}
    </button>
  );

  return (
    <div
      ref={kbRef}
      data-vk
      onMouseDown={keepFocus}
      className="fixed inset-x-0 bottom-0 z-[9998] px-3 pb-3 pt-2 select-none"
      style={{
        background: 'linear-gradient(to top, rgba(0,0,0,0.97), rgba(0,0,0,0.86))',
        borderTop: '1px solid rgba(255,255,255,0.08)',
        boxShadow: '0 -12px 40px rgba(0,0,0,0.6)',
      }}
    >
      <div className="mx-auto max-w-3xl">
        {rows.map((row, i) => (
          <div key={i} className="mb-2 flex justify-center">
            {i === 2 && !symbols && makeKey(shift ? '⇧' : '⇪', () => { setShift((s) => !s); refocus(); }, { grow: 1.6, accent: true, key: 'shift' })}
            {row.map((ch) => {
              const label = (!symbols && shift) ? ch.toUpperCase() : ch;
              return makeKey(label, () => insert(label), { key: ch });
            })}
            {i === 2 && makeKey('⌫', backspace, { grow: 1.6, accent: true, key: 'bksp' })}
          </div>
        ))}
        <div className="flex justify-center">
          {makeKey(symbols ? 'ABC' : '?123', () => { setSymbols((s) => !s); refocus(); }, { grow: 1.6, accent: true, key: 'mode' })}
          {makeKey(',', () => insert(','), { key: 'comma' })}
          {makeKey('space', () => insert(' '), { grow: 5, key: 'space' })}
          {makeKey('.', () => insert('.'), { key: 'dot' })}
          {makeKey('return', submit, { grow: 2, accent: true, key: 'ret' })}
          {makeKey('✕', close, { grow: 1.4, accent: true, key: 'close' })}
        </div>
      </div>
    </div>
  );
}
