import { useEffect, useRef } from 'react';

const openDialogs: HTMLElement[] = [];
const focusableSelector = [
  'button:not([disabled])', 'a[href]', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Keep keyboard focus in the topmost open dialog and restore it when that dialog closes. */
export function useModalFocus(open: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!open || !dialog) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    openDialogs.push(dialog);
    const isTop = () => openDialogs[openDialogs.length - 1] === dialog;
    const controls = () => Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector))
      .filter(element => element.getClientRects().length > 0 && !element.closest('[inert], [aria-hidden="true"]'));
    const focusFirst = () => (controls().find(element => element.hasAttribute('autofocus')) ?? controls()[0] ?? dialog).focus();
    if (!dialog.contains(document.activeElement)) focusFirst();
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTop() || event.key !== 'Tab') return;
      const items = controls();
      if (!items.length) { event.preventDefault(); dialog.focus(); return; }
      const active = document.activeElement;
      if (!dialog.contains(active) || (event.shiftKey && active === items[0])) {
        event.preventDefault(); (event.shiftKey ? items[items.length - 1] : items[0]).focus();
      } else if (!event.shiftKey && active === items[items.length - 1]) {
        event.preventDefault(); items[0].focus();
      }
    };
    const onFocus = (event: FocusEvent) => {
      if (isTop() && event.target instanceof Node && !dialog.contains(event.target)) focusFirst();
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocus, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocus, true);
      const index = openDialogs.lastIndexOf(dialog);
      if (index !== -1) openDialogs.splice(index, 1);
      const top = openDialogs[openDialogs.length - 1];
      if (previous?.isConnected && (!top || top.contains(previous))) previous.focus();
      else if (top && !top.contains(document.activeElement)) top.focus();
    };
  }, [open]);
  return ref;
}
