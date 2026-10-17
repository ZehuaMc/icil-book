'use client';
import { useEffect, useRef, type ReactNode } from 'react';

export default function Modal({ title, close, wide = false, children }: {
    title: string; close: () => void; wide?: boolean; children: ReactNode;
}) {
    const ref = useRef<HTMLElement>(null), closeRef = useRef(close);
    closeRef.current = close;
    useEffect(() => {
        const dialog = ref.current!;
        const previous = document.activeElement as HTMLElement | null;
        const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]'));
        (focusable()[0] ?? dialog).focus();
        const keyboard = (event: KeyboardEvent) => {
            if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); }
            if (event.key === 'Tab') {
                const items = focusable(), first = items[0], last = items.at(-1);
                if (!first) { event.preventDefault(); dialog.focus(); }
                else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { event.preventDefault(); last?.focus(); }
                else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
            }
        };
        const focus = (event: FocusEvent) => { if (!dialog.contains(event.target as Node)) (focusable()[0] ?? dialog).focus(); };
        document.addEventListener('keydown', keyboard);
        document.addEventListener('focusin', focus);
        return () => { document.removeEventListener('keydown', keyboard); document.removeEventListener('focusin', focus); if (previous?.isConnected) previous.focus(); };
    }, []);
    return <div className="modal-backdrop" onClick={close}><section ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className={`modal ${wide ? 'wide-modal' : ''}`} onClick={e => e.stopPropagation()}>{children}</section></div>;
}
