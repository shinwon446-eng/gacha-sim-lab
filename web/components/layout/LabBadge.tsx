"use client";

import { useEffect, useState } from "react";

/**
 * 실험용 사이트 표시 — 운영 사이트(VOILA)와 화면에서 바로 구분된다.
 *   · 화면 맨 위 시안(cyan) 라인
 *   · 좌하단 고정 "TEST SITE" 배지 (모바일은 하단 내비 위)
 *   · 브라우저 저장 공간이 가득 차 저장이 실패하면 배지 옆에 안내(lib/labSite.ts 의 voila:storage-full)
 * 클릭을 가로막지 않도록 pointer-events-none.
 */
export function LabBadge() {
  const [storageFull, setStorageFull] = useState(false);
  useEffect(() => {
    const w = window as Window & { __voilaStorageFull?: number };
    if (w.__voilaStorageFull) setStorageFull(true);
    const onFull = () => setStorageFull(true);
    window.addEventListener("voila:storage-full", onFull);
    return () => window.removeEventListener("voila:storage-full", onFull);
  }, []);

  return (
    <>
      <div aria-hidden className="pointer-events-none fixed inset-x-0 top-0 z-[300] h-[3px] bg-cyan-400" />
      <div className="pointer-events-none fixed bottom-[72px] left-3 z-[300] flex max-w-[calc(100vw-24px)] flex-col items-start gap-1.5 md:bottom-4 md:left-4">
        {storageFull && (
          <div role="status" className="rounded-xl border border-amber-300/50 bg-amber-950/90 px-3 py-2 text-[11px] leading-snug text-amber-100 shadow-lg backdrop-blur">
            브라우저 저장 공간이 가득 차 이 기기에 기록을 저장하지 못했습니다. 새로고침하면 이번 변경은 사라집니다.
          </div>
        )}
        <div
          role="note"
          aria-label="Test site"
          className="flex items-center gap-1.5 rounded-full border border-cyan-300/60 bg-cyan-950/90 px-3 py-1.5 text-[11px] font-bold tracking-[0.14em] text-cyan-200 shadow-[0_0_18px_rgba(34,211,238,0.35)] backdrop-blur"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-cyan-300" />
          TEST SITE
        </div>
      </div>
    </>
  );
}

export default LabBadge;
