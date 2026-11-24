import type { MediaItem } from './types';

export interface JustifiedBox {
  item: MediaItem;
  left: number;
  width: number;
  height: number;
}

export interface JustifiedRow {
  index: number;
  top: number;
  height: number;
  boxes: JustifiedBox[];
}

export interface JustifiedLayoutResult {
  rows: JustifiedRow[];
  totalHeight: number;
}

function getAspectRatio(item: MediaItem): number {
  if (item.width > 0 && item.height > 0) {
    const ar = item.width / item.height;
    return Math.min(2.8, Math.max(0.45, ar));
  }
  return 4 / 3;
}

export function computeJustifiedLayout(
  items: MediaItem[],
  containerWidth: number,
  targetRowHeight: number,
  gap: number,
  justifyLastRow = false,
): JustifiedLayoutResult {
  if (items.length === 0 || containerWidth <= 0) {
    return { rows: [], totalHeight: 0 };
  }

  const rows: JustifiedRow[] = [];
  let currentTop = 0;
  let rowItems: Array<{ item: MediaItem; ar: number }> = [];
  let sumAr = 0;

  const flushRow = (isLastRow: boolean) => {
    if (rowItems.length === 0) return;
    const totalGap = gap * (rowItems.length - 1);
    const availWidth = Math.max(100, containerWidth - totalGap);
    let rowHeight = availWidth / sumAr;

    if (isLastRow) {
      // Avoid over-stretching the last incomplete row
      rowHeight = Math.min(targetRowHeight * 1.15, rowHeight);
      if (rowHeight < targetRowHeight * 0.75) {
        rowHeight = targetRowHeight;
      }
    }

    const boxes: JustifiedBox[] = [];
    let left = 0;
    for (let i = 0; i < rowItems.length; i++) {
      const { item, ar } = rowItems[i];
      let w = ar * rowHeight;
      if (!isLastRow && i === rowItems.length - 1) {
        w = Math.max(24, containerWidth - left);
      }
      boxes.push({
        item,
        left,
        width: w,
        height: rowHeight,
      });
      left += w + gap;
    }

    rows.push({
      index: rows.length,
      top: currentTop,
      height: rowHeight,
      boxes,
    });

    currentTop += rowHeight + gap;
    rowItems = [];
    sumAr = 0;
  };

  for (const item of items) {
    const ar = getAspectRatio(item);
    rowItems.push({ item, ar });
    sumAr += ar;

    const totalGap = gap * (rowItems.length - 1);
    const idealWidth = sumAr * targetRowHeight + totalGap;
    if (idealWidth >= containerWidth) {
      flushRow(false);
    }
  }

  if (rowItems.length > 0) {
    // For intermediate pages within a large month, justify the seam row when it's reasonably full
    const totalGap = gap * (rowItems.length - 1);
    const fillRatio = (sumAr * targetRowHeight + totalGap) / containerWidth;
    flushRow(!(justifyLastRow && fillRatio >= 0.65));
  }

  return {
    rows,
    totalHeight: Math.max(0, currentTop - gap),
  };
}
