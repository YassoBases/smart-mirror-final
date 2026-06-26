import React, { useState, useRef, useEffect } from 'react';

const DraggableApp = ({
  children,
  initialPosition = { x: 0, y: 0 },
  initialSize = { width: 200, height: 150 },
  appId,
  onPositionChange,
  onSizeChange,
  externalPosition = null, // New prop for external position updates
  isExternallyDragged = false, // Flag to indicate external dragging
  externalSize = null,
  isExternallyResized = false,
  hoverHighlightEnabled = false,
  isHoverHighlighted = false,
  widgetShadowsEnabled = true,
  isActive = false,           // True when this widget is click-selected
  onActivate = null,          // Callback to mark this widget as active
  gestureEnabled = true
}) => {
  const [position, setPosition] = useState(initialPosition);
  const [size, setSize] = useState(initialSize);
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [resizeStart, setResizeStart] = useState({ x: 0, y: 0, width: 0, height: 0 });
  const [isHovered, setIsHovered] = useState(false);
  const [locked, setLocked] = useState(false);

  const appRef = useRef(null);

  useEffect(() => {
    if (!hoverHighlightEnabled) {
      setIsHovered(false);
    }
  }, [hoverHighlightEnabled]);

  // Load saved position and size from localStorage
  useEffect(() => {
    const saved = localStorage.getItem(`smartMirror_${appId}_layout`);
    if (saved) {
      try {
        const { position: savedPos, size: savedSize, locked: savedLocked } = JSON.parse(saved);
        if (savedPos) setPosition(savedPos);
        if (savedSize) setSize(savedSize);
        if (savedLocked !== undefined) setLocked(savedLocked);
      } catch (e) {
        console.error('Error loading saved layout:', e);
      }
    }
  }, [appId]);

  // Sync position with external position when provided (hand-tracking drag)
  useEffect(() => {
    if (externalPosition && isExternallyDragged) {
      setPosition(externalPosition);
    }
  }, [externalPosition, isExternallyDragged]);

  // Sync size with external size when provided (hand-tracking resize)
  useEffect(() => {
    if (externalSize && isExternallyResized) {
      setSize(externalSize);
    }
  }, [externalSize, isExternallyResized]);

  // When externally dragged, we render using the external position directly
  // to avoid conflicts with internal state updates.

  // Save position and size to localStorage
  const saveLayout = (newPosition, newSize, newLocked) => {
    const layout = {
      position: newPosition || position,
      size: newSize || size,
      locked: newLocked !== undefined ? newLocked : locked
    };
    localStorage.setItem(`smartMirror_${appId}_layout`, JSON.stringify(layout));
  };

  const canMove = gestureEnabled && !locked;

  // Mouse down handler for dragging
  const handleMouseDown = (e) => {
    if (e.target.classList.contains('resize-handle')) return;
    if (e.target.closest('.widget-lock-btn')) return;
    if (!canMove) return;
    if (isExternallyDragged) return; // Don't handle mouse events when externally dragged
    
    setIsDragging(true);
    const rect = appRef.current.getBoundingClientRect();
    setDragOffset({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    });
    e.preventDefault();
  };

  // Mouse down handler for resizing
  const handleResizeMouseDown = (e) => {
    if (!canMove) return;
    setIsResizing(true);
    setResizeStart({
      x: e.clientX,
      y: e.clientY,
      width: size.width,
      height: size.height
    });
    e.preventDefault();
    e.stopPropagation();
  };

  // Mouse move handler
  useEffect(() => {
    const handleMouseMove = (e) => {
      if (isDragging) {
        const newPosition = {
          x: Math.max(0, Math.min(window.innerWidth - size.width, e.clientX - dragOffset.x)),
          y: Math.max(0, Math.min(window.innerHeight - size.height, e.clientY - dragOffset.y))
        };
        setPosition(newPosition);
        onPositionChange?.(newPosition);
      } else if (isResizing) {
        const deltaX = e.clientX - resizeStart.x;
        const deltaY = e.clientY - resizeStart.y;
        const newSize = {
          width: Math.max(150, Math.min(window.innerWidth - position.x, resizeStart.width + deltaX)),
          height: Math.max(100, Math.min(window.innerHeight - position.y, resizeStart.height + deltaY))
        };
        setSize(newSize);
        onSizeChange?.(newSize);
      }
    };

    const handleMouseUp = () => {
      if (isDragging || isResizing) {
        saveLayout(position, size);
      }
      setIsDragging(false);
      setIsResizing(false);
    };

    if (isDragging || isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      
      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [isDragging, isResizing, dragOffset, resizeStart, position, size, onPositionChange, onSizeChange]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      ref={appRef}
      className="draggable-app absolute"
      data-app-id={appId}
      data-locked={locked ? 'true' : 'false'}
      style={{
        left: (externalPosition ? externalPosition.x : position.x),
        top: (externalPosition ? externalPosition.y : position.y),
        width: (isExternallyResized && externalSize) ? externalSize.width : size.width,
        height: (isExternallyResized && externalSize) ? externalSize.height : size.height,
        zIndex: (isExternallyDragged || isExternallyResized || isDragging || isResizing) ? 1000 : 'auto',
        transition: (isExternallyDragged || isExternallyResized) ? 'none' : undefined,
        willChange: isExternallyDragged ? 'transform' : isExternallyResized ? 'width, height' : undefined,
        contain: 'layout style'
      }}
      onMouseDown={handleMouseDown}
      onMouseEnter={() => hoverHighlightEnabled && setIsHovered(true)}
      onMouseLeave={() => hoverHighlightEnabled && setIsHovered(false)}
      onClick={(e) => { e.stopPropagation(); onActivate?.(); }}
    >
      <div
        className="w-full h-full bg-black/80 overflow-hidden"
        style={{
          cursor: !canMove ? 'default' : isDragging ? 'grabbing' : 'grab',
          border: isActive
            ? '1px solid var(--mirror-accent-color)'
            : hoverHighlightEnabled && (isHovered || isHoverHighlighted)
              ? '1px solid var(--mirror-accent-color)'
              : 'var(--mirror-widget-border, 1px solid rgba(255, 255, 255, 0.18))',
          boxShadow: (() => {
            const hoverActive = hoverHighlightEnabled && (isHovered || isHoverHighlighted);
            const shadows = [];
            if (isActive) {
              // Click-selected: full accent glow
              shadows.push('0 0 0 1px var(--mirror-accent-color)');
              shadows.push('0 0 32px var(--mirror-accent-soft)');
              shadows.push('var(--mirror-widget-shadow-strong, none)');
            } else if (hoverActive) {
              // Hand-tracking hover: accent glow
              shadows.push('0 0 0 1px var(--mirror-accent-color)');
              shadows.push('0 0 32px var(--mirror-accent-soft)');
            } else if (widgetShadowsEnabled) {
              // Idle: subtle ambient shadow only (no neon)
              shadows.push('var(--mirror-widget-shadow, none)');
            }
            return shadows.length ? shadows.join(', ') : 'none';
          })(),
          borderRadius: 'var(--mirror-widget-radius, 18px)'
        }}
      >
        {children}
      </div>
      
      {/* Per-widget lock toggle — visible only when gesture recognition is enabled */}
      {gestureEnabled && (
        <button
          className="widget-lock-btn"
          onClick={(e) => {
            e.stopPropagation();
            const newLocked = !locked;
            setLocked(newLocked);
            saveLayout(undefined, undefined, newLocked);
          }}
          style={{
            position: 'absolute',
            top: 6,
            right: 6,
            width: 28,
            height: 28,
            padding: 0,
            background: 'rgba(0,0,0,0.45)',
            border: 'none',
            borderRadius: 6,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 20,
            color: locked ? 'var(--mirror-accent-color)' : 'rgba(255,255,255,0.35)',
            transition: 'color 0.2s'
          }}
          title={locked ? 'Unlock widget' : 'Lock widget position'}
        >
          {locked ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
              <path d="M7 11V7a5 5 0 0 1 9.9-1"/>
            </svg>
          )}
        </button>
      )}

      {/* Resize handle */}
      <div
        className="resize-handle"
        onMouseDown={handleResizeMouseDown}
      />
    </div>
  );
};

export default DraggableApp;
