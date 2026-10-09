import type { ReactNode } from 'react';

export function Panel({ title, right, children, className = '', id }: { title: ReactNode; right?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  return (
    <section className={`panel flex flex-col gap-3 ${className}`} aria-labelledby={id}>
      <header className="flex items-center justify-between gap-2 min-w-0">
        <h2 id={id} className="panel-title truncate">
          {title}
        </h2>
        {right && <div className="flex items-center gap-1.5 flex-wrap justify-end">{right}</div>}
      </header>
      {children}
    </section>
  );
}
