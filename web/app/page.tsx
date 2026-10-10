/**
 * 루트(/), 정적 export 라 middleware 가 없다. 하이드레이션을 기다리지 않고 브라우저 수준에서 즉시 보낸다.
 *   1) 인라인 스크립트(파싱 즉시 실행): 저장된 선택 > navigator.language(ko→ko, zh→zh, 그 외 전 세계 → en) 로 location.replace
 *   2) 폴백 <meta http-equiv="refresh" content="0; url=./ko/">: JS 가 꺼진 환경
 * 상대 경로(./ko/)라 basePath(/gacha-sim-lab) 아래에서도 그대로 동작한다.
 */
const REDIRECT = `(function(){try{var k="gachaflix.locale";var s=null;try{s=localStorage.getItem(k)}catch(e){}var l=(navigator.language||"").toLowerCase();var t=(s==="ko"||s==="en"||s==="zh")?s:(l.indexOf("ko")===0?"ko":l.indexOf("zh")===0?"zh":"en");location.replace("./"+t+"/")}catch(e){location.replace("./en/")}})();`;

export default function RootRedirect() {
  return (
    <>
      <meta httpEquiv="refresh" content="0; url=./ko/" />
      <script dangerouslySetInnerHTML={{ __html: REDIRECT }} />
      <main className="flex min-h-screen items-center justify-center bg-canvas">
        <span className="caption-luxury">VOILA.GG</span>
      </main>
    </>
  );
}
