/**
 * 실험용 사이트 표시 — 운영 사이트(VOILA)와 화면에서 바로 구분된다.
 *   · 화면 맨 위 시안(cyan) 라인
 *   · 좌하단 고정 "TEST SITE" 배지 (모바일은 하단 내비 위)
 * 클릭을 가로막지 않도록 pointer-events-none.
 */
export function LabBadge() {
  return (
    <>
      <div aria-hidden className="pointer-events-none fixed inset-x-0 top-0 z-[300] h-[3px] bg-cyan-400" />
      <div
        role="note"
        aria-label="Test site"
        className="pointer-events-none fixed bottom-[72px] left-3 z-[300] flex items-center gap-1.5 rounded-full border border-cyan-300/60 bg-cyan-950/90 px-3 py-1.5 text-[11px] font-bold tracking-[0.14em] text-cyan-200 shadow-[0_0_18px_rgba(34,211,238,0.35)] backdrop-blur md:bottom-4 md:left-4"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-cyan-300" />
        TEST SITE
      </div>
    </>
  );
}

export default LabBadge;
