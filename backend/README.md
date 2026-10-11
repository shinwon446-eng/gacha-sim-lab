# VOILA 백엔드 — 1단계: 최소 세션 + 서버 원장

잔액·개봉·보관함의 기준을 브라우저 저장소에서 서버 DB 로 옮기는 첫 단계다.
API 계약은 `web/ACCOUNT-WALLET-API.md` 를 따른다. 상품표·추첨 계산·자금 원천·롤오버 가중치는 `web/lib` 코드를 그대로 가져다 써서 화면과 서버가 같은 확률표로 동작한다.

## 실행

```bash
npm install
DEV_CREDIT=1 npm run dev      # http://localhost:4000, 프론트(3001)에서 쿠키와 함께 호출 가능
npm test                      # 16개: 인증, CSRF, 원자적 개봉, 멱등성, 동시 개봉, 되팔기, 시드 공개 검증
npm run typecheck
```

| 환경변수 | 기본값 | 설명 |
| --- | --- | --- |
| `PORT` | 4000 | |
| `DATABASE_URL` | 없음 → 내장 PGlite(`./.data/pglite`) | 운영은 PostgreSQL 필수 |
| `ALLOWED_ORIGINS` | `http://localhost:3001` | 쿠키 호출을 허용할 프론트 주소(정확히 일치), 쉼표 구분 |
| `NODE_ENV` | | `production` 이면 Secure 쿠키, 개발용 입금 경로 꺼짐 |
| `DEV_CREDIT` | | `1` 이면 `POST /dev/deposit` 활성(운영에서는 항상 꺼짐) |

로컬 DB 는 설치 없이 PGlite(내장 PostgreSQL)를 쓴다. SQL 은 실제 PostgreSQL 과 같다.
1단계에는 메일 발송 업체가 없어 가입 인증 코드가 **서버 콘솔에만** 찍힌다. 그래서 `NODE_ENV=production` 으로는 시작을 거부한다.

## 엔드포인트

모든 POST 는 `GET /auth/csrf` 로 받은 토큰을 `X-CSRF-Token` 헤더로 보내야 하고, Origin 이 허용 목록에 있어야 한다.

| 경로 | 설명 |
| --- | --- |
| `GET /auth/csrf` | `{ token }` |
| `POST /auth/signup` · `/auth/email/verify` · `/auth/email/resend` | 가입, 6자리 코드 인증(5회 실패 시 잠김) → 세션 쿠키 |
| `POST /auth/login` · `/auth/logout`, `GET /auth/session` | 로그인(인증 완료 계정만), 로그아웃(세션 폐기), 세션 조회 |
| `GET /wallet` | 원천별 잔액, 입금·롤오버 누계, 최근 거래 100건 |
| `POST /open` `{ boxSlug, quantity, requestId }` | 차감·추첨·보관함·현금 즉시 적립을 **한 트랜잭션**으로. 잔액 부족은 409 + 부족액 |
| `GET /inventory`, `POST /inventory/sell` `{ ids, requestId }` | 보관함, 95% 되팔기(자금 원천 비율대로 환급) |
| `GET /fair/seed`, `POST /fair/rotate` `{ clientSeed? }`, `GET /fair/seeds/:id` | 서버 시드 커밋(해시만), 교체 시 이전 시드 공개 |
| `POST /dev/deposit` `{ network, amountUsdt, requestId }` | 개발 전용 입금. 실제 입금 확인(`/deposit/check`)은 다음 단계 |

## 원장 규칙

- 금액은 정수 센트(USDT × 100). 소수점 계산은 잔액에 닿지 않는다.
- 돈이 움직이는 일은 `wallet_transactions` 1행 + `ledger_entries`(추가만, 수정·삭제 없음) + `accounts` 잔액 캐시를 같은 트랜잭션에서 쓴다. 테스트가 매번 "잔액 캐시 = 원장 합계"를 확인한다.
- 계정 행 잠금(`FOR UPDATE`)으로 한 사용자의 잔액 변경을 직렬화한다. `crypto_cents >= 0` 제약이 마지막 방어선이다.
- 같은 `requestId` 재요청은 첫 응답을 그대로 돌려주고 다시 차감하지 않는다. 같은 id 에 다른 내용이면 409.
- 개봉 시 암호화폐 잔액 먼저, 모자라면 카드 잔액(`lib/funding.ts`). 아이템에 원천 비율을 남기고 되팔기는 그 비율대로만 돌려준다.
- 서버 시드는 교체(`/fair/rotate`)로 은퇴하기 전까지 서버 밖으로 나가지 않는다. 모든 개봉은 시드별로 겹치지 않는 연속 nonce 를 받는다. 주문마다 사용한 확률표 사본을 저장한다.

## 다음 단계에서 할 것

- 프론트 연결: `NEXT_PUBLIC_API_BASE` 가 있으면 지갑·개봉·보관함·인증을 이 서버로(지금 프론트는 아직 브라우저 원장을 쓴다)
- 실제 메일 발송, 비밀번호 재설정, 소셜 로그인, Google OTP, 요청 횟수 제한
- 실제 입금 확인(`/deposit/check`), 출금(`/withdraw`, 72시간 대기, 심사), 배송
- 추첨 고도화(`web/docs/FAIRNESS-SERVER.md`): 모듈로 편향 제거한 새 알고리즘 버전, 서명된 커밋 영수증, 공개 시각 증거
- 운영 배포처(PostgreSQL 호스팅) 결정
