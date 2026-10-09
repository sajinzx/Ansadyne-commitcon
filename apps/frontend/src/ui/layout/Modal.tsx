import { useEffect, type ReactNode } from 'react';

export function Modal({ title, onClose, children, wide = false }: { title: string; onClose(): void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose} role="presentation">
      <div role="dialog" aria-modal="true" aria-label={title} className={`panel max-h-[90vh] overflow-auto ${wide ? 'w-[min(960px,100%)]' : 'w-[min(560px,100%)]'}`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="panel-title">{title}</h2>
          <button className="btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
