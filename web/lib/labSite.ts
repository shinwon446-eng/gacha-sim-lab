/**
 * 실험용 복제 사이트(gacha-sim-lab) 전용 설정.
 *
 * 이 사이트는 운영 사이트(https://shinwon446-eng.github.io/gacha-sim/)와 **같은 출처(origin)** 에 배포된다.
 * 출처가 같으면 localStorage·sessionStorage 를 공유하므로, 그대로 두면 실험 사이트가 운영 사이트의
 * 지갑(gachaflix.wallet) · 보관함 · 로그인 세션 같은 저장값을 읽고 덮어쓴다.
 *
 * 그래서 페이지의 어떤 스크립트보다 먼저 Storage 를 감싸, 이 사이트가 쓰는 모든 키 앞에 LAB_STORAGE_PREFIX 를 붙인다.
 * 앱 코드(스토어 persist 키 등)는 원본과 똑같이 두고, 실제 저장소에서만 "voila-lab:gachaflix.wallet" 처럼 분리된다.
 * clear() 는 실험 사이트 키만 지운다 — 운영 사이트 데이터에는 손대지 않는다.
 */
export const LAB_STORAGE_PREFIX = "voila-lab:";

export const LAB_STORAGE_SHIM = `(function(){try{var P=${JSON.stringify(LAB_STORAGE_PREFIX)};var S=Storage.prototype;if(S.__voilaLab)return;S.__voilaLab=1;var g=S.getItem,s=S.setItem,r=S.removeItem,k=S.key;var own=function(st){var a=[];for(var i=0;i<st.length;i++){var n=k.call(st,i);if(n&&n.indexOf(P)===0)a.push(n)}return a};S.getItem=function(x){return g.call(this,P+x)};S.setItem=function(x,v){return s.call(this,P+x,v)};S.removeItem=function(x){return r.call(this,P+x)};S.clear=function(){var a=own(this);for(var i=0;i<a.length;i++)r.call(this,a[i])};S.key=function(i){var n=own(this)[i];return n===undefined?null:n.slice(P.length)}}catch(e){}})();`;

/** 화면 표시 — 운영 사이트와 한눈에 구분되도록 */
export const LAB_TITLE = "[TEST] VOILA";
