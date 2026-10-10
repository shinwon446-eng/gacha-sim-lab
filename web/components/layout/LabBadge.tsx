"use client";

import { useEffect, useState } from "react";
import { LAB_COLOR, LAB_OWNER } from "@/lib/labSite";

/**
 * 테스트 사이트 표시 — 운영 사이트(VOILA)와 다른 테스트 사이트를 화면에서 바로 구분한다.
 *   · 화면 맨 위 색 라인 (shinwon = 시안, aresjoo = 마젠타)
 *   · 좌하단 고정 배지 "TEST · {작업자}" + "VOILA 테스트 사이트" (모바일은 하단 내비 위)
 *   · 브라우저 저장 공간이 가득 차 저장이 실패하면 배지 위에 안내(lib/labSite.ts 의 voila:storage-full)
 * 클릭을 가로막지 않도록 pointer-events-none.
 */
const THEME = {
  cyan: { line: "bg-cyan-400", badge: "border-cyan-300/60 bg-cyan-950/90 text-cyan-100 shadow-[0_0_18px_rgba(34,211,238,0.35)]", dot: "bg-cyan-300", sub: "text-cyan-300/80" },
  fuchsia: { line: "bg-fuchsia-500", badge: "border-fuchsia-300/60 bg-fuchsia-950/90 text-fuchsia-100 shadow-[0_0_18px_rgba(217,70,239,0.35)]", dot: "bg-fuchsia-300", sub: "text-fuchsia-300/80" },
} as const;

export function LabBadge() {
  const [storageFull, setStorageFull] = useState(false);
  useEffect(() => {
    const w = window as Window & { __voilaStorageFull?: number };
    if (w.__voilaStorageFull) setStorageFull(true);
    const onFull = () => setStorageFull(true);
    window.addEventListener("voila:storage-full", onFull);
    return () => window.removeEventListener("voila:storage-full", onFull);
  }, []);
  const theme = THEME[LAB_COLOR];

  return (
    <>
      <div aria-hidden className={`pointer-events-none fixed inset-x-0 top-0 z-[300] h-[3px] ${theme.line}`} />
      <div className="pointer-events-none fixed bottom-[72px] left-3 z-[300] flex max-w-[calc(100vw-24px)] flex-col items-start gap-1.5 md:bottom-4 md:left-4">
        {storageFull && (
          <div role="status" className="rounded-xl border border-amber-300/50 bg-amber-950/90 px-3 py-2 text-[11px] leading-snug text-amber-100 shadow-lg backdrop-blur">
            브라우저 저장 공간이 가득 차 이 기기에 기록을 저장하지 못했습니다. 새로고침하면 이번 변경은 사라집니다.
          </div>
        )}
        <div role="note" aria-label={`Test site · ${LAB_OWNER}`} className={`flex items-center gap-2 rounded-2xl border px-3 py-1.5 backdrop-blur ${theme.badge}`}>
          <span className={`h-1.5 w-1.5 flex-none rounded-full ${theme.dot}`} />
          <span className="flex flex-col leading-tight">
            <span className="text-[11px] font-bold tracking-[0.14em]">TEST · {LAB_OWNER}</span>
            <span className={`text-[10px] font-medium ${theme.sub}`}>VOILA 테스트 사이트</span>
          </span>
        </div>
      </div>
    </>
  );
}

export default LabBadge;
